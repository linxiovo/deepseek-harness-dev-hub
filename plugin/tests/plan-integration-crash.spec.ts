import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

type ChildPhase = 'crash' | 'crash-before-post' | 'recover' | 'recover-missing'
type ChildMessage = { kind: 'accepted' | 'before-post'; context: string }
  | { kind: 'recovered'; view?: PlanIntegrationView; retained?: PlanIntegrationView; dispatches: number; relays: number }

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

function closed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once('close', (code, signal) => resolve({ code, signal }))
  return promise
}

async function runChild(root: string, phase: ChildPhase): Promise<ChildMessage> {
  const child = fork(join(bundleDir, entry), [phase, root], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const finished = closed(child)
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error(`Crash fixture did not finish for ${phase}`)), 15_000)
  try {
    const report = await Promise.race([receive(child), deadline.promise])
    if (phase === 'crash' || phase === 'crash-before-post') {
      expect(report.kind).toBe(phase === 'crash' ? 'accepted' : 'before-post')
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await Promise.race([finished, deadline.promise])).toEqual({ code: null, signal: 'SIGKILL' })
    } else {
      expect(report.kind).toBe('recovered')
      expect(await Promise.race([finished, deadline.promise])).toEqual({ code: 0, signal: null })
    }
    return report
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await finished
  }
}

function markedVersion(root: string, context: string) {
  const persisted = new Store(join(root, 'plan.sqlite'))
  try {
    const view = persisted.get(KV.plans.integration('plan-crash'))
    if (view?.status !== 'verifying') throw new Error('Dispatch did not persist a verifying version before the crash')
    expect(view.version).toMatchObject({ repository: 'acme/widgets', ref: 'refs/heads/main', sha: 'a'.repeat(40), context })
    expect(persisted.get(KV.plans.integrationDispatch(context))).toBe(true)
    return view.version
  } finally { persisted.close() }
}

it('recovers an accepted workflow dispatch after SIGKILL before its local receipt', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'plan-integration-crash-'))
  try {
    const accepted = await runChild(root, 'crash')
    if (accepted.kind !== 'accepted') throw new Error('Crash fixture did not report accepted dispatch')
    const version = markedVersion(root, accepted.context)

    const recovered = await runChild(root, 'recover')
    expect(recovered).toMatchObject({ dispatches: 1, relays: 1,
      view: { planId: 'plan-crash', status: 'delivered', version } })
    expect(readFileSync(join(root, 'dispatch-count'), 'utf8')).toBe('1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

it('waits for an exact manual Actions run after SIGKILL before the workflow dispatch POST', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'plan-integration-before-post-'))
  try {
    const crash = await runChild(root, 'crash-before-post')
    if (crash.kind !== 'before-post') throw new Error('Crash fixture did not stop before POST')
    const version = markedVersion(root, crash.context)
    const runPath = join(root, 'accepted-run.json'), countPath = join(root, 'dispatch-count')
    expect(existsSync(runPath)).toBe(false)
    expect(existsSync(countPath)).toBe(false)

    const blocked = { planId: 'plan-crash', status: 'blocked', reason: 'dispatch_unconfirmed', version }
    expect(await runChild(root, 'recover')).toMatchObject({ dispatches: 0, relays: 0, view: blocked, retained: blocked })

    // External operator runs bypass the agent's POST counter. Return green near-misses before the exact run is available.
    const { workflowId: _workflowId, ...identity } = version
    const nearMisses = [
      { ...identity, id: 103, context: '0'.repeat(64) },
      { ...identity, id: 104, sha: 'c'.repeat(40) },
      { ...identity, id: 105, ref: 'refs/heads/other' },
    ]
    writeFileSync(runPath, JSON.stringify(nearMisses))
    expect(await runChild(root, 'recover')).toMatchObject({ dispatches: 0, relays: 0, view: blocked, retained: blocked })

    writeFileSync(runPath, JSON.stringify([...nearMisses, { ...identity, id: 102 }]))
    const delivered = { planId: 'plan-crash', status: 'delivered', version, run: { id: 102, attempt: 1 }, artifact: { fileName: 'package.tgz' } }
    expect(await runChild(root, 'recover')).toMatchObject({ dispatches: 0, relays: 1, view: delivered, retained: delivered })
    expect(await runChild(root, 'recover')).toMatchObject({ dispatches: 0, relays: 1, view: delivered, retained: delivered })
    expect(existsSync(countPath)).toBe(false)
    const relay = JSON.parse(readFileSync(join(root, 'relay.jsonl'), 'utf8'))
    expect(relay.id).toBe('plan-delivered:plan-crash')
    expect(JSON.parse(relay.text)).toMatchObject({ kind: 'plan-delivered', planId: 'plan-crash', version,
      verification: 'https://github.com/acme/widgets/actions/runs/102' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

it('withdraws a queued delivery relay when restart finds its package missing', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'plan-integration-missing-'))
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

    expect(await runChild(root, 'recover-missing')).toMatchObject({ relays: 0, retained: { status: 'blocked', reason: 'artifact_unavailable' } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
