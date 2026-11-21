import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function holdWindowsGate() {
  // Use the OS account's profile, not cwd or shell-specific HOME/TEMP values.
  const profile = userInfo().homedir.toLowerCase()
  const key = createHash('sha256').update(profile).digest('hex')
  const gate = `dsh-superagent-vitest-${key}`
  const path = `\\\\.\\pipe\\${gate}`
  const server = createServer(socket => socket.destroy())
  const limitMs = 30 * 60_000
  const progressMs = 60_000
  const startedAt = performance.now()
  const deadline = startedAt + limitMs
  const state = elapsed => `gate=${gate} waiter pid=${process.pid} waited=${(elapsed / 1000).toFixed(1)}s (limit 30 min)`
  // Diagnostics stay on stderr: no lock file or sidecar can go stale.
  let announced = false
  let reportedAt = startedAt
  do {
    // libuv binds the first Windows pipe instance exclusively. The kernel
    // reclaims it on exit (even a hard kill); a paused process never looks stale.
    server.listen({ path, exclusive: true })
    try {
      await once(server, 'listening')
      server.unref() // Hold for this PID's lifetime without keeping Vitest alive.
      if (announced) console.error(`[test] Acquired the Windows Vitest gate (${state(performance.now() - startedAt)}); starting Vitest.`)
      return
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
    const elapsed = performance.now() - startedAt
    if (!announced) {
      console.error(`[test] Waiting for the Windows Vitest gate (${state(elapsed)}); Vitest has not started. Another test run for this Windows account holds the gate; the named-pipe API does not reveal its owner PID.`)
      announced = true
      reportedAt = elapsed
    } else if (elapsed - reportedAt >= progressMs) {
      console.error(`[test] Still waiting for the Windows Vitest gate (${state(elapsed)}); Vitest has not started.`)
      reportedAt = elapsed
    }
    await delay(1000)
  } while (performance.now() < deadline)
  // Emit the diagnostic before throwing so it reaches stderr even when the
  // unhandled rejection ends the process.
  const timeout = `Timed out waiting for the Windows Vitest gate (${state(performance.now() - startedAt)}). Vitest was not started. This indicates only that another test run for this Windows account holds the gate; the named-pipe API does not identify its owner process.`
  console.error(`[test] ${timeout}`)
  throw new Error(timeout)
}

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
if (process.platform === 'win32') await holdWindowsGate()

// Run the installed CLI in the lock owner, not in a child that could outlive
// a killed wrapper. Keep its stdio, signal handling and exit status intact.
const require = createRequire(import.meta.url)
const manifest = require.resolve('vitest/package.json')
const cli = resolve(dirname(manifest), require(manifest).bin.vitest)
process.argv.splice(1, 1, cli, 'run')
await import(pathToFileURL(cli).href)
