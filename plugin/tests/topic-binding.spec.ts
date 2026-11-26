import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { pollBoundTopic, runFeishu } from '../src/sources/feishu-loops.ts'
import { KV } from '../src/kv.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { gitRepository } from './fixtures/git.ts'
import { feishu, MEMBER, startRuntime, type Host } from './fixtures/host.ts'

let host: Host, root: string, project: { id: string; repository: string; workspace: string }
beforeEach(async () => {
  root = mkdtempSync(join(realpathSync.native(tmpdir()), 'topic-project-'))
  const repo = gitRepository(root)
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, repository: repo.repository, baseRef: repo.base.ref } })
  }, { realGit: false })
  const registered = await host.runtime.installation.createProject({ repository: 'acme/widgets', workspace: repo.repository, baseRef: repo.base.ref })
  project = registered.project
  await host.restart()
})
afterEach(async () => {
  try { await host?.stop() } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

const receive = (event: Trigger) => host.runtime.context(feishuKind).receive(event)
async function bind(triggerId: string) {
  const result = await host.api('POST', 'topic-binding', { triggerId, allowedActors: [MEMBER] }, project.id)
  expect(result, JSON.stringify(result.body)).toMatchObject({ status: 200 })
}
const messages = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  .filter(args => args.includes('+messages-reply')).map(args => ({ to: args[args.indexOf('--message-id') + 1], text: args[args.indexOf('--markdown') + 1]! }))

it('applies one quota decision across the original card and management API, and admits the next model call', async () => {
  const context = () => host.runtime.context(feishuKind).feishuTopic!
  const anchor = feishu('80', 'Project topic')
  await receive(anchor)
  await bind(anchor.id)
  const settings = host.runtime.settings.block('executor')
  const initial = await host.api('PUT', 'settings/executor', { revision: settings.revision,
    value: { ...host.runtime.settings.current().executor, runLimits: { projectTokens: 0 } } }, project.id)
  expect(initial.status).toBe(200)
  const revision = Number(initial.body.revision)
  const path = 'settings-confirmations', botIdentity = 'cli_bot:ou_bot'
  context().cardReady!(botIdentity, true)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_card80', chat_id: 'oc_team' })
  const proposal = await host.api('POST', path, { revision, change: { object: 'projectTokens', value: 100 }, approvers: [MEMBER] }, project.id)
  expect(proposal).toMatchObject({ status: 200, body: { status: 'pending', currentValue: 0, proposedValue: 100, effectiveValue: 0 } })
  const requestId = String(proposal.body.id), resource = `${path}/${requestId}`
  await host.runtime.sendReplies()
  const action = { action: 'approve' as const, requestId, projectId: project.id, revision, actorId: MEMBER, at: Date.now(),
    eventId: 'evt80', messageId: 'om_card80', chatId: 'oc_team', botIdentity }
  await receive(feishu('81', '同意', { root_id: 'om_80', create_time: String(Date.now()) }))
  for (const override of [{ actorId: 'ou_intruder' }, { chatId: 'oc_forward' }, { messageId: 'om_copy' }, { botIdentity: 'another' },
    { projectId: 'another-project' }, { revision: revision + 1 }]) await context().cardAction!({ ...action, ...override })
  expect(await host.api('GET', resource, undefined, project.id)).toMatchObject({ body: { status: 'pending', effectiveValue: 0 } })
  const entered = vi.fn(async function* () { yield { type: 'usage' as const, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } })
  await expect(host.modelRequest(host.runtime.masterId, 100, entered)).rejects.toThrow()
  expect(entered).not.toHaveBeenCalled()
  await Promise.all([context().cardAction!(action), context().cardAction!(action), host.api('POST', `${resource}/approve`, { revision }, project.id)])
  await host.modelRequest(host.runtime.masterId, 100, entered)
  expect(entered).toHaveBeenCalledOnce()
  await host.restart()
  expect(await host.api('GET', resource, undefined, project.id)).toMatchObject({ status: 200, body: { status: 'approved',
    currentValue: 0, effectiveValue: 100, effectiveRevision: revision + 1 } })
  expect(await host.api('PUT', 'settings/executor', { revision: revision + 1,
    value: { ...host.runtime.settings.current().executor, runLimits: { projectTokens: 120 } } }, project.id)).toMatchObject({ status: 200 })
  context().cardReady!(botIdentity, true)
  await context().cardAction!({ ...action, action: 'status', eventId: 'evt82', at: Date.now() })
  await host.runtime.sendReplies()
  expect(messages()).toContainEqual({ to: 'om_80', text: expect.stringMatching(/projectTokens.*120/s) })
  expect(await host.api('GET', resource, undefined, project.id)).toMatchObject({ body: { status: 'approved',
    currentValue: 0, proposedValue: 100, effectiveValue: 120, effectiveRevision: revision + 2 } })
  expect(await host.api('GET', 'project/run-limits', undefined, project.id)).toMatchObject({ body: { budget: { limitTokens: 120, accountedTokens: 10 } } })
})

it('accepts a bound approver’s listening change and receives the next message only under the reviewed scope', async () => {
  const anchor = feishu('90', 'Group root')
  await receive(anchor)
  await bind(anchor.id)
  const source = host.runtime.context(feishuKind), card = source.feishuTopic!, botIdentity = 'cli_bot:ou_bot'
  card.cardReady!(botIdentity, true)
  const revision = host.runtime.settings.block('source:feishu').revision
  const change = { object: 'feishuChat', chatId: 'oc_next', value: 'all' }
  const propose = () => host.api('POST', 'settings-confirmations', { revision, change, approvers: [MEMBER] }, project.id)
  const before = feishu('91', 'Please fix search', { chat_id: change.chatId, mentions: [] })
  expect(await source.receive(before)).toBe('filtered')
  const old = await propose()
  expect(old.status).toBe(200)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_card92', chat_id: 'oc_team' })
  const current = await propose()
  expect(current).toMatchObject({ status: 200, body: { projectId: project.id, chatId: 'oc_next', currentValue: 'none', proposedValue: 'all' } })
  await host.runtime.sendReplies()
  const click = { action: 'approve' as const, projectId: project.id, requestId: String(current.body.id), revision, actorId: MEMBER,
    eventId: 'evt92', messageId: 'om_card92', chatId: 'oc_team', at: Date.now(), botIdentity }
  const sourceBlock = host.runtime.sources.instance('feishu')!
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_settings_save', { block: 'source', source: 'feishu', revision,
    value: { enabled: true, config: { ...sourceBlock.config, chats: [{ chatId: change.chatId, listen: 'all' }] } } })).rejects.toThrow(/operator authorization/i)
  expect(await host.api('POST', `settings-confirmations/${old.body.id}/approve`, { revision }, project.id)).toMatchObject({ status: 409 })
  await card.cardAction!(click)
  expect(await host.api('GET', `settings-confirmations/${click.requestId}`, undefined, project.id)).toMatchObject({
    body: { status: 'approved', effectiveRevision: revision + 1, effectiveValue: 'all' } })
  expect(await source.receive(feishu('93', 'Please fix search', { chat_id: change.chatId, mentions: [] }))).toBe('stored')
  expect(await source.receive(feishu('94', 'Other room', { chat_id: 'oc_unreviewed', mentions: [] }))).toBe('filtered')
})

