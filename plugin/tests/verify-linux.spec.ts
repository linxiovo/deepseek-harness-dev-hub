/** End-to-end CLI tests for scripts/verify-linux.mjs against temporary real git repositories and external CLI boundaries. */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync }
  from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { GIT_LOCATION } from '../src/infra/environment.ts'
import { gitEnv } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-linux.mjs')

interface StageRecord {
  status: string
  exitCode: number | null
  log: string | null
}

interface VerifyManifest {
  sha: string | null
  ref: string | null
  workflow: string
  status: string
  exitCode: number
  distro: string | null
  platform: string | null
  nodeVersion: string | null
  pnpmVersion: string | null
  pnpmRunner: string | null
  snapshotDir: string | null
  snapshotCleaned: boolean
  cleanupError: string | null
  runDir: string
  error: string | null
  stages: {
    preflight: StageRecord
    export: StageRecord
    install: StageRecord
    check: StageRecord
  }
}

interface ObservedRun {
  stage: string
  cwd: string
  argv: string[]
  docsContent: string | null
  committedContent: string | null
  hasUntracked: boolean
  hasNodeModules: boolean
  gitEnvKeys: string[]
  gitToplevel: string | null
}

interface WslCall {
  distro: string | null
  execMode: string | null
  argv: string[]
  hostGitEnvKeys: string[]
  unsetVars: string[]
}

let sharedWslDir: string | undefined
let wslHandlerPath: string | undefined
let root: string

beforeAll(async () => {
  if (!windows) return
  sharedWslDir = mkdtempSync(join(tmpdir(), 'verify-linux-wsl-'))
  const source = join(sharedWslDir, 'wsl.cs')
  const exe = join(sharedWslDir, 'wsl.exe')
  wslHandlerPath = join(sharedWslDir, 'wsl-handler.mjs')

  writeFileSync(source, `
using System;
using System.Diagnostics;
using System.Text;

class FakeWsl {
  static int Main() {
    var args = Environment.GetCommandLineArgs();
    var encoded = new string[Math.Max(0, args.Length - 1)];
    for (int i = 1; i < args.Length; i++) {
      encoded[i - 1] = Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
    }
    var psi = new ProcessStartInfo {
      FileName = Environment.GetEnvironmentVariable("DSH_FAKE_WSL_NODE"),
      Arguments = "\\"" + Environment.GetEnvironmentVariable("DSH_FAKE_WSL_HANDLER") + "\\"",
      UseShellExecute = false,
    };
    psi.EnvironmentVariables["DSH_FAKE_WSL_ARGV_B64"] = string.Join(",", encoded);
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`)

  writeFileSync(wslHandlerPath, `
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const stateDir = process.env.DSH_FAKE_WSL_STATE
const rawArgvB64 = process.env.DSH_FAKE_WSL_ARGV_B64 ?? ''
const argv = rawArgvB64
  ? rawArgvB64.split(',').map(part => Buffer.from(part, 'base64').toString('utf8'))
  : []

let distro = null
let execMode = null
let rest = [...argv]
while (rest.length > 0) {
  if (rest[0] === '--distribution' && rest.length > 1) {
    distro = rest[1]
    rest = rest.slice(2)
  } else if (rest[0] === '--exec') {
    execMode = '--exec'
    rest = rest.slice(1)
    break
  } else {
    break
  }
}
const gitLocKeys = ${JSON.stringify(GIT_LOCATION)}
const hostGitEnvKeys = gitLocKeys.filter(key => key in process.env)
if (execMode !== '--exec') {
  appendFileSync(join(stateDir, 'wsl-calls.jsonl'), JSON.stringify({ distro, execMode, argv: rest, hostGitEnvKeys, unsetVars: [] }) + '\\n')
  process.stderr.write('Expected wsl.exe --exec to bypass default shell\\n')
  process.exit(2)
}

function readStdin() {
  const { promise, resolve, reject } = Promise.withResolvers()
  const chunks = []
  process.stdin.on('data', chunk => chunks.push(chunk))
  process.stdin.on('end', () => resolve(Buffer.concat(chunks)))
  process.stdin.on('error', reject)
  return promise
}

function writeAndDrain(stream, data) {
  const { promise, resolve } = Promise.withResolvers()
  if (stream.write(data)) resolve()
  else stream.once('drain', resolve)
  return promise
}

function extractTar(buffer, dest) {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    offset += 512
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\\0.*$/, '')
    const fullName = prefix ? prefix + '/' + name : name
    const typeFlag = String.fromCharCode(header[156] || 48)
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\\0.*$/, '').trim()
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0
    if (typeFlag === '5') {
      if (fullName && fullName !== './') mkdirSync(join(dest, fullName), { recursive: true })
    } else if (typeFlag === '0' || typeFlag === '\\0') {
      const target = join(dest, fullName)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
}

function unwrapCommand(tokens) {
  const unsetVars = []
  if (tokens[0] === 'sh' && tokens[1] === '-c') {
    const dir = tokens[4]
    let inner = tokens.slice(5)
    if (inner[0] === 'env') {
      inner = inner.slice(1)
      while (inner.length > 0) {
        if (inner[0] === '-u' && inner.length > 1) {
          unsetVars.push(inner[1])
          inner = inner.slice(2)
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(inner[0])) {
          inner = inner.slice(1)
        } else {
          break
        }
      }
    }
    return { dir, cmd: inner, unsetVars }
  }
  return { dir: null, cmd: tokens, unsetVars }
}

const { dir, cmd, unsetVars } = unwrapCommand(rest)
appendFileSync(join(stateDir, 'wsl-calls.jsonl'), JSON.stringify({ distro, execMode, argv: rest, hostGitEnvKeys, unsetVars }) + '\\n')
if (rest[0] === 'sh' && rest[1] === '-c' && rest[2] && rest[2].includes('mktemp -d')) {
  const snapshotDir = mkdtempSync(join(process.env.TMPDIR || stateDir, 'linux snap '))
  process.stdout.write(snapshotDir + '\\n')
  process.exit(0)
}
if (rest[0] === 'sh' && rest[1] === '-s') {
  await readStdin()
  const failMsg = process.env.DSH_FAKE_WSL_PREFLIGHT_ERROR
  if (failMsg) {
    process.stderr.write(failMsg + '\\n')
    process.exit(Number(process.env.DSH_FAKE_WSL_PREFLIGHT_CODE || '1'))
  }
  if (process.env.DSH_FAKE_WSL_PREFLIGHT_STDOUT !== undefined) {
    process.stdout.write(process.env.DSH_FAKE_WSL_PREFLIGHT_STDOUT + '\\n')
    process.exit(0)
  }
  const explicitPnpm = rest[5] ?? ''
  const snapshotDir = rest[6] ?? ''
  process.stdout.write('__PREFLIGHT_JSON__:' + JSON.stringify({
    snapshotDir,
    platform: 'linux',
    nodePath: '/usr/bin/node',
    nodeVersion: 'v22.22.1',
    pnpmPath: explicitPnpm || '/usr/bin/corepack',
    pnpmVersion: '11.7.0',
    pnpmRunner: explicitPnpm ? 'explicit' : 'corepack',
    cleanPath: '/usr/local/bin:/usr/bin:/bin',
    pnpmBinPath: explicitPnpm || '/usr/bin/corepack',
  }) + '\\n')
  process.exit(0)
}

if (rest[0] === 'tar') {
  const cIdx = rest.indexOf('-C')
  const dest = cIdx >= 0 ? rest[cIdx + 1] : null
  if (!dest) process.exit(2)
  const data = await readStdin()
  extractTar(data, dest)
  process.exit(0)
}

if (rest[0] === 'rm') {
  const target = rest[rest.length - 1]
  if (process.env.DSH_FAKE_WSL_FAIL_CLEANUP) {
    await writeAndDrain(process.stderr, 'rm: cannot remove ' + (target || '') + ': Permission denied\\n')
    process.exit(Number(process.env.DSH_FAKE_WSL_CLEANUP_CODE || '7'))
  }
  if (target) rmSync(target, { recursive: true, force: true })
  process.exit(0)
}

if (cmd.includes('install') || cmd.includes('check')) {
  const stage = cmd.includes('install') ? 'install' : 'check'
  const snapRoot = dir ? dirname(dir) : ''
  const record = {
    stage,
    cwd: dir || process.cwd(),
    argv: cmd,
    docsContent: existsSync(join(snapRoot, 'DOCS.md')) ? readFileSync(join(snapRoot, 'DOCS.md'), 'utf8') : null,
    committedContent: existsSync(join(dir || '', 'committed.txt')) ? readFileSync(join(dir || '', 'committed.txt'), 'utf8') : null,
    hasUntracked: existsSync(join(dir || '', 'untracked.txt')),
    hasNodeModules: existsSync(join(dir || '', 'node_modules')),
    gitEnvKeys: gitLocKeys.filter(key => key in process.env),
    gitToplevel: null,
  }
  appendFileSync(join(stateDir, 'observed.jsonl'), JSON.stringify(record) + '\\n')
  if (process.env.DSH_FAKE_WSL_FAIL_STAGE === stage) {
    const bytes = Number(process.env.DSH_FAKE_WSL_LARGE_BYTES || '0')
    if (bytes > 0) await writeAndDrain(process.stdout, 'L'.repeat(bytes) + '\\n')
    await writeAndDrain(process.stdout, 'STDOUT_TAIL_MARKER_' + stage + '\\n')
    await writeAndDrain(process.stderr, 'STDERR_FAIL_MARKER_' + stage + '\\n')
    process.exit(Number(process.env.DSH_FAKE_WSL_FAIL_CODE || '3'))
  }


  process.stdout.write('fake ' + stage + ' ok\\n')
  process.exit(0)
}

process.stderr.write('Unexpected fake wsl invocation: ' + JSON.stringify(rest) + '\\n')
process.exit(1)
`)

  const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  await exec(csc, ['/nologo', `/out:${exe}`, source])
})

