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
  const path = `\\\\.\\pipe\\dsh-superagent-vitest-${key}`
  const server = createServer(socket => socket.destroy())
  const deadline = performance.now() + 30 * 60_000
  let announced = false
  do {
    // libuv binds the first Windows pipe instance exclusively. The kernel
    // reclaims it on exit (even a hard kill); a paused process never looks stale.
    server.listen({ path, exclusive: true })
    try {
      await once(server, 'listening')
      server.unref() // Hold for this PID's lifetime without keeping Vitest alive.
      return
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
    if (!announced) {
      console.error('[test] Waiting for another Vitest run for this Windows user (up to 30 min).')
      announced = true
    }
    await delay(1000)
  } while (performance.now() < deadline)
  throw new Error('Timed out waiting for the Windows Vitest gate. Vitest was not started.')
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