it('keeps a text fallback non-authorizing and refuses expired and rebound proposals at both entrances', async () => {
  const anchor = feishu('95', 'Selected topic')
  await receive(anchor)
  await bind(anchor.id)
  const card = host.runtime.context(feishuKind).feishuTopic!, botIdentity = 'cli_bot:ou_bot'
  const { revision } = host.runtime.settings.block('executor')
  const body = { revision, change: { object: 'maxWorkers', value: 6 }, approvers: [MEMBER] }
  expect(await host.api('POST', 'settings-confirmations', { ...body, approvers: ['ou_neighbor'] }, project.id)).toMatchObject({ status: 403 })
  const pending = await host.api('POST', 'settings-confirmations', body, project.id)
  expect(pending.status).toBe(200)
  const requestId = String(pending.body.id), url = `settings-confirmations/${requestId}`
  await host.runtime.sendReplies()
  expect(messages()).toContainEqual({ to: 'om_95', text: expect.stringContaining(`Request ${requestId}`) })
  card.cardReady!(botIdentity, true)
  const action = { action: 'approve' as const, projectId: project.id, requestId, revision, chatId: 'oc_team', messageId: 'om_text95',
    botIdentity, actorId: MEMBER, eventId: 'evt95', at: Date.now() }
  await card.cardAction!(action)
  expect(await host.api('GET', url, undefined, project.id)).toMatchObject({ body: { status: 'pending', effectiveValue: 3 } })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(String(pending.body.expiresAt)))
  try {
    expect(await host.api('POST', `${url}/approve`, { revision }, project.id)).toMatchObject({ status: 409 })
    expect(await host.api('GET', url, undefined, project.id)).toMatchObject({ body: { status: 'expired', effectiveValue: 3 } })
  } finally { clock.mockRestore() }
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_card96', chat_id: 'oc_team' })
  const next = await host.api('POST', 'settings-confirmations', body, project.id)
  expect(next.status).toBe(200)
  await host.runtime.sendReplies()
  const validating = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  vi.spyOn(host.runtime.installation, 'validateWorkspace').mockImplementationOnce(async () => {
    validating.resolve(); await resume.promise; return project.workspace
  })
  const attempt = card.cardAction!({ ...action, requestId: String(next.body.id), messageId: 'om_card96', at: Date.now() })
  try {
    await validating.promise
    expect(await host.api('POST', 'topic-binding/unbind', undefined, project.id)).toMatchObject({ status: 200 })
    await bind(anchor.id)
  } finally { resume.resolve(); await attempt }
  expect(await host.api('POST', `settings-confirmations/${next.body.id}/approve`, { revision }, project.id)).toMatchObject({ status: 409 })
  expect(await host.api('GET', `settings-confirmations/${next.body.id}`, undefined, project.id)).toMatchObject({
    body: { status: 'superseded', effectiveValue: 3, effectiveRevision: revision } })
})

