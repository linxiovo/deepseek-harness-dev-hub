import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { KV } from '../src/kv.ts'
import { startManagedProject, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { vi.useRealTimers(); await host?.stop(); host = undefined })

const readTool = 'orchestrator_inspection_read', finishTool = 'orchestrator_inspection_finish'
async function saveInspector(h: Host, project: string, extra: Record<string, unknown>) {
  const current = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'settings/executor' })
  const { revision, value } = JSON.parse(String(current.text))
  return h.api('PUT', 'settings/executor', { revision, value: { ...value, ...extra } }, project)
}
async function tick(h: Host, at: number) {
  vi.setSystemTime(at); await h.runtime.pump(); await h.runtime.idle()
}
async function inspectionView(h: Host, project: string) {
  const response = await h.api('GET', 'project/inspection', undefined, project)
  expect(response.status).toBe(200)
  return response.body
}
const run = z.object({ lastRun: z.object({ sessionId: z.string().startsWith('inspection-'), status: z.string() }) })

it('starts one scoped inspection only after the operator supplies a complete grant and its interval elapses', async () => {
  const mounted = await startManagedProject()
  const runtime = (host = mounted.host).runtime, projectId = mounted.project.id
  vi.useFakeTimers({ toFake: ['Date'] })
  const start = Date.now()
  runtime.store.set(KV.plans.maintenanceStarted, { deliveredPlan: 'prior-delivery', startedAt: new Date(start).toISOString() })
  const inspections = () => [...mounted.host.agents.keys()].filter(id => id.startsWith('inspection-'))
  const advance = (ms: number) => tick(mounted.host, start + ms)
  await advance(100_000)
  expect(inspections()).toEqual([])
  const block = await host.runTool(runtime.masterId, 'orchestrator_read', { resource: 'settings/executor' })
  const { revision, value } = JSON.parse(String(block.text))
  const save = (idleInspection: unknown) => mounted.host.api('PUT', 'settings/executor', { revision, value: { ...value, idleInspection } }, projectId)
  for (const incomplete of [{ intervalSeconds: 10, maxTokens: 100 }, { scope: 'shared.txt', maxTokens: 100 }, { scope: 'shared.txt', intervalSeconds: 10 }]) {
    expect((await save(incomplete)).status).toBe(400)
  }
  expect((await save({ scope: 'shared.txt', intervalSeconds: 10, maxTokens: 100 })).status).toBe(200)
  await advance(109_999)
  expect(inspections()).toEqual([])
  await advance(110_000)
  expect(inspections()).toHaveLength(1)
  await advance(110_000)
  expect(inspections()).toHaveLength(1)
  const id = inspections()[0]!
  expect((await host.api('GET', 'project/inspection')).body.code).toBe('projectScopeRequired')
  expect((await host.api('GET', 'project/inspection', undefined, 'another-project')).body.code).toBe('staleProject')
  expect((await saveInspector(host, projectId, { idleInspection: null })).status).toBe(200)
  await expect(host.modelTool(id, readTool, { path: 'shared.txt', offset: 0 })).rejects.toThrow()
  host.sendUserMessage(runtime.masterId, 'Correct the label “Widgtes” to “Widgets”.')
  await advance(900_000)
  expect(inspections()).toEqual([id])
  expect(await host.runTool(runtime.masterId, 'orchestrator_read', { resource: 'maintenance' })).toMatchObject({ items: [expect.anything()] })
  expect(await inspectionView(host, projectId)).toMatchObject({ grant: null, lastRun: { sessionId: id, status: 'withdrawn' }, items: [] })
})

