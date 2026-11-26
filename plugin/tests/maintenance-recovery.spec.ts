import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind, feishuTrigger, historyEvent } from '../src/sources/feishu.ts'
import { pollBoundTopic } from '../src/sources/feishu-loops.ts'
import { cursorAt } from '../src/sources/poll.ts'
import { feishu, MEMBER, startManagedProject, type Host } from './fixtures/host.ts'
import captured from './fixtures/feishu-bound-private-lark-cli-1.0.100.json' with { type: 'json' }

let host: Host, project: string
beforeEach(async () => {
  const mounted = await startManagedProject()
  host = mounted.host
  project = mounted.project.id
})
afterEach(async () => { await host?.stop() })

const read = (resource: string) => host.runTool(host.runtime.masterId, 'orchestrator_read', { resource })
const startStageTwo = () => host.runtime.store.set(KV.plans.maintenanceStarted, {
  deliveredPlan: 'prior-delivery', startedAt: new Date().toISOString(),
})
async function history() {
  await using log = await host.ctx.sessionPersistence.open(host.runtime.masterId as SessionId, 'read')
  return (await log.read()).events
}
async function expectNoDispatch() {
  expect(await read('tickets')).toEqual({ items: [], next_offset: null })
  expect(host.deliveries.mock.calls.map(([delivery]) => delivery.sessionId).filter(id => id.startsWith('worker-'))).toEqual([])
}