it('reconciles the original card after a lost send receipt without accepting an unreceipted or copied message', async () => {
  const anchor = feishu('97', 'Project topic'), botIdentity = 'cli_bot:ou_bot'
  await receive(anchor)
  await bind(anchor.id)
  await host.runtime.sendReplies()
  const connection = () => host.runtime.context(feishuKind).feishuTopic!
  connection().cardReady!(botIdentity, true)
  const published = new Map<string, string>()
  let attempts = 0
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    if (!args.includes('interactive')) return {}
    const uuid = args[args.indexOf('--idempotency-key') + 1]!
    const msg = published.get(uuid) ?? `om_origin${published.size + 1}`
    published.set(uuid, msg)
    if (++attempts === 1) throw new Error('Lost response after remote send')
    return { message_id: msg, chat_id: 'oc_team' }
  })
  const { revision } = host.runtime.settings.block('executor')
  const proposal = await host.api('POST', 'settings-confirmations', { revision, change: { object: 'maxWorkers', value: 4 },
    approvers: [MEMBER] }, project.id)
  expect(proposal.status).toBe(200)
  const requestId = String(proposal.body.id), url = `settings-confirmations/${requestId}`
  await host.runtime.sendReplies()
  expect(published.get(requestId)).toBe('om_origin1')
  const action = { action: 'approve' as const, requestId, projectId: project.id, revision, actorId: MEMBER,
    eventId: 'evt97', messageId: 'om_origin1', chatId: 'oc_team', botIdentity, at: Date.now() }
  await connection().cardAction!(action)
  expect(await host.api('GET', url, undefined, project.id)).toMatchObject({ body: { status: 'pending', effectiveValue: 3 } })
  await host.restart()
  connection().cardReady!(botIdentity, true)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
  try {
    await host.runtime.sendReplies()
    expect(attempts).toBe(2)
    expect([...published.entries()]).toEqual([[requestId, 'om_origin1']])
    await connection().cardAction!({ ...action, messageId: 'om_copy' })
    expect(await host.api('GET', url, undefined, project.id)).toMatchObject({ body: { status: 'pending' } })
    await connection().cardAction!({ ...action, eventId: 'evt98', at: Date.now() })
    expect(await host.api('GET', url, undefined, project.id)).toMatchObject({ body: { status: 'approved', effectiveValue: 4, effectiveRevision: revision + 1 } })
  } finally { clock.mockRestore() }
})

