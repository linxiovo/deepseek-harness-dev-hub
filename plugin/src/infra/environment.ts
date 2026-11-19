/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts, block disallowed commands, and refuse a Worker's direct channel sends by name.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { batchInvocation, CliError, windowsBatchRunner } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
const WINDOWS = process.platform === 'win32'
const BATCH_UNSAFE = /["&|<>^%!\r\n]/
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
/** The shared send guard in worker-bin; its name is reserved so `blockedCommands` cannot replace it. */
const SEND_GUARD = 'send-guard.mjs'
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/** Quotes one Windows batch argument; `%` expands even inside quotes, so it is doubled. */
const cmdQuote = (value: string): string => `"${value.replaceAll('%', '%%')}"`
/** Lines that print a refusal on stderr and exit 1 from a Windows `.cmd` shim. */
const cmdFail = (message: string): readonly string[] => [
  `echo ${message.replaceAll('%', '%%').replaceAll('^', '^^').replaceAll('&', '^&').replaceAll('|', '^|').replaceAll('<', '^<').replaceAll('>', '^>')} 1>&2`,
  '@exit /b 1',
]
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync.native(path) } catch { return resolve(path) } }
  return WINDOWS ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.replace(/\r$/, ''))
  return head.some(line => [MARKER, ...LEGACY_MARKERS].some(marker =>
    line === marker || line === `rem ${marker}` || line === `// ${marker}` || line === `:: ${marker}`))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * The shared send guard: every platform's `gh` and `lark-cli` shims run this script with the host's Node. cmd.exe and
 * PowerShell do not execute the extensionless POSIX shims, so Windows also gets `.cmd` shims that call the same script.
 * The script implements the argv rules, strips the shim directory from PATH, and runs the configured CLI with inherited
 * stdio (replaying any inspected stdin), signal forwarding and its exit result. This is a default-path guardrail:
 * an absolute CLI path, raw HTTP or another credential bypasses it, as documented.
 */
