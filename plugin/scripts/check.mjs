import { spawnSync } from 'node:child_process'

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this check with pnpm check.')

// pnpm can run as a Node.js script or a standalone executable.
const [command, ...prefix] = /\.[cm]?js$/i.test(pnpm) ? [process.execPath, pnpm] : [pnpm]
for (const stage of ['check:imports', 'typecheck', 'test', 'build']) {
  const { error, signal, status } = spawnSync(command, [...prefix, 'run', stage], { stdio: 'inherit' })
  if (error) throw error
  if (signal) throw new Error(`${stage} terminated by ${signal}`)
  if (status !== 0) process.exit(status)
}