it('clears only binding health after a persisted unbind when the Feishu Source still has an authorization failure', async () => {
  const anchor = feishu('30', 'topic root')
  await receive(anchor)
  await bind(anchor.id)
  const context = host.runtime.context(feishuKind)
  context.state.set(KV.feishu.history('oc_team'), '2026-09-08T00:00:00.000Z')
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('Feishu authorization denied'))
  const controller = new AbortController()
  const running = runFeishu(context, controller.signal)
  try {
    await vi.waitFor(() => expect(host.runtime.health.feishuBinding).toMatchObject({
      state: 'error', detail: expect.stringContaining('Feishu authorization denied'),
    }))
    await vi.waitFor(() => expect(host.runtime.health.history).toMatchObject({
      state: 'error', detail: expect.stringContaining('Feishu authorization denied'),
    }))
    const unbound = await host.api('POST', 'topic-binding/unbind', undefined, project.id)
    expect(unbound).toMatchObject({ status: 200 })
    expect(host.runtime.topicBinding?.view()).toBeNull()
    expect(host.runtime.health.feishuBinding).toMatchObject({ state: 'ready', detail: 'No Feishu topic is bound' })
    expect(host.runtime.health.history).toMatchObject({ state: 'error', detail: expect.stringContaining('Feishu authorization denied') })
  } finally {
    controller.abort()
    await running
  }
})
it('does not reset binding health when shutdown has started before unbind completes', async () => {
  const anchor = feishu('31', 'topic root')
  await receive(anchor)
  await bind(anchor.id)
  const previous = host.runtime
  previous.context(feishuKind).feishuTopic?.report({ state: 'error', detail: 'Bound-topic poll failed' })
  expect(previous.health.feishuBinding).toMatchObject({ state: 'error', detail: 'Bound-topic poll failed' })
  const stopping = previous.stop()
  previous.topicBinding?.unbind()
  expect(previous.health.feishuBinding).toMatchObject({ state: 'error', detail: 'Bound-topic poll failed' })
  await stopping
  await host.restart()
  expect(host.runtime.health.feishuBinding).toBeUndefined()
})
it('confirms only the selected topic once, including after a restart and retry', async () => {
  const anchor = feishu('1', 'topic root')
  await receive(anchor)
  await bind(anchor.id)
  await host.runtime.sendReplies()
  await host.restart()
  await bind(anchor.id)
  await host.runtime.sendReplies()
  expect(messages()).toEqual([{ to: 'om_1', text: expect.stringContaining(project.id) }])
})

