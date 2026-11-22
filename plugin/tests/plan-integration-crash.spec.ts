import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { PlanIntegrationView } from '../src/core/plan-integration.ts'
type ChildMessage = { kind: 'accepted'; context: string } | { kind: 'recovered'; view: PlanIntegrationView; retained?: PlanIntegrationView; dispatches: number; relays: number }

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

it('withdraws a queued delivery relay when restart finds its package missing', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'plan-integration-missing-'))
  let recovering: ChildProcess | undefined
  try {
    const store = new Store(join(root, 'plan.sqlite'))
    try {
      const effects = new Effects(store, new HealthBoard())
      const planId = 'plan-crash'
      store.atomic(() => {
        store.set(KV.plans.integration(planId), { planId, status: 'delivered',
          version: { repository: 'acme/widgets', ref: 'refs/heads/main', sha: 'a'.repeat(40), context: 'b'.repeat(64),
            workflowId: '44', configuration: 'checks-v1', environment: 'hosted-ci-v1' },
          run: { id: 101, attempt: 1, url: 'https://github.com/acme/widgets/actions/runs/101', checks: [] },
          artifact: { id: 202, name: 'package', url: 'https://github.com/acme/widgets/actions/runs/101/artifacts/202',
            fileName: 'package.tgz', contentType: 'application/gzip', size: 1, sha256: 'd'.repeat(64) }, verifiedAt: new Date().toISOString() })
        effects.enqueue('relay', `plan-delivered:${planId}`, { text: 'verified package ready' })
      })
    } finally { store.close() }

    const recovery = recovering = fork(join(bundleDir, entry), ['recover-missing', root], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const recoveryClosed = closed(recovery)
    const recovered = await receiveWithin(recovery, 'Missing-package recovery did not finish')
    if (recovered.kind !== 'recovered') throw new Error('Recovery fixture did not report its final state')
    expect(recovered).toMatchObject({ relays: 0, retained: { status: 'blocked', reason: 'artifact_unavailable' } })
    expect(await recoveryClosed).toEqual({ code: 0, signal: null })
    recovering = undefined
  } finally {
    if (recovering && recovering.exitCode === null && recovering.signalCode === null) recovering.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