afterAll(() => {
  if (sharedWslDir) rmSync(sharedWslDir, { recursive: true, force: true })
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify linux '))
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function gitIdentityEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return gitEnv({
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra as Record<string, string>,
  })
}

async function createGitRepo(repoDir: string, committedText: string, branch = 'main'): Promise<string> {
  mkdirSync(join(repoDir, 'plugin'), { recursive: true })
  writeFileSync(join(repoDir, 'DOCS.md'), '# Root Docs\n')
  writeFileSync(join(repoDir, 'plugin', 'package.json'), JSON.stringify({
    name: 'verify-fixture',
    packageManager: 'pnpm@11.7.0',
    engines: { node: '^22.19.0 || >=24.0.0' },
    scripts: { check: 'node -e "process.exit(0)"' },
  }, null, 2))
  writeFileSync(join(repoDir, 'plugin', 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(repoDir, 'plugin', 'committed.txt'), committedText)

  const env = gitIdentityEnv()
  await exec('git', ['init', '-q', '-b', branch, repoDir], { env })
  await exec('git', ['-C', repoDir, 'add', '.'], { env })
  await exec('git', ['-C', repoDir, 'commit', '-q', '-m', 'Initial fixture commit'], { env })
  const { stdout } = await exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { env })
  return stdout.trim()
}

function setupLinuxFakePnpm(options: {
  version?: string
  failStage?: string
  failCode?: number
  largeBytes?: number
  lockSnapshotOnCheck?: boolean
  writeFile?: string
} = {}): string {
  const observedPath = join(root, 'state', 'observed.jsonl')
  const target = options.writeFile ?? join(root, 'bin', 'pnpm')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const gitLocKeys = ${JSON.stringify(GIT_LOCATION)}

function writeAndDrain(stream, data) {
  const { promise, resolve } = Promise.withResolvers()
  if (stream.write(data)) resolve()
  else stream.once('drain', resolve)
  return promise
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--version') {
    await writeAndDrain(process.stdout, ${JSON.stringify(options.version ?? '11.7.0')} + '\\n')
    return
  }
  const stage = args.includes('install') ? 'install' : args.includes('check') ? 'check' : 'other'
  const cwd = process.cwd()
  const snapRoot = dirname(cwd)
  const gitTop = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  appendFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
    stage,
    cwd,
    argv: args,
    docsContent: existsSync(join(snapRoot, 'DOCS.md')) ? readFileSync(join(snapRoot, 'DOCS.md'), 'utf8') : null,
    committedContent: existsSync(join(cwd, 'committed.txt')) ? readFileSync(join(cwd, 'committed.txt'), 'utf8') : null,
    hasUntracked: existsSync(join(cwd, 'untracked.txt')),
    hasNodeModules: existsSync(join(cwd, 'node_modules')),
    gitEnvKeys: gitLocKeys.filter(key => key in process.env),
    gitToplevel: gitTop.status === 0 ? gitTop.stdout.trim() : null,
  }) + '\\n')
  if (${JSON.stringify(Boolean(options.lockSnapshotOnCheck))} && stage === 'check') {
    const { mkdirSync: mkd, writeFileSync: wf, chmodSync: chm } = require('node:fs')
    const locked = join(snapRoot, 'locked-child')
    mkd(locked, { recursive: true })
    wf(join(locked, 'keep'), 'locked')
    chm(locked, 0o555)
    chm(snapRoot, 0o555)
  }
  if (${JSON.stringify(options.failStage ?? '')} === stage) {
    const bytes = ${options.largeBytes ?? 0}
    if (bytes > 0) await writeAndDrain(process.stdout, 'L'.repeat(bytes) + '\\n')
    await writeAndDrain(process.stdout, 'STDOUT_TAIL_MARKER_' + stage + '\\n')
    await writeAndDrain(process.stderr, 'STDERR_FAIL_MARKER_' + stage + '\\n')
    process.exit(${options.failCode ?? 3})
  }
  await writeAndDrain(process.stdout, 'fake ' + stage + ' ok\\n')
}

