// Run from plugin/ *outside* Vitest: node --test tests/probes/test-runner.mjs
// Each checkout has a tiny instrumented Vitest bin. Only the real public runner
// is invoked: no alternate lock namespace, platform override, or skip-lock flag.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runner = new URL('../../scripts/test.mjs', import.meta.url)
async function publishOffset(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, String(value), { flag: 'wx' })
  await rename(temporary, path)
}
const args = ['tests/a file.spec.ts', '-t', 'a & b', '--lock-dir', 'not a runner option', '--no-lock']
const windows = process.platform === 'win32'

async function checkout(root, name) {
  const plugin = join(root, name, 'plugin')
  const pkg = join(plugin, 'node_modules', 'vitest')
  await mkdir(pkg, { recursive: true })
  await mkdir(join(plugin, 'scripts'))
  await copyFile(runner, join(plugin, 'scripts', 'test.mjs'))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: './vitest.mjs' } }))
  await writeFile(join(pkg, 'vitest.mjs'), `
    import { realpathSync } from 'node:fs'
    let previousAlive = false
    if (process.env.PROBE_PREVIOUS_PID) {
      try { process.kill(Number(process.env.PROBE_PREVIOUS_PID), 0); previousAlive = true }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    console.error('probe stderr')
    console.log(JSON.stringify({ cwd: realpathSync('.'), args: process.argv.slice(2), pid: process.pid, previousAlive }))
    let input = ''
    process.stdin.setEncoding('utf8').on('data', chunk => { input += chunk })
    process.stdin.on('end', () => { process.exitCode = Number(input) })
  `)
  return plugin
}

function start(cwd, previousPid, nodeOptions = [], vitestArgs = args) {
  const child = spawn(process.execPath, [...nodeOptions, 'scripts/test.mjs', ...vitestArgs], {
    cwd,
    env: { ...process.env, PROBE_PREVIOUS_PID: previousPid ? String(previousPid) : '' },
    stdio: 'pipe',
  })
  const run = { child, stdout: '', stderr: '', closed: false }
  child.stdout.setEncoding('utf8').on('data', text => { run.stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { run.stderr += text })
  run.exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { run.closed = true; resolve({ code, signal }) })
  })
  return run
}

const gatePattern = /gate=dsh-superagent-vitest-[0-9a-f]{64}/

function stderrLines(run) {
  return run.stderr.split(/\r?\n/)
}

function waitLines(run) {
  return stderrLines(run).filter(line => line.includes('Windows Vitest gate') && line.includes('Vitest has not started'))
}

function assertWaiter(line, run) {
  assert.match(line, gatePattern)
  assert.match(line, new RegExp(`waiter pid=${run.child.pid}(?!\\d)`))
  const waited = Number(line.match(/waited=([\d.]+)s/)[1])
  assert.ok(Number.isFinite(waited), line)
  return waited
}

async function observe(run, predicate) {
  const deadline = performance.now() + 30_000
  while (!predicate()) {
    assert.ok(!run.closed && performance.now() < deadline, `runner exited or timed out: ${run.stdout}\n${run.stderr}`)
    await delay(25)
  }
}

async function observeWait(run) {
  await observe(run, () => waitLines(run).length > 0 || run.stdout.includes('\n'))
  assert.equal(run.stdout, '', 'Vitest entered while the first runner was held open')
  const line = waitLines(run)[0]
  assert.match(line, /Waiting for the Windows Vitest gate/)
  assertWaiter(line, run)
  assert.match(line, /Another test run for this Windows account holds the gate/)
  assert.match(line, /named-pipe API does not reveal its owner PID/)
  assert.doesNotMatch(line, /(?:owner|holder) (?:PID|pid)\s*[=:]\s*\d/)
}

async function entered(run, cwd) {
  await observe(run, () => run.stdout.includes('\n'))
  const entry = JSON.parse(run.stdout)
  assert.equal(entry.cwd, await realpath(cwd))
  assert.deepEqual(entry.args, ['run', ...args])
  return entry
}

