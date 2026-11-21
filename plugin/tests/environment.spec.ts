import { execFile, spawn, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, verifyEnvironment, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { batchInvocation, CliError, Commands } from '../src/infra/commands.ts'
import { sendFeishu } from '../src/sources/feishu-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const windows = process.platform === 'win32'
let dir: string
const program = (path: string, body: string, batch?: string): string => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  if (windows && batch !== undefined) writeFileSync(`${path}.cmd`, `@echo off\r\n${batch}\r\n`)
  return windows && batch !== undefined ? `${path}.cmd` : path
}
/** The first executable on PATH with a Windows executable extension; Node cannot run an extensionless POSIX script here. */
const executable = (name: string): string | undefined => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of windows ? ['.exe'] : ['']) {
      const candidate = join(directory, name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}
const foundShell = executable('sh') ?? (windows ? undefined : '/bin/sh')
if (!foundShell) throw new Error('The tests need a POSIX shell (sh) on PATH')
/** A real POSIX shell: the Worker's by-name shims are resolved and run by one, also on Windows (Git Bash). */
const shell: string = foundShell
/** The directory links the tests can create without privileges: junctions on Windows, directory symlinks elsewhere. */
const directoryLink = (target: string, path: string): void => { symlinkSync(target, path, windows ? 'junction' : 'dir') }
const removeDirectoryLink = (path: string): void => { if (windows) rmdirSync(path); else rmSync(path) }
const shim = (bin: string, name: string): string => join(bin, `${name}${windows ? '.cmd' : ''}`)
const invoke = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding = {}) =>
  windows ? exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/e:on', '/v:off', '/s', '/c', batchInvocation(file, args)], { ...options, windowsVerbatimArguments: true })
    : exec(file, args, options)
const waitForPid = async (file: string): Promise<number> => {
  for (let i = 0; i < 250; i++) {
    try {
      const pid = Number(readFileSync(file, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch { /* The child has not written its PID yet. */ }
    await delay(20)
  }
  throw new Error('The child did not start')
}
const waitForExit = async (pid: number): Promise<void> => {
  for (let i = 0; i < 250; i++) {
    try { process.kill(pid, 0) } catch { return }
    await delay(20)
  }
  throw new Error('The child process tree survived cancellation')
}
const cleanupPid = async (pid: number | undefined): Promise<void> => {
  if (pid === undefined) return
  try { process.kill(pid, 0) } catch { return }
  if (windows) await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 5_000 }).catch(() => {})
  else try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ }
}
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** The PATH a Worker shell gets: its shims first, then the real CLIs, then the POSIX utilities. */
const workerPath = (): string => [workerBin(dir), join(dir, 'real'), dirname(process.execPath),
  ...windows ? [] : ['/usr/bin', '/bin']].join(delimiter)
/** A Worker shell environment: the host's variables, with the Worker's PATH, but no inherited Node preload or inbox. */
const workerShell = (inbox?: string): Record<string, string> => {
  const env: Record<string, string | undefined> = { ...process.env, PATH: workerPath(), HOME: dir, NODE_OPTIONS: undefined, DSH_TEST_INBOX: inbox }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
/** The host's environment: absolute CLIs only, so no Worker shim is in the way. */
const hostShell = (inbox: string, hook: string): Record<string, string> => ({
  PATH: [join(dir, 'real'), ...windows ? [] : ['/usr/bin', '/bin']].join(delimiter), HOME: dir, DSH_TEST_INBOX: inbox,
  NODE_OPTIONS: `--require=${hook}` })
/** The files writeEnvironment must leave in worker-bin, plus one `.cmd` wrapper per shim on Windows. */
const workerFiles = (): string[] => windows
  ? ['gh', 'gh.cmd', 'lark-cli', 'lark-cli.cmd', 'send-guard.mjs']
  : ['gh', 'lark-cli', 'send-guard.mjs']

type InboxRequest = { args: string[]; stdin: string; config: string | null; ghConfig: string | null }
/** A local HTTP inbox that records each fake CLI invocation, so a refused send can be shown never to arrive. */
const startInbox = async () => {
  const requests: InboxRequest[] = []
  const inbox = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body) as InboxRequest)
      response.writeHead(200, { 'content-type': 'application/json' }).end()
    })
  })
  const listening = Promise.withResolvers<void>()
  inbox.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  return { requests, url: `http://127.0.0.1:${(inbox.address() as AddressInfo).port}/inbox`,
    close: async () => { const closed = Promise.withResolvers<void>(); inbox.close(() => closed.resolve()); await closed.promise } }
}
/**
 * A native fake CLI: this Node executable with a preload hook. Windows cannot execFile a script CLI, so the generated
 * `.cmd` shims and the host's Commands both spawn a real executable here; the hook runs its answer synchronously, before
 * Node tries to resolve the command name as a script, and the runner answers as the bot CLIs do.
 */