main().catch(err => {
  process.stderr.write(String(err) + '\\n')
  process.exit(1)
})
`, 'utf8')
  chmodSync(target, 0o755)
  return target
}

function runCli(
  args: string[],
  cwd: string,
  options: {
    scriptPath?: string
    pathOverride?: string
    extraEnv?: Record<string, string | undefined>
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const defaultPath = windows
    ? [sharedWslDir!, process.env.PATH ?? ''].filter(Boolean).join(delimiter)
    : [join(root, 'bin'), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)

  const baseEnv = gitEnv()
  for (const key of Object.keys(baseEnv)) {
    if (key.toUpperCase() === 'PATH') delete baseEnv[key]
  }
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    PATH: options.pathOverride ?? defaultPath,
    ...(windows
      ? {
          DSH_FAKE_WSL_NODE: process.execPath,
          DSH_FAKE_WSL_HANDLER: wslHandlerPath,
          DSH_FAKE_WSL_STATE: join(root, 'state'),
        }
      : {}),
    ...options.extraEnv,
  }
  const { promise, resolve: done } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>()
  const child = spawn(process.execPath, [options.scriptPath ?? SCRIPT, ...args], { cwd, env: env as NodeJS.ProcessEnv })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('close', code => done({ code: code ?? 1, stdout, stderr }))
  return promise
}

const diag = (result: { stdout: string; stderr: string }): string => [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')

it('exports the committed snapshot rather than dirty working tree files, writes manifest and logs to a spaced output dir, and cleans up the snapshot', async () => {
  if (!windows) setupLinuxFakePnpm()
  const repoDir = join(root, 'repo with spaces')
  const sha = await createGitRepo(repoDir, 'committed v1\n', 'feature')

  // Dirty working tree, untracked files, and local node_modules must never enter the exported Linux snapshot.
  writeFileSync(join(repoDir, 'plugin', 'committed.txt'), 'dirty working tree\n')
  writeFileSync(join(repoDir, 'plugin', 'untracked.txt'), 'should not exist\n')
  mkdirSync(join(repoDir, 'plugin', 'node_modules'), { recursive: true })
  writeFileSync(join(repoDir, 'plugin', 'node_modules', 'stale.txt'), 'windows modules\n')

  const outputDir = join(root, 'out put', 'verify runs')
  const callerCwd = join(root, 'outside cwd')
  mkdirSync(callerCwd, { recursive: true })

  const result = await runCli(['--repo', repoDir, '--output', outputDir, ...(windows ? ['--distro', 'Ubuntu-Test'] : [])], callerCwd)

  expect(result.code, diag(result)).toBe(0)
  expect(result.stdout).toContain(sha)
  expect(result.stdout).toContain('manifest.json')

  const runs = readdirSync(outputDir)
  expect(runs).toHaveLength(1)
  const runDir = join(outputDir, runs[0]!)
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as VerifyManifest

  expect(manifest).toMatchObject({
    sha,
    ref: 'refs/heads/feature',
    workflow: 'verify-linux',
    status: 'passed',
    exitCode: 0,
    distro: windows ? 'Ubuntu-Test' : null,
    platform: 'linux',
    nodeVersion: expect.stringMatching(/^v\d+/),
    pnpmVersion: '11.7.0',
    snapshotCleaned: true,
  })
  expect(manifest.snapshotDir).toBeTruthy()
  expect(existsSync(manifest.snapshotDir!)).toBe(false)

  for (const stage of [manifest.stages.preflight, manifest.stages.export, manifest.stages.install, manifest.stages.check]) {
    expect(stage.status).toBe('passed')
    expect(stage.exitCode).toBe(0)
    expect(stage.log).toBeTruthy()
    expect(existsSync(stage.log!)).toBe(true)
  }

  const observed = readFileSync(join(root, 'state', 'observed.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as ObservedRun)
  expect(observed.map(entry => entry.stage)).toEqual(['install', 'check'])
  for (const entry of observed) {
    expect(entry.docsContent).toBe('# Root Docs\n')
    expect(entry.committedContent).toBe('committed v1\n')
    expect(entry.hasUntracked).toBe(false)
    expect(entry.hasNodeModules).toBe(false)
  }

  if (windows) {
    const wslCalls = readFileSync(join(root, 'state', 'wsl-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as WslCall)
    expect(wslCalls.length).toBeGreaterThanOrEqual(5)
    for (const call of wslCalls) expect(call).toMatchObject({ distro: 'Ubuntu-Test', execMode: '--exec' })
  }
})

it('defaults to the script worktree HEAD and plugin/.artifacts/verify regardless of caller cwd or git env, and verifies an explicit --ref without overwriting prior evidence', async () => {
  if (!windows) setupLinuxFakePnpm()
  const scriptRepo = join(root, 'script worktree')
  const sha1 = await createGitRepo(scriptRepo, 'commit v1\n', 'feature-worktree')
  mkdirSync(join(scriptRepo, 'plugin', 'scripts'), { recursive: true })
  const copiedScript = join(scriptRepo, 'plugin', 'scripts', 'verify-linux.mjs')
  copyFileSync(SCRIPT, copiedScript)
  writeFileSync(join(scriptRepo, 'plugin', 'committed.txt'), 'commit v2\n')
  const env = gitIdentityEnv()
  await exec('git', ['-C', scriptRepo, 'add', '.'], { env })
  await exec('git', ['-C', scriptRepo, 'commit', '-q', '-m', 'Second commit'], { env })
  const sha2 = (await exec('git', ['-C', scriptRepo, 'rev-parse', 'HEAD'], { env })).stdout.trim()

  // Separate git repository on `main` as caller cwd + inherited GIT_DIR/GIT_WORK_TREE must be ignored.
  const callerRepo = join(root, 'caller main repo')
  const callerSha = await createGitRepo(callerRepo, 'caller main\n', 'main')

  const defaultRun = await runCli([], callerRepo, {
    scriptPath: copiedScript,
    extraEnv: { GIT_DIR: join(callerRepo, '.git'), GIT_WORK_TREE: callerRepo },
  })
  expect(defaultRun.code, diag(defaultRun)).toBe(0)

  const explicitRefRun = await runCli(['--ref', sha1], callerRepo, { scriptPath: copiedScript })
  expect(explicitRefRun.code, diag(explicitRefRun)).toBe(0)

  const verifyRoot = join(scriptRepo, 'plugin', '.artifacts', 'verify')
  const runs = readdirSync(verifyRoot).sort()
  expect(runs).toHaveLength(2)

  const manifests = runs.map(dir => JSON.parse(readFileSync(join(verifyRoot, dir, 'manifest.json'), 'utf8')) as VerifyManifest)
  const headManifest = manifests.find(item => item.sha === sha2)
  const refManifest = manifests.find(item => item.sha === sha1)
  expect(headManifest).toMatchObject({ sha: sha2, ref: 'refs/heads/feature-worktree', status: 'passed' })
  expect(refManifest).toMatchObject({ sha: sha1, ref: sha1, status: 'passed' })
  expect(manifests.every(item => item.sha !== callerSha)).toBe(true)

  const observed = readFileSync(join(root, 'state', 'observed.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as ObservedRun)
  expect(observed.map(entry => entry.gitEnvKeys)).toEqual([[], [], [], []])
  expect(observed.map(entry => entry.gitToplevel)).toEqual([null, null, null, null])
  expect(observed.filter(item => item.stage === 'check').map(item => item.committedContent)).toEqual(['commit v2\n', 'commit v1\n'])
})

it('stops after a failing stage, preserves full logs beyond 1MB without truncation, cleans up the snapshot, and keeps separate run evidence', async () => {
  const largeBytes = 1_500_000
  if (!windows) setupLinuxFakePnpm({ failStage: 'check', failCode: 4, largeBytes })
  const repoDir = join(root, 'failing repo')
  const sha = await createGitRepo(repoDir, 'committed v1\n')
  const outputDir = join(root, 'verify logs')

  const failedCheck = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    extraEnv: windows
      ? { DSH_FAKE_WSL_FAIL_STAGE: 'check', DSH_FAKE_WSL_FAIL_CODE: '4', DSH_FAKE_WSL_LARGE_BYTES: String(largeBytes) }
      : undefined,
  })
  expect(failedCheck.code, diag(failedCheck)).toBe(4)
  // Full large log must live in the artifact file rather than flooding stdout.
  expect(failedCheck.stdout.length).toBeLessThan(10_000)

  const firstRunName = readdirSync(outputDir)[0]!
  const firstManifest = JSON.parse(readFileSync(join(outputDir, firstRunName, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(firstManifest).toMatchObject({
    sha,
    status: 'failed',
    exitCode: 4,
    snapshotCleaned: true,
  })
  expect(existsSync(firstManifest.snapshotDir!)).toBe(false)
  expect(firstManifest.stages.install.status).toBe('passed')
  expect(firstManifest.stages.check.status).toBe('failed')
  expect(firstManifest.stages.check.exitCode).toBe(4)

  const checkLogPath = firstManifest.stages.check.log!
  expect(statSync(checkLogPath).size).toBeGreaterThan(largeBytes)
  const checkLog = readFileSync(checkLogPath, 'utf8')
  expect(checkLog).toContain('STDOUT_TAIL_MARKER_check')
  expect(checkLog).toContain('STDERR_FAIL_MARKER_check')
  // An install failure stops before check and preserves the earlier run directory untouched.
  if (!windows) setupLinuxFakePnpm({ failStage: 'install', failCode: 2 })
  const failedInstall = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    extraEnv: windows ? { DSH_FAKE_WSL_FAIL_STAGE: 'install', DSH_FAKE_WSL_FAIL_CODE: '2' } : undefined,
  })
  expect(failedInstall.code, diag(failedInstall)).toBe(2)

  const allRuns = readdirSync(outputDir)
  expect(allRuns).toHaveLength(2)
  const secondRunName = allRuns.find(name => name !== firstRunName)!
  const secondManifest = JSON.parse(readFileSync(join(outputDir, secondRunName, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(secondManifest.stages.install).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(secondManifest.stages.check).toMatchObject({ status: 'skipped', exitCode: null, log: null })
  expect(existsSync(join(outputDir, firstRunName, 'manifest.json'))).toBe(true)
})

it('fails preflight explicitly on missing tools or Windows tool contamination, skips later stages, and accepts explicit --pnpm', async () => {
  const repoDir = join(root, 'preflight repo')
  const sha = await createGitRepo(repoDir, 'committed v1\n')
  const outputDir = join(root, 'preflight out')

  if (windows) {
    // Missing wsl.exe on PATH (keep git and node, omit System32 and fake wsl) must fail preflight explicitly.
    const gitExeDir = (process.env.PATH ?? '').split(delimiter).find(entry => entry && existsSync(join(entry, 'git.exe')))
    const missingWsl = await runCli(['--repo', repoDir, '--output', outputDir], root, {
      pathOverride: [dirname(process.execPath), ...(gitExeDir ? [gitExeDir] : [])].join(delimiter),
    })
    expect(missingWsl.code, diag(missingWsl)).not.toBe(0)
    const missingDir = readdirSync(outputDir)[0]!
    const missingManifest = JSON.parse(readFileSync(join(outputDir, missingDir, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(missingManifest).toMatchObject({ sha, status: 'failed' })
    expect(missingManifest.stages.preflight.status).toBe('failed')
    expect(missingManifest.stages.export.status).toBe('skipped')
    expect(readFileSync(missingManifest.stages.preflight.log!, 'utf8')).toContain('wsl.exe was not found')

    // Simulated Windows contamination / preflight rejection inside WSL must fail before export.
    const contaminated = await runCli(['--repo', repoDir, '--output', outputDir], root, {
      extraEnv: {
        DSH_FAKE_WSL_PREFLIGHT_ERROR: 'Refusing Windows pnpm on PATH: /mnt/c/pnpm/pnpm',
        DSH_FAKE_WSL_PREFLIGHT_CODE: '5',
      },
    })
    expect(contaminated.code, diag(contaminated)).toBe(5)
    const contaminatedDir = readdirSync(outputDir).find(name => name !== missingDir)!
    const contaminatedManifest = JSON.parse(readFileSync(join(outputDir, contaminatedDir, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(contaminatedManifest.stages.preflight).toMatchObject({ status: 'failed', exitCode: 5 })
    expect(contaminatedManifest.stages.export.status).toBe('skipped')
    expect(readFileSync(contaminatedManifest.stages.preflight.log!, 'utf8')).toContain('Refusing Windows pnpm on PATH')

    // Explicit --pnpm passes Linux path into preflight and succeeds.
    const explicit = await runCli(['--repo', repoDir, '--output', outputDir, '--pnpm', '/opt/native/pnpm.cjs'], root)
    expect(explicit.code, diag(explicit)).toBe(0)
    const explicitDir = readdirSync(outputDir).find(name => name !== missingDir && name !== contaminatedDir)!
    const explicitManifest = JSON.parse(readFileSync(join(outputDir, explicitDir, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(explicitManifest).toMatchObject({ status: 'passed', pnpmRunner: 'explicit', pnpmVersion: '11.7.0' })
    return
  }

  // Linux: Windows pnpm.exe first on PATH must fail preflight explicitly rather than falling back or succeeding.
  const winPnpmDir = join(root, 'winbin')
  setupLinuxFakePnpm({ writeFile: join(winPnpmDir, 'pnpm.exe') })
  const winContaminated = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    pathOverride: [winPnpmDir, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  })
  expect(winContaminated.code, diag(winContaminated)).not.toBe(0)
  const failedDir = readdirSync(outputDir)[0]!
  const failedManifest = JSON.parse(readFileSync(join(outputDir, failedDir, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(failedManifest.stages.preflight.status).toBe('failed')
  expect(failedManifest.stages.export.status).toBe('skipped')
  expect(readFileSync(failedManifest.stages.preflight.log!, 'utf8')).toContain('Refusing Windows pnpm on PATH')

  // Linux: explicit --pnpm (.cjs in a spaced path executed via real Linux node through generated .verify-bin/pnpm)
  // must run install, check, and nested `pnpm` subshell commands without breaking on spaces or hitting pnpm.exe.
  const nestedLog = join(root, 'state', 'nested.jsonl')
  const explicitCjs = join(root, 'pnpm cache', '11.7.0', 'bin', 'pnpm.cjs')
  mkdirSync(dirname(explicitCjs), { recursive: true })
  writeFileSync(explicitCjs, `
