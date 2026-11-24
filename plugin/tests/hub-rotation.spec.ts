import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { realGit: true }) })
afterEach(async () => { await h.stop() })

it('rotates the Hub authority without losing a queued direct input or replaying a Worker dispatch', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复回归'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '补充一个待处理事实', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  const oldId = h.runtime.masterId
  const old = h.agents.get(oldId)!
  old.status = 'idle' // The fixture does not finish the earlier assessment turn automatically.
  const direct = { id: 'direct-user-pending', role: 'user', content: [{ type: 'text', text: '请继续处理这个项目' }], source: { kind: 'user' } }
  old.inbox.nextTurn.push(direct as never)
  const dispatchesBefore = h.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === sessionId).length

  const rotated = await h.runtime.rotateHub()

  expect(rotated).not.toBe(oldId)
  expect(h.runtime.masterId).toBe(rotated)
  expect(h.runtime.store.get(KV.runtime.authority)).toMatchObject({ phase: 'active', epoch: 1, sessionId: rotated,
    generations: expect.arrayContaining([expect.objectContaining({ sessionId: oldId, status: 'retired' })]) })
 const delivered = h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === rotated)
 expect(delivered).toContainEqual(expect.objectContaining({ id: direct.id, text: '请继续处理这个项目' }))
 await expect(h.runTool(rotated, 'orchestrator_plan_requirements', { mode: 'preview' })).rejects.toThrow(/single text message/i)
 const resume = delivered.find(message => message.id === 'dsh-superagent:hub-resume:1')
 const resumeText = resume?.text ?? ''
 const summary = JSON.parse(resumeText.slice(resumeText.lastIndexOf('\n') + 1)) as Record<string, unknown>
 expect(summary).toMatchObject({ project: null, counts: { pending_events: 1 }, truncated: { pending_events: false, text: false } })
 expect(resumeText).toContain(`ticket/${ticket.id}`)
 expect(h.runtime.store.tickets.get(ticket.id)?.undelivered).toHaveLength(1)
 expect(h.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === sessionId)).toHaveLength(dispatchesBefore)
 const staleTool = h.tools.get(oldId)?.get('orchestrator_route')
 await expect(staleTool?.execute({ decisions: [{ kind: 'ignore', trigger_id: 'om_2', reason: 'stale Hub command' }] },
   { signal: new AbortController().signal })).rejects.toThrow(/inactive|current|rotat/i)

 await h.runtime.settings.pause(false, 'panel')
 await h.runtime.idle()
 await h.restart()
 expect(h.runtime.masterId).toBe(rotated)
 expect(h.agents.get(oldId)).toBeUndefined()
 expect(h.agents.get(rotated)).toBeDefined()
})

it('lets the current Hub finish a claimed direct input before granting authority to its successor', async () => {
 const oldId = h.runtime.masterId
 const old = h.agents.get(oldId)!
 const message = { id: 'direct-already-claimed', role: 'user', content: [{ type: 'text', text: '请处理已经认领的工作' }], source: { kind: 'user' } }
 old.followup(message as never)
 // DSH removes claimed input from its inbox; the lightweight fixture retains it.
 expect(old.inbox.nextTurn.shift()?.id).toBe(message.id)
 expect(old.status).toBe('running')
 const rotation = h.runtime.rotateHub()
 try {
   await new Promise<void>(resolve => setImmediate(resolve))
   expect(h.runtime.masterId).toBe(oldId)
   expect(old.status).toBe('running')
 } finally {
   old.status = 'idle'
   await rotation
 }
 expect(h.runtime.masterId).toBe(await rotation)
 expect(h.runtime.masterId).not.toBe(oldId)
 expect(h.deliveries.mock.calls.filter(([delivery]) => delivery.id === message.id).map(([delivery]) => delivery.sessionId))
   .toEqual([oldId])
})

it('delivers a post-rotation assessment to the current Hub Session', async () => {
 const oldId = h.runtime.masterId
 const rotated = await h.runtime.rotateHub()
 h.deliveries.mockClear()
 const trigger = feishu('3', '@bot 请检查新的回归事实')
 expect(h.runtime.receive(trigger)).toBe('stored')
 await h.runtime.idle()
 const candidates = h.deliveries.mock.calls.filter(([delivery]) => {
   try { return JSON.parse(delivery.text).kind === 'candidate' } catch { return false }
 })
 expect(candidates).toHaveLength(1)
 expect(candidates[0]?.[0].sessionId).toBe(rotated)
 expect(candidates[0]?.[0].sessionId).not.toBe(oldId)
})