it('preserves ordinary Source follow-ups and stops for a Ticket in the bound topic', async () => {
  const { trigger: anchor, ticket } = await host.acceptedTicket(feishu('1', '@bot Fix the regression'))
  const beforeBinding = feishu('6', 'Answer export: use CSV.', { root_id: 'om_1', mentions: [] })
  await receive(beforeBinding)
  await bind(anchor.id)
  const ctx = host.runtime.context(feishuKind)
  const binding = ctx.feishuTopic!.target()!
  const followup = feishu('2', 'Answer export: use CSV.', { root_id: 'om_1', mentions: [], create_time: String(Date.now()) })
  // The binding-only poll is not a new Source subscription and must not block subsequent normal intake of the same event.
  expect(await ctx.feishuTopic!.receive(followup, binding.epoch)).toBe('filtered')
  expect(await receive(followup)).toBe('stored')
  const bot = feishu('3', 'CI confirmation for the existing ticket', { root_id: 'om_1', mentions: [], sender_type: 'bot', sender_id: 'ou_ci' })
  expect(await receive(bot)).toBe('stored')
  const invalid = feishu('4', 'answer 000000000000000000000000: change the assignment', { root_id: 'om_1' })
  await receive(invalid)
  const details = await host.api('GET', `tickets/${ticket.id}`, undefined, project.id)
  expect(details).toMatchObject({ status: 200, body: { inputs: expect.arrayContaining([
    expect.objectContaining({ triggerId: beforeBinding.id }),
    expect.objectContaining({ triggerId: bot.id }), expect.objectContaining({ triggerId: followup.id }),
  ]) } })
  expect(details.body.inputs).not.toContainEqual(expect.objectContaining({ triggerId: invalid.id }))
  const stop = feishu('5', '@bot Stop this ticket.', { root_id: 'om_1' })
  await receive(stop)
  expect(await host.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: stop.id }))
    .toMatchObject({ decision: 'stop', ticket: { ticket_id: ticket.id, state: 'stopped' } })
})

async function startPlanner() {
  const brief = { project: { repository: project.repository, workspace: project.workspace }, goal: 'Save a customer list.',
    constraints: [], acceptanceScope: ['Users can view a saved list.'], authorization: { scope: 'Implement and test.', release: 'not-authorized' } }
  const confirmation = JSON.stringify({ confirmed: true, brief })
  const hub = host.runtime.masterId
  host.sendUserMessage(hub, confirmation)
  const { id } = await host.runTool(hub, 'orchestrator_handoff_confirm', { ...brief, confirmation })
  await host.idlePlanning()
  const planner = `planner-${id}`
  return { hub, id, planner, brief }
}

it('does not send a question answered in Harness while Feishu delivery was validating the checkout', async () => {
  const { id, brief } = await startPlanner()
  const anchor = feishu('1', 'group topic')
  await receive(anchor)
  await bind(anchor.id)
  await host.runtime.sendReplies()
  const validating = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  vi.spyOn(host.runtime.installation, 'validateWorkspace').mockImplementationOnce(async () => {
    validating.resolve(); await resume.promise; return project.workspace
  })
  const handoffs = host.runtime.handoffs
  const awaiting = handoffs.question(String(id), { text: 'Who may see a list?', why: 'Visibility is unspecified.', affectedAcceptance: brief.acceptanceScope })
  const sending = host.runtime.sendReplies()
  try {
    await validating.promise
    handoffs.answer(awaiting.id, awaiting.question!.id, 'Only the owner.')
  } finally { resume.resolve(); await sending }
  expect(messages().map(item => item.text).join('\n')).not.toMatch(/answer [\w-]+:/i)
})

