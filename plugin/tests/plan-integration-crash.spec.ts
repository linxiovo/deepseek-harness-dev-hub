import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import type { PlanIntegrationView } from '../src/core/plan-integration.ts'

type ChildMessage = { kind: 'accepted'; context: string } | { kind: 'recovered'; view: PlanIntegrationView; dispatches: number; relays: number }

const fixture = fileURLToPath(new URL('./fixtures/plan-integration-crash-child.ts', import.meta.url))
const entry = 'plan-integration-crash-child.mjs'
let bundleDir: string

beforeAll(async () => {
  bundleDir = mkdtempSync(fileURLToPath(new URL('../node_modules/.plan-integration-crash-', import.meta.url)))
  await build({ config: false, entry: fixture, outDir: bundleDir, outputOptions: { entryFileNames: entry },
    format: 'esm', platform: 'node', target: 'es2024', deps: { neverBundle: true }, dts: false, logLevel: 'warn' })
})

afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }) })

function receive(child: ChildProcess): Promise<ChildMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildMessage>()
  child.once('message', message => resolve(message as ChildMessage))
  child.once('error', reject)
  child.once('close', (code, signal) => reject(new Error(`Crash fixture exited before reporting (${code ?? signal})`)))
  return promise
}

async function receiveWithin(child: ChildProcess, timeoutMessage: string): Promise<ChildMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildMessage>()
  const timeout = setTimeout(() => reject(new Error(timeoutMessage)), 15_000)
  receive(child).then(resolve, reject)
  try { return await promise }
  finally { clearTimeout(timeout) }
}

function closed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once('close', (code, signal) => resolve({ code, signal }))
  return promise
}

it('recovers an accepted workflow dispatch after SIGKILL before its local receipt', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'plan-integration-crash-'))
  let crashing: ChildProcess | undefined
  let recovering: ChildProcess | undefined
  try {
    const crashClosed = crashing = fork(join(bundleDir, entry), ['crash', root], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const crashFinished = closed(crashClosed)
    const accepted = await receiveWithin(crashClosed, 'No dispatch reached the crash point')
    if (accepted.kind !== 'accepted') throw new Error('Crash fixture did not report accepted dispatch')
    expect(crashClosed.kill('SIGKILL')).toBe(true)
    expect(await crashFinished).toEqual({ code: null, signal: 'SIGKILL' })
    crashing = undefined

    const persisted = new Store(join(root, 'plan.sqlite'))
    try {
      const view = persisted.get(KV.plans.integration('plan-crash'))
      expect(view).toMatchObject({ status: 'verifying', version: { context: accepted.context } })
      expect(persisted.get(KV.plans.integrationDispatch(accepted.context))).toBe(true)
    } finally { persisted.close() }

    const recovery = recovering = fork(join(bundleDir, entry), ['recover', root], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const recoveryClosed = closed(recovery)
    const recovered = await receiveWithin(recovery, 'Recovery did not finish')
    if (recovered.kind !== 'recovered') throw new Error('Recovery fixture did not report its final state')
    expect(recovered).toMatchObject({ dispatches: 1, relays: 1,
      view: { planId: 'plan-crash', status: 'delivered', version: { context: accepted.context, sha: 'a'.repeat(40) } } })
    expect(await recoveryClosed).toEqual({ code: 0, signal: null })
    recovering = undefined
    expect(readFileSync(join(root, 'dispatch-count'), 'utf8')).toBe('1')
  } finally {
    if (crashing && crashing.exitCode === null && crashing.signalCode === null) crashing.kill('SIGKILL')
    if (recovering && recovering.exitCode === null && recovering.signalCode === null) recovering.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