it('replays a durable Hub inbox transfer after activation and restart', async () => {
 const oldId = h.runtime.masterId
 const rotated = await h.runtime.rotateHub()
 const pending = { id: 'direct-user-recovery', role: 'user', content: [{ type: 'text', text: '恢复这条尚未交接的输入' }], source: { kind: 'user' } }
 h.runtime.store.set(KV.runtime.transfer(oldId), [pending as never])
 h.deliveries.mockClear()
 await h.restart()
 const delivered = h.deliveries.mock.calls.filter(([delivery]) => delivery.id === pending.id).map(([delivery]) => delivery)
 expect(delivered).toHaveLength(1)
 expect(delivered[0]?.sessionId).toBe(rotated)
 expect(h.runtime.store.get(KV.runtime.transfer(oldId))).toBeUndefined()
 expect(h.runtime.store.get(KV.runtime.transferred(oldId, pending.id))).toBe(true)
})

it('persists inputs claimed by a retired Hub after activation for the current Hub', async () => {
 const oldId = h.runtime.masterId
 const rotated = await h.runtime.rotateHub()
 const late = { id: 'late-user-after-transfer', role: 'user', content: [{ type: 'text', text: '轮换完成后到达的输入' }], source: { kind: 'user' } }
 h.agents.get(oldId)?.followup(late as never)
 h.claim(oldId)
 await h.runtime.idle()
 expect(h.deliveries.mock.calls.map(([delivery]) => delivery)).toContainEqual(expect.objectContaining({
   sessionId: rotated, id: late.id, text: '轮换完成后到达的输入' }))
 await expect(h.runTool(rotated, 'orchestrator_plan_requirements', { mode: 'preview' })).rejects.toThrow(/single text message/i)
})

it('treats persisted Hub authority as canonical over the legacy Session mirror', async () => {
 const rotated = await h.runtime.rotateHub()
 h.runtime.store.set(KV.runtime.masterId, 'stale-legacy-session-id')
 await h.restart()
 expect(h.runtime.masterId).toBe(rotated)
 expect(h.runtime.store.get(KV.runtime.authority)).toMatchObject({ sessionId: rotated, epoch: 1, phase: 'active' })
})

it('reconciles a transferred input persisted before its receipt without delivering it twice', async () => {
 const oldId = h.runtime.masterId
 const rotated = await h.runtime.rotateHub()
 expect(rotated).not.toBe(oldId)
 const message = { id: 'dsh-superagent:late-transfer', role: 'user', content: [{ type: 'text', text: '一条待回执的迁移输入' }],
   source: { kind: 'dsh-superagent', form: 'relay' } }
 h.runtime.store.set(KV.runtime.transfer(oldId), [message as never])
 const target = h.agents.get(rotated)!
 target.status = 'idle' // Let the test host claim and record the transferred message.
 const isTransferred = () => h.runtime.store.get(KV.runtime.transferred(oldId, message.id))
 const isTargetMessage = (event: SessionEvent) => event.type === 'user/message' && event.data.id === message.id
 let interrupted = false
 h.hooks.flushSessionLog = () => {
   if (!isTransferred() && h.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === rotated && delivery.id === message.id)) {
     interrupted = true
     throw new Error('interrupt before recording the inbox transfer receipt')
   }
 }
 h.runtime.effects.enqueue('hubInbox', oldId, {})
 await h.runtime.effects.idle('hubInbox')
 expect(interrupted).toBe(true)
 expect(isTransferred()).toBeUndefined()
 expect(h.runtime.store.get(KV.runtime.transfer(oldId))).toEqual([message])
 {
   await using log = await h.ctx.sessionPersistence.open(rotated as SessionId, 'read')
   expect((await log.read(0, 512)).events.filter(isTargetMessage)).toHaveLength(1)
 }
 expect(h.deliveries.mock.calls.filter(([delivery]) => delivery.id === message.id).map(([delivery]) => delivery))
   .toEqual([expect.objectContaining({ sessionId: rotated, id: message.id })])
 h.hooks.flushSessionLog = undefined
 await h.restart()
 expect(isTransferred()).toBe(true)
 expect(h.deliveries.mock.calls.filter(([delivery]) => delivery.id === message.id).map(([delivery]) => delivery))
   .toEqual([expect.objectContaining({ sessionId: rotated, id: message.id })])
})