it.each(['group', 'p2p'] as const)('answers the existing Harness question as the Feishu sender, only in the bound %s', async chatType => {
  const { hub, id, planner, brief } = await startPlanner()
  await host.runTool(planner, 'orchestrator_spec_question', { handoffId: id, text: 'Who may see a saved list?',
    why: 'Visibility changes who can use a list.', affectedAcceptance: brief.acceptanceScope })
  const readHandoff = () => host.runTool(hub, 'orchestrator_read', { resource: `handoff/${id}` })
  const destination = { chat_type: chatType, ...(chatType === 'p2p' && { chat_id: 'oc_private' }) }
  const anchor = feishu('10', 'selected destination', destination)
  await receive(anchor)
  await bind(anchor.id)
  await host.runtime.sendReplies()
  const traffic = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
    .filter(args => args.includes('+messages-reply') || args.includes('+messages-send'))
  const notice = traffic().map(args => args.join(' ')).find(text => /answer [\w-]+:/i.test(text))
  expect(notice).toBeDefined()
  const prefix = notice!.match(/answer [\w-]+:/i)![0]
  const answer = 'Only the owner sees their list.'
  const reply = (n: string, text: string, extra = {}) => feishu(n, text, { ...destination, ...(chatType === 'group' && { root_id: 'om_10' }),
    mentions: [], create_time: String(Date.now()), ...extra })
  await receive(reply('11', `${prefix} ${answer}`, { sender_id: 'ou_neighbor' }))
  await receive(reply('12', `${prefix} ${answer}`, { sender_type: 'bot' }))
  await receive(reply('13', `${prefix} ${answer}`, chatType === 'group' ? { root_id: 'om_other' } : { chat_id: 'oc_elsewhere' }))
  await receive(reply('14', '同意'))
  await receive(reply('16', `${prefix} 同意`))
  await receive(reply('17', 'PRIVATE_DM_TEXT', { chat_type: 'p2p', chat_id: 'oc_unbound', root_id: undefined }))
  expect(await readHandoff()).toMatchObject({ status: 'awaiting', question: { status: 'awaiting' } })

  const accepted = reply('15', `${prefix} ${answer}`)
  if (chatType === 'p2p') {
    expect(await host.api('POST', 'executor/pause', { paused: true }, project.id)).toMatchObject({ status: 200 })
    expect(await receive(accepted)).toBe('filtered')
    expect(await readHandoff()).toMatchObject({ question: { status: 'awaiting' } })
    expect(await host.api('POST', 'executor/pause', { paused: false }, project.id)).toMatchObject({ status: 200 })
    // An offline DM arrives via Feishu history, without a mention or a Ticket subscription.
    const ctx = host.runtime.context(feishuKind)
    const target = ctx.feishuTopic!.target()!
    vi.mocked(Commands.prototype.lark).mockResolvedValueOnce({ items: [{ message_id: 'om_15', chat_id: 'oc_private', create_time: String(Date.parse(accepted.at)),
      sender: { id: MEMBER, sender_type: 'user' }, body: { content: JSON.stringify({ text: accepted.text }) } }], has_more: false })
    await pollBoundTopic(ctx, target, new AbortController().signal)
    expect(await readHandoff()).toMatchObject({ question: { status: 'answered', answer } })
  } else await receive(accepted)
  await receive(accepted)
  await host.idlePlanning()
  expect(await readHandoff()).toMatchObject({ status: 'planning', question: { status: 'answered', answer,
    answeredBy: { source: 'feishu', actorId: MEMBER, triggerId: accepted.id } } })
  await receive(reply('18', '状态'))
  await host.runtime.sendReplies()
  expect(traffic().at(-1)?.join(' ')).toContain('Planning is in progress')
  await host.runTool(planner, 'orchestrator_spec_publish', { handoffId: id, body: 'PRIVATE_SPEC_BODY',
    acceptance: [{ statement: 'The owner sees the list.', observable: 'Someone else cannot view it.', delivery: 'backend' }],
    testInterfaces: [{ seam: 'Saved lists', kind: 'existing', note: 'Read from another account.' }], outOfScope: [] })
  await host.runtime.sendReplies()
  const sent = traffic()
  const last = sent.at(-1)!
  expect(last.join(' ')).toContain(project.id)
  expect(last.join(' ')).toMatch(/spec|规格/i)
  for (const args of sent) {
    expect(args).toContain(chatType === 'group' ? 'om_10' : 'oc_private')
    expect(args.join(' ')).not.toContain(answer)
    expect(args.join(' ')).not.toContain('PRIVATE_SPEC_BODY')
    expect(args.join(' ')).not.toContain('PRIVATE_DM_TEXT')
  }
})