function workerSendGuardScript(): string {
  return String.raw`// ${MARKER}
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [program, cli, ...args] = process.argv.slice(2)
const refuse = () => {
  console.error('dsh-superagent: Worker Sessions report through orchestrator_report; direct channel sends are disabled.')
  process.exit(1)
}
/** Positional command words, skipping options and values of options that take one. */
const pathOf = (argv, valueFlags) => {
  let top = '', sub = '', third = '', target = -1
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (valueFlags.includes(arg)) { index++; continue }
    if (arg.startsWith('-')) continue
    if (!top) { top = arg; target = index }
    else if (!sub) sub = arg
    else if (!third) third = arg
  }
  return { top, sub, third, target }
}
let inspectedStdin
/** GitHub's human-facing comments and reviews, by command path or by api write. */
const ghRefuses = () => {
  const { top, sub, target } = pathOf(args, ['-R', '--repo', '--hostname'])
  if (top === 'issue' && sub === 'comment') return true
  if (top === 'pr' && (sub === 'comment' || sub === 'review')) return true
  if ((top === 'issue' || top === 'pr') && (sub === 'close' || sub === 'reopen')) {
    return args.some(arg => arg.startsWith('-c') || arg === '--comment' || arg.startsWith('--comment='))
  }
  if (top !== 'api') return false
  let path = '', method = '', field = false, pending = false, input
  const queries = []
  const addField = (value, typed) => {
    field = true
    const equals = value.indexOf('=')
    if (equals !== -1 && value.slice(0, equals) === 'query') queries.push([value.slice(equals + 1), typed])
  }
  const tail = args.slice(target + 1)
  for (let index = 0; index < tail.length; index++) {
    const arg = tail[index]
    if (pending) { method = arg; pending = false; continue }
    if (arg === '-X' || arg === '--method') { pending = true; continue }
    if (arg.startsWith('-X') && arg.length > 2) { method = arg.slice(2).replace(/^=/, ''); continue }
    if (arg.startsWith('--method=')) { method = arg.slice(9); continue }
    if (arg === '-f' || arg === '-F' || arg === '--raw-field' || arg === '--field') {
      if (index + 1 < tail.length) addField(tail[++index], arg === '-F' || arg === '--field')
      else field = true
      continue
    }
    if (/^-[fF]./.test(arg)) { addField(arg.slice(2).replace(/^=/, ''), arg[1] === 'F'); continue }
    if (arg.startsWith('--raw-field=') || arg.startsWith('--field=')) {
      addField(arg.slice(arg.indexOf('=') + 1), arg.startsWith('--field=')); continue
    }
    if (arg === '--input') { field = true; input = tail[++index] ?? ''; continue }
    if (arg.startsWith('--input=')) { field = true; input = arg.slice(8); continue }
    if (arg === '-H' || arg === '--header' || arg === '-q' || arg === '--jq' || arg === '-t' || arg === '--template'
      || arg === '--cache' || arg === '--preview' || arg === '-p' || arg === '--repo' || arg === '-R' || arg === '--hostname') { index++; continue }
    if (arg.startsWith('-')) continue
    if (!path) path = arg
  }
  // Fields and an input body default to POST, but an explicit GET remains a read.
  if (!method && field) method = 'POST'
  if (!/^(?:POST|PUT|PATCH|DELETE)$/i.test(method)) return false
  const clean = path.split('?')[0].replace(/\/+$/, '')
  if (clean === 'graphql' || clean.endsWith('/graphql')) {
    const inspectFile = file => {
      if (file === '-') {
        inspectedStdin ??= readFileSync(0)
        return inspectedStdin.toString('utf8')
      }
      return readFileSync(file, 'utf8')
    }
    try {
      const texts = queries.map(([value, typed]) => typed && value.startsWith('@') ? inspectFile(value.slice(1)) : value)
      if (input !== undefined) {
        const payload = JSON.parse(inspectFile(input))
        if (typeof payload?.query !== 'string') return true
        texts.push(payload.query)
      }
      if (path.includes('?')) texts.push(...new URLSearchParams(path.slice(path.indexOf('?') + 1)).getAll('query'))
      return texts.some(query => /\bmutation\b[\s\S]*\b(?:addComment|addPullRequestReview(?:Comment|Thread(?:Reply)?)?|submitPullRequestReview|addDiscussionComment|addDiscussionReply)\b/.test(query))
    } catch { return true } // Never send an uninspected GraphQL body; do not print files or credentials.
  }
  return /(?:^|\/)(?:comments|reviews|replies)(?:\/|$)/.test(clean)
}
/** Feishu message writes and shortcuts; reads, chat reads and other domains pass. */
const larkRefuses = () => {
  const { top, sub, third, target } = pathOf(args, ['--as', '--format', '--jq', '--output', '--output-dir', '--profile', '--config', '--page-size', '--page-limit', '--page-delay'])
  const shortcutReads = ['+messages-mget', '+messages-search', '+messages-read-status', '+messages-resources-download']
  if (top.startsWith('+messages-') && !shortcutReads.includes(top)) return true
  if (sub.startsWith('+messages-') && !shortcutReads.includes(sub)) return true
  if (top === 'im') {
    const messageReads = ['read_status', 'read_users', 'mget', 'get', 'list', 'search', 'batch_query', 'batch_get', 'resources']
    if (sub === 'messages' && third && !messageReads.includes(third)) return true
    if (sub === 'threads' && third === 'forward') return true
    if (sub === 'threads.forward') return true
    if (sub.startsWith('messages.') && !messageReads.includes(sub.slice(9))) return true
  }
  if (top !== 'api') return false
  let method = '', body = false, pending = false
  const tail = args.slice(target + 1)
  for (let index = 0; index < tail.length; index++) {
    const arg = tail[index]
    if (pending) { method = arg; pending = false; continue }
    if (arg === '-X' || arg === '--method') { pending = true; continue }
    if (arg.startsWith('-X')) { method = arg.slice(2); continue }
    if (arg.startsWith('--method=')) { method = arg.slice(9); continue }
    if (arg === '--data' || arg === '--data-file' || arg === '-d') { body = true; index++; continue }
    if (arg.startsWith('--data=') || arg.startsWith('--data-file=') || arg.startsWith('-d=')) { body = true; continue }
    if (arg === '--params' || arg === '--params-file' || arg === '--format' || arg === '--jq' || arg === '--output'
      || arg === '--output-dir' || arg === '--profile' || arg === '--config' || arg === '--as' || arg === '-H' || arg === '--header') { index++; continue }
    if (arg.startsWith('-')) continue
    if (!method) method = arg
  }
  // A body without an explicit method is a write; any method other than GET can write.
  if (!method) return body
  return !/^GET$/i.test(method)
}
if (program === 'gh' ? ghRefuses() : larkRefuses()) refuse()

const home = dirname(fileURLToPath(import.meta.url))
const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value
const real = (value) => { try { return realpathSync(value) } catch { return resolve(value) } }
const env = { ...process.env }
for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name]
env.PATH = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(entry => entry && fold(real(entry)) !== fold(real(home))).join(delimiter)
const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cli)
if (batch && (/["&|<>^%!\r\n]/.test(cli) || args.some(arg => /[\r\n\0]/.test(arg)))) {
  console.error('dsh-superagent: unsafe Windows batch CLI path or argument')
  process.exit(1)
}
// Keep this standalone script's quoting in sync with batchInvocation in commands.ts.
const batchInvocation = () => {
  const quote = arg => {
    if (/^[A-Za-z0-9#$*+./:?@\\_-]+$/.test(arg) && !arg.endsWith('\\')) return arg
    return '"' + arg.replace(/(\\*)"/g, (_, slash) => slash + slash + '""').replace(/%/g, '%%cd:~,%').replace(/(\\+)$/, '$1$1') + '"'
  }
  return '""' + cli + '"' + (args.length ? ' ' + args.map(quote).join(' ') : '') + '"'
}
let child
try {
  child = spawn(batch ? process.env.ComSpec ?? 'cmd.exe' : cli,
    batch ? ['/d', '/e:on', '/v:off', '/s', '/c', batchInvocation()] : args,
    { stdio: [inspectedStdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env, windowsVerbatimArguments: batch })
} catch (error) {
  console.error('dsh-superagent: could not run ' + program + ': ' + error.message)
  process.exit(127)
}
let stdinError = false
if (inspectedStdin !== undefined && child.stdin) {
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') {
      stdinError = true
      console.error('dsh-superagent: could not forward standard input.')
      child.kill()
    }
  })
  child.stdin.end(inspectedStdin)
}
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const forward = Object.fromEntries(signals.map(signal => [signal, () => {
  if (!batch || child.pid === undefined) { child.kill(signal); return }
  // A batch CLI runs below cmd.exe: terminate its descendants rather than orphaning the CLI on cancellation.
  const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  killer.on('error', () => child.kill(signal))
  killer.on('close', code => { if (code !== 0 && child.exitCode === null) child.kill(signal) })
}]))
for (const signal of signals) process.on(signal, forward[signal])
child.on('error', error => {
  console.error('dsh-superagent: could not run ' + program + ': ' + error.message)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (stdinError) process.exit(1)
  if (signal === null) { process.exit(code ?? 1) }
  for (const name of signals) process.removeListener(name, forward[name])
  try { process.kill(process.pid, signal) } catch { process.exit(1) }
})
`
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Every platform gets one `send-guard.mjs` and `gh`/`lark-cli` shims that run it with the host's Node; on Windows, `.cmd`
 * shims give cmd.exe and PowerShell the same entry points. The guard strips the shim directory from PATH, refuses a
 * Worker's direct channel sends, and then runs the configured CLI. Blocked commands get name-only fail shims.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  if (WINDOWS) {
    if (!/^[A-Za-z0-9-]+$/.test(github.login) || blockedCommands.some(name =>
      !/^[A-Za-z0-9._-]+$/.test(name) || name.endsWith('.') || /\.(?:com|exe|cmd|bat)$/i.test(name) ||
      !WORKER_COMMANDS.includes(name) && WORKER_COMMANDS.some(required => required.toLowerCase() === name.toLowerCase()) ||
      name !== SEND_GUARD && name.toLowerCase() === SEND_GUARD)) {
      throw new Error('Unsafe Windows worker command name or account')
    }
    for (const path of [dir, process.execPath, github.cli, feishu?.cli ?? '']) {
      if (BATCH_UNSAFE.test(path)) throw new Error('Unsafe Windows worker CLI path')
    }
  }
  const shim = (name: string, body: string): Promise<void> => write(name, `#!/bin/sh\n${MARKER}\n${body}\n`, 0o755)
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const guard = join(dir, SEND_GUARD)
  await write(SEND_GUARD, workerSendGuardScript())
  // The guard strips the shim directory, refuses channel sends, then runs the CLI with inherited stdio and exit result.
  const guarded = (program: 'gh' | 'lark-cli', cli: string): string =>
    `exec ${shellQuote(process.execPath)} ${shellQuote(guard)} ${program} ${shellQuote(cli)} "$@"`
  await shim('gh', guarded('gh', github.cli))
  await shim('lark-cli', feishu ? guarded('lark-cli', feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  const blocked = new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name) && name !== SEND_GUARD))
  for (const name of blocked) await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  if (WINDOWS) {
    // cmd.exe and PowerShell ignore extensionless shell scripts; these wrappers hand the same arguments to the guard.
    const cmd = (name: string, lines: readonly string[]): Promise<void> =>
      write(`${name}.cmd`, `@echo off\r\nrem ${MARKER}\r\nsetlocal DisableDelayedExpansion\r\n${lines.join('\r\n')}\r\n`)
    const run = (program: 'gh' | 'lark-cli', cli: string): readonly string[] =>
      [`${cmdQuote(process.execPath)} ${cmdQuote(guard)} ${program} ${cmdQuote(cli)} %*`, '@exit /b %errorlevel%']
    await cmd('gh', run('gh', github.cli))
    await cmd('lark-cli', feishu ? run('lark-cli', feishu.cli) : cmdFail('lark-cli is unavailable: this installation has no Feishu bot.'))
    for (const name of blocked) await cmd(name, cmdFail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  let command = argv
  // DSH has no windowsVerbatimArguments option. Its local provider owns the Node runner and descendants in
  // a Windows Job (or taskkill fallback), and its abort signal terminates that managed range.
  const batch = WINDOWS && /\.(?:cmd|bat)$/i.test(command[0] ?? '')
  if (batch) command = [process.execPath, '-e', windowsBatchRunner, batchInvocation(command[0]!, command.slice(1))]
  const handle = subprocess.spawn({ argv: command, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  let exitCode: number | null
  try { ({ exitCode } = await handle.done) }
  finally {
    // done observes the direct Node child; on cancellation wait until the provider proves its range empty.
    if (batch && signal.aborted && !await handle.waitForExit()) throw new CliError('Windows worker CLI process tree could not be terminated')
  }
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${basename(argv[0] ?? 'command')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  const [origin, helper, ...tail] = helpers
  if (!origin?.startsWith('file:') || !sameDirectory(origin.slice(5), workerGitConfig(stateDir)) || helper !== credentialHelper(github.cli) || tail.length !== 1 || tail[0] !== '') throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