it('reads pinned content, chooses the configured route, and associates repeat evidence without dispatching work', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, project = mounted.project.id, git = h.localGit!
  vi.useFakeTimers({ toFake: ['Date'] }); const start = Date.now()
  h.runtime.store.set(KV.plans.maintenanceStarted, { deliveredPlan: 'prior-delivery', startedAt: new Date(start).toISOString() })
  const stage = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'project/stage' })
  const grant = { scope: 'shared.txt', intervalSeconds: 10, maxTokens: 100 }
  const model = { provider: 'fixture', model: 'small-model' }
  expect((await saveInspector(h, project, { idleInspection: grant, lightweightModel: model })).status).toBe(200)
  const provider = vi.fn(async function*(_request: { provider: string; model: string }): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  let firstId = ''
  for (let i = 1; i <= 3; i++) {
    await tick(h, start + i * 10_000)
    const state = await inspectionView(h, project), { sessionId } = run.parse(state).lastRun
    expect(state.lastRun).toMatchObject({ status: 'running', commit: git.base.sha, model: i === 3 ? null : model })
    await using log = await h.ctx.sessionPersistence.open(sessionId as SessionId, 'read')
    const selection = (await log.read()).events.filter(event => event.type === 'model/selection')
    expect(selection.map(event => event.data)).toEqual(i === 3 ? [] : [model])
    for (const name of ['write', 'edit', 'bash', 'orchestrator_plan_register', 'read']) {
      await expect(h.runTool(sessionId, name, { path: 'shared.txt', content: 'overwritten' })).rejects.toThrow(/not registered/)
    }
    if (i === 1) {
      firstId = sessionId
      await expect(h.modelTool(sessionId, readTool, { path: 'outside.txt', offset: 0 })).rejects.toThrow(/scope/i)
      await h.modelTool(sessionId, readTool, { path: 'shared.txt', offset: 9 })
      await expect(h.modelTool(sessionId, finishTool, { findings: [] })).rejects.toThrow(/read/i)
    }
    await h.modelRequest(sessionId, 20, provider)
    expect(provider).toHaveBeenLastCalledWith(expect.objectContaining(i === 3 ? { provider: 'fixture', model: 'fixture-model' } : model))
    h.record(sessionId, [{ type: 'assistant/message', data: { turn: 1, step: 4, message: { role: 'assistant', content: [] },
      stream: [], usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } }])
    expect(await h.modelTool(sessionId, readTool, { path: 'shared.txt', offset: 0 })).toMatchObject({ kind: 'file', text: 'baseline\n' })
    if (i === 1) await expect(h.modelTool(sessionId, finishTool, { findings: [{ path: 'shared.txt', offset: 0,
      evidence: 'not in the file', summary: 'Unchecked claim' }] })).rejects.toThrow(/evidence|quote/i)
    await h.modelTool(sessionId, finishTool, { findings: i === 3 ? [] : [{ path: 'shared.txt', offset: 0, evidence: i === 1 ? 'baseline' : 'base',
      summary: i === 1 ? 'Clarify this label.' : 'Same issue described differently.' }] })
    const view = await inspectionView(h, project)
    expect(view.lastRun).toMatchObject({ status: 'completed', todoIds: i === 3 ? [] : [expect.any(String)] })
    expect(view.items).toEqual([expect.objectContaining({ projectId: project, path: 'shared.txt', summary: 'Clarify this label.',
      first: expect.objectContaining({ sessionId: firstId }), ...(i < 3 && { latest: expect.objectContaining({ sessionId }) }) })])
    expect((await h.api('GET', 'project/meter', undefined, project)).body).toMatchObject({ shared: { reported_total_tokens: i * 10 },
      sessions: expect.arrayContaining([expect.objectContaining({ session_id: sessionId, roles: ['inspection'], ticket_id: null, plan_id: null,
        parent_session_id: h.runtime.masterId, log_status: 'available' })]) })
    if (i === 2) expect((await saveInspector(h, project, { lightweightModel: null })).status).toBe(200)
  }
  await h.restart()
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'project/inspection' })).toEqual(await inspectionView(h, project))
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'project/stage' })).toEqual(stage)
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'tickets' })).toMatchObject({ items: [] })
  expect(git.git('rev-parse', 'refs/heads/main')).toBe(git.base.sha)
  expect(git.git('status', '--porcelain')).toBe('')
  expect(readFileSync(join(git.repository, 'shared.txt'), 'utf8')).toMatch(/^baseline\r?\n$/)
})