const { spawnSync } = require('node:child_process')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('11.7.0\\n')
  process.exit(0)
}
if (args[0] === 'nested-subcheck') {
  appendFileSync(${JSON.stringify(nestedLog)}, JSON.stringify(args) + '\\n')
  process.exit(0)
}
const stage = args.includes('install') ? 'install' : args.includes('check') ? 'check' : 'other'
const cwd = process.cwd()
const snapRoot = dirname(cwd)
appendFileSync(${JSON.stringify(join(root, 'state', 'observed.jsonl'))}, JSON.stringify({
  stage,
  cwd,
  argv: args,
  docsContent: existsSync(join(snapRoot, 'DOCS.md')) ? readFileSync(join(snapRoot, 'DOCS.md'), 'utf8') : null,
  committedContent: existsSync(join(cwd, 'committed.txt')) ? readFileSync(join(cwd, 'committed.txt'), 'utf8') : null,
  hasUntracked: existsSync(join(cwd, 'untracked.txt')),
  hasNodeModules: existsSync(join(cwd, 'node_modules')),
}) + '\\n')
if (stage === 'check') {
  const sub = spawnSync('/bin/sh', ['-c', 'pnpm nested-subcheck --arg "with space"'], { stdio: 'inherit' })
  process.exit(sub.status ?? 1)
}
`, 'utf8')
  const explicitOk = await runCli(['--repo', repoDir, '--output', outputDir, '--pnpm', explicitCjs], root, {
    pathOverride: [winPnpmDir, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  })
  expect(explicitOk.code, diag(explicitOk)).toBe(0)
  const okDir = readdirSync(outputDir).find(name => name !== failedDir)!
  const okManifest = JSON.parse(readFileSync(join(outputDir, okDir, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(okManifest).toMatchObject({ status: 'passed', pnpmRunner: 'explicit', pnpmVersion: '11.7.0' })
  const nestedCalls = readFileSync(nestedLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(nestedCalls).toEqual([['nested-subcheck', '--arg', 'with space']])

  // Linux: native corepack fallback also generates a working .verify-bin/pnpm wrapper.
  const corepackDir = join(root, 'corepack bin')
  mkdirSync(corepackDir, { recursive: true })
  const corepackBin = join(corepackDir, 'corepack')
  writeFileSync(corepackBin, `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'pnpm' && args[1] === '--version') {
  process.stdout.write('11.7.0\\n')
  process.exit(0)
}
if (args[0] === 'pnpm') {
  appendFileSync(${JSON.stringify(nestedLog)}, JSON.stringify(['corepack', ...args.slice(1)]) + '\\n')
  process.exit(0)
}
process.exit(1)
`, 'utf8')
  chmodSync(corepackBin, 0o755)
  const corepackOk = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    pathOverride: [corepackDir, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  })
  expect(corepackOk.code, diag(corepackOk)).toBe(0)
  const corepackManifestDir = readdirSync(outputDir).find(name => name !== failedDir && name !== okDir)!
  const corepackManifest = JSON.parse(readFileSync(join(outputDir, corepackManifestDir, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(corepackManifest).toMatchObject({ status: 'passed', pnpmRunner: 'corepack', pnpmVersion: '11.7.0' })
  const allNested = readFileSync(nestedLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(allNested.slice(1)).toEqual([
    ['corepack', 'install', '--frozen-lockfile'],
    ['corepack', 'check'],
  ])
})

it('marks the run failed with non-zero exit when snapshot cleanup fails, while preserving any earlier stage failure code and error', async () => {
  const repoDir = join(root, 'cleanup repo')
  await createGitRepo(repoDir, 'committed v1\n')
  const outputDir = join(root, 'cleanup out')
  const linuxTmp = join(root, 'linux-tmp')
  mkdirSync(linuxTmp, { recursive: true })

  // 1) All stages succeed, only snapshot cleanup fails: must mark failed and exit non-zero with traceable path/error.
  if (!windows) setupLinuxFakePnpm({ lockSnapshotOnCheck: true })
  const onlyCleanupFails = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    extraEnv: windows
      ? { DSH_FAKE_WSL_FAIL_CLEANUP: '1', DSH_FAKE_WSL_CLEANUP_CODE: '7' }
      : { TMPDIR: linuxTmp },
  })
  const run1Name = readdirSync(outputDir)[0]!
  const manifest1 = JSON.parse(readFileSync(join(outputDir, run1Name, 'manifest.json'), 'utf8')) as VerifyManifest
  try {
    expect(onlyCleanupFails.code, diag(onlyCleanupFails)).toBe(windows ? 7 : 1)
    expect(manifest1).toMatchObject({
      status: 'failed',
      exitCode: windows ? 7 : 1,
      snapshotCleaned: false,
    })
    expect(manifest1.stages.check.status).toBe('passed')
    expect(manifest1.snapshotDir).toBeTruthy()
    expect(existsSync(manifest1.snapshotDir!)).toBe(true)
    expect(manifest1.cleanupError).toContain(manifest1.snapshotDir!)
    expect(manifest1.error).toContain(manifest1.snapshotDir!)
    expect(onlyCleanupFails.stdout).toContain('FAILED')
    expect(onlyCleanupFails.stdout).toContain(manifest1.snapshotDir!)
  } finally {
    if (!windows && manifest1.snapshotDir && existsSync(manifest1.snapshotDir)) {
      chmodSync(manifest1.snapshotDir, 0o755)
      const locked = join(manifest1.snapshotDir, 'locked-child')
      if (existsSync(locked)) chmodSync(locked, 0o755)
    }
  }

  // 2) An earlier stage fails AND cleanup fails: prior exitCode and error must be preserved alongside cleanupError.
  if (!windows) setupLinuxFakePnpm({ failStage: 'check', failCode: 4, lockSnapshotOnCheck: true })
  const bothFail = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    extraEnv: windows
      ? { DSH_FAKE_WSL_FAIL_STAGE: 'check', DSH_FAKE_WSL_FAIL_CODE: '4', DSH_FAKE_WSL_FAIL_CLEANUP: '1', DSH_FAKE_WSL_CLEANUP_CODE: '7' }
      : { TMPDIR: linuxTmp },
  })
  const run2Name = readdirSync(outputDir).find(name => name !== run1Name)!
  const manifest2 = JSON.parse(readFileSync(join(outputDir, run2Name, 'manifest.json'), 'utf8')) as VerifyManifest
  try {
    expect(bothFail.code, diag(bothFail)).toBe(4)
    expect(manifest2).toMatchObject({
      status: 'failed',
      exitCode: 4,
      snapshotCleaned: false,
    })
    expect(manifest2.stages.check).toMatchObject({ status: 'failed', exitCode: 4 })
    expect(manifest2.error).toContain('STDERR_FAIL_MARKER_check')
    expect(manifest2.cleanupError).toContain(manifest2.snapshotDir!)
    expect(bothFail.stdout).toContain('cleanupError:')
  } finally {
    if (!windows && manifest2.snapshotDir && existsSync(manifest2.snapshotDir)) {
      chmodSync(manifest2.snapshotDir, 0o755)
      const locked = join(manifest2.snapshotDir, 'locked-child')
      if (existsSync(locked)) chmodSync(locked, 0o755)
    }
  }
})

it('requires an exact packageManager pnpm version match and isolates child install/check processes from inherited GIT_LOCATION variables', async () => {
  const repoDir = join(root, 'strict env repo')
  await createGitRepo(repoDir, 'committed v1\n')
  const callerRepo = join(root, 'unrelated git repo')
  await createGitRepo(callerRepo, 'unrelated\n')
  const outputDir = join(root, 'strict env out')
  const inheritedGitEnv = {
    GIT_DIR: join(callerRepo, '.git'),
    GIT_WORK_TREE: callerRepo,
    GIT_INDEX_FILE: join(callerRepo, '.git', 'index'),
    GIT_COMMON_DIR: join(callerRepo, '.git'),
  }

  if (!windows) {
    // Higher minor version (11.8.0) must be rejected when packageManager pins pnpm@11.7.0.
    setupLinuxFakePnpm({ version: '11.8.0' })
    const mismatched = await runCli(['--repo', repoDir, '--output', outputDir], root, { extraEnv: inheritedGitEnv })
    expect(mismatched.code, diag(mismatched)).not.toBe(0)
    const mismatchRun = readdirSync(outputDir)[0]!
    const mismatchManifest = JSON.parse(readFileSync(join(outputDir, mismatchRun, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(mismatchManifest.stages.preflight.status).toBe('failed')
    expect(mismatchManifest.stages.export.status).toBe('skipped')
    expect(readFileSync(mismatchManifest.stages.preflight.log!, 'utf8')).toContain('does not match exact packageManager')

    // Exact 11.7.0 passes and child install/check processes inherit no GIT_LOCATION variables or caller git repo.
    setupLinuxFakePnpm({ version: '11.7.0' })
    const isolated = await runCli(['--repo', repoDir, '--output', outputDir], root, { extraEnv: inheritedGitEnv })
    expect(isolated.code, diag(isolated)).toBe(0)
    const observed = readFileSync(join(root, 'state', 'observed.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as ObservedRun)
    expect(observed).toHaveLength(2)
    for (const entry of observed) {
      expect(entry.gitEnvKeys).toEqual([])
      expect(entry.gitToplevel).toBeNull()
    }
    return
  }

  const isolatedWin = await runCli(['--repo', repoDir, '--output', outputDir], root, { extraEnv: inheritedGitEnv })
  expect(isolatedWin.code, diag(isolatedWin)).toBe(0)
  const wslCalls = readFileSync(join(root, 'state', 'wsl-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as WslCall)
  expect(wslCalls.length).toBeGreaterThanOrEqual(5)
  for (const call of wslCalls) expect(call.hostGitEnvKeys).toEqual([])
  const runnerCalls = wslCalls.filter(call => call.unsetVars.length > 0)
  expect(runnerCalls).toHaveLength(2)
  for (const call of runnerCalls) expect(call.unsetVars).toEqual([...GIT_LOCATION])
})

it('fails preflight clearly when structured __PREFLIGHT_JSON__ metadata or required fields are missing instead of falling back, and still cleans up the owned snapshot directory', async () => {
  const repoDir = join(root, 'meta fail repo')
  await createGitRepo(repoDir, 'committed v1\n')
  const outputDir = join(root, 'meta fail out')
  const linuxTmp = join(root, 'linux-tmp')
  mkdirSync(linuxTmp, { recursive: true })

  if (windows) {
    // Bare JSON without __PREFLIGHT_JSON__: prefix must be rejected, and the pre-created snapshot dir cleaned up.
    const bareJson = await runCli(['--repo', repoDir, '--output', outputDir], root, {
      extraEnv: {
        TMPDIR: linuxTmp,
        DSH_FAKE_WSL_PREFLIGHT_STDOUT: JSON.stringify({
          snapshotDir: join(root, 'never-created'),
          platform: 'linux',
          nodeVersion: 'v22.22.1',
          pnpmVersion: '11.7.0',
          pnpmRunner: 'corepack',
          cleanPath: '/usr/bin:/bin',
          pnpmBinPath: '/usr/bin/corepack',
        }),
      },
    })
    expect(bareJson.code, diag(bareJson)).toBe(1)
    const run1 = readdirSync(outputDir)[0]!
    const manifest1 = JSON.parse(readFileSync(join(outputDir, run1, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(manifest1).toMatchObject({ status: 'failed', snapshotCleaned: true })
    expect(manifest1.error).toContain('__PREFLIGHT_JSON__')
    expect(manifest1.snapshotDir).toBeTruthy()
    expect(manifest1.snapshotDir!.startsWith(linuxTmp)).toBe(true)
    expect(basename(manifest1.snapshotDir!)).toMatch(/^linux snap /)
    expect(existsSync(manifest1.snapshotDir!)).toBe(false)
    expect(readdirSync(linuxTmp)).toEqual([])
    expect(manifest1.stages.preflight.status).toBe('failed')
    expect(manifest1.stages.export.status).toBe('skipped')
    expect(readFileSync(manifest1.stages.preflight.log!, 'utf8')).toContain('__PREFLIGHT_JSON__')

    // Structured output missing required pnpmBinPath must fail at preflight and still clean up the owned snapshot dir.
    const missingField = await runCli(['--repo', repoDir, '--output', outputDir], root, {
      extraEnv: {
        TMPDIR: linuxTmp,
        DSH_FAKE_WSL_PREFLIGHT_STDOUT: '__PREFLIGHT_JSON__:' + JSON.stringify({
          snapshotDir: join(root, 'never-created-2'),
          platform: 'linux',
          nodeVersion: 'v22.22.1',
          pnpmVersion: '11.7.0',
          pnpmRunner: 'corepack',
          cleanPath: '/usr/bin:/bin',
        }),
      },
    })
    expect(missingField.code, diag(missingField)).toBe(1)
    const run2 = readdirSync(outputDir).find(name => name !== run1)!
    const manifest2 = JSON.parse(readFileSync(join(outputDir, run2, 'manifest.json'), 'utf8')) as VerifyManifest
    expect(manifest2).toMatchObject({ status: 'failed', snapshotCleaned: true })
    expect(manifest2.error).toContain('pnpmBinPath')
    expect(manifest2.snapshotDir).toBeTruthy()
    expect(manifest2.snapshotDir!.startsWith(linuxTmp)).toBe(true)
    expect(basename(manifest2.snapshotDir!)).toMatch(/^linux snap /)
    expect(existsSync(manifest2.snapshotDir!)).toBe(false)
    expect(readdirSync(linuxTmp)).toEqual([])
    expect(manifest2.stages.preflight.status).toBe('failed')
    expect(manifest2.stages.export.status).toBe('skipped')
    expect(readFileSync(manifest2.stages.preflight.log!, 'utf8')).toContain('pnpmBinPath')
    const wslCalls = readFileSync(join(root, 'state', 'wsl-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as WslCall)
    expect(wslCalls.filter(call => call.argv[0] === 'rm' && call.argv.at(-1) === manifest1.snapshotDir)).toHaveLength(1)
    expect(wslCalls.filter(call => call.argv[0] === 'rm' && call.argv.at(-1) === manifest2.snapshotDir)).toHaveLength(1)
    return
  }

  // Linux: wrap real node to corrupt __PREFLIGHT_JSON__ emission inside TMPDIR and prove no snapshot directory leaks.
  setupLinuxFakePnpm()
  const badNodeDir = join(root, 'bad-node-bin')
  mkdirSync(badNodeDir, { recursive: true })
  const badNode = join(badNodeDir, 'node')
  writeFileSync(badNode, `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const res = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { encoding: 'utf8' })
