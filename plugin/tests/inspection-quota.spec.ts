/** Inspection reservations at the model-admission seam, with the same durable Store used on remount. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MeterSessionBinding } from '../src/app/project-meter.ts'
import type { ModelAdmission } from '../src/app/model-admission.ts'
import type { Relay } from '../src/app/notices.ts'
import { RunLimits } from '../src/app/run-limits.ts'
import { Store } from '../src/app/store.ts'

const scope = 'shared.txt', grant = { scope, maxTokens: 100 }
const inspection: MeterSessionBinding = { session_id: 'inspection-one', roles: ['inspection'], ticket_id: null, plan_id: null, parent_session_id: null }
const hub: MeterSessionBinding = { ...inspection, session_id: 'hub', roles: ['hub'] }
const worker: MeterSessionBinding = { ...inspection, session_id: 'worker-one', roles: ['implementation'], ticket_id: 'ticket-one' }
const relay = vi.fn<(message: Relay) => void>(), inspectionRefused = vi.fn<(sessionId: string, reason: string) => void>()
let directory: string, store: Store, limits: RunLimits
function saveWorkerTicket() {
  const at = '2026-11-26T00:00:00.000Z'
  store.tickets.save({ id: 'ticket-one', title: 'Independent work', decisionId: 'accepted', origin: { triggerId: 'task', triggerIds: ['task'] },
    mandate: { strength: 'explicit', policyVersion: 'v1', actor: { source: 'github', id: 'alice' }, scope: 'task', basis: { via: 'listed' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at })
}
function mount() {
  store = new Store(join(directory, 'quota.sqlite'))
  limits = new RunLimits({ store, relay, changed: () => {}, inspectionRefused })
  limits.recover()
}
function restart() { limits.close(); store.close(); mount() }
function configure(inspectionGrant: typeof grant | null, projectTokens: number | null = null) {
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, runLimits: { projectTokens, ticketTokens: 60 },
    idleInspection: inspectionGrant ? { ...inspectionGrant, intervalSeconds: 10 } : undefined } })
  limits.configurationChanged()
}
function admitted(decision: ModelAdmission) {
  if (!decision.admitted) throw new Error(decision.reason)
  return decision
}
function waiting(decision: ModelAdmission) {
  if (decision.admitted || !decision.wait) throw new Error('Expected a transient reservation conflict')
  return decision.wait
}
const notices = () => relay.mock.calls.map(([message]) => JSON.parse(message.text))
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'inspection-quota-'))
  relay.mockClear(); inspectionRefused.mockClear(); mount()
})
afterEach(() => { limits.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })

it('reserves the full request in both pools, wakes waiters, and charges a receipt only once to each applicable pool', async () => {
  configure(grant, 150)
  const first = admitted(limits.acquire(inspection, 80, undefined, grant))
  const scopeView = () => limits.inspectionBudget(scope, 100)
  expect(scopeView()).toMatchObject({ reservedTokens: 80, availableTokens: 20, inFlight: [{ sessionId: inspection.session_id }] })
  expect(limits.view()?.budget).toMatchObject({ reservedTokens: 80, availableTokens: 70 })
  const scopeWait = waiting(limits.acquire(inspection, 21, undefined, grant))
  const projectWait = waiting(limits.acquire(hub, 71))
  admitted(limits.acquire(hub, 70)).settle(10)
  await Promise.all([scopeWait, projectWait])
  expect(scopeView()).toMatchObject({ accountedTokens: null, reportedCalls: 0, reservedTokens: 80 })
  first.settle(30); first.settle(30)
  admitted(limits.acquire({ ...inspection, session_id: 'inspection-next-window' }, 70, undefined, grant)).settle(70)
  expect(scopeView()).toMatchObject({ state: 'exhausted', accountedTokens: 100, reportedCalls: 2, inFlight: [] })
  expect(limits.view()?.budget).toMatchObject({ state: 'available', accountedTokens: 110, reportedCalls: 3, availableTokens: 40 })
  expect(notices()).toEqual([expect.objectContaining({ kind: 'quota-paused', scope: 'inspection', inspectionScope: scope,
    reason: 'exhausted', ticketId: null, resource: 'project/inspection' })])
  expect(inspectionRefused).not.toHaveBeenCalled()
})

it('uses the current grant for admission and keeps the original scope for settlement, even when disabled or remounted', async () => {
  configure(grant)
  const first = admitted(limits.acquire(inspection, 80, undefined, grant))
  const changed = waiting(limits.acquire(inspection, 21, undefined, grant))
  configure({ scope, maxTokens: 25 }); await changed
  expect(limits.acquire(inspection, 5, undefined, grant)).toMatchObject({ admitted: false })
  expect(limits.inspectionBudget(scope, 25)).toMatchObject({ state: 'reserved', availableTokens: 0, reservedTokens: 80 })
  configure(null)
  expect(limits.acquire(inspection, 1, undefined, grant)).toMatchObject({ admitted: false })
  first.settle(40)
  restart()
  configure({ scope: 'other.txt', maxTokens: 25 })
  expect(limits.inspectionBudget('other.txt', 25)).toMatchObject({ state: 'available', accountedTokens: null, availableTokens: 25 })
  configure({ scope, maxTokens: 25 }); restart()
  expect(limits.inspectionBudget(scope, 25)).toMatchObject({ state: 'exhausted', accountedTokens: 40, reportedCalls: 1 })
  expect(notices()).toHaveLength(1)
  configure({ scope, maxTokens: 50 })
  expect(limits.inspectionBudget(scope, 50)).toMatchObject({ state: 'available', availableTokens: 10 })
  admitted(limits.acquire(inspection, 10, undefined, { scope, maxTokens: 50 })).settle(10)
  expect(notices()).toHaveLength(2)
})

it.each(['interrupted', 'no receipt'])('holds only the strict pools after an inspection with %s usage', mode => {
  configure(grant)
  const first = admitted(limits.acquire(inspection, 20, undefined, grant))
  if (mode === 'no receipt') first.settle(null)
  restart(); first.settle(5)
  limits.recover()
  expect(limits.inspectionBudget(scope, 100)).toMatchObject({ state: 'usage-missing', accountedTokens: null, reportedCalls: 0,
    reservedTokens: 0, availableTokens: null, inFlight: [],
    missing: [{ sessionId: inspection.session_id, calls: 1, interrupted: mode === 'interrupted' ? 1 : 0 }] })
  expect(notices()).toEqual([expect.objectContaining({ scope: 'inspection', reason: 'usage-missing', resource: 'project/inspection' })])
  configure({ scope, maxTokens: 120 })
  expect(limits.acquire(inspection, 1, undefined, { scope, maxTokens: 120 })).toMatchObject({ admitted: false })
  saveWorkerTicket()
  admitted(limits.acquire(worker, 60)).settle(50)
  expect(limits.view('ticket-one')).toMatchObject({ budget: { accountedTokens: 50, availableTokens: 10, missing: [] },
    projectBudget: { state: 'unlimited', accountedTokens: 50, missing: [{ sessionId: inspection.session_id, calls: 1 }] } })
  configure(grant, 200)
  expect(limits.view()?.budget.state).toBe('usage-missing')
  expect(limits.acquire(worker, 1)).toMatchObject({ admitted: false })
  expect(notices().map(notice => notice.scope)).toEqual(['inspection', 'project'])
})

it('refuses a missing, forged, stale or conflicting grant without leaving a reservation', () => {
  configure(grant)
  saveWorkerTicket()
  for (const decision of [
    limits.acquire(inspection, 1), limits.acquire(hub, 1, undefined, grant),
    limits.acquire({ ...inspection, roles: ['hub', 'inspection'] }, 1, undefined, grant),
    limits.acquire({ ...inspection, ticket_id: 'ticket-one' }, 1, undefined, grant),
    limits.acquire({ ...inspection, plan_id: 'plan-one' }, 1, undefined, grant),
    limits.acquire(inspection, 1, undefined, { scope: 'other.txt', maxTokens: 100 }),
    limits.acquire(inspection, 1, undefined, { scope, maxTokens: 101 }),
  ]) expect(decision).toMatchObject({ admitted: false })
  expect(limits.view()?.budget.inFlight).toEqual([])
  expect(inspectionRefused).not.toHaveBeenCalled()
  configure({ scope, maxTokens: 0 })
  expect(limits.acquire(inspection, 1, undefined, { scope, maxTokens: 0 })).toMatchObject({ admitted: false })
  expect(limits.inspectionBudget(scope, 0)).toMatchObject({ state: 'exhausted', reportedCalls: 0 })
  expect(notices()).toHaveLength(1)
})

it('tells the scheduler when a verified inspection cannot fit, without spending quota or mistaking it for exhaustion', () => {
  configure(grant, 150)
  admitted(limits.acquire(inspection, 50, undefined, grant)).settle(50)
  for (const bound of [null, 51]) {
    const result = limits.acquire(inspection, bound, undefined, grant)
    if (result.admitted) throw new Error('Unverifiable or unfittable request reached the provider')
    expect(result.requiresOperator).toBe(true)
    expect(inspectionRefused).toHaveBeenLastCalledWith(inspection.session_id, result.reason)
  }
  const raised = { scope, maxTokens: 200 }
  configure(raised, 150)
  const projectRefusal = limits.acquire(inspection, 101, undefined, raised)
  expect(projectRefusal).toMatchObject({ admitted: false, requiresOperator: true })
  expect(limits.acquire(hub, 101)).toMatchObject({ admitted: false, requiresOperator: true })
  expect(inspectionRefused).toHaveBeenCalledTimes(3)
  expect(limits.inspectionBudget(scope, 200)).toMatchObject({ state: 'available', availableTokens: 150, reportedCalls: 1, inFlight: [] })
  admitted(limits.acquire(inspection, 51, undefined, raised)).settle(1)
  expect(notices()).toEqual([])
})