const fakeCliHook = (): string => {
  const runner = join(dir, 'fake-cli-run.cjs')
  writeFileSync(runner, [
    "const { request } = require('node:http')",
    'const args = JSON.parse(process.env.DSH_FAKE_ARGS ?? "[]")',
    'let stdin = ""',
    'const answer = () => {',
    '  if (!process.env.DSH_TEST_INBOX) {',
    '    process.stdout.write(`${args.join(" ")}\\n`)',
    '    return',
    '  }',
    '  const payload = JSON.stringify({ args, stdin, config: process.env.LARKSUITE_CLI_CONFIG_DIR ?? null, ghConfig: process.env.GH_CONFIG_DIR ?? null })',
    '  const call = request(process.env.DSH_TEST_INBOX, { method: "POST", headers: { "content-type": "application/json" } }, response => {',
    '    response.resume()',
    '    response.on("end", () => {',
    '      const data = args[0] === "api" && args[1] === "user" ? { login: "agent-bot" } : {}',
    '      process.stdout.write(JSON.stringify({ ok: true, data }))',
    '    })',
    '  })',
    '  call.on("error", error => { console.error(error.message); process.exit(1) })',
    '  call.end(payload)',
    '}',
    'if (process.env.DSH_FAKE_STDIN) {',
    '  process.stdin.setEncoding("utf8")',
    '  process.stdin.on("data", chunk => { stdin += chunk })',
    '  process.stdin.on("end", answer)',
    '} else { answer() }',
  ].join('\n'))
  const hook = join(dir, 'fake-cli.cjs')
  writeFileSync(hook, [
    "const { spawnSync } = require('node:child_process')",
    // Node resolves the first argument as its entry script, so recover the command name from the resolved path.
    "const args = [require('node:path').basename(process.argv[1] ?? ''), ...process.argv.slice(2)]",
    // The generated send-guard runs under Node too and inherits this preload; leave it alone.
    "if (!/send-guard\\.mjs$/.test(process.argv[1] ?? '')) {",
    "  const env = { ...process.env, DSH_FAKE_ARGS: JSON.stringify(args) }",
    '  delete env.NODE_OPTIONS',
    "  const child = spawnSync(process.execPath, [require('node:path').join(__dirname, 'fake-cli-run.cjs')], { stdio: 'inherit', env })",
    '  process.exit(child.status ?? 1)',
    '}',
  ].join('\n'))
  return hook
}
/** A native wrapper that sets its own config from DSH_WRAPPER_CONFIG and calls `gh` by name, as an operator's wrapper script would. */
const fakeWrapperHook = (): string => {
  const hook = join(dir, 'fake-wrapper.cjs')
  writeFileSync(hook, [
    "const { spawnSync } = require('node:child_process')",
    "if (!/send-guard\\.mjs$/.test(process.argv[1] ?? '')) {",
    "  const args = [require('node:path').basename(process.argv[1] ?? ''), ...process.argv.slice(2)]",
    `  const child = spawnSync(${JSON.stringify(foundShell)}, ['-c', 'GH_CONFIG_DIR="$DSH_WRAPPER_CONFIG" exec gh "$@"', 'gh', ...args], { stdio: 'inherit' })`,
    "  process.exit(child.status ?? 1)",
    '}',
  ].join('\n'))
  return hook
}
/** A deployment whose GitHub and Feishu CLIs are the native fake above; its hook reports every invocation to the inbox. */
const fakeDeployment = () => {
  fakeCliHook()
  const base = testDeployment()
  return testDeployment({ stateDir: dir, github: { ...base.github, cli: process.execPath }, feishu: { ...base.feishu!, cli: process.execPath } })
}
/** Runs a Worker command by name through a real shell, as the Worker's own shell resolves it. */
const runByName = (name: string, args: string[], env: Record<string, string>, timeout = 10_000) =>
  exec(shell, ['-c', 'exec "$@"', 'sh', name, ...args], { env, timeout })
