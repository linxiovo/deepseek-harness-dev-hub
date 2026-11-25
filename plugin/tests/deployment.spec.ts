import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, verifyGithubAccount, verifyGithubRepository, workerProbe, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const win32 = process.platform === 'win32'
const exec = promisify(execFile)
let dir: string
let path: string
const cliPath = (file: string): string => win32 ? `${file}.cmd` : file
const program = (file: string, body = ''): string => {
  const target = cliPath(file)
  const script = `${file}.cjs`
  writeFileSync(script, `${body}\n`)
  if (win32) {
    writeFileSync(target, `@echo off\r\n"${process.execPath}" "%~dp0${basename(script)}" %*\r\n`)
    return target
  }
  writeFileSync(target, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`)
  chmodSync(target, 0o755)
  return target
}
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, [
  "const args = process.argv.slice(2).join(' ')",
  `if (args === 'api user') console.log(${JSON.stringify(JSON.stringify({ login, id: 7 }))})`,
  `else if (/^api repos\\/acme\\/.* --jq \\{name: \\.full_name, push: \\.permissions\\.push\\}$/.test(args)) console.log(${JSON.stringify(JSON.stringify({ name: 'acme/widgets', push }))})`,
  'else process.exit(1)',
].join('\n'))
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string => [
  "const args = process.argv.slice(2).join(' ')",
  `if (args === 'auth status') console.log(${JSON.stringify(JSON.stringify(status))})`,
  `else if (args === 'config strict-mode') console.log(${JSON.stringify(`strict-mode: ${mode} (source: profile)`)})`,
  `else if (args === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') console.log(${JSON.stringify(JSON.stringify(bot))})`,
].join('\n')
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async (argv, extraEnv) => {
  const env: Record<string, string> = {
    ...(win32 && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(win32 && process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    PATH: path,
    HOME: dir,
    ...extraEnv,
  }
  const [command, ...args] = argv
  if (win32 && /\.(?:cmd|bat)$/i.test(command!)) {
    return (await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/c', 'call', command!, ...args], { env })).stdout
  }
  return (await exec(command!, args, { env })).stdout
}
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [
    join(dir, 'state-link', 'worker-bin'),
    `${join(dir, 'state', 'worker-bin')}/`,
    join(dir, 'bin'),
    ...(win32 ? (process.env.PATH ? [process.env.PATH] : []) : ['/usr/bin', '/bin']),
  ].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'), win32 ? 'junction' : undefined)
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), runtimeMode: 'desktop', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(machineOf(Config(minimal({ runtimeMode: 'headless' }))).runtimeMode).toBe('headless')
    expect(() => Config(minimal({ runtimeMode: 'unknown' }))).toThrow('runtimeMode')
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
    if (win32) expect(() => Config(minimal({ stateDir: 'C:relative' }))).toThrow()
  })

  it('requires one verifier per registered project, a listed identity job and safe unique configuration', () => {
    const verification = { projectId: 'a'.repeat(32), workflowId: '12345678', identityJob: 'full-regression', jobs: ['full-regression', 'bundle'],
      artifactName: 'package', configuration: 'checks-v1', environment: 'hosted-ci-v1' }
    expect(machineOf(Config(minimal({ planVerification: [verification] }))).planVerification).toEqual([verification])
    expect(() => Config(minimal({ planVerification: [{ ...verification, projectId: 'invalid' }] }))).toThrow()
    expect(() => machineOf(Config(minimal({ planVerification: [verification, verification] }))))
      .toThrow('Duplicate Plan verification for the same project')
    expect(() => machineOf(Config(minimal({ planVerification: [{ ...verification, jobs: ['full-regression', 'full-regression'] }] }))))
      .toThrow('unique, non-blank full regression job names')
    expect(() => machineOf(Config(minimal({ planVerification: [{ ...verification, identityJob: 'missing' }] }))))
      .toThrow('listed identity job')
    expect(() => machineOf(Config(minimal({ planVerification: [{ ...verification, workflowId: '9007199254740992' }] }))))
      .toThrow('safe positive integer')
  })

  it('requires a scoped release adapter and a controlled credential-provider URL', () => {
    const projectId = 'a'.repeat(32)
    const verification = { projectId, workflowId: '44', identityJob: 'full-regression', jobs: ['full-regression'],
      artifactName: 'package', configuration: 'checks-v1', environment: 'ci-v1' }
    const release = { projectId, executable: cliPath(join(dir, 'bin', 'release-adapter')), environment: 'production', target: 'widgets-production',
      scope: 'catalog service', credentialId: 'production-deploy', credentialProviderUrl: 'https://vault.example.test/projects/widgets' }
    expect(machineOf(Config(minimal({ planVerification: [verification], planRelease: [release] }))).planRelease).toEqual([{ ...release, args: [] }])
    expect(() => machineOf(Config(minimal({ planRelease: [release] })))).toThrow('matching full-regression workflow')
    expect(() => machineOf(Config(minimal({ planVerification: [verification], planRelease: [release, release] }))))
    expect(() => machineOf(Config(minimal({ planVerification: [verification], planRelease: [{ ...release, credentialProviderUrl: 'http://vault.example.test' }] }))))
      .toThrow('credential provider URL must be HTTPS')
  })

  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now executor.repository in the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('verifies a github.com account without a repository and resolves renamed repositories separately', async () => {
    const cli = cliPath(join(dir, 'bin', 'gh'))
    const github = vi.fn<Probe>(async ([command, operation, endpoint, ...flags], env) => {
      expect(command).toBe(cli)
      expect(operation).toBe('api')
      expect(flags).toEqual(expect.arrayContaining(['--hostname', 'github.com']))
      expect(env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_TOKEN: '', GITHUB_TOKEN: '' })
      if (endpoint === 'user') return JSON.stringify({ id: 7, login: 'Agent-Bot', extra: 'not public identity' })
      expect(endpoint).toBe('repos/acme/gadgets')
      return JSON.stringify({ name: 'Acme/Widgets', push: true })
    })
    const account = await verifyGithubAccount(machine(), 'gh', github, path)
    expect(account).toEqual({ cli, id: 7, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(github).toHaveBeenCalledTimes(1)
    await expect(verifyGithubRepository(account, 'acme/gadgets', github)).resolves.toBe('Acme/Widgets')
    github.mockResolvedValueOnce('{"name":"Acme/Widgets","push":false}')
    await expect(verifyGithubRepository(account, 'acme/gadgets', github)).rejects.toEqual(setupError('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'Acme/Widgets' }))
  })

  it('rejects unverified identities and unsafe repository inputs without exposing probe diagnostics', async () => {
    const secret = 'fake-secret-sentinel'
    const github = vi.fn<Probe>().mockRejectedValue(new Error(secret))
    const noDiagnostic = (code: string, values: Record<string, string> = {}) => ({ code, values, message: expect.not.stringContaining(secret) })
    await expect(verifyGithubAccount(machine(), 'gh', github, path)).rejects.toMatchObject(noDiagnostic('agentCliSignedOut'))
    await expect(verifyGithubAccount(machine(), join(dir, secret), github, path)).rejects.toMatchObject(noDiagnostic('agentCliMissing'))
    await expect(verifyGithubAccount(machine(), cliPath(join(dir, 'state-link', 'worker-bin', 'gh')), github, path)).rejects.toMatchObject(noDiagnostic('agentCliMissing'))
    expect(github).toHaveBeenCalledTimes(1)
    github.mockResolvedValueOnce('{"id":0,"login":"Agent-Bot"}')
    await expect(verifyGithubAccount(machine(), 'gh', github, path)).rejects.toMatchObject(noDiagnostic('agentCliNoAccount'))
    github.mockResolvedValueOnce('{"id":7,"login":"Agent-Bot"}')
    const account = await verifyGithubAccount(machine(), 'gh', github, path)
    await expect(verifyGithubRepository(account, 'acme/widgets', github)).rejects.toMatchObject(noDiagnostic('repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets' }))
    github.mockClear()
    await expect(verifyGithubRepository(account, `https://${secret}@github.com/acme/widgets`, github)).rejects.toMatchObject(noDiagnostic('repositoryUnset'))
    await expect(verifyGithubRepository(account, 'acme/..', github)).rejects.toMatchObject(noDiagnostic('repositoryUnset'))
    expect(github).not.toHaveBeenCalled()
  })

  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: cliPath(join(dir, 'bin', 'gh')), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: cliPath(join(dir, 'bin', 'gh')), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    if (win32) await needs('github', 'agentCliMissing', { output: 'bin\\gh must be a command name or an absolute path' }, { repository, cli: 'bin\\gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'process.exit(1)') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'), [
      "if (process.argv.slice(2).join(' ') === 'api user') console.log('{\"login\":\"Agent-Bot\",\"id\":7}')",
      "else { console.error('HTTP 404'); process.exit(1) }",
    ].join('\n'))
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), "console.log('{}')") })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: cliPath(join(dir, 'bin', 'lark-cli')), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), "console.error('not configured'); process.exit(1)")
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
  it('probes CLIs without worker shims on PATH and passes notifier variables via env instead of the POSIX env command', async () => {
    const calls: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = []
    const subprocess = {
      spawn: vi.fn((spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
        calls.push(spec)
        let stdout = '', stderr = ''
        const env: NodeJS.ProcessEnv = {
          ...(win32 && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(win32 && process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
          HOME: dir,
          ...spec.env,
        }
        const done = exec(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal }).then(
          output => { stdout = output.stdout; stderr = output.stderr; return { exitCode: 0, signal: null } },
          (error: { stdout?: unknown; stderr?: unknown; message?: string; code?: unknown }) => {
            stdout = String(error.stdout ?? '')
            stderr = String(error.stderr ?? error.message ?? '')
            return { exitCode: typeof error.code === 'number' ? error.code : 1, signal: null }
          },
        )
        const reader = (get: () => string) => ({ readFrom: () => ({ text: get(), nextOffset: get().length, lossy: false }) })
        return { done, collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) } }
      }),
    } as unknown as SubprocessRuntime
    vi.stubEnv('PATH', path)
    try {
      const probeThroughWorker = workerProbe(subprocess, join(dir, 'state'), join(dir, 'state'), new AbortController().signal)
      const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probeThroughWorker)
      const feishu = await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probeThroughWorker)
      expect(deployment.github.cli).toBe(cliPath(join(dir, 'bin', 'gh')))
      expect(feishu).toEqual({ cli: cliPath(join(dir, 'bin', 'lark-cli')), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
      expect(calls.every(call => call.argv[0] !== 'env')).toBe(true)
      expect(calls[0]!.env?.PATH?.split(delimiter)).not.toContain(join(dir, 'state', 'worker-bin'))
      expect(calls[0]!.env?.PATH?.split(delimiter)).not.toContain(join(dir, 'state-link', 'worker-bin'))
      expect(calls[0]!.env?.PATH?.split(delimiter)).toContain(join(dir, 'bin'))
      const larkCall = calls.find(call => win32 ? call.argv[3]?.includes(cliPath(join(dir, 'bin', 'lark-cli'))) : call.argv[0] === cliPath(join(dir, 'bin', 'lark-cli')))!
      expect(larkCall).toBeDefined()
      expect(larkCall.env).toMatchObject({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
      if (win32) {
        expect(calls[0]!.argv[0]).toBe(process.execPath)
        expect(calls[0]!.argv[3]).toContain(cliPath(join(dir, 'bin', 'gh')))
        expect(calls[0]!.argv[3]).toContain('api user')
        expect(larkCall.argv[3]).toContain('auth status')
      } else {
        expect(calls[0]!.argv).toEqual([cliPath(join(dir, 'bin', 'gh')), 'api', 'user'])
        expect(larkCall.argv).toEqual([cliPath(join(dir, 'bin', 'lark-cli')), 'auth', 'status'])
      }
    } finally { vi.unstubAllEnvs() }
  })
})