for (const interrupt of [false, true]) {
  test(`two checkouts after ${interrupt ? 'hard kill' : 'nonzero exit'}`, { timeout: 100_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'test runner '))
    const runs = []
    t.after(async () => {
      for (const run of runs) {
        run.child.stdin.end()
        if (!run.closed) run.child.kill('SIGKILL')
      }
      await Promise.allSettled(runs.map(run => run.exit))
      await rm(root, { recursive: true, force: true })
    })
    const a = await checkout(root, 'A')
    const b = await checkout(root, 'B')
    const first = start(a)
    runs.push(first)
    const holder = await entered(first, a)
    if (windows && !interrupt) {
      // Advance only a waiting probe process's clock. No timing or ownership
      // override is exposed by the runner. Cross the progress report, then the
      // 30-minute deadline: expiry must not start the bin or dislodge the first
      // runner, and the following contender still has to wait.
      const clock = join(root, 'clock-offset')
      const preload = join(root, 'clock.mjs')
      await writeFile(preload, `
        import { existsSync, readFileSync } from 'node:fs'
        const offsetFile = ${JSON.stringify(clock)}
        const now = performance.now.bind(performance)
        Object.defineProperty(performance, 'now', { value: () => {
          if (!existsSync(offsetFile)) return now()
          const text = readFileSync(offsetFile, 'utf8')
          if (!/^(?:0|[1-9]\\d*)$/.test(text)) throw new Error('Invalid probe clock offset')
          const offset = Number(text)
          if (!Number.isSafeInteger(offset)) throw new Error('Invalid probe clock offset')
          return now() + offset
        } })
      `)
      const waiter = start(b, holder.pid, ['--import', pathToFileURL(preload).href])
      runs.push(waiter)
      await observeWait(waiter)
      await publishOffset(clock, 61_000)
      await observe(waiter, () => stderrLines(waiter).some(line => line.includes('Still waiting for the Windows Vitest gate')))
      const progress = stderrLines(waiter).find(line => line.includes('Still waiting for the Windows Vitest gate'))
      const waited = assertWaiter(progress, waiter)
      assert.ok(waited >= 60)
      assert.match(progress, /Vitest has not started/)
      assert.equal(waiter.stdout, '')
      await publishOffset(clock, 30 * 60_000 + 1_000)
      await observe(waiter, () => waiter.closed)
      assert.equal(waiter.stdout, '')
      const timedOut = await waiter.exit
      assert.notEqual(timedOut.code, 0)
      assert.equal(timedOut.signal, null)
      assert.ok(!waiter.stderr.includes('probe stderr'), 'timeout waiter entered Vitest')
      for (const checkoutPath of [root, root.replaceAll('\\', '/'), pathToFileURL(root).href]) {
        assert.ok(!waiter.stderr.includes(checkoutPath), `timeout stderr named the temporary checkout path: ${checkoutPath}`)
      }
      const timeout = stderrLines(waiter).find(line => line.startsWith('[test] Timed out waiting for the Windows Vitest gate'))
      assert.ok(assertWaiter(timeout, waiter) >= 1_800)
      assert.match(timeout, /Vitest was not started/)
      assert.match(timeout, /only that another test run for this Windows account holds the gate/)
      assert.match(timeout, /named-pipe API does not identify its owner process/)
      assert.doesNotMatch(waiter.stderr, /(?:owner|holder) (?:PID|pid)\s*[=:]\s*\d/)
    }
    const second = start(b, holder.pid)
    runs.push(second)

    // Wait for a real bind conflict, not a guess about Node startup latency.
    if (windows) {
      await observeWait(second)
    } else {
      const entry = await entered(second, b)
      assert.equal(entry.previousAlive, true, 'POSIX must not queue')
      assert.doesNotMatch(second.stderr, /Windows Vitest gate/)
    }

    if (interrupt) first.child.kill('SIGKILL')
    else first.child.stdin.end('23')
    await observe(first, () => first.closed)
    const exit = await first.exit
    if (interrupt) assert.ok(exit.signal || exit.code !== 0)
    else assert.deepEqual(exit, { code: 23, signal: null })

    // A runner that starts after waiting preserves its own independent exit code.
    const secondExit = interrupt ? 23 : 0
    if (windows) {
      const entry = await entered(second, b)
      assert.equal(entry.previousAlive, false)
    }
    second.child.stdin.end(String(secondExit))
    await observe(second, () => second.closed)
    const secondResult = await second.exit
    if (interrupt) assert.notEqual(secondResult.code, 0)
    assert.equal(secondResult.signal, null)
    assert.equal(secondResult.code, secondExit)
    assert.match(second.stderr, /probe stderr/)
    if (windows) assert.match(second.stderr, /Acquired the Windows Vitest gate/)
  })
}

test('an explicit Vitest filter must run at least one test, even with a custom reporter', { timeout: 25_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'test selection '))
  const runs = []
  t.after(async () => {
    for (const run of runs) if (!run.closed) run.child.kill('SIGKILL')
    await Promise.allSettled(runs.map(run => run.exit))
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests', 'selected.spec.ts'), `test('selected probe', () => console.log('probe assertion reached'))\n`)
  await writeFile(join(root, 'tests', 'skipped.spec.ts'), `test.skip('skipped probe', () => { throw new Error('must stay skipped') })\n`)
  const plugin = fileURLToPath(new URL('../../', import.meta.url))
  const options = ['--root', root, '--config', join(plugin, 'vitest.config.ts'), '--globals', '--reporter=dot', '--passWithNoTests']
  for (const [selection, code] of [
    [['tests/selected.spec.ts', '--testNamePattern=^missing probe$'], 1],
    [['tests/skipped.spec.ts'], 1],
    [['tests/selected.spec.ts', '-t', '^selected probe$'], 0],
  ]) {
    const run = start(plugin, undefined, [], [...options, ...selection])
    runs.push(run)
    run.child.stdin.end()
    assert.deepEqual(await run.exit, { code, signal: null }, `${run.stdout}\n${run.stderr}`)
    if (code) assert.match(run.stderr, /\[test\] The explicit test filter ran no tests\./)
    else assert.match(run.stdout, /probe assertion reached/)
  }
})
