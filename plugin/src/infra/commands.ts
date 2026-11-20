/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}

/** cmd.exe requires a shell to start .cmd/.bat files. Keep the fixed executable path and each argument quoted separately. */
export function batchInvocation(program: string, args: readonly string[]): string {
  if (/["&|<>^%!\r\n]/.test(program) || args.some(arg => /[\r\n\0]/.test(arg))) throw new CliError('Unsafe batch CLI path or argument')
  const quote = (arg: string): string => {
    if (/^[A-Za-z0-9#$*+./:?@\\_-]+$/.test(arg) && !arg.endsWith('\\')) return arg
    return `"${arg.replace(/(\\*)"/g, (_, slash: string) => `${slash}${slash}""`).replace(/%/g, '%%cd:~,%').replace(/(\\+)$/, '$1$1')}"`
  }
  return `""${program}"${args.length ? ` ${args.map(quote).join(' ')}` : ''}"`
}

/** Keep a process alive above cmd.exe while it runs, so Windows can terminate its entire descendant tree by PID. */
export const windowsBatchRunner = [
  "const { spawnSync } = require('node:child_process')",
  "const child = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/e:on', '/v:off', '/s', '/c', process.argv[1]], { stdio: 'inherit', windowsVerbatimArguments: true })",
  'if (child.error) { console.error("Worker CLI could not run: " + child.error.code); process.exit(1) }',
  'process.exit(child.status ?? 1)',
].join('; ')

const MAX_OUTPUT = 16 * 1024 * 1024
async function terminateWindowsTree(child: ChildProcess): Promise<CliError | undefined> {
  if (child.pid !== undefined) {
    try {
      await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true })
      return undefined
    } catch { /* Report incomplete tree teardown rather than claiming cancellation succeeded. */ }
  }
  child.kill('SIGTERM')
  child.stdout?.destroy(); child.stderr?.destroy()
  return new CliError('Windows CLI process tree could not be terminated')
}

/** Deliver literal UTF-8 input. Prefer a failed CLI's own diagnostic to a secondary broken pipe. */
function feedInput(child: ChildProcess, input: string) {
  return pipeline(Readable.from([Buffer.from(input, 'utf8')]), child.stdin!).then(() => true, () => false)
}
/** Execute a batch CLI through a rooted Node child, collecting bounded output while owning abort and timeout teardown. */
async function runWindowsBatch(program: string, args: string[], cwd: string | undefined, signal: AbortSignal, env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const command = batchInvocation(program, args)
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const child = spawn(process.execPath, ['-e', windowsBatchRunner, command], { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
  const fed = input === undefined ? true : feedInput(child, input)
  const streams = { stdout: { chunks: [] as Buffer[], size: 0 }, stderr: { chunks: [] as Buffer[], size: 0 } }
  let stopped: 'abort' | 'timeout' | 'maxBuffer' | undefined
  let cleanup: Promise<CliError | undefined> | undefined
  const stop = (reason: typeof stopped): void => {
    if (stopped) return
    stopped = reason
    cleanup = terminateWindowsTree(child)
  }
  for (const name of ['stdout', 'stderr'] as const) {
    const collected = streams[name]
    child[name]?.on('data', (chunk: Buffer) => {
      if (collected.size + chunk.length > MAX_OUTPUT) { stop('maxBuffer'); return }
      collected.size += chunk.length
      collected.chunks.push(chunk)
    })
  }
  const { promise: done, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once('error', reject)
  child.once('close', (code, reason) => resolve({ code, signal: reason }))
  const abort = (): void => stop('abort')
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => stop('timeout'), TIMEOUT_MS)
  if (signal.aborted) abort()
  try {
    const { code, signal: endedBy } = await done
    const failure = await cleanup
    if (failure) throw failure
    if (stopped === 'abort') throw new DOMException('The operation was aborted', 'AbortError')
    if (stopped === 'timeout') throw new CliError(`${basename(program)} timed out after ${TIMEOUT_MS / 1000} s`)
    if (stopped === 'maxBuffer') throw new CliError(`${basename(program)} printed more output than it may`)
    if (code !== 0) throw commandError({ code, signal: endedBy, stderr: Buffer.concat(streams.stderr.chunks).toString() }, program)
    if (!await fed) throw new CliError('Could not deliver CLI input')
    return Buffer.concat(streams.stdout.chunks).toString()
  } finally {
    signal.removeEventListener('abort', abort)
    clearTimeout(timeout)
  }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string, input?: string): Promise<string> {
    const environment = { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)) {
      try { return await runWindowsBatch(program, args, cwd, this.signal, environment, input) }
      catch (error) { if (error instanceof CliError || error instanceof Error && error.name === 'AbortError') throw error; throw commandError(error, program) }
    }
    try {
      const running = exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: environment })
      const fed = input === undefined ? true : feedInput(running.child, input)
      const { stdout } = await running
      if (!await fed) throw new CliError('Could not deliver CLI input')
      return stdout
    } catch (error) { throw error instanceof CliError ? error : commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.githubOutput(args)) as T }
  private async githubOutput(args: string[]): Promise<string> {
    const { github, managed } = this.deployment
    try { return await this.run(github.cli, args) }
    catch (error) {
      if (!managed) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new DOMException('The operation was aborted', 'AbortError')
      if (!(error instanceof CliError)) throw new CliError('GitHub CLI command failed')
      const code = Number.isSafeInteger(error.code) ? error.code : undefined
      const exitCode = Number.isSafeInteger(error.exitCode) ? error.exitCode : undefined
      const locked = code === 403 && /^gh: Unable to create comment because issue is locked\. \(HTTP 403\)\r?$/m.test(error.message)
      const status = code === undefined ? exitCode === undefined ? '' : ` (exit ${exitCode})`
        : code >= 100 && code <= 599 ? ` (HTTP ${code})` : ` (code ${code})`
      throw new CliError(`${locked ? 'GitHub issue is locked' : 'GitHub CLI command failed'}${status}`, code, exitCode)
    }
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.githubOutput(['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const argv = [...args, '--as', 'bot', '--format', 'json']
    const markdown = args[0] === 'im' && (args[1] === '+messages-send' || args[1] === '+messages-reply') ? args.indexOf('--markdown') : -1
    const input = markdown < 0 ? undefined : args[markdown + 1]
    if (input !== undefined) argv[markdown + 1] = '-'
    const output = await this.run(bot.cli, argv, cwd, input)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
