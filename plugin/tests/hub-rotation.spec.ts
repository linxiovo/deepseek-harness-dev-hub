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
