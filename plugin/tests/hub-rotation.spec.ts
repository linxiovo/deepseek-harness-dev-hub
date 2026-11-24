import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { ROUTER_PRESET } from '../src/app/sessions.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { realGit: true }) })
afterEach(async () => { await h.stop() })

async function hubHistory(id: string) {
  await using log = await h.ctx.sessionPersistence.open(id as SessionId, 'read')
  return (await log.read(0, 512)).events.filter(event => event.type === 'user/message').map(event => event.data)
}

const directInput = (id: string, text: string, rpcId: string) => freezeMessage({
  id: MessageId(id), role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
})

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
 const history = await hubHistory(rotated)
 expect(history[0]?.id).toBe('dsh-superagent:hub-resume:1')
 expect(history.filter(message => message.id === direct.id)).toEqual([
   expect.objectContaining({ content: direct.content, source: { kind: 'dsh-superagent', form: 'relay' } }),
 ])
 await expect(h.runTool(rotated, 'orchestrator_plan_requirements', { mode: 'preview' })).rejects.toThrow(/single text message/i)
 const resume = history[0]?.content[0]
 const resumeText = resume?.type === 'text' ? resume.text : ''
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

it('finishes the admitted Hub turn without steering late input into it or admitting another old turn', async () => {
 const oldId = h.runtime.masterId
 const old = h.agents.get(oldId)!
 h.hooks.deferStep = delivery => delivery.sessionId === oldId
 const admitted = directInput('already-admitted', '正在处理的请求', 'original-rpc')
 const steer = directInput('late-steer', '轮换期间的追加输入', 'steered-rpc')
 const followup = directInput('late-queued', '轮换期间的下一条输入', 'queued-rpc')
 old.followup(admitted)
 expect(await h.nativeStep(oldId, { starts: true })).toBe(true)
 const rotation = h.runtime.rotateHub()
 try {
   old.steer(steer)
   old.followup(followup)
   expect(await h.nativeStep(oldId, { starts: false })).toBe(true)
   expect((await hubHistory(oldId)).map(message => message.id)).toEqual([admitted.id])
   expect(h.runtime.masterId).toBe(oldId)
   expect(await h.nativeStep(oldId, { starts: true })).toBe(false)
 } finally { old.status = 'idle' }
 const target = await rotation
 const history = await hubHistory(target)
 expect(history[0]?.id).toBe('dsh-superagent:hub-resume:1')
 expect(history[1]).toMatchObject({ id: steer.id, source: { originalRequestId: 'steered-rpc' } })
 expect(h.agents.get(target)!.inbox.nextTurn.map(message => message.id)).not.toContain(admitted.id)
 expect((await hubHistory(oldId)).map(message => message.id)).toEqual([admitted.id])
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
 expect(h.runtime.store.get(KV.runtime.transferred(oldId, pending.id))).toBe(rotated)
})

it('persists inputs claimed by a retired Hub after activation for the current Hub', async () => {
 const oldId = h.runtime.masterId
 const rotated = await h.runtime.rotateHub()
 const late = { id: 'late-user-after-transfer', role: 'user', content: [{ type: 'text', text: '轮换完成后到达的输入' }], source: { kind: 'user' } }
 h.hooks.deferStep = delivery => delivery.sessionId === oldId
 h.agents.get(oldId)?.followup(late as never)
 expect(await h.nativeStep(oldId, { starts: true })).toBe(false)
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
 expect(isTransferred()).toBe(rotated)
 expect(h.deliveries.mock.calls.filter(([delivery]) => delivery.id === message.id).map(([delivery]) => delivery))
   .toEqual([expect.objectContaining({ sessionId: rotated, id: message.id })])
})