it('offers the next unmentioned maintenance request only after the bound group gains all-message intake', async () => {
  const source = host.runtime.context(feishuKind)
  const anchor = feishu('71', 'Selected group')
  await source.receive(anchor)
  expect(await host.api('POST', 'topic-binding', { triggerId: anchor.id, allowedActors: [MEMBER] }, project)).toMatchObject({ status: 200 })
  const { config } = host.runtime.sources.instance('feishu')!
  const saved = await host.api('PUT', 'settings/source:feishu', { revision: host.runtime.settings.block('source:feishu').revision,
    value: { enabled: true, config: { ...config, chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } }, project)
  expect(saved.status).toBe(200)
  const revision = Number(saved.body.revision)
  startStageTwo()
  const meta = { root_id: 'om_71', mentions: [], message_type: 'text', create_time: String(Date.now()) }
  const path = 'settings-confirmations'
  const proposal = await host.api('POST', path, { revision, change: { object: 'feishuChat', chatId: 'oc_team', value: 'all' } }, project)
  expect(proposal).toMatchObject({ status: 200, body: { status: 'pending', effectiveValue: 'mentions' } })
  await source.receive(feishu('72', 'Correct the typo in the catalogue.', meta))
  expect(await read('maintenance')).toEqual({ items: [], next_offset: null })
  expect(await host.api('POST', `${path}/${proposal.body.id}/approve`, { revision }, project)).toMatchObject({ status: 200, body: { effectiveValue: 'all' } })
  const next = feishu('73', 'Fix the missing invoice label.', meta)
  await source.receive(next)
  await source.receive(feishu('74', 'Wrong topic', { ...meta, root_id: 'om_elsewhere' }))
  expect(await read('maintenance')).toEqual({ items: [{ event_id: next.id, read: `maintenance/${next.id}` }], next_offset: null })
  expect(await read(`maintenance/${next.id}`)).toMatchObject({ text: 'Fix the missing invoice label.', status: 'pending' })
  await expectNoDispatch()
})

it('keeps the original maintenance wake-up when the durable inbox has not entered the turn', async () => {
  startStageTwo()
  const hub = host.runtime.masterId
  const text = 'Correct the label “Widgtes” to “Widgets”.'
  host.sendUserMessage(hub, text)
  const pending = await read('maintenance') as { items: { event_id: string; read: string }[] }
  expect(pending.items).toHaveLength(1)
  const event = pending.items[0]!
  expect(await read(event.read)).toMatchObject({ status: 'pending', text })

  host.hooks.deferStep = delivery => delivery.sessionId === hub && delivery.text.includes('"kind":"maintenance-pending"')
  await host.restart()
  await host.idleRelay()
  const inbox = host.agents.get(hub)!.inbox
  const target = inbox.nextTurn.length ? 'next-turn' : 'next-step'
  const queued = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
  expect(queued).toEqual([expect.objectContaining({ content: [{ type: 'text', text: '{"kind":"maintenance-pending","read":"maintenance"}' }] })])
  const wake = queued[0]!
  host.record(hub, [{ type: 'agent/inbox/spliced', data: { target, start: 0, inserted: [wake] } }])
  const wakeMessages = async () => (await history()).flatMap(entry => entry.type === 'user/message' &&
    entry.data.content.some(block => block.type === 'text' && block.text.includes('"kind":"maintenance-pending"')) ? [entry.data] : [])
  expect(await wakeMessages()).toEqual([])

  delete host.hooks.deferStep
  // The DSH fixture reloads the log but does not project its durable inbox on startup.
  host.controller.resolveAgent.mockImplementation(async session => {
    const restoring = session === hub && !host.agents.has(hub)
    const resolved = await host.resolveDefault(session)
    if (restoring && resolved.agent) {
      for (const entry of await history()) {
        if (entry.type === 'agent/inbox/spliced') {
          const { target, start, removedCount, inserted } = entry.data
          const queue = target === 'next-turn' ? resolved.agent.inbox.nextTurn : resolved.agent.inbox.nextStep
          queue.splice(start, removedCount ?? 0, ...inserted)
        }
      }
    }
    return resolved
  })
  await host.restart()
  await host.idleRelay()
  const restored = host.agents.get(hub)!.inbox
  expect([...restored.nextTurn, ...restored.nextStep].map(message => message.id)).toEqual([wake.id])
  expect(await host.nativeStep(hub, { starts: true })).toBe(true)
  expect(await wakeMessages()).toEqual([expect.objectContaining({ id: wake.id, content: wake.content })])
  expect(await read('maintenance')).toEqual(pending)
  expect(await read(event.read)).toMatchObject({ status: 'pending', text })
  expect(host.runtime.plans.list()).toEqual([])
  await expectNoDispatch()
})

it('recovers native input missing its maintenance record without authorizing input received while off', async () => {
  startStageTwo()
  const hub = host.runtime.masterId
  const revoked = 'Correct the label “Teh” to “The”.', text = 'Correct the label “Toosl” to “Tools”.'
  const setMode = async (mode: 'off' | 'auto') => {
    const { revision, value } = JSON.parse(String((await read('settings/eval')).text))
    expect(await host.api('PUT', 'settings/eval', { revision, value: { ...value, mode } }, project)).toMatchObject({ status: 200 })
  }
  const native = (id: string, text: string) => freezeMessage({ id: MessageId(id), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text }] }) as UserMessage
  const plan = (request: string) => ({ kind: 'plan', scope: request, intentEvidence: request,
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: request },
    ruleAssessments: [{ rule_id: 'copy', matched: true, reason: 'Exact spelling correction.' },
      { rule_id: 'visual', matched: false, reason: 'Does not change styling.' }],
    spec: { body: request, acceptance: [{ statement: request, observable: 'The label shows the corrected spelling.', delivery: 'backend' }],
      testInterfaces: [{ seam: 'label()', kind: 'existing', note: 'Call the public label formatter.' }], outOfScope: [] },
    draft: { features: [{ id: 'label', kind: 'backend' }], nodes: [{ id: 'label', featureId: 'label', title: 'Correct the label',
      role: 'backend', acceptance: [1], blockedBy: [], demonstration: 'Read the corrected label.' }] } })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const start = Date.now()
    await setMode('off')
    vi.setSystemTime(start + 10)
    host.sendUserMessage(hub, revoked)
    vi.setSystemTime(start + 20)
    await setMode('auto')
    await expect(host.runTool(hub, 'orchestrator_maintenance', { verdict: plan(revoked) }))
      .rejects.toThrow(/authorization/i)
    expect(await read('maintenance')).toEqual({ items: [], next_offset: null })

    vi.setSystemTime(start + 30)
    await host.runtime.stop()
    host.agents.delete(hub)
    // The native log has the message; the stopped plugin cannot record it.
    host.record(hub, [{ type: 'user/message', data: native('maintenance-restart-native', text) }])
    await host.restart()
    const pending = await read('maintenance') as { items: { event_id: string; read: string }[] }
    expect(pending.items).toHaveLength(1)
    const event = pending.items[0]!
    expect(await read(event.read)).toMatchObject({ status: 'pending', actor: { source: 'harness', id: hub }, text })
    await host.restart()
    expect(await read('maintenance')).toEqual(pending)
    expect(host.runtime.plans.list()).toEqual([])
    const adjudication = { event_id: event.event_id, verdict: plan(text) }
    const result = await host.runTool(hub, 'orchestrator_maintenance', adjudication)
    expect(result).toMatchObject({ status: 'registered', planId: expect.any(String) })
    expect(await host.runTool(hub, 'orchestrator_maintenance', adjudication)).toEqual(result)
    expect(host.runtime.plans.list().map(plan => plan.id)).toEqual([result.planId])
    expect(await read('maintenance')).toEqual({ items: [], next_offset: null })
    await expectNoDispatch()
  } finally { vi.useRealTimers() }
})