it('yields to pending maintenance and never replays an already consumed task after restart', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, project = mounted.project.id, hub = h.runtime.masterId
  vi.useFakeTimers({ toFake: ['Date'] }); const start = Date.now()
  const idleInspection = { scope: 'shared.txt', intervalSeconds: 2, maxTokens: 50 }
  expect((await saveInspector(h, project, { idleInspection })).status).toBe(200)
  await tick(h, start + 3000)
  expect((await inspectionView(h, project)).lastRun).toBeNull() // The clock cannot bypass Stage 1.
  h.runtime.store.set(KV.plans.maintenanceStarted, { deliveredPlan: 'verified-delivery', startedAt: new Date(start).toISOString() })
  h.sendUserMessage(hub, 'Please correct the typo in the label.')
  await tick(h, start + 4000)
  expect((await inspectionView(h, project)).lastRun).toBeNull()
  const events = z.object({ items: z.array(z.object({ event_id: z.string() })).length(1) }).parse(
    await h.runTool(hub, 'orchestrator_read', { resource: 'maintenance' }))
  await h.runTool(hub, 'orchestrator_maintenance', { event_id: events.items[0]!.event_id, verdict: { kind: 'ignore', reason: 'No new work required.' } })
  await tick(h, start + 4000)
  const id = run.parse(await inspectionView(h, project)).lastRun.sessionId
  const deliveries = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === id)
  expect(deliveries()).toHaveLength(1)
  await h.restart(); await h.runtime.idle()
  expect(await inspectionView(h, project)).toMatchObject({ lastRun: { sessionId: id, status: 'failed' }, items: [] })
  expect(deliveries()).toHaveLength(1)
  await expect(h.modelTool(id, finishTool, { findings: [] })).rejects.toThrow()
})

it('does not spend an unfittable inspection bound, start another run, or block the independent project pool', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, project = mounted.project.id
  vi.useFakeTimers({ toFake: ['Date'] }); const start = Date.now()
  h.runtime.store.set(KV.plans.maintenanceStarted, { deliveredPlan: 'verified-delivery', startedAt: new Date(start).toISOString() })
  const grant = { intervalSeconds: 5, scope: 'shared.txt', maxTokens: 10 }
  expect((await saveInspector(h, project, { idleInspection: grant })).status).toBe(200)
  await tick(h, start + 5000)
  const { sessionId } = run.parse(await inspectionView(h, project)).lastRun
  const provider = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await expect(h.modelRequest(sessionId, 11, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT_CONFIGURATION' })
  expect(provider).not.toHaveBeenCalled()
  await tick(h, start + 50_000)
  expect(await inspectionView(h, project)).toMatchObject({ budget: { accountedTokens: null, reservedTokens: 0 },
    lastRun: { sessionId, status: 'quota-paused' } })
  await h.modelRequest(h.runtime.masterId, 11, provider)
  expect(provider).toHaveBeenCalledOnce()
  expect((await saveInspector(h, project, { idleInspection: { ...grant, maxTokens: 20 } })).status).toBe(200)
  await tick(h, start + 55_000)
  const next = run.parse(await inspectionView(h, project)).lastRun.sessionId
  expect(next).not.toBe(sessionId)
  await h.modelRequest(next, 10, provider); await h.modelRequest(next, 10, provider)
  await tick(h, start + 65_000)
  expect(await inspectionView(h, project)).toMatchObject({ budget: { state: 'exhausted', accountedTokens: 20 },
    pausedReason: 'exhausted', lastRun: { sessionId: next, status: 'quota-paused' } })
  expect((await h.api('GET', 'project/run-limits', undefined, project)).body.budget).toMatchObject({ state: 'unlimited', accountedTokens: 30 })
})
