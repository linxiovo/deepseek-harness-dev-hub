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
  const direct = { id: 'direct-user-pending', role: 'user', content: [{ type: 'text', text: '请继续处理这个项目' }], source: { kind: 'user' } }
  old.inbox.nextTurn.push(direct as never)
  const dispatchesBefore = h.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === sessionId).length

  const rotated = await h.runtime.rotateHub()

  expect(rotated).not.toBe(oldId)
  expect(h.runtime.masterId).toBe(rotated)
  expect(h.runtime.store.get(KV.runtime.authority)).toMatchObject({ phase: 'active', epoch: 1, sessionId: rotated,
    generations: expect.arrayContaining([expect.objectContaining({ sessionId: oldId, status: 'retired' })]) })
 expect(h.agents.get(rotated)?.inbox.nextTurn).toContainEqual(direct)
 const resume = h.agents.get(rotated)?.inbox.nextTurn.find(message => message.id === 'dsh-superagent:hub-resume:1')
 const resumeText = resume?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
 expect(resumeText).toContain('"pending_events"')
 expect(resumeText).toContain('"actions"')
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
 h.runtime.store.set(KV.runtime.transfer(rotated), { fromSessionId: oldId, targetSessionId: rotated, messages: [pending as never] })
 for (const inbox of [h.agents.get(rotated)?.inbox.nextStep, h.agents.get(rotated)?.inbox.nextTurn]) {
   const index = inbox?.findIndex(message => message.id === pending.id) ?? -1
   if (index >= 0) inbox?.splice(index, 1)
 }
 await h.restart()
 expect(h.agents.get(rotated)?.inbox.nextTurn).toContainEqual(pending)
 expect(h.runtime.store.get(KV.runtime.transfer(rotated))).toBeUndefined()
})