/** Runs a Worker command by name with `input` on stdin; the fake CLI reports the bytes the guard forwarded. */
const runWithInput = (name: string, args: string[], env: Record<string, string>, input: string) => {
  const running = exec(shell, ['-c', 'exec "$@"', 'sh', name, ...args], { env: { ...env, DSH_FAKE_STDIN: '1' }, timeout: 10_000 })
  // A refusal may exit before reading stdin; the write then fails with EPIPE, which the test observes as the exit status.
  running.child.stdin?.on('error', () => {})
  running.child.stdin?.end(input)
  return running
}

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    const config = join(dir, 'agent-config').replaceAll('\\', '/')
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const hook = fakeWrapperHook()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: process.execPath }, feishu: undefined }), [])
    const path = [workerBin(dir), join(dir, 'venv'), join(dir, 'real'), dirname(process.execPath), ...windows ? [] : ['/usr/bin', '/bin']]
    const { stdout } = await runByName('gh', ['api', 'user'], { ...workerShell(), PATH: path.join(delimiter),
      NODE_OPTIONS: `--require=${hook}`, DSH_WRAPPER_CONFIG: config })
    const parsed = JSON.parse(stdout) as { login: string; config: string; path: string }
    expect(parsed.login).toBe('agent-bot')
    expect(parsed.config).toBe(config)
    // The wrapper's `gh` resolves past the shim directory to the caller's other entries.
    expect(parsed.path).not.toContain('worker-bin')
    // The fake CLI is a POSIX shell script; its PATH variable is colon-separated even in Git Bash.
    expect(parsed.path.split(':')).toEqual(expect.arrayContaining([expect.stringMatching(/venv$/), expect.stringMatching(/real$/)]))
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    await expect(runByName('lark-cli', ['im', '+chat-list'], workerShell())).rejects.toMatchObject({ code: 1,
      stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(runByName('personal-gh', [], workerShell())).rejects.toMatchObject({ code: 1,
      stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
    if (windows) {
      const before = readFileSync(shim(workerBin(dir), 'gh'), 'utf8')
      await expect(writeEnvironment(testDeployment({ stateDir: dir }), ['GH'])).rejects.toThrow('Unsafe Windows worker command name or account')
      await expect(writeEnvironment(testDeployment({ stateDir: dir }), ['personal-gh.exe'])).rejects.toThrow('Unsafe Windows worker command name or account')
      await expect(writeEnvironment(testDeployment({ stateDir: dir }), ['SEND-GUARD.MJS'])).rejects.toThrow('Unsafe Windows worker command name or account')
      expect(readFileSync(shim(workerBin(dir), 'gh'), 'utf8')).toBe(before)
    }
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const deployment = fakeDeployment()
    const hook = join(dir, 'fake-cli.cjs')
    await writeEnvironment(deployment, ['gh', 'git', 'lark-cli'])
    const env = { ...workerShell(), NODE_OPTIONS: `--require=${hook}` }
    expect([(await runByName('gh', ['api', 'user'], env)).stdout,
      (await runByName('lark-cli', ['im'], env)).stdout]).toEqual(['api user\n', 'im\n'])
    const files = readdirSync(workerBin(dir))
    expect(files).not.toContain('git')
    expect(files).not.toContain('git.cmd')
  })
  it('refuses a Worker\'s by-name channel sends before the inbox, while reads and the host\'s absolute CLIs run', async () => {
    const { requests, url, close } = await startInbox()
    try {
      const deployment = fakeDeployment()
      const hook = join(dir, 'fake-cli.cjs')
      await writeEnvironment(deployment, [])
      const mutationFile = join(dir, 'mutation.graphql')
      writeFileSync(mutationFile, 'mutation { addComment(input:{body:"hello"}) { clientMutationId } }')
      const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
      const worker = (name: 'gh' | 'lark-cli', args: string[]) => runByName(name, args, env)
      const refused = async (name: 'gh' | 'lark-cli', args: string[]) => expect(worker(name, args), args.join(' ')).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining('direct channel sends are disabled') })

      await worker('lark-cli', ['im', '+chat-messages-list', '--chat-id', 'oc_team'])
      expect(requests).toHaveLength(1)
      for (const args of [
        ['im', '+messages-send', '--chat-id', 'oc_team', '--text', 'hello'],
        ['im', '+messages-reply', '--message-id', 'om_1', '--text', 'hello'],
        ['im', '+messages-forward', '--message-id', 'om_1', '--chat-id', 'oc_team'],
        ['im', '+messages-revoke', '--message-id', 'om_1'],
        ['im', '+messages-edit', '--message-id', 'om_1', '--text', 'hello'],
        ['im', 'messages', 'delete', '--message-id', 'om_1'],
        ['im', 'messages', 'forward', '--message-id', 'om_1', '--chat-id', 'oc_team'],
        ['im', 'messages', 'merge_forward', '--message-id', 'om_1'],
        ['im', 'messages', 'patch', '--message-id', 'om_1'],
        ['im', 'messages', 'urgent_app', '--message-id', 'om_1'],
        ['im', 'threads', 'forward', '--message-id', 'om_1'],
        ['im', 'messages.delete', '--message-id', 'om_1'],
        ['im', 'threads.forward', '--message-id', 'om_1'],
        ['api', 'POST', '/open-apis/im/v1/messages'],
        ['api', 'POST', '/open-apis/im/v1/messages', '--data', '{}'],
        ['api', '--data', '@body.json'],
      ]) await refused('lark-cli', args)
      expect(requests).toHaveLength(1)
      // Feishu reads still run, and an explicit GET overrides body flags.
      await worker('lark-cli', ['im', '+messages-mget', '--message-ids', 'om_1'])
      await worker('lark-cli', ['api', 'GET', '/open-apis/im/v1/messages'])
      await worker('lark-cli', ['api', 'GET', '/open-apis/im/v1/messages', '--data', '{}'])
      expect(requests).toHaveLength(4)

      await worker('gh', ['pr', 'view', '1', '--json', 'number'])
      expect(requests).toHaveLength(5)
      // Workers may inspect PRs and checks, but cannot merge or mutate the merge queue.
      await worker('gh', ['pr', 'create', '--title', 't', '--body', 'b'])
      await worker('gh', ['pr', 'checks', '1'])
      await worker('gh', ['api', 'graphql', '-f', 'query=mutation { resolveReviewThread(input:{threadId:"t"}) { thread { id } } }'])
      await worker('gh', ['api', '-X', 'GET', 'repos/acme/widgets/issues/1/comments'])
      expect(requests).toHaveLength(9)
      for (const args of [
        ['issue', 'comment', '1', '--body', 'hello'],
        ['pr', 'comment', '1', '--body', 'hello'],
        ['pr', 'review', '1', '--approve'],
        ['pr', '--repo', 'acme/widgets', 'review', '1'],
        ['issue', '--repo=acme/widgets', 'comment', '1'],
        ['api', 'repos/acme/widgets/issues/1/comments', '-f', 'body=hello'],
        ['api', '-F', 'body=hello', 'repos/acme/widgets/issues/1/comments'],
        ['api', '-X', 'PATCH', 'repos/acme/widgets/issues/comments/1', '-f', 'body=hello'],
        ['api', '--method=POST', 'repos/acme/widgets/pulls/1/reviews', '-f', 'body=hello'],
        ['api', 'graphql', '-f', 'query=mutation { addComment(input:{body:"hello"}) { clientMutationId } }'],
        ['api', 'graphql', '-f', 'query=mutation { submitPullRequestReview(input:{}) { clientMutationId } }'],
        ['api', 'graphql', '-f', 'query=mutation { addPullRequestReviewComment(input:{body:"hello"}) { clientMutationId } }'],
        ['api', 'graphql', '-f', 'query=mutation { addPullRequestReviewThread(input:{body:"hello"}) { clientMutationId } }'],
        ['api', 'graphql', '-f', 'query=mutation { addPullRequestReviewThreadReply(input:{body:"hello"}) { clientMutationId } }'],
        ['api', 'repos/acme/widgets/issues/1/comments', '-fbody=hello'],
        ['api', 'graphql', '-F', `query=@${mutationFile}`],
        ['pr', 'merge', '1', '--merge'],
        ['api', '--method', 'PUT', 'repos/acme/widgets/pulls/1/merge'],
        ['api', 'repos/acme/widgets/merges', '-f', 'base=main', '-f', 'head=agent/labels'],
        ['api', '-XPOST', 'repos/acme/widgets/merge-queue/entries'],
        ['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input:{pullRequestId:"p"}) { pullRequest { id } } }'],
        ['api', 'graphql', '-f', 'query=mutation { enablePullRequestAutoMerge(input:{pullRequestId:"p",mergeMethod:MERGE}) { pullRequest { id } } }'],
        ['api', 'graphql', '-f', 'query=mutation { enqueuePullRequest(input:{pullRequestId:"p"}) { clientMutationId } }'],
        ['api', 'graphql', '-f', 'query=mutation { dequeuePullRequest(input:{pullRequestId:"p"}) { clientMutationId } }'],
        ['pr', 'close', '1', '--comment', 'hello'],
      ]) await refused('gh', args)
      expect(requests).toHaveLength(9)
      // The host's Commands use the absolute CLIs, outside the Worker shims, so Hub replies still send.
      const commands = new Commands(() => deployment, hostShell(url, hook), new AbortController().signal)
      await expect(sendFeishu({ commands }, { id: 'reply-1', channel: { source: 'feishu', thread: 'feishu:oc_team:om_1',
        address: { chatId: 'oc_team', messageId: 'om_1' } }, text: 'Routed answer', kind: 'reply' })).resolves.toBe('sent')
      await commands.api(z.unknown(), 'issues/1/comments', '--method', 'POST', '-f', 'body=host')
      expect(requests).toHaveLength(11)
      expect(requests[9]!.args).toEqual(expect.arrayContaining(['im', '+messages-reply', '--as', 'bot']))
      expect(requests[10]!.args).toEqual(expect.arrayContaining(['api', 'repos/acme/widgets/issues/1/comments', '--method', 'POST']))
    } finally {
      await close()
    }
  })
  it('refuses a GraphQL mutation read from a file or stdin, while queries and review-thread resolution still pass', async () => {
    const { requests, url, close } = await startInbox()
    try {
      const deployment = fakeDeployment()
      const hook = join(dir, 'fake-cli.cjs')
      await writeEnvironment(deployment, [])
      const mutation = 'mutation { addComment(input:{body:"hello"}) { clientMutationId } }'
      const reviewThread = 'mutation { resolveReviewThread(input:{threadId:"t"}) { thread { id } } }'
      const query = 'query { viewer { login } }'
      const file = (name: string, body: string): string => { const path = join(dir, name); writeFileSync(path, body); return path }
      const mutationFile = file('mutation.graphql', mutation)
      const reviewFile = file('review-thread.graphql', reviewThread)
      const queryFile = file('query.graphql', query)
      const mutationInput = file('mutation.json', JSON.stringify({ query: mutation }))
      const reviewInput = file('review-thread.json', JSON.stringify({ query: reviewThread }))
      const queryInput = file('query.json', JSON.stringify({ query }))
      const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
      const worker = (args: string[], input?: string) => input === undefined ? runByName('gh', args, env) : runWithInput('gh', args, env, input)
      const refused = async (args: string[], input?: string) => expect(worker(args, input), `${args.join(' ')}${input === undefined ? '' : ` < ${input}`}`)
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('direct channel sends are disabled') })

      const refusals: { args: string[]; input?: string }[] = [
        { args: ['api', 'graphql', '-F', `query=@${mutationFile}`] },
        { args: ['api', 'graphql', `-Fquery=@${mutationFile}`] },
        { args: ['api', 'graphql', `--field=query=@${mutationFile}`] },
        { args: ['api', 'graphql', '--input', mutationInput] },
        { args: ['api', 'graphql', `--input=${mutationInput}`] },
        { args: ['api', 'graphql', '-F', 'query=@-'], input: mutation },
        { args: ['api', 'graphql', '--input', '-'], input: JSON.stringify({ query: mutation }) },
      ]
      for (const refusal of refusals) await refused(refusal.args, refusal.input)
      expect(requests).toHaveLength(0)

      const forwarded = async (args: string[], input?: string): Promise<InboxRequest> => {
        const { stdout } = await worker(args, input)
        expect(JSON.parse(stdout)).toEqual({ ok: true, data: {} })
        return requests.at(-1)!
      }
      expect(await forwarded(['api', 'graphql', '-F', `query=@${queryFile}`]))
        .toMatchObject({ args: ['api', 'graphql', '-F', `query=@${queryFile}`], stdin: '' })
      expect(await forwarded(['api', 'graphql', '--input', queryInput]))
        .toMatchObject({ args: ['api', 'graphql', '--input', queryInput], stdin: '' })
      // A review-thread resolution is a mutation the guard must not refuse.
      expect(await forwarded(['api', 'graphql', '-F', `query=@${reviewFile}`]))
        .toMatchObject({ args: ['api', 'graphql', '-F', `query=@${reviewFile}`], stdin: '' })
      expect(await forwarded(['api', 'graphql', '--input', reviewInput]))
        .toMatchObject({ args: ['api', 'graphql', '--input', reviewInput], stdin: '' })
      // A guard that pre-reads stdin must hand the bytes to the real CLI unchanged.
      expect(await forwarded(['api', 'graphql', '-F', 'query=@-'], query))
        .toMatchObject({ args: ['api', 'graphql', '-F', 'query=@-'], stdin: query })
      const queryJson = JSON.stringify({ query })
      expect(await forwarded(['api', 'graphql', '--input', '-'], queryJson))
        .toMatchObject({ args: ['api', 'graphql', '--input', '-'], stdin: queryJson })
      // An explicit GET overrides the implicit write, for both the comment endpoint and a mutation file.
      expect(await forwarded(['api', '-XGET', 'repos/acme/widgets/issues/1/comments', '-fbody=hello']))
        .toMatchObject({ args: ['api', '-XGET', 'repos/acme/widgets/issues/1/comments', '-fbody=hello'] })
      expect(await forwarded(['api', 'graphql', '-XGET', '-F', `query=@${mutationFile}`]))
        .toMatchObject({ args: ['api', 'graphql', '-XGET', '-F', `query=@${mutationFile}`] })
      expect(requests).toHaveLength(8)
    } finally {
      await close()
    }
  })
  it('refuses dotted Lark message writes by name, while dotted message reads still arrive', async () => {
    const { requests, url, close } = await startInbox()
    try {
      const deployment = fakeDeployment()
      const hook = join(dir, 'fake-cli.cjs')
      await writeEnvironment(deployment, [])
      const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
      const worker = (args: string[]) => runByName('lark-cli', args, env)
      const refused = async (args: string[]) => expect(worker(args), args.join(' ')).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining('direct channel sends are disabled') })

      for (const args of [
        ['im', 'messages.create', '--chat-id', 'oc_team', '--text', 'hello'],
        ['im', 'messages.reply', '--message-id', 'om_1', '--text', 'hello'],
        ['im', 'messages.send', '--chat-id', 'oc_team', '--text', 'hello'],
      ]) await refused(args)
      expect(requests).toHaveLength(0)

      const reads = [
        ['im', 'messages.get', '--message-id', 'om_1'],
        ['im', 'messages.list', '--chat-id', 'oc_team'],
        ['im', 'messages.mget', '--message-ids', 'om_1'],
        ['im', 'messages.search', '--query', 'hello'],
      ]
      for (const args of reads) await worker(args)
      expect(requests.map(request => request.args)).toEqual(reads)
    } finally {
      await close()
    }
  })
  it('refuses comments on pull request and issue close or reopen, while the state change alone is a repository operation', async () => {
    const { requests, url, close } = await startInbox()
    try {
      const deployment = fakeDeployment()
      const hook = join(dir, 'fake-cli.cjs')
      await writeEnvironment(deployment, [])
      const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
      const worker = (args: string[]) => runByName('gh', args, env)
      const refused = async (args: string[]) => expect(worker(args), args.join(' ')).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining('direct channel sends are disabled') })

      for (const args of [
        ['pr', 'close', '1', '--comment', 'hello'],
        ['pr', 'close', '1', '--comment=hello'],
        ['pr', 'close', '1', '-c', 'hello'],
        ['pr', 'close', '1', '-chello'],
        ['pr', 'reopen', '1', '--comment', 'hello'],
        ['pr', 'reopen', '1', '--comment=hello'],
        ['pr', 'reopen', '1', '-c', 'hello'],
        ['pr', 'reopen', '1', '-chello'],
        ['issue', 'close', '1', '--comment', 'hello'],
        ['issue', 'close', '1', '--comment=hello'],
        ['issue', 'close', '1', '-c', 'hello'],
        ['issue', 'close', '1', '-chello'],
        ['issue', 'reopen', '1', '--comment', 'hello'],
        ['issue', 'reopen', '1', '--comment=hello'],
        ['issue', 'reopen', '1', '-c', 'hello'],
        ['issue', 'reopen', '1', '-chello'],
        ['pr', 'close', '--comment', 'hello', '1'],
        ['issue', 'reopen', '-chello', '1'],
      ]) await refused(args)
      expect(requests).toHaveLength(0)
      // A close or reopen without a comment changes repository state without sending a human-facing message.
      const actions = [
        ['pr', 'close', '1'],
        ['pr', 'reopen', '1'],
        ['issue', 'close', '1'],
        ['issue', 'reopen', '1'],
      ]
      for (const args of actions) await worker(args)
      expect(requests.map(request => request.args)).toEqual(actions)
    } finally {
      await close()
    }
  })
  it('runs by-name sends through a real ToolRuntime shell and stops them before the inbox', async () => {
    const { requests, url, close } = await startInbox()
    try {
      const deployment = fakeDeployment()
      const hook = join(dir, 'fake-cli.cjs')
      await writeEnvironment(deployment, [])
      writeFileSync(join(dir, 'mutation.graphql'), 'mutation { addComment(input:{body:"hello"}) { clientMutationId } }')
      writeFileSync(join(dir, 'mutation.json'), JSON.stringify({ query: 'mutation { addComment(input:{body:"hello"}) { clientMutationId } }' }))
      const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
      // A real Cordis Context and Tool Runtime with a real shell tool: commands run as `sh -c` with the Worker PATH,
      // so `gh` and `lark-cli` resolve to the generated shims. This is the CLI boundary, not a full DSH host run.
      const ctx = new Context()
      ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
      const tools = new ToolRuntime(ctx)
      const shellCommand = z.object({ command: z.string() })
      const ShellResult = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
      const run = (command: string) => {
        const { promise, resolve } = Promise.withResolvers<z.infer<typeof ShellResult>>()
        const child = spawn(shell, ['-c', command], { cwd: dir, env })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('close', code => resolve({ exitCode: code ?? -1, stdout, stderr }))
        child.on('error', error => resolve({ exitCode: -1, stdout, stderr: String(error) }))
        return promise
      }
      tools.register({
        name: 'bash',
        description: 'Run a command in the Worker shell.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
          required: ['exitCode', 'stdout', 'stderr'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        execute: async args => run(shellCommand.parse(args).command),
      } satisfies ToolDefinition)
      let call = 0
      const bash = async (command: string) => {
        const result = await tools.execute({ callId: `call-${++call}` as ToolCallId, name: 'bash', arguments: { command },
          signal: new AbortController().signal })
        if (result.isError) throw new Error(`bash failed: ${result.error.message}`)
        return ShellResult.parse(result.value)
      }
      for (const command of [
        'gh issue comment 1 --body hello',
        'gh pr review 1 --approve',
        'gh api graphql -f \'query=mutation { addComment(input:{body:"hello"}) { clientMutationId } }\'',
        'gh api repos/acme/widgets/issues/1/comments -fbody=hello',
        'gh api graphql -F query=@mutation.graphql',
        'gh api graphql --input mutation.json',
        'lark-cli im +messages-send --chat-id oc_team --text hello',
        'lark-cli im messages delete --message-id om_1',
        'lark-cli api POST /open-apis/im/v1/messages --data \'{}\'',
      ]) {
        const value = await bash(command)
        expect(value.exitCode, command).toBe(1)
        expect(value.stderr, command).toContain('direct channel sends are disabled')
      }
      expect(requests).toHaveLength(0)
      for (const command of ['gh pr view 1 --json number', 'gh pr create --title t --body b', 'lark-cli im +messages-mget --message-ids om_1'])
        expect((await bash(command)).exitCode, command).toBe(0)
      expect(requests).toHaveLength(3)
      // The host's Commands keep using the absolute CLIs, so the Hub's reply is the only message that leaves.
      const commands = new Commands(() => deployment, hostShell(url, hook), new AbortController().signal)
      await expect(sendFeishu({ commands }, { id: 'reply-2', channel: { source: 'feishu', thread: 'feishu:oc_team:om_1',
        address: { chatId: 'oc_team', messageId: 'om_1' } }, text: 'Routed answer', kind: 'reply' })).resolves.toBe('sent')
      expect(requests).toHaveLength(4)
      expect(requests[3]!.args).toEqual(expect.arrayContaining(['im', '+messages-reply', '--as', 'bot']))
    } finally {
      await close()
    }
  })
  it.skipIf(!windows)('launches a configured batch wrapper without recursive shims or shell injection', async () => {
    program(join(dir, 'real', 'gh'), 'exit 0',
      `"${process.execPath}" -e "process.stdout.write(JSON.stringify({login:'agent-bot',config:process.env.GH_CONFIG_DIR,path:process.env.PATH,args:process.argv.slice(1)}))" %*`)
    const config = join(dir, 'agent-config')
    const tools = join(dir, 'configured tools'); mkdirSync(tools)
    const wrapper = program(join(tools, 'gh-agent'), 'exit 0', `set "GH_CONFIG_DIR=${config}"\r\ngh %*`)
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined })
    await writeEnvironment(deployment, [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)].join(delimiter)
    const injected = join(dir, 'injected')
    const args = ['api', 'user', '--raw-field', `body=hello & echo pwned > ${injected}`]
    const { stdout } = await invoke(shim(bin, 'gh'), args, { env: { ...workerShell(), PATH: path }, timeout: 10_000 })
    const result = JSON.parse(stdout) as { login: string; config: string; path: string; args: string[] }
    expect(result).toMatchObject({ login: 'agent-bot', config, args })
    expect(result.path.split(delimiter)).toEqual(expect.arrayContaining([expect.stringMatching(/venv$/), expect.stringMatching(/real$/)]))
    expect(result.path.split(delimiter)).not.toContain(bin)
    expect(() => readFileSync(injected, 'utf8')).toThrow()
    await expect(invoke(shim(bin, 'gh'), ['issue', 'comment', '1', '--body', 'hello'], { env: { ...workerShell(), PATH: path } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('direct channel sends are disabled') })
  })
  it('forwards configured batch CLIs through Commands and the DSH worker spawn without exposing arguments in failures', async () => {
    const gh = program(join(dir, 'gh-agent'), `exec "${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@"`,
      `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*`)
    const lark = program(join(dir, 'lark-bot'), `exec "${process.execPath}" -e 'process.stdout.write(JSON.stringify({ok:true,data:process.argv.slice(1)}))' "$@"`,
      `"${process.execPath}" -e "process.stdout.write(JSON.stringify({ok:true,data:process.argv.slice(1)}))" %*`)
    const base = testDeployment()
    const deployment = testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } })
    await writeEnvironment(deployment, [])
    const commands = new Commands(() => deployment, agentVariables(dir), new AbortController().signal)
    const injected = join(dir, 'injected')
    const args = ['api', 'repos/acme/widgets/issues?state=open&per_page=10', '--jq', '{name: .full_name, push: .permissions.push}', '--raw-field', `body=hello & echo pwned > ${injected}`]
    expect(await commands.gh(args)).toEqual(args)
    expect(await commands.lark(['api', 'GET', '/open-apis/bot/v3/info'])).toEqual(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'json'])
    expect(JSON.parse(await runAsWorker(subprocess(join(dir, 'global')), [gh, ...args], dir, new AbortController().signal))).toEqual(args)
    expect(() => readFileSync(injected, 'utf8')).toThrow()
    const failing = program(join(dir, 'failing'), 'exit 7', 'exit /b 7')
    const error = await commands.run(failing, ['private-message']).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CliError)
    if (!(error instanceof CliError)) throw error
    expect(error.message).not.toContain('private-message')
    if (windows) {
      const unsafe = join(dir, 'unsafe&cli.cmd')
      await expect(commands.run(unsafe, [])).rejects.toThrow('Unsafe batch CLI path or argument')
      await expect(writeEnvironment({ ...deployment, github: { ...deployment.github, cli: unsafe } }, [])).rejects.toThrow('Unsafe Windows worker CLI path')
    }
  })

  it('ends a batch CLI child when Commands.run is aborted', async () => {
    const pidFile = join(dir, 'child.pid')
    const cli = program(join(dir, 'long-running'), `exec "${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)' "${pidFile}"`,
      `"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${pidFile}"`)
    const controller = new AbortController()
    const commands = new Commands(() => testDeployment(), {}, controller.signal)
    const running = commands.run(cli, [])
    let pid: number | undefined
    try {
      pid = await waitForPid(pidFile)
      controller.abort()
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      await waitForExit(pid)
    } finally { controller.abort(); void running.catch(() => {}); await cleanupPid(pid) }
  })

  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(workerFiles().sort())
    // A marker on a later line, a directory link, and a foreign guard or gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    mkdirSync(join(dir, 'elsewhere'))
    directoryLink(join(dir, 'elsewhere'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    removeDirectoryLink(join(workerBin(dir), 'link'))
    const guard = join(workerBin(dir), 'send-guard.mjs')
    const original = readFileSync(guard, 'utf8')
    writeFileSync(guard, 'foreign guard\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${guard} was not written by dsh-superagent`)
    expect(readFileSync(guard, 'utf8')).toBe('foreign guard\n')
    writeFileSync(guard, original)
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(shim(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(shim(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(workerFiles().sort())
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
  // The same shims under the shells a Windows Worker uses: `cmd.exe` and PowerShell resolve a bare `gh` to `gh.cmd`
  // through PATHEXT, never to the extensionless POSIX shim, so the native name is what the tests must exercise.
  describe.skipIf(!windows)('native Windows shells', () => {
    it('refuse by-name channel sends from cmd and PowerShell and still run authorized reads and pull-request creation', async () => {
      const { requests, url, close } = await startInbox()
      try {
        const hook = join(dir, 'fake-cli.cjs')
        await writeEnvironment(fakeDeployment(), [])
        const env = { ...workerShell(url), NODE_OPTIONS: `--require=${hook}` }
        const cmd = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
        const powershell = executable('pwsh') ?? executable('powershell')
        if (!powershell) throw new Error('The tests need PowerShell to run the generated .cmd shims')
        const run = (file: string, args: string[]) => exec(file, args, { env, timeout: 20_000 })
        await expect(run(cmd, ['/d', '/s', '/c', 'gh issue comment 1 --body hello'])).rejects.toMatchObject({ code: 1,
          stderr: expect.stringContaining('direct channel sends are disabled') })
        await expect(run(cmd, ['/d', '/s', '/c', 'lark-cli im +messages-send --chat-id oc_team --text hello'])).rejects.toMatchObject({ code: 1,
          stderr: expect.stringContaining('direct channel sends are disabled') })
        await expect(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'gh pr review 1 --approve; exit $LASTEXITCODE']))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('direct channel sends are disabled') })
        expect(requests).toHaveLength(0)
        expect((await run(cmd, ['/d', '/s', '/c', 'gh pr view 1 --json number'])).stdout.trim()).toBe('{"ok":true,"data":{}}')
        expect((await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'gh pr create --title t --body b; exit $LASTEXITCODE']))
          .stdout.trim()).toBe('{"ok":true,"data":{}}')
        await run(cmd, ['/d', '/s', '/c', 'lark-cli im +messages-mget --message-ids om_1'])
        expect(requests).toHaveLength(3)
        expect(requests[0]!.args).toEqual(['pr', 'view', '1', '--json', 'number'])
        expect(requests[1]!.args).toEqual(['pr', 'create', '--title', 't', '--body', 'b'])
        // The Windows fail wrappers need no helper: an unavailable bot and a blocked command both fail by name.
        await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
        await expect(run(cmd, ['/d', '/s', '/c', 'lark-cli im +chat-list'])).rejects.toMatchObject({ code: 1,
          stderr: expect.stringContaining('lark-cli is unavailable: this installation has no Feishu bot.') })
        await expect(run(cmd, ['/d', '/s', '/c', 'personal-gh'])).rejects.toMatchObject({ code: 1,
          stderr: expect.stringContaining('personal-gh is blocked in this installation; use gh, which acts as agent-bot.') })
      } finally {
        await close()
      }
    })
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    // `-z` is NUL-separated; Git may spell the same Windows path with slashes and different casing.
    const [origin, helper, tail] = (await exec('git', ['config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], { cwd: dir, env })).stdout.split('\0')
    expect(origin?.startsWith('file:')).toBe(true)
    expect(origin?.slice(5).replaceAll('\\', '/').toLowerCase()).toBe(workerGitConfig(dir).replaceAll('\\', '/').toLowerCase())
    expect([helper, tail]).toEqual([credentialHelper('/opt/agent tools/gh'), ''])
    await expect(verifyEnvironment(deployment, subprocess(workerGitConfig(dir)), new AbortController().signal)).resolves.toBeUndefined()
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`, `echo asked >> "${log}"\r\necho operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0', 'exit /b 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  directoryLink(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  const kept = [join(dir, 'elsewhere'), windows ? 'C:\\Windows' : '/usr/bin', 'node_modules/.bin']
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), ...kept].join(delimiter), bin)).toBe(kept.join(delimiter))
  removeDirectoryLink(join(dir, 'link'))
})

/** Minimal local subprocess seam: native child execution with signal-driven process-range termination. */
const subprocess = (config: string, waited?: () => void): SubprocessRuntime => ({
  spawn: ({ argv, cwd, env, signal }: { argv: readonly string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }), ...env } })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const { promise: done, resolve } = Promise.withResolvers<{ exitCode: number | null; signal: null }>()
    child.on('close', code => resolve({ exitCode: code, signal: null }))
    let cancellation: Promise<void> | undefined
    const stop = (): void => {
      if (windows && child.pid !== undefined) {
        cancellation = exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000 }).then(() => {})
      } else { child.kill('SIGTERM'); cancellation = Promise.resolve() }
    }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') }, waitForExit: async () => { waited?.(); await cancellation; return true } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = [program(join(dir, 'worker-fails'), 'echo nope >&2; exit 3', 'echo nope 1>&2\r\nexit /b 3')]
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
  it('waits for the worker batch process range to close after cancellation', async () => {
    const pidFile = join(dir, 'worker-child.pid')
    const cli = program(join(dir, 'worker-running'), `exec "${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)' "${pidFile}"`,
      `"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${pidFile}"`)
    const controller = new AbortController()
    const waited = vi.fn()
    const running = runAsWorker(subprocess(join(dir, 'global'), waited), [cli], dir, controller.signal)
    let pid: number | undefined
    try {
      pid = await waitForPid(pidFile)
      controller.abort()
      await expect(running).rejects.toBeInstanceOf(CliError)
      expect(waited).toHaveBeenCalledTimes(windows ? 1 : 0)
      await waitForExit(pid)
    } finally { controller.abort(); void running.catch(() => {}); await cleanupPid(pid) }
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
