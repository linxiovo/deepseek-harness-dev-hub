import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { pollBoundTopic } from '../src/sources/feishu-loops.ts'
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
  try { await host?.stop() } finally { rmSync(root, { recursive: true, force: true }) }
})

const receive = (event: Trigger) => host.runtime.context(feishuKind).receive(event)
async function bind(triggerId: string) {
  const result = await host.api('POST', 'topic-binding', { triggerId, allowedActors: [MEMBER] }, project.id)
  expect(result, JSON.stringify(result.body)).toMatchObject({ status: 200 })
}
const messages = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  .filter(args => args.includes('+messages-reply')).map(args => ({ to: args[args.indexOf('--message-id') + 1], text: args[args.indexOf('--markdown') + 1]! }))

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
  const followup = feishu('2', 'The regression also affects exports.', { root_id: 'om_1', mentions: [], create_time: String(Date.now()) })
  // The binding-only poll is not a new Source subscription and must not block subsequent normal intake of the same event.
  expect(await ctx.feishuTopic!.receive(followup, binding.epoch)).toBe('filtered')
  expect(await receive(followup)).toBe('stored')
  const bot = feishu('3', 'CI confirmation for the existing ticket', { root_id: 'om_1', mentions: [], sender_type: 'bot', sender_id: 'ou_ci' })
  expect(await receive(bot)).toBe('stored')
  const invalid = feishu('4', 'answer invalid-code: change the assignment', { root_id: 'om_1' })
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