it('replays the transferred request after the successor claims it but stops before writing history', async () => {
 const oldId = h.runtime.masterId
 const input = directInput('claimed-without-history', '认领后重启仍要处理', 'claim-rpc')
 h.hooks.deferStep = delivery => delivery.id === input.id
 h.agents.get(oldId)!.followup(input)
 const targetId = await h.runtime.rotateHub()
 const target = h.agents.get(targetId)!
 expect(target.inbox.nextTurn.map(message => message.id)).toContain(input.id)
 expect(await h.nativeStep(targetId, { starts: true, cut: true })).toBe(false)
 expect(target.inbox.nextTurn).toEqual([])
 expect((await hubHistory(targetId)).map(message => message.id)).toEqual(['dsh-superagent:hub-resume:1'])
 h.hooks.deferStep = undefined
 await h.restart()
 expect(h.runtime.masterId).toBe(targetId)
 expect((await hubHistory(targetId)).filter(message => message.id === input.id)).toEqual([
   expect.objectContaining({ content: input.content, source: { kind: 'dsh-superagent', form: 'relay', originalRequestId: 'claim-rpc' } }),
 ])
})

it('deduplicates a native request retried against the successor with a different message ID', async () => {
 const oldId = h.runtime.masterId
 const old = h.agents.get(oldId)!
 h.hooks.deferStep = delivery => delivery.sessionId === oldId
 const targetId = await h.runtime.rotateHub()
 const input = directInput('old-request-message', '这条请求只应处理一次', 'same-native-rpc')
 old.followup(input)
 expect(await h.nativeStep(oldId, { starts: true })).toBe(false)
 await h.runtime.idle()
 const retry = directInput('new-request-message', '这条请求只应处理一次', 'same-native-rpc')
 const target = h.agents.get(targetId)!
 target.status = 'idle'
 h.hooks.deferStep = delivery => delivery.id === retry.id
 target.followup(retry)
 expect(await h.nativeStep(targetId, { starts: true })).toBe(false)
 expect((await hubHistory(targetId)).map(message => message.id)).toEqual(['dsh-superagent:hub-resume:1', input.id])
})

it.each(['foreign workspace', 'foreign preset', 'matching header without the rotation proof'])('refuses a successor with %s', async (mismatch) => {
 const oldId = h.runtime.masterId
 const old = h.agents.get(oldId)!
 old.status = 'running'
 const rotation = h.runtime.rotateHub()
 const intent = h.runtime.store.get(KV.runtime.authority)!.rotation!
 try {
   const workspace = await h.ctx.workspaceRegistry.create(mismatch === 'foreign workspace' ? h.directory : intent.creation!.cwd)
   await h.ctx.sessionController.create({ sessionId: intent.targetSessionId as SessionId, workspaceId: workspace.id,
     agentPreset: mismatch === 'foreign preset' ? 'foreign-preset' : ROUTER_PRESET })
   h.sendUserMessage(intent.targetSessionId, 'not a direct message for this Hub')
 } finally { old.status = 'idle' }
 await expect(rotation).rejects.toThrow(/persisted creation intent/)
 expect(h.runtime.masterId).toBe(oldId)
 expect(h.runtime.hubConversation(oldId)).toBeUndefined()
 expect(h.tools.get(intent.targetSessionId)?.has('orchestrator_plan_requirements')).toBe(false)
})

it('reopens the exact proven successor after restart between its creation and activation', async () => {
 const oldId = h.runtime.masterId
 const old = h.agents.get(oldId)!
 old.status = 'running'
 const rotation = h.runtime.rotateHub()
 const target = h.runtime.store.get(KV.runtime.authority)!.rotation!.targetSessionId
 h.hooks.openingLog = id => id === target ? Promise.reject(new Error('stop after writing the creation proof')) : undefined
 old.status = 'idle'
 await expect(rotation).rejects.toThrow('stop after writing the creation proof')
 expect(h.runtime.hubConversation(oldId)).toBeUndefined()
 h.hooks.openingLog = undefined
 await h.restart()
 expect(h.runtime.masterId).toBe(target)
 expect(h.runtime.hubConversation(oldId)).toBe(target)
 expect((await hubHistory(target)).map(message => message.id)).toEqual(['dsh-superagent:hub-resume:1'])
})
