#!/usr/bin/env node
/** Run the native Windows check against a pinned Git commit, not a developer checkout. */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const help = `Usage: node plugin/scripts/verify-windows.mjs [--ref REF] [--output DIR] [--repo DIR]

  --ref REF       Git ref or commit to verify (default: HEAD)
  --output DIR    Evidence directory (default: <repo>/plugin/.artifacts/verify)
  --repo DIR      Git worktree root (default: script worktree root)
  -h, --help      Show this help message
`

function parseArgs(argv) {
  const options = { ref: 'HEAD', repo: scriptRepo, output: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2)
    if ((flag === '-h' || flag === '--help') && inline === undefined) {
      options.help = true
      continue
    }
    if (!['--ref', '--repo', '--output'].includes(flag)) throw new Error(`Unknown option: ${argv[i]}`)
    const value = inline ?? argv[++i]
    if (!value || (inline === undefined && (value.startsWith('--') || value === '-h'))) throw new Error(`Missing value for ${flag}`)
    options[flag.slice(2)] = flag === '--ref' ? value : resolve(value)
  }
  options.output ??= join(options.repo, 'plugin', '.artifacts', 'verify')
  return options
}

const envValue = name => Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1]
const systemBinary = name => join(envValue('SYSTEMROOT') || 'C:\\Windows', 'System32', name)
const isWithin = (root, file) => {
  const rel = relative(root, file)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function nativeEnv(repo) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|NPM_|PNPM_CONFIG_|COREPACK_ROOT$|INIT_CWD$|NODE(?:_OPTIONS|_PATH)?$|PWD$|OLDPWD$|PATH$)/i.test(key)))
  const roots = [realpathSync(repo), realpathSync(scriptRepo)]
  const path = (envValue('PATH') ?? '').split(delimiter).flatMap(raw => {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!isAbsolute(entry)) return []
    try {
      const actual = realpathSync(entry)
      return !statSync(actual).isDirectory() || roots.some(root => isWithin(root, actual)) ? [] : [actual]
    } catch {
      return [] // A missing PATH entry cannot provide a native tool.
    }
  })
  env.PATH = [...new Set(path)].join(delimiter)
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return env
}

function findNative(env, names) {
  for (const dir of env.PATH.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
  }
  throw new Error(`${names[0]} was not found on the native Windows PATH`)
}

function pnpmCommand(pnpm, args, env) {
  const ext = extname(pnpm).toLowerCase()
  if (ext === '.exe') return { command: pnpm, args, env }
  if (ext !== '.cmd' && ext !== '.bat') return { command: process.execPath, args: [pnpm, ...args], env }
  // Only fixed verifier arguments enter the command string; cmd expands the quoted path once.
  return {
    command: systemBinary('cmd.exe'),
    args: ['/d', '/e:on', '/v:off', '/s', '/c', `""%_DSH_VERIFY_WINDOWS_PNPM%" ${args.join(' ')}"`],
    env: { ...env, _DSH_VERIFY_WINDOWS_PNPM: pnpm },
    windowsVerbatimArguments: true,
  }
}