if (res.stderr) process.stderr.write(res.stderr)
if (res.stdout && res.stdout.includes('__PREFLIGHT_JSON__:')) {
  const mode = process.env.DSH_BAD_NODE_MODE || 'strip-prefix'
  if (mode === 'drop-field') {
    const prefix = '__PREFLIGHT_JSON__:'
    const idx = res.stdout.indexOf(prefix)
    const head = res.stdout.slice(0, idx)
    const payload = JSON.parse(res.stdout.slice(idx + prefix.length).trim())
    delete payload.pnpmBinPath
    process.stdout.write(head + prefix + JSON.stringify(payload) + '\\n')
  } else {
    process.stdout.write(res.stdout.replace('__PREFLIGHT_JSON__:', ''))
  }
} else if (res.stdout) {
  process.stdout.write(res.stdout)
}
process.exit(res.status ?? 1)
`, 'utf8')
  chmodSync(badNode, 0o755)

  const pathWithBadNode = [badNodeDir, join(root, 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
  const badPrefix = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    pathOverride: pathWithBadNode,
    extraEnv: { TMPDIR: linuxTmp, DSH_BAD_NODE_MODE: 'strip-prefix' },
  })
  expect(badPrefix.code, diag(badPrefix)).toBe(1)
  const failedDir1 = readdirSync(outputDir)[0]!
  const manifest1 = JSON.parse(readFileSync(join(outputDir, failedDir1, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(manifest1).toMatchObject({ status: 'failed', snapshotCleaned: true })
  expect(manifest1.error).toContain('__PREFLIGHT_JSON__')
  expect(manifest1.snapshotDir).toBeTruthy()
  expect(manifest1.snapshotDir!.startsWith(linuxTmp)).toBe(true)
  expect(basename(manifest1.snapshotDir!)).toMatch(/^dsh-superagent-verify\./)
  expect(existsSync(manifest1.snapshotDir!)).toBe(false)
  expect(readdirSync(linuxTmp)).toEqual([])
  expect(manifest1.stages.preflight.status).toBe('failed')
  expect(manifest1.stages.export.status).toBe('skipped')
  expect(readFileSync(manifest1.stages.preflight.log!, 'utf8')).toContain('__PREFLIGHT_JSON__')

  const missingField = await runCli(['--repo', repoDir, '--output', outputDir], root, {
    pathOverride: pathWithBadNode,
    extraEnv: { TMPDIR: linuxTmp, DSH_BAD_NODE_MODE: 'drop-field' },
  })
  expect(missingField.code, diag(missingField)).toBe(1)
  const failedDir2 = readdirSync(outputDir).find(name => name !== failedDir1)!
  const manifest2 = JSON.parse(readFileSync(join(outputDir, failedDir2, 'manifest.json'), 'utf8')) as VerifyManifest
  expect(manifest2).toMatchObject({ status: 'failed', snapshotCleaned: true })
  expect(manifest2.error).toContain('pnpmBinPath')
  expect(manifest2.snapshotDir).toBeTruthy()
  expect(manifest2.snapshotDir!.startsWith(linuxTmp)).toBe(true)
  expect(basename(manifest2.snapshotDir!)).toMatch(/^dsh-superagent-verify\./)
  expect(existsSync(manifest2.snapshotDir!)).toBe(false)
  expect(readdirSync(linuxTmp)).toEqual([])
  expect(manifest2.stages.preflight.status).toBe('failed')
  expect(manifest2.stages.export.status).toBe('skipped')
  expect(readFileSync(manifest2.stages.preflight.log!, 'utf8')).toContain('pnpmBinPath')
})
