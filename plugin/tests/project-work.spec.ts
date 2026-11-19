import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Handoffs } from '../src/app/handoffs.ts'
import { InstallationError } from '../src/app/installation-api.ts'
import { Plans } from '../src/app/plans.ts'
import { Store } from '../src/app/store.ts'
import type { HandoffInput } from '../src/core/handoff.ts'
import { Engine, MemoryRepositories, key, type Outcome, type Trigger } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const approval = (project: HandoffInput['project']): HandoffInput => {
  const brief = { project, goal: 'Add saved products', constraints: [], acceptanceScope: ['List saved products'],
    authorization: { scope: 'Implement and verify saved products', release: 'not-authorized' as const } }
  return { ...brief, confirmedBy: { sessionId: 'hub', messageId: '1', text: JSON.stringify({ confirmed: true, brief }) } }
}

it('gates bound handoffs before persisting and records only the canonical project', () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'bound-handoff-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const checkout = mkdirSync(join(directory, 'Checkout'), { recursive: true })!
    const otherCheckout = mkdirSync(join(directory, 'other'), { recursive: true })!
    const alias = join(directory, 'alias')
    symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const project = { id: 'registered-widgets', repository: 'Acme/Widgets', workspace: realpathSync.native(checkout) }
    const effects = new Effects(store, new HealthBoard())
    const blocked = new InstallationError(409, 'switching')
    const gate = vi.fn<() => void>().mockImplementationOnce(() => { throw blocked })
    const handoffs = new Handoffs(store, effects, project, gate)
    const approved = approval({ repository: 'acme/widgets', workspace: process.platform === 'win32' ? alias.toUpperCase() : alias })

    expect(() => handoffs.confirm(approved)).toThrow(blocked)
    for (const mismatched of [approval({ ...project, workspace: otherCheckout }), approval({ ...project, repository: 'Acme/Other' })]) {
      expect(() => handoffs.confirm(mismatched)).toThrow(/does not match the bound project/)
    }
    expect(store.keys('handoff')).toEqual([])
    expect(effects.count()).toBe(0)

    const { handoff, reused } = handoffs.confirm(approved)
    expect(reused).toBe(false)
    expect(handoff.project).toEqual(project)
    const canonical = approval({ repository: project.repository, workspace: project.workspace })
    const { confirmedBy, ...canonicalBrief } = canonical
    expect(handoff.id).toBe(key('handoff', project.id, JSON.stringify(canonicalBrief)))
    expect(store.get(KV.handoffs.current(project.id))).toBe(handoff.id)
    expect(store.get(KV.handoffs.project(project.id))).toEqual(project)
    expect(effects.pending('planning', handoff.id)).toBe(true)
    expect(handoffs.confirm(approved)).toEqual({ handoff, reused: true })
    const nextReceipt = { ...confirmedBy, messageId: '2' }
    gate.mockImplementationOnce(() => { throw blocked })
    expect(() => handoffs.confirm({ ...canonical, confirmedBy: nextReceipt })).toThrow(blocked)
    expect(store.get(KV.handoffs.confirmationReceipt(nextReceipt.sessionId, nextReceipt.messageId))).toBeUndefined()
    expect(handoffs.confirm({ ...canonical, confirmedBy: nextReceipt })).toEqual({ handoff, reused: true })

    const planning = handoffs.begin(handoff.id)
    expect(planning.project).toEqual(project)
    const { spec } = handoffs.publish(handoff.id, { body: 'Persist and list saved products',
      acceptance: [{ statement: 'List saved products', observable: 'Previously saved products appear', delivery: 'backend' }],
      testInterfaces: [{ kind: 'existing', seam: 'Product API', note: 'Save and list products' }], outOfScope: [] })
    const plan = new Plans(store, handoffs, effects).register(handoff.id, spec!.id, {
      features: [{ id: 'saved', kind: 'backend' }], nodes: [{ id: 'saved-api', featureId: 'saved', title: 'List saved products',
        role: 'backend', acceptance: [1], demonstration: 'List products after saving', blockedBy: [] }],
    })
    expect(handoffs.get(plan.handoffId)?.project).toEqual(project)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('replays a persisted legacy receipt after restart and a binding change without creating work', () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'recovered-handoff-'))
  const database = join(directory, 'state.sqlite')
  let store = new Store(database)
  try {
    const workspace = mkdirSync(join(directory, 'first'), { recursive: true })!
    const approved = approval({ repository: 'Acme/Widgets', workspace })
    const effects = new Effects(store, new HealthBoard())
    const { handoff } = new Handoffs(store, effects).confirm(approved)
    effects.cancel('planning', handoff.id)
    store.close()
    store = new Store(database)

    const switched = { id: 'second-project', repository: 'Acme/Other', workspace: mkdirSync(join(directory, 'second'), { recursive: true })! }
    const recoveredEffects = new Effects(store, new HealthBoard())
    const gate = vi.fn(() => { throw new InstallationError(409, 'switching') })
    const recovered = new Handoffs(store, recoveredEffects, switched, gate)
    const writes = vi.spyOn(store, 'set')
    expect(recovered.confirm(approved)).toEqual({ handoff, reused: true })
    expect(() => recovered.confirm(approval(switched))).toThrow(/already confirmed a different product brief/)
    expect(() => recovered.confirm({ ...approved, goal: 'A different goal' })).toThrow(/already confirmed a different product brief/)
    expect(writes).not.toHaveBeenCalled()
    expect(gate).not.toHaveBeenCalled()
    expect(recoveredEffects.count()).toBe(0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('namespaces generated Worker Session IDs while preserving legacy IDs and acceptance replay', () => {
  const now = () => '2026-11-19T12:00:00.000Z'
  const thread = { source: 'chat', id: 'same-thread' }
  const event: Trigger = { id: 'same-upstream-event', source: thread.source, threads: [thread], actor: { source: thread.source, id: 'person' },
    human: true, at: now(), text: 'Fix saved products', meta: {} }
  const outcome: Outcome = { kind: 'accept', title: 'Fix saved products', scope: 'Fix saving', reason: 'Requested' }
  const open = (projectId?: string, repo = new MemoryRepositories()) => new Engine({ projectId, repo, now,
    policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60000, revalidate: () => true, admitsInferred: () => false,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
  })
  const accept = (engine: Engine) => { engine.receive(event); return engine.decide(event.id, outcome).ticketId! }

  const legacyRepo = new MemoryRepositories()
  const legacy = accept(open(undefined, legacyRepo))
  expect(legacy).toBe(key('ticket', key('eval', 'chat:same-thread', 'direct', event.id, 'accept', now())))
  const first = accept(open('first-project'))
  const second = accept(open('second-project'))
  expect(new Set([legacy, first, second].map(workerSessionId)).size).toBe(3)
  expect(accept(open('first-project'))).toBe(first)
  expect(accept(open('first-project', legacyRepo))).toBe(legacy)
  expect(legacyRepo.tickets.list().map(ticket => ticket.id)).toEqual([legacy])
})

it('gates Hub actions that start work and still accepts stops from a configured legacy Hub', async () => {
  const host = await startRuntime()
  try {
    const { ticket } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const request = feishu('2', '@bot 顺便看看这个')
    const stop = feishu('3', '@bot 不用修了')
    host.runtime.receive(request)
    host.runtime.receive(stop)
    await host.runtime.idle()
    const blocked = new InstallationError(409, 'switching')
    const gate = vi.spyOn(host.runtime.installation, 'assertNewWork').mockImplementation(() => { throw blocked })
    const run = (name: string, args: unknown) => host.runTool(host.runtime.masterId, `orchestrator_${name}`, args)
    const before = host.runtime.store.triggers.disposition(request.id)
    await expect(run('route', { decisions: [
      { kind: 'accept', trigger_id: request.id, title: 'Fix saving', acknowledgement: 'I’ll fix saving.', worktree_name: 'fix-saving' },
      { kind: 'attach', trigger_id: request.id, ticket_id: ticket.id },
      { kind: 'stop', trigger_id: stop.id, ticket_id: ticket.id, reason: 'Stop saving work' },
    ] })).resolves.toMatchObject({ results: [{ refused: blocked.message }, { refused: blocked.message }, { decision: 'stop' }] })
    expect(gate).toHaveBeenCalledTimes(2)
    await expect(run('ticket_retry', { ticket_id: ticket.id })).rejects.toThrow(blocked)
    await expect(run('trigger_requeue', { trigger_id: request.id })).rejects.toThrow(blocked)
    await expect(run('eval_decide', { trigger_id: request.id, decision: 'accept', title: 'Fix saving', scope: 'Saving', reason: 'Request',
      rule_assessments: [], direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Fix saving' },
    })).rejects.toThrow(blocked)
    expect(host.runtime.store.triggers.disposition(request.id)).toEqual(before)
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
    expect(host.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human' })
  } finally { await host.stop() }
})