async function verify(options) {
  const startedAt = new Date().toISOString()
  mkdirSync(options.output, { recursive: true })
  const runDir = mkdtempSync(join(options.output, `${startedAt.replace(/[:.]/g, '-')}-windows-`))
  const manifestPath = join(runDir, 'manifest.json')
  const stageNames = ['preflight', 'export', 'install', 'check']
  const manifest = {
    sha: null,
    ref: options.ref,
    requestedRef: options.ref,
    repo: options.repo,
    workflow: 'verify-windows',
    hostPlatform: process.platform,
    platform: null,
    nodeVersion: process.version,
    pnpmVersion: null,
    pnpmRunner: null,
    status: 'running',
    exitCode: null,
    startedAt,
    finishedAt: null,
    runDir,
    snapshotDir: null,
    snapshotCleaned: true,
    cleanupError: null,
    stages: Object.fromEntries(stageNames.map(name => [name, { status: 'skipped', exitCode: null, log: null }])),
    error: null,
  }
  function saveManifest() {
    const pending = `${manifestPath}.tmp`
    writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    renameSync(pending, manifestPath)
  }

  let child = null
  let interrupted = null
  let interruptError = null
  const signals = { SIGINT: 130, SIGBREAK: 130, SIGTERM: 143 }
  function onSignal(signal) {
    if (interrupted) return
    interrupted = signal
    if (!child?.pid) return
    // The native pnpm runner may have started cmd, Node, and dependency scripts.
    const kill = spawnSync(systemBinary('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 5000, windowsHide: true,
    })
    if (kill.status !== 0 && child.kill()) interruptError = 'Could not terminate the entire child process tree'
  }
  function throwIfInterrupted() {
    if (interrupted) throw Object.assign(new Error(`Interrupted by ${interrupted}${interruptError ? `: ${interruptError}` : ''}`), {
      exitCode: signals[interrupted],
    })
  }

  function run(spec, log, { cwd, capture = false } = {}) {
    throwIfInterrupted()
    return new Promise((done, fail) => {
      const proc = spawn(spec.command, spec.args, {
        cwd, env: spec.env, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['ignore', capture ? 'pipe' : log, log],
      })
      child = proc
      const chunks = []
      proc.stdout?.on('data', chunk => chunks.push(chunk))
      proc.once('error', fail)
      proc.once('close', (code, signal) => {
        if (child === proc) child = null
        const stdout = Buffer.concat(chunks).toString('utf8')
        try {
          throwIfInterrupted()
          if (code !== 0) {
            throw Object.assign(new Error(`${spec.command} ${spec.args[0]} failed (${signal ?? `exit ${code}`})`), {
              exitCode: code || 1,
            })
          }
          done(stdout)
        } catch (error) {
          fail(error)
        }
      })
    })
  }

  async function stage(name, action) {
    throwIfInterrupted()
    const info = manifest.stages[name]
    info.log = join(runDir, `0${stageNames.indexOf(name) + 1}-${name}.log`)
    const log = openSync(info.log, 'wx')
    try {
      info.status = 'running'
      saveManifest()
      await action(log)
      throwIfInterrupted()
      info.status = 'passed'
      info.exitCode = 0
    } catch (error) {
      info.status = 'failed'
      info.exitCode = error.exitCode || 1
      writeSync(log, `${error.message}\n`)
      throw error
    } finally {
      closeSync(log)
      saveManifest()
    }
  }

  let scratch = null
  let snapshot = null
  let env, gitEnv, git, pnpm, objectDir
  saveManifest()
  console.log(`verify-windows evidence: ${runDir}`)
  for (const signal of Object.keys(signals)) process.on(signal, onSignal)
  try {
    await stage('preflight', async log => {
      if (process.platform !== 'win32') throw new Error('verify-windows must run on native Windows; use verify-linux from Linux or WSL')
      manifest.platform = process.platform
      env = nativeEnv(options.repo)
      gitEnv = {
        ...env,
        GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
      }
      git = findNative(env, ['git.exe'])
      const source = args => run({ command: git, args: ['-C', options.repo, ...args], env: gitEnv }, log, { capture: true })
      const root = (await source(['rev-parse', '--show-toplevel'])).trim()
      if (relative(realpathSync(options.repo), realpathSync(root))) throw new Error('--repo must be the worktree root')
      try {
        manifest.sha = (await source(['rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`])).trim()
      } catch (error) {
        throwIfInterrupted()
        throw Object.assign(new Error(`Cannot resolve ref ${JSON.stringify(options.ref)} to a commit: ${error.message}`), { exitCode: error.exitCode })
      }
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sha)) throw new Error(`Unexpected Git commit ID: ${manifest.sha}`)
      saveManifest()
      writeSync(log, `Commit ${manifest.sha} (${options.ref})\nNode ${process.version} (${process.execPath})\n`)
      const pkg = JSON.parse(await source(['cat-file', 'blob', `${manifest.sha}:plugin/package.json`]))
      objectDir = (await source(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim()
      pnpm = findNative(env, ['pnpm.exe', 'pnpm.cmd', 'pnpm.bat', 'pnpm.cjs', 'pnpm.mjs', 'pnpm.js'])
      // Resolve pnpm in PATH order, then pin Node for its wrappers and lifecycle scripts.
      env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter)
      manifest.pnpmRunner = pnpm
      const temp = realpathSync(tmpdir())
      if (!/^[a-z]:\\/i.test(temp) || isWithin(realpathSync(options.repo), temp) || isWithin(realpathSync(scriptRepo), temp)) {
        throw new Error('Windows TEMP must be a drive-letter path outside the source checkouts')
      }
      scratch = mkdtempSync(join(temp, 'dsh-superagent-verify-windows-'))
      snapshot = join(scratch, 'snapshot')
      manifest.snapshotDir = snapshot
      manifest.snapshotCleaned = false
      // Prevent Git discovery above the snapshot, even if TEMP is under another repo.
      Object.assign(env, { GIT_CEILING_DIRECTORIES: scratch, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1' })
      saveManifest()
      const probe = join(scratch, 'probe')
      mkdirSync(probe)
      writeFileSync(join(probe, 'package.json'), JSON.stringify({ packageManager: pkg.packageManager }))
      const reported = await run(pnpmCommand(pnpm, ['--version'], env), log, { cwd: probe, capture: true })
      writeSync(log, `pnpm --version (${pnpm}): ${reported.trim()}\n`)
      const version = reported.trim().replace(/^v/, '')
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid pnpm --version output')
      manifest.pnpmVersion = version
      if (pkg.packageManager && pkg.packageManager.split('+', 1)[0] !== `pnpm@${version}`) {
        throw new Error(`pnpm ${version} does not match committed packageManager (${pkg.packageManager})`)
      }
    })

    await stage('export', async log => {
      // Read the source object store through fresh Git metadata: no source .git/info/attributes,
      // worktree, index, or Git config participates in the archive.
      const gitDir = join(scratch, 'objects.git')
      const archive = join(scratch, 'snapshot.tar')
      const objectFormat = manifest.sha.length === 64 ? 'sha256' : 'sha1'
      await run({ command: git, args: ['init', '--bare', '--template=', `--object-format=${objectFormat}`, gitDir], env: gitEnv }, log, { cwd: scratch })
      writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${objectDir}\n`)
      // Export every tracked path at its committed bytes, including offline test fixtures.
      mkdirSync(join(gitDir, 'info'), { recursive: true })
      writeFileSync(join(gitDir, 'info', 'attributes'), '* -export-ignore -export-subst\n')
      await run({ command: git, args: ['--git-dir', gitDir, 'archive', '--format=tar', '--output', archive, manifest.sha], env: gitEnv }, log, { cwd: scratch })
      mkdirSync(snapshot)
      await run({ command: systemBinary('tar.exe'), args: ['-xf', archive], env }, log, { cwd: snapshot })
      writeSync(log, `Exported ${manifest.sha} to ${snapshot}\n`)
    })

    const pluginDir = join(snapshot, 'plugin')
    for (const [name, args] of [['install', ['install', '--frozen-lockfile']], ['check', ['check']]]) {
      await stage(name, async log => {
        if (name === 'install' && !statSync(join(pluginDir, 'pnpm-lock.yaml'), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Commit ${manifest.sha} does not contain plugin/pnpm-lock.yaml`)
        }
        writeSync(log, `pnpm ${args.join(' ')}\n`)
        await run(pnpmCommand(pnpm, args, env), log, { cwd: pluginDir })
      })
    }
  } catch (error) {
    manifest.error = error.message
    manifest.exitCode = error.exitCode || 1
  } finally {
    try {
      if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
      manifest.snapshotCleaned = true
    } catch (error) {
      manifest.cleanupError = `Could not remove ${scratch}: ${error.message}`
      manifest.error ??= manifest.cleanupError
      manifest.exitCode ??= 1
    }
    if (interrupted) {
      manifest.error ??= `Interrupted by ${interrupted}`
      manifest.exitCode = signals[interrupted]
    }
    manifest.exitCode ??= 0
    manifest.status = manifest.exitCode === 0 ? 'passed' : 'failed'
    manifest.finishedAt = new Date().toISOString()
    saveManifest()
    for (const signal of Object.keys(signals)) process.removeListener(signal, onSignal)
  }
  console.log(`verify-windows: ${manifest.status.toUpperCase()} (exit ${manifest.exitCode})${manifest.sha ? ` ${manifest.sha}` : ''}\nmanifest: ${manifestPath}`)
  if (manifest.error) console.error(manifest.error)
  if (manifest.cleanupError && manifest.cleanupError !== manifest.error) console.error(manifest.cleanupError)
  return manifest.exitCode
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
if (options?.help) {
  process.stdout.write(help)
} else if (options) {
  try {
    process.exitCode = await verify(options)
  } catch (error) {
    console.error(`verify-windows: ${error.message}`)
    process.exitCode = 1
  }
}