it.each(['rebind', 'enter Stage 2'] as const)('refuses a Feishu status reply when workspace validation overlaps %s', async change => {
  const context = host.runtime.context(feishuKind)
  const meta = () => ({ mentions: [], message_type: 'text', create_time: String(Date.now()) })
  const anchor = feishu('1', 'Project discussion', meta())
  await context.receive(anchor)
  const bind = async () => expect(await host.api('POST', 'topic-binding', { triggerId: anchor.id, allowedActors: [MEMBER] }, project))
    .toMatchObject({ status: 200 })
  await bind()
  const topic = context.feishuTopic!, epoch = topic.target()!.epoch
  if (change === 'rebind') startStageTwo()
  const trigger = feishu('2', '状态', { ...meta(), root_id: 'om_1', ...(change === 'enter Stage 2' && { reply_to: 'om_1' }) })
  const validating = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  vi.spyOn(host.runtime.installation, 'validateWorkspace').mockImplementationOnce(async () => {
    validating.resolve()
    await resume.promise
    return host.localGit!.repository
  })
  const replyCount = () => vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply')).length
  const receiving = topic.receive(trigger, epoch)
  let before = 0
  try {
    await Promise.race([validating.promise, receiving.then(result => { throw new Error(`Received ${result} before workspace validation`) })])
    if (change === 'rebind') {
      expect(await host.api('POST', 'topic-binding/unbind', undefined, project)).toMatchObject({ status: 200 })
      await bind()
      expect(topic.target()!.epoch).not.toBe(epoch)
    } else {
      expect(await read('project/stage')).toEqual({ stage: 1 })
      startStageTwo()
    }
    await host.runtime.sendReplies()
    before = replyCount()
  } finally { resume.resolve(); await receiving }
  expect(await receiving).toBe('filtered')
  await host.runtime.sendReplies()
  expect(replyCount()).toBe(before)
  expect(await read('project/stage')).toMatchObject({ stage: 2 })
  expect(await read('maintenance')).toEqual({ items: [], next_offset: null })
  expect(host.runtime.plans.list()).toEqual([])
  await expectNoDispatch()
})

it('backfills one maintenance event from captured Feishu private-chat messages without admitting the root reply', async () => {
  const { root, standalone, rootReply } = captured
  const normalize = (event: unknown) => feishuTrigger(event, 'ou_bot', 'cli_bot')!
  const anchor = normalize(root), feedback = normalize(standalone.live), reply = normalize(rootReply.live)
  for (const pair of [standalone, rootReply]) {
    expect(pair.live).toMatchObject({ chat_id: root.chat_id, chat_type: 'p2p', message_type: 'text' })
    expect(pair.history).toMatchObject({ chat_id: root.chat_id, chat_type: 'p2p', message_id: pair.live.message_id, msg_type: 'text' })
    expect(normalize(historyEvent(pair.history, root.chat_id, true))).toEqual(normalize(pair.live))
  }
  expect(feedback.meta.mentioned).toBe(false)
  expect(feedback.meta).not.toHaveProperty('parentId')
  expect(feedback.meta).not.toHaveProperty('rootId')
  expect(reply.meta).toMatchObject({ parentId: root.message_id, rootId: root.message_id })
  expect(rootReply.live.reply_to).toBe(root.message_id)
  expect(rootReply.history.parent_id).toBe(root.message_id)

  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(anchor.at) })
  try {
    startStageTwo()
    const context = host.runtime.context(feishuKind)
    await context.receive(anchor)
    const bound = await host.api('POST', 'topic-binding', { triggerId: anchor.id, allowedActors: [MEMBER] }, project)
    expect(bound, JSON.stringify(bound.body)).toMatchObject({ status: 200 })
    await host.runtime.sendReplies()
    const topic = context.feishuTopic!.target()!
    const signal = new AbortController().signal
    const lark = vi.mocked(Commands.prototype.lark)
    vi.setSystemTime(Date.parse(feedback.at))
    lark.mockResolvedValueOnce({ items: [], has_more: false })
    await pollBoundTopic(context, topic, signal, topic.since, feedback.at)
    expect(await read('maintenance')).toEqual({ items: [], next_offset: null })

    vi.setSystemTime(Date.parse(reply.at))
    lark.mockResolvedValueOnce({ items: [standalone.history, rootReply.history], has_more: false })
    await pollBoundTopic(context, topic, signal, cursorAt(feedback.at), reply.at)
    expect(await context.receive(feedback)).toBe('duplicate')
    const resource = `maintenance/${feedback.id}`
    expect(await read('maintenance')).toEqual({ items: [{ event_id: feedback.id, read: resource }], next_offset: null })
    expect(await read(resource)).toMatchObject({ status: 'pending', actor: { source: 'feishu', id: MEMBER }, text: standalone.live.content })
    await expect(read(`maintenance/${reply.id}`)).rejects.toThrow('Unknown maintenance event')
    expect(host.runtime.plans.list()).toEqual([])
    await expectNoDispatch()
  } finally { vi.useRealTimers() }
})
