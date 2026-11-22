#!/usr/bin/env node
/**
 * Verify a fixed git commit of dsh-superagent in an isolated Linux filesystem environment.
 * On Windows, invokes WSL via wsl.exe argv arrays without multi-layer shell interpolation;
 * on Linux, executes natively. Writes per-stage logs and manifest.json under --output.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GIT_LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const LINUX_PREFLIGHT_SCRIPT = [
  'set -eu',
  'NODE_RANGE="$1"',
  'PNPM_SPEC="$2"',
  'EXPLICIT_PNPM="$3"',
  'SNAP_DIR="$4"',
  '',
  'if [ -z "$SNAP_DIR" ] || [ ! -d "$SNAP_DIR" ]; then',
  '  echo "Missing pre-created snapshot directory: ${SNAP_DIR:-empty}" >&2',
  '  exit 1',
  'fi',
  'OS_NAME="$(uname -s 2>/dev/null || true)"',
  'if [ "$OS_NAME" != "Linux" ]; then',
  '  echo "Expected Linux environment, got: ${OS_NAME:-unknown}" >&2',
  '  exit 1',
  'fi',
  '',
  'is_windows_path() {',
  '  case "$1" in',
  '    /mnt/[A-Za-z]|/mnt/[A-Za-z]/*|[A-Za-z]:\\\\*|[A-Za-z]:/*) return 0 ;;',
  '  esac',
  '  lower="$(printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\')"',
  '  case "$lower" in',
  '    *.exe|*.cmd|*.bat|*.ps1|*.vbs|*.com) return 0 ;;',
  '  esac',
  '  if command -v readlink >/dev/null 2>&1; then',
  '    resolved="$(readlink -f "$1" 2>/dev/null || true)"',
  '    case "$resolved" in',
  '      /mnt/[A-Za-z]|/mnt/[A-Za-z]/*) return 0 ;;',
  '    esac',
  '  fi',
  '  return 1',
  '}',
  '',
  'is_executable_file() {',
  '  [ -f "$1" ] && [ -x "$1" ]',
  '}',
  '',
  'CLEAN_PATH=""',
  'FIRST_NODE=""',
  'FIRST_TAR=""',
  'FIRST_PNPM=""',
  'FIRST_PNPM_IS_WIN=0',
  'FIRST_COREPACK=""',
  '',
  'IFS=:',
  'for dir in ${PATH:-}; do',
  '  [ -n "$dir" ] || continue',
  '  dir_is_win=0',
  '  case "$dir" in',
  '    /mnt/[A-Za-z]|/mnt/[A-Za-z]/*) dir_is_win=1 ;;',
  '  esac',
  '  if [ "$dir_is_win" -eq 0 ]; then',
  '    CLEAN_PATH="${CLEAN_PATH:+${CLEAN_PATH}:}${dir}"',
  '  fi',
  '',
  '  if [ -z "$FIRST_NODE" ]; then',
  '    for cand in "$dir/node" "$dir/node.exe"; do',
  '      if is_executable_file "$cand"; then',
  '        FIRST_NODE="$cand"',
  '        break',
  '      fi',
  '    done',
  '  fi',
  '',
  '  if [ "$dir_is_win" -eq 0 ] && [ -z "$FIRST_TAR" ] && is_executable_file "$dir/tar"; then',
  '    if ! is_windows_path "$dir/tar"; then',
  '      FIRST_TAR="$dir/tar"',
  '    fi',
  '  fi',
  '',
  '  if [ -z "$FIRST_PNPM" ]; then',
  '    for cand in "$dir/pnpm" "$dir/pnpm.exe" "$dir/pnpm.cmd"; do',
  '      if is_executable_file "$cand"; then',
  '        FIRST_PNPM="$cand"',
  '        if [ "$dir_is_win" -eq 1 ] || is_windows_path "$cand"; then',
  '          FIRST_PNPM_IS_WIN=1',
  '        fi',
  '        break',
  '      fi',
  '    done',
  '  fi',
  '',
  '  if [ "$dir_is_win" -eq 0 ] && [ -z "$FIRST_COREPACK" ] && is_executable_file "$dir/corepack"; then',
  '    if ! is_windows_path "$dir/corepack"; then',
  '      FIRST_COREPACK="$dir/corepack"',
  '    fi',
  '  fi',
  'done',
  'unset IFS',
  '',
  'if [ -z "$FIRST_NODE" ]; then',
  '  echo "Linux node was not found on PATH." >&2',
  '  exit 1',
  'fi',
  'if is_windows_path "$FIRST_NODE"; then',
  '  echo "Refusing Windows node on PATH: $FIRST_NODE" >&2',
  '  exit 1',
  'fi',
  'if [ -z "$FIRST_TAR" ]; then',
  '  echo "Linux tar was not found on PATH." >&2',
  '  exit 1',
  'fi',
  '',
  'NODE_VERSION="$(PATH="$CLEAN_PATH" "$FIRST_NODE" -e \'',
  '  if (process.platform !== "linux") {',
  '    console.error("Refusing non-Linux node platform: " + process.platform + " (" + process.execPath + ")");',
  '    process.exit(1);',
  '  }',
  '  const range = process.argv[1] || "";',
  '  const parse = (v) => {',
  '    const m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)/.exec(String(v).trim());',
  '    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;',
  '  };',
  '  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);',
  '  const satisfiesPart = (ver, part) => {',
  '    const tokens = part.trim().split(/\\s+/).filter(Boolean);',
  '    if (tokens.length === 0) return true;',
  '    for (const tok of tokens) {',
  '      if (tok.startsWith("^")) {',
  '        const base = parse(tok.slice(1));',
  '        if (!base) return false;',
  '        const upper = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];',
  '        if (cmp(ver, base) < 0 || cmp(ver, upper) >= 0) return false;',
  '      } else if (tok.startsWith("~")) {',
  '        const base = parse(tok.slice(1));',
  '        if (!base) return false;',
  '        const upper = [base[0], base[1] + 1, 0];',
  '        if (cmp(ver, base) < 0 || cmp(ver, upper) >= 0) return false;',
  '      } else if (tok.startsWith(">=")) {',
  '        const base = parse(tok.slice(2));',
  '        if (!base || cmp(ver, base) < 0) return false;',
  '      } else if (tok.startsWith("<=")) {',
  '        const base = parse(tok.slice(2));',
  '        if (!base || cmp(ver, base) > 0) return false;',
  '      } else if (tok.startsWith(">")) {',
  '        const base = parse(tok.slice(1));',
  '        if (!base || cmp(ver, base) <= 0) return false;',
  '      } else if (tok.startsWith("<")) {',
  '        const base = parse(tok.slice(1));',
  '        if (!base || cmp(ver, base) >= 0) return false;',
  '      } else {',
  '        const base = parse(tok.replace(/^=/, ""));',
  '        if (!base || cmp(ver, base) !== 0) return false;',
  '      }',
  '    }',
  '    return true;',
  '  };',
  '  const cur = parse(process.version);',
  '  if (!cur) {',
  '    console.error("Unable to parse Linux node version: " + process.version);',
  '    process.exit(1);',
  '  }',
  '  if (range) {',
  '    const ok = range.split("||").some((part) => satisfiesPart(cur, part));',
  '    if (!ok) {',
  '      console.error("Linux node " + process.version + " does not satisfy engines.node (" + range + ")");',
  '      process.exit(1);',
  '    }',
  '  }',
  '  process.stdout.write(process.version);',
  '\' "$NODE_RANGE")"',
  '',
  'PNPM_RUNNER=""',
  'PNPM_PATH=""',
  'PNPM_VERSION=""',
  'PNPM_VIA_NODE=0',
  '',
  'if [ -n "$EXPLICIT_PNPM" ]; then',
  '  case "$EXPLICIT_PNPM" in',
  '    /*) ;;',
  '    *) echo "Explicit --pnpm path must be an absolute Linux path: $EXPLICIT_PNPM" >&2; exit 1 ;;',
  '  esac',
  '  if is_windows_path "$EXPLICIT_PNPM"; then',
  '    echo "Refusing Windows --pnpm path: $EXPLICIT_PNPM" >&2',
  '    exit 1',
  '  fi',
  '  if [ ! -f "$EXPLICIT_PNPM" ]; then',
  '    echo "Explicit --pnpm file does not exist on Linux: $EXPLICIT_PNPM" >&2',
  '    exit 1',
  '  fi',
  '  PNPM_RUNNER="explicit"',
  '  PNPM_PATH="$EXPLICIT_PNPM"',
  '  case "$EXPLICIT_PNPM" in',
  '    *.cjs|*.mjs|*.js)',
  '      PNPM_VIA_NODE=1',
  '      PNPM_VERSION="$(PATH="$CLEAN_PATH" "$FIRST_NODE" "$EXPLICIT_PNPM" --version)"',
  '      ;;',
  '    *)',
  '      if [ ! -x "$EXPLICIT_PNPM" ]; then',
  '        echo "Explicit --pnpm binary is not executable: $EXPLICIT_PNPM" >&2',
  '        exit 1',
  '      fi',
  '      PNPM_VERSION="$(PATH="$CLEAN_PATH" "$EXPLICIT_PNPM" --version)"',
  '      ;;',
  '  esac',
  'elif [ -n "$FIRST_PNPM" ]; then',
  '  if [ "$FIRST_PNPM_IS_WIN" -eq 1 ]; then',
  '    echo "Refusing Windows pnpm on PATH: $FIRST_PNPM. Install Linux-native pnpm or pass --pnpm <linux-path>." >&2',
  '    exit 1',
  '  fi',
  '  PNPM_RUNNER="pnpm"',
  '  PNPM_PATH="$FIRST_PNPM"',
  '  PNPM_VERSION="$(PATH="$CLEAN_PATH" "$FIRST_PNPM" --version)"',
  'elif [ -n "$FIRST_COREPACK" ]; then',
  '  PNPM_RUNNER="corepack"',
  '  PNPM_PATH="$FIRST_COREPACK"',
  '  PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-corepack-probe.XXXXXX")"',
  '  cleanup_probe() { rm -rf "$PROBE_DIR"; }',
  '  trap cleanup_probe EXIT',
  '  if [ -n "$PNPM_SPEC" ]; then',
  '    printf \'{"packageManager":"%s"}\\n\' "$PNPM_SPEC" > "$PROBE_DIR/package.json"',
  '  else',
  '    printf \'{}\\n\' > "$PROBE_DIR/package.json"',
  '  fi',
  '  PNPM_VERSION="$(cd "$PROBE_DIR" && PATH="$CLEAN_PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$FIRST_COREPACK" pnpm --version)"',
  '  rm -rf "$PROBE_DIR"',
  '  trap - EXIT',
  'else',
  '  echo "Linux pnpm was not found on PATH. Install Linux-native pnpm or pass --pnpm <linux-path>." >&2',
  '  exit 1',
  'fi',
  '',
  'PNPM_VERSION="$(PATH="$CLEAN_PATH" "$FIRST_NODE" -e \'',
  '  const raw = (process.argv[1] || "").trim().replace(/^v/, "");',
  '  const spec = (process.argv[2] || "").trim();',
  '  const semverRe = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-[0-9A-Za-z.-]+)?$/;',
  '  if (!semverRe.test(raw)) {',
  '    console.error("Invalid pnpm --version output: " + JSON.stringify(raw));',
  '    process.exit(1);',
  '  }',
  '  if (spec) {',
  '    const cleanSpec = spec.split("+")[0];',
  '    const m = /^pnpm@(.+)$/.exec(cleanSpec);',
  '    if (!m) {',
  '      console.error("Unsupported packageManager spec: " + spec);',
  '      process.exit(1);',
  '    }',
  '    const req = m[1].trim().replace(/^v/, "");',
  '    if (!semverRe.test(req)) {',
  '      console.error("Invalid packageManager version: " + spec);',
  '      process.exit(1);',
  '    }',
  '    if (raw !== req) {',
  '      console.error("Linux pnpm " + raw + " does not match exact packageManager (" + spec + ")");',
  '      process.exit(1);',
  '    }',
  '  }',
  '  process.stdout.write(raw);',
  '\' "$PNPM_VERSION" "$PNPM_SPEC")"',
  '',
  'PATH="$CLEAN_PATH" "$FIRST_NODE" -e \'',
  '  const fs = require("node:fs");',
  '  const path = require("node:path");',
  '  const [snapDir, nodePath, nodeVersion, pnpmPath, pnpmVersion, pnpmRunner, viaNode, cleanPathBase] = process.argv.slice(1);',
  '  const q = String.fromCharCode(39);',
  '  const bs = String.fromCharCode(92);',
  '  const shQuote = (value) => q + String(value).replaceAll(q, q + bs + q + q) + q;',
  '  let cleanPath = cleanPathBase;',
  '  let pnpmBinPath = pnpmPath;',
  '  if (pnpmRunner === "corepack" || pnpmRunner === "explicit") {',
  '    const binDir = path.join(snapDir, ".verify-bin");',
  '    fs.mkdirSync(binDir, { recursive: true });',
  '    const lines = ["#!/bin/sh"];',
  '    if (pnpmRunner === "corepack") {',
  '      lines.push("export COREPACK_ENABLE_DOWNLOAD_PROMPT=0");',
  '      lines.push("exec " + shQuote(pnpmPath) + " pnpm \\"$@\\"");',
  '    } else if (viaNode === "1") {',
  '      lines.push("exec " + shQuote(nodePath) + " " + shQuote(pnpmPath) + " \\"$@\\"");',
  '    } else {',
  '      lines.push("exec " + shQuote(pnpmPath) + " \\"$@\\"");',
  '    }',
  '    const wrapper = path.join(binDir, "pnpm");',
  '    fs.writeFileSync(wrapper, lines.join("\\n") + "\\n", { mode: 0o755 });',
  '    cleanPath = binDir + ":" + cleanPath;',
  '    pnpmBinPath = wrapper;',
  '  }',
  '  const payload = {',
  '    snapshotDir: snapDir,',
  '    platform: process.platform,',
  '    nodePath,',
  '    nodeVersion,',
  '    pnpmPath,',
  '    pnpmVersion,',
  '    pnpmRunner,',
  '    cleanPath,',
  '    pnpmBinPath,',
  '  };',
  '  process.stdout.write("__PREFLIGHT_JSON__:" + JSON.stringify(payload) + "\\n");',
  '\' "$SNAP_DIR" "$FIRST_NODE" "$NODE_VERSION" "$PNPM_PATH" "$PNPM_VERSION" "$PNPM_RUNNER" "$PNPM_VIA_NODE" "$CLEAN_PATH"',
].join('\n')

function printHelp() {
  process.stdout.write(
    [
      'Usage: node plugin/scripts/verify-linux.mjs [--ref REF] [--output DIR] [--distro NAME] [--repo DIR] [--pnpm PATH]',
      '',
      'Options:',
      '  --ref REF       Git ref or commit to verify (default: HEAD of script worktree)',
      '  --output DIR    Evidence output directory (default: <repo>/plugin/.artifacts/verify)',
      '  --distro NAME   WSL distribution name on Windows (optional)',
      '  --repo DIR      Git repository root (default: script worktree root)',
      '  --pnpm PATH     Explicit Linux-side path to pnpm CLI or pnpm.cjs (optional)',
      '  -h, --help      Show this help message',
      '',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const options = { ref: 'HEAD', output: null, distro: null, repo: DEFAULT_REPO, pnpm: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    const readValue = (flagName, inlineValue) => {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new Error(`Missing value for ${flagName}`)
        return inlineValue
      }
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${flagName}`)
      const next = argv[++i]
      if (!next) throw new Error(`Missing value for ${flagName}`)
      return next
    }
    const eq = arg.indexOf('=')
    const flag = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined
    if (flag === '--ref') options.ref = readValue('--ref', inline)
    else if (flag === '--output') options.output = resolve(process.cwd(), readValue('--output', inline))
    else if (flag === '--distro') options.distro = readValue('--distro', inline)
    else if (flag === '--repo') options.repo = resolve(process.cwd(), readValue('--repo', inline))
    else if (flag === '--pnpm') options.pnpm = readValue('--pnpm', inline)
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.output) options.output = join(options.repo, 'plugin', '.artifacts', 'verify')
  return options
}

function cleanGitEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of GIT_LOCATION) delete env[key]
  if (Object.keys(extra).some(key => key.toUpperCase() === 'PATH')) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key]
    }
  }
  return Object.assign(env, extra)
}

function findExecutableOnPath(name, pathValue = process.env.PATH ?? '') {
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue
    const candidate = join(entry, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return null
}

function runBuffered(command, args, { env = process.env, cwd } = {}) {
  const { promise, resolve: done } = Promise.withResolvers()
  const child = spawn(command, args, { cwd, env, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('error', error => done({ code: 1, stdout, stderr: `${stderr}${error.message}\n` }))
  child.on('close', code => done({ code: code ?? 1, stdout, stderr }))
  return promise
}

function createTailBuffer(limit = 4096) {
  let text = ''
  return {
    append(chunk) {
      text += chunk
      if (text.length > limit) text = text.slice(-limit)
    },
    get value() {
      return text.trim()
    },
  }
}

function runStreaming(command, args, logStream, { cwd, env = process.env, stdinText, collectStdout = false } = {}) {
  const { promise, resolve: done } = Promise.withResolvers()
  const child = spawn(command, args, { cwd, env, windowsHide: true })
  let stdout = ''
  const stderrTail = createTailBuffer()
  const stdoutTail = createTailBuffer()
  child.stdout.on('data', chunk => {
    const text = String(chunk)
    logStream.write(chunk)
    stdoutTail.append(text)
    if (collectStdout) stdout += text
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    logStream.write(chunk)
    stderrTail.append(text)
  })
  child.on('error', error => {
    logStream.write(`${error.message}\n`)
    done({ code: 1, stdout, stderrTail: error.message, stdoutTail: stdoutTail.value })
  })
  child.on('close', code => {
    done({ code: code ?? 1, stdout, stderrTail: stderrTail.value, stdoutTail: stdoutTail.value })
  })
  if (stdinText !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(stdinText)
  } else {
    child.stdin.end()
  }
  return promise
}

function runArchiveExport(repoRoot, sha, targets, linuxCommand, linuxArgs, logStream, linuxEnv) {
  const { promise, resolve: done } = Promise.withResolvers()
  const gitChild = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repoRoot, 'archive', '--format=tar', sha, '--', ...targets], {
    env: cleanGitEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tarChild = spawn(linuxCommand, linuxArgs, {
    env: linuxEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const gitStderr = createTailBuffer()
  const tarStderr = createTailBuffer()
  let gitCode = null
  let tarCode = null
  let settled = false

  const maybeFinish = () => {
    if (settled || gitCode === null || tarCode === null) return
    settled = true
    const code = tarCode !== 0 ? tarCode : gitCode
    done({ code, errorText: tarStderr.value || gitStderr.value })
  }

  gitChild.stderr.on('data', chunk => {
    logStream.write(chunk)
    gitStderr.append(String(chunk))
  })
  tarChild.stdout.on('data', chunk => logStream.write(chunk))
  tarChild.stderr.on('data', chunk => {
    logStream.write(chunk)
    tarStderr.append(String(chunk))
  })
  tarChild.stdin.on('error', () => {})
  gitChild.stdout.pipe(tarChild.stdin)

  gitChild.on('error', error => {
    logStream.write(`${error.message}\n`)
    gitStderr.append(error.message)
    tarChild.stdin.end()
    gitCode = 1
    maybeFinish()
  })
  tarChild.on('error', error => {
    logStream.write(`${error.message}\n`)
    tarStderr.append(error.message)
    tarCode = 1
    maybeFinish()
  })
  gitChild.on('close', code => {
    gitCode = code ?? 1
    maybeFinish()
  })
  tarChild.on('close', code => {
    tarCode = code ?? 1
    maybeFinish()
  })

  return promise
}

function makeRunDir(outputBase, sha) {
  const now = new Date().toISOString()
  const stamp = now.slice(0, 19).replace(/[-:]/g, '') + '-' + now.slice(20, 23) + 'Z'
  const shortSha = sha ? sha.slice(0, 7) : 'unknown'
  const runId = `${stamp}-${shortSha}-${process.pid}-${randomBytes(3).toString('hex')}`
  const runDir = join(outputBase, runId)
  mkdirSync(runDir, { recursive: true })
  return runDir
}

function closeStream(stream) {
  const { promise, resolve: done } = Promise.withResolvers()
  stream.end(() => done())
  return promise
}

function writeManifest(runDir, manifest) {
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

function printSummary(manifest) {
  const lines = [
    `verify-linux: ${manifest.status.toUpperCase()} (exit ${manifest.exitCode})`,
    `sha: ${manifest.sha ?? 'unknown'}`,
    `ref: ${manifest.ref ?? 'unknown'}`,
    `workflow: ${manifest.workflow}`,
    `platform: ${manifest.platform ?? 'unknown'} (node ${manifest.nodeVersion ?? 'unknown'}, pnpm ${manifest.pnpmVersion ?? 'unknown'})`,
    'stages:',
    ...Object.entries(manifest.stages).map(([name, stage]) =>
      `  ${name}: ${stage.status} (exit ${stage.exitCode ?? '-'})${stage.log ? ` -> ${stage.log}` : ''}`),
    ...(manifest.error ? [`error: ${manifest.error}`] : []),
    ...(manifest.cleanupError && manifest.cleanupError !== manifest.error ? [`cleanupError: ${manifest.cleanupError}`] : []),
    ...(!manifest.snapshotCleaned && manifest.snapshotDir ? [`snapshotDir: ${manifest.snapshotDir} (not cleaned)`] : []),
    `manifest: ${join(manifest.runDir, 'manifest.json')}`,
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

async function resolveGitTarget(repoRoot, requestedRef) {
  if (!existsSync(repoRoot)) throw new Error(`Repository path does not exist: ${repoRoot}`)
  const env = cleanGitEnv()
  const shaRes = await runBuffered('git', ['-C', repoRoot, 'rev-parse', '--verify', `${requestedRef}^{commit}`], { env })
  if (shaRes.code !== 0) {
    throw new Error(`Failed to resolve commit for ref "${requestedRef}" in ${repoRoot}: ${shaRes.stderr.trim() || 'unknown git error'}`)
  }
  const sha = shaRes.stdout.trim()
  const refRes = await runBuffered('git', ['-C', repoRoot, 'rev-parse', '--symbolic-full-name', requestedRef], { env })
  const ref = refRes.code === 0 && refRes.stdout.trim() ? refRes.stdout.trim() : requestedRef

  const pkgCheck = await runBuffered('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}:plugin/package.json`], { env })
  if (pkgCheck.code !== 0) {
    throw new Error(`Commit ${sha} does not contain plugin/package.json`)
  }
  const pkgShow = await runBuffered('git', ['-C', repoRoot, 'show', `${sha}:plugin/package.json`], { env })
  if (pkgShow.code !== 0) {
    throw new Error(`Unable to read ${sha}:plugin/package.json: ${pkgShow.stderr.trim()}`)
  }
  const pkg = JSON.parse(pkgShow.stdout)
  const targets = ['plugin']
  // The offline docs test also reads the committed root DOCS.md.
  const docs = await runBuffered('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}:DOCS.md`], { env })
  if (docs.code === 0) targets.push('DOCS.md')
  return {
    sha,
    ref,
    targets,
    nodeRange: typeof pkg.engines?.node === 'string' ? pkg.engines.node : '',
    pnpmSpec: typeof pkg.packageManager === 'string' ? pkg.packageManager : '',
  }
}

const REQUIRED_PREFLIGHT_FIELDS = ['snapshotDir', 'platform', 'nodeVersion', 'pnpmVersion', 'pnpmRunner', 'cleanPath', 'pnpmBinPath']

function parsePreflightPayload(stdout) {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('__PREFLIGHT_JSON__:')) continue
    const payload = JSON.parse(line.slice('__PREFLIGHT_JSON__:'.length))
    if (!payload || typeof payload !== 'object') {
      throw new Error('Preflight metadata payload must be a JSON object')
    }
    for (const field of REQUIRED_PREFLIGHT_FIELDS) {
      if (typeof payload[field] !== 'string' || !payload[field]) {
        throw new Error(`Preflight metadata missing required field: ${field}`)
      }
    }
    return payload
  }
  throw new Error('Preflight did not emit __PREFLIGHT_JSON__ metadata')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  if (options.help) {
    printHelp()
    process.exit(0)
  }

  const hostPlatform = process.platform
  const workflow = process.env.GITHUB_WORKFLOW || 'verify-linux'
  const startedAt = new Date().toISOString()

  let gitInfo = null
  let gitResolveError = null
  try {
    gitInfo = await resolveGitTarget(options.repo, options.ref)
  } catch (error) {
    gitResolveError = error instanceof Error ? error.message : String(error)
  }

  const runDir = makeRunDir(options.output, gitInfo?.sha ?? null)
  const preflightLog = join(runDir, '01-preflight.log')
  const exportLog = join(runDir, '02-export.log')
  const installLog = join(runDir, '03-install.log')
  const checkLog = join(runDir, '04-check.log')

  const manifest = {
    sha: gitInfo?.sha ?? null,
    ref: gitInfo?.ref ?? options.ref,
    workflow,
    status: 'failed',
    exitCode: 1,
    startedAt,
    finishedAt: startedAt,
    requestedRef: options.ref,
    repo: options.repo,
    distro: options.distro,
    platform: null,
    hostPlatform,
    nodeVersion: null,
    pnpmVersion: null,
    pnpmRunner: null,
    snapshotDir: null,
    snapshotCleaned: true,
    cleanupError: null,
    runDir,
    stages: {
      preflight: { status: 'skipped', exitCode: null, log: preflightLog },
      export: { status: 'skipped', exitCode: null, log: null },
      install: { status: 'skipped', exitCode: null, log: null },
      check: { status: 'skipped', exitCode: null, log: null },
    },
    error: null,
  }

  const windowsHost = hostPlatform === 'win32'
  let wslExe = null
  const distroArgs = options.distro ? ['--distribution', options.distro] : []
  const wslEnv = windowsHost ? cleanGitEnv({ WSL_UTF8: '1' }) : cleanGitEnv()

  const linuxCommand = (args) => (windowsHost ? [wslExe, [...distroArgs, '--exec', ...args], wslEnv] : [args[0], args.slice(1), cleanGitEnv()])

  let preflightInfo = null
  let ownedSnapshotDir = null

  try {
    // Stage 1: Preflight
    const preflightStream = createWriteStream(preflightLog, { flags: 'a' })
    try {
      if (gitResolveError) {
        preflightStream.write(`${gitResolveError}\n`)
        manifest.stages.preflight = { status: 'failed', exitCode: 1, log: preflightLog }
        manifest.exitCode = 1
        manifest.error = gitResolveError
        return
      }
      if (hostPlatform !== 'win32' && hostPlatform !== 'linux') {
        const message = `Unsupported host platform for verify-linux: ${hostPlatform}`
        preflightStream.write(`${message}\n`)
        manifest.stages.preflight = { status: 'failed', exitCode: 1, log: preflightLog }
        manifest.exitCode = 1
        manifest.error = message
        return
      }
      if (windowsHost) {
        wslExe = findExecutableOnPath('wsl.exe')
        if (!wslExe) {
          const message = 'wsl.exe was not found on PATH; cannot run Linux verification from Windows.'
          preflightStream.write(`${message}\n`)
          manifest.stages.preflight = { status: 'failed', exitCode: 1, log: preflightLog }
          manifest.exitCode = 1
          manifest.error = message
          return
        }
      }

      if (windowsHost) {
        const snapRes = await runBuffered(
          wslExe,
          [...distroArgs, '--exec', 'sh', '-c', 'mktemp -d "${TMPDIR:-/tmp}/dsh-superagent-verify.XXXXXX"'],
          { env: wslEnv },
        )
        if (snapRes.code !== 0 || !snapRes.stdout.trim()) {
          const message = `Failed to create Linux snapshot directory: ${snapRes.stderr.trim() || snapRes.stdout.trim() || `exit ${snapRes.code}`}`
          preflightStream.write(`${message}\n`)
          manifest.stages.preflight = { status: 'failed', exitCode: snapRes.code || 1, log: preflightLog }
          manifest.exitCode = snapRes.code || 1
          manifest.error = message
          return
        }
        ownedSnapshotDir = snapRes.stdout.trim()
      } else {
        ownedSnapshotDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'dsh-superagent-verify.'))
      }
      manifest.snapshotDir = ownedSnapshotDir
      manifest.snapshotCleaned = false

      const [cmd, args, env] = linuxCommand(['sh', '-s', '--', gitInfo.nodeRange, gitInfo.pnpmSpec, options.pnpm ?? '', ownedSnapshotDir])
      const res = await runStreaming(cmd, args, preflightStream, { env, stdinText: LINUX_PREFLIGHT_SCRIPT, collectStdout: true })
      if (res.code !== 0) {
        manifest.stages.preflight = { status: 'failed', exitCode: res.code, log: preflightLog }
        manifest.exitCode = res.code || 1
        manifest.error = res.stderrTail || res.stdoutTail || `Preflight failed with exit code ${res.code}`
        return
      }

      try {
        preflightInfo = parsePreflightPayload(res.stdout)
        if (preflightInfo.snapshotDir !== ownedSnapshotDir) {
          throw new Error(`Preflight snapshotDir mismatch: expected ${ownedSnapshotDir}, got ${preflightInfo.snapshotDir}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        preflightStream.write(`${message}\n`)
        manifest.stages.preflight = { status: 'failed', exitCode: 1, log: preflightLog }
        manifest.exitCode = 1
        manifest.error = message
        return
      }
      manifest.platform = preflightInfo.platform
      manifest.nodeVersion = preflightInfo.nodeVersion
      manifest.pnpmVersion = preflightInfo.pnpmVersion
      manifest.pnpmRunner = preflightInfo.pnpmRunner
      manifest.stages.preflight = { status: 'passed', exitCode: 0, log: preflightLog }
    } finally {
      await closeStream(preflightStream)
    }

    // Stage 2: Export committed snapshot
    const exportStream = createWriteStream(exportLog, { flags: 'a' })
    manifest.stages.export.log = exportLog
    try {
      const [tarCmd, tarArgs, tarEnv] = linuxCommand(['tar', '-xf', '-', '-C', ownedSnapshotDir])
      const exportRes = await runArchiveExport(options.repo, gitInfo.sha, gitInfo.targets, tarCmd, tarArgs, exportStream, tarEnv)
      if (exportRes.code !== 0) {
        manifest.stages.export = { status: 'failed', exitCode: exportRes.code, log: exportLog }
        manifest.exitCode = exportRes.code || 1
        manifest.error = exportRes.errorText || `Snapshot export failed with exit code ${exportRes.code}`
        return
      }
      manifest.stages.export = { status: 'passed', exitCode: 0, log: exportLog }
    } finally {
      await closeStream(exportStream)
    }

    const pluginDir = `${ownedSnapshotDir}/plugin`
    const runLinuxPnpm = (pnpmArgs, logPath) => {
      const cleanPath = preflightInfo.cleanPath
      const pnpmExec = preflightInfo.pnpmBinPath
      if (windowsHost) {
        const [cmd, args, env] = linuxCommand([
          'sh',
          '-c',
          'cd "$1" && shift && exec "$@"',
          '_',
          pluginDir,
          'env',
          ...GIT_LOCATION.flatMap(name => ['-u', name]),
          `PATH=${cleanPath}`,
          'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
          pnpmExec,
          ...pnpmArgs,
        ])
        return { cmd, args, env, cwd: undefined, logPath }
      }
      return {
        cmd: pnpmExec,
        args: pnpmArgs,
        env: cleanGitEnv({ PATH: cleanPath, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }),
        cwd: pluginDir,
        logPath,
      }
    }

    for (const stage of [
      { name: 'install', args: ['install', '--frozen-lockfile'], log: installLog },
      { name: 'check', args: ['check'], log: checkLog },
    ]) {
      const spec = runLinuxPnpm(stage.args, stage.log)
      manifest.stages[stage.name].log = stage.log
      const stream = createWriteStream(stage.log, { flags: 'a' })
      try {
        const res = await runStreaming(spec.cmd, spec.args, stream, { cwd: spec.cwd, env: spec.env })
        if (res.code !== 0) {
          manifest.stages[stage.name] = { status: 'failed', exitCode: res.code, log: stage.log }
          manifest.exitCode = res.code || 1
          manifest.error = res.stderrTail || res.stdoutTail || `pnpm ${stage.args[0]} failed with exit code ${res.code}`
          return
        }
        manifest.stages[stage.name] = { status: 'passed', exitCode: 0, log: stage.log }
      } finally {
        await closeStream(stream)
      }
    }
    manifest.status = 'passed'
    manifest.exitCode = 0
  } catch (error) {
    manifest.status = 'failed'
    manifest.exitCode = manifest.exitCode || 1
    manifest.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (ownedSnapshotDir) {
      let cleanupError = null
      let cleanupCode = 1
      try {
        if (windowsHost && wslExe) {
          const cleanupRes = await runBuffered(wslExe, [...distroArgs, '--exec', 'rm', '-rf', ownedSnapshotDir], { env: wslEnv })
          if (cleanupRes.code !== 0) {
            cleanupCode = cleanupRes.code || 1
            const detail = cleanupRes.stderr.trim() || cleanupRes.stdout.trim() || `rm exited with code ${cleanupRes.code}`
            cleanupError = `Failed to clean up snapshot directory ${ownedSnapshotDir}: ${detail}`
          }
          manifest.snapshotCleaned = cleanupRes.code === 0
        } else {
          rmSync(ownedSnapshotDir, { recursive: true, force: true })
          manifest.snapshotCleaned = !existsSync(ownedSnapshotDir)
          if (!manifest.snapshotCleaned) {
            cleanupError = `Failed to clean up snapshot directory ${ownedSnapshotDir}: directory still exists`
          }
        }
      } catch (error) {
        manifest.snapshotCleaned = false
        const detail = error instanceof Error ? error.message : String(error)
        cleanupError = `Failed to clean up snapshot directory ${ownedSnapshotDir}: ${detail}`
      }
      if (cleanupError) {
        manifest.cleanupError = cleanupError
        if (manifest.status === 'passed') {
          manifest.status = 'failed'
          manifest.exitCode = cleanupCode || 1
          manifest.error = cleanupError
        } else {
          manifest.exitCode = manifest.exitCode || 1
          if (!manifest.error) manifest.error = cleanupError
        }
      }
    }
    manifest.finishedAt = new Date().toISOString()
    writeManifest(runDir, manifest)
    printSummary(manifest)
    process.exitCode = manifest.exitCode
  }
}

await main()
