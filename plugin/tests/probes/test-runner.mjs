// Run from plugin/ *outside* Vitest: node --test tests/probes/test-runner.mjs
// Each checkout has a tiny instrumented Vitest bin. Only the real public runner
// is invoked: no alternate lock namespace, platform override, or skip-lock flag.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const runner = new URL('../../scripts/test.mjs', import.meta.url)
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

function start(cwd, previousPid, nodeOptions = []) {
  const child = spawn(process.execPath, [...nodeOptions, 'scripts/test.mjs', ...args], {
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

async function observe(run, predicate) {
  const deadline = performance.now() + 30_000
  while (!predicate()) {
    assert.ok(!run.closed && performance.now() < deadline, `runner exited or timed out: ${run.stdout}\n${run.stderr}`)
    await delay(25)
  }
}

async function observeWait(run) {
  await observe(run, () => run.stderr.includes('Waiting for another Vitest run') || run.stdout.includes('\n'))
  assert.equal(run.stdout, '', 'Vitest entered while the first runner was held open')
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
      // override is exposed by the runner. Expiry must not start the bin or
      // dislodge the first runner: the following contender still has to wait.
      const expired = join(root, 'advance-clock')
      const preload = join(root, 'clock.mjs')
      await writeFile(preload, `
        import { existsSync } from 'node:fs'
        const now = performance.now.bind(performance)
        Object.defineProperty(performance, 'now', { value: () => now() + (existsSync(${JSON.stringify(expired)}) ? 86_400_000 : 0) })
      `)
      const waiter = start(b, holder.pid, ['--import', pathToFileURL(preload).href])
      runs.push(waiter)
      await observeWait(waiter)
      await writeFile(expired, '')
      await observe(waiter, () => waiter.closed)
      assert.match(waiter.stderr, /Timed out waiting/)
      assert.equal(waiter.stdout, '')
      assert.notEqual((await waiter.exit).code, 0)
    }
    const second = start(b, holder.pid)
    runs.push(second)

    // Wait for a real bind conflict, not a guess about Node startup latency.
    if (windows) {
      await observeWait(second)
    } else {
      assert.equal((await entered(second, b)).previousAlive, true, 'POSIX must not queue')
    }

    if (interrupt) first.child.kill('SIGKILL')
    else first.child.stdin.end('23')
    await observe(first, () => first.closed)
    const exit = await first.exit
    if (interrupt) assert.ok(exit.signal || exit.code !== 0)
    else assert.deepEqual(exit, { code: 23, signal: null })

    if (windows) assert.equal((await entered(second, b)).previousAlive, false)
    second.child.stdin.end('0')
    await observe(second, () => second.closed)
    assert.deepEqual(await second.exit, { code: 0, signal: null })
    assert.match(second.stderr, /probe stderr/)
  })
}
