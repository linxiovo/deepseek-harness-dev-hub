import { describe, expect, it, vi } from 'vitest'
import type { SettingsConfirmationView } from '../src/confirmed-settings.ts'
import { Commands } from '../src/infra/commands.ts'
import { findSettingsCard, sendSettingsCard } from '../src/sources/feishu-card.ts'
import { testDeployment } from './fixtures/deployment.ts'

const view: SettingsConfirmationView = {
  id: '25755adf-d489-46de-9d22-25fad4034f22', projectId: 'project-a', repository: 'acme/widgets', object: 'feishuChat',
  chatId: 'oc_team', revision: 7, currentValue: 'mentions', proposedValue: 'all', effectiveValue: 'mentions', effectiveRevision: 7,
  impact: 'Expands listening scope.', status: 'pending', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
}
const target = { chatId: 'oc_dm', direct: true }
const identity = 'cli_app:ou_bot'
function card() {
  const plain = (content: string) => ({ tag: 'plain_text', content })
  return { schema: '2.0', config: { enable_forward: false }, header: { title: plain('Project settings approval'), template: 'blue' },
    body: { elements: [{ tag: 'div', text: plain([
      `Project: ${view.repository} (${view.projectId})`, `Setting: ${view.object} (${view.chatId})`,
      `Current: mentions → Proposed: all`, 'Effective: mentions (revision 7)', `Impact: ${view.impact}`,
      `Status: pending. Approval expires: ${view.expiresAt}`, `Request: ${view.id}`,
    ].join('\n')) }, ...(['approve', 'status'] as const).map(action => ({ tag: 'button',
      text: plain(action === 'approve' ? 'Approve change' : 'Check current status'), type: action === 'approve' ? 'primary_filled' : 'default',
      behaviors: [{ type: 'callback', value: { projectId: view.projectId, requestId: view.id, revision: view.revision, action } }] }))] } }
}
function message(overrides: Record<string, unknown> = {}) {
  return { message_id: 'om_original', chat_id: target.chatId, msg_type: 'interactive', create_time: String(Date.now()), deleted: false,
    sender: { sender_type: 'app', id_type: 'app_id', id: 'cli_app' }, body: { content: JSON.stringify(card()) }, ...overrides }
}
function commands(responses: unknown[]) {
  const instance = new Commands(() => testDeployment(), {}, new AbortController().signal)
  vi.spyOn(instance, 'lark').mockImplementation(async () => {
    const result = responses.shift()
    if (result instanceof Error) throw result
    return result as never
  })
  return instance
}
const page = (items: unknown[], has_more = false, page_token?: string) => ({ items, has_more, ...(page_token ? { page_token } : {}) })

describe('findSettingsCard', () => {
  it('recovers the exact interactive card emitted by the sender renderer', async () => {
    const responses: unknown[] = [{ message_id: 'om_original', chat_id: target.chatId }]
    const commandsMock = commands(responses)
    await sendSettingsCard(commandsMock, target, view)
    const sendArgs = vi.mocked(commandsMock.lark).mock.calls[0]![0]
    const content = sendArgs[sendArgs.indexOf('--content') + 1]!
    expect(content).toContain(`Request: ${view.id}`)
    const original = JSON.parse(content)
    for (const button of original.body.elements.slice(1)) {
      const behavior = button.behaviors[0]
      behavior.value = Object.fromEntries(Object.entries(behavior.value).reverse())
    }
    original.body.elements.splice(1, 2, ...original.body.elements.slice(1).reverse())
    responses.push(page([message({ body: { content: JSON.stringify(original) } })]))
    await expect(findSettingsCard(commandsMock, target, view, identity, () => true)).resolves.toBe('om_original')
  })

  it('refuses to recover a card whose visible limit differs from its approval payload', async () => {
    const original = card()
    const description = original.body.elements[0]!.text
    description.content = description.content.replace('Proposed: all', 'Proposed: mentions')
    await expect(findSettingsCard(commands([page([message({ body: { content: JSON.stringify(original) } })])]),
      target, view, identity, () => true)).rejects.toThrow('mismatched proposal')
  })

  it('recovers only this app card in the bounded DM history after a lost send receipt', async () => {
    const commandsMock = commands([page([
      message({ message_id: 'om_user', sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_alice' } }),
      message({ message_id: 'om_another_bot', sender: { sender_type: 'app', id_type: 'app_id', id: 'cli_other' } }),
      message({ message_id: 'om_original' }),
    ])])
    await expect(findSettingsCard(commandsMock, target, view, identity, () => true)).resolves.toBe('om_original')
    const [args] = vi.mocked(commandsMock.lark).mock.calls[0]!
    expect(args.slice(0, 4)).toEqual(['api', 'GET', '/open-apis/im/v1/messages', '--params'])
    expect(JSON.parse(args[4]!)).toMatchObject({ container_id_type: 'chat', container_id: 'oc_dm', sort_type: 'ByCreateTimeAsc',
      page_size: 50, card_msg_content_type: 'user_card_content' })
    expect(Number(JSON.parse(args[4]!).start_time) * 1000).toBeLessThanOrEqual(Date.parse(view.expiresAt) - 15 * 60_000)
  })

  it('uses the verified group thread when the provider omits the root on a reply', async () => {
    const group = { chatId: 'oc_team', direct: false, rootId: 'om_root' }
    const commandsMock = commands([
      { items: [{ message_id: 'om_root', chat_id: 'oc_team', thread_id: 'omt_topic' }] },
      page([message({ message_id: 'om_root', chat_id: 'oc_team', root_id: undefined, thread_id: 'omt_topic', msg_type: 'text' }),
        message({ chat_id: 'oc_team', thread_id: 'omt_topic' })]),
    ])
    await expect(findSettingsCard(commandsMock, group, view, identity, () => true)).resolves.toBe('om_original')
    const [args] = vi.mocked(commandsMock.lark).mock.calls[1]!
    expect(JSON.parse(args[4]!)).toMatchObject({ container_id_type: 'thread', container_id: 'omt_topic', card_msg_content_type: 'user_card_content' })
  })

  it('rejects a matching marker in another topic or forwarded card rather than claiming it', async () => {
    const group = { chatId: 'oc_team', direct: false, rootId: 'om_root' }
    const outsideTopic = commands([
      { items: [{ message_id: 'om_root', chat_id: 'oc_team', thread_id: 'omt_topic' }] },
      page([message({ chat_id: 'oc_team', root_id: 'om_other_root', thread_id: 'omt_other' })]),
    ])
    await expect(findSettingsCard(outsideTopic, group, view, identity, () => true)).rejects.toThrow('outside the bound topic')
    const forwarded = commands([page([message({ sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_alice' } })])])
    await expect(findSettingsCard(forwarded, target, view, identity, () => true)).resolves.toBeUndefined()
  })

  it('refuses duplicate candidates, repeated cursors, unreadable messages and page-budget exhaustion', async () => {
    await expect(findSettingsCard(commands([page([message(), message({ message_id: 'om_duplicate' })])]), target, view, identity, () => true))
      .rejects.toThrow('Multiple Feishu settings cards')
    await expect(findSettingsCard(commands([page([], true, 'same'), page([], true, 'same')]), target, view, identity, () => true))
      .rejects.toThrow('pagination is incomplete')
    await expect(findSettingsCard(commands([page([{ message_id: 'om_bad' }])]), target, view, identity, () => true))
      .rejects.toThrow('unverifiable message')
    const pages = Array.from({ length: 20 }, (_, index) => page([], true, `cursor-${index}`))
    await expect(findSettingsCard(commands(pages), target, view, identity, () => true)).rejects.toThrow('page limit')
  })

  it('checks the current identity before each read and after the final read', async () => {
    const commandsMock = commands([page([])])
    await expect(findSettingsCard(commandsMock, target, view, identity, () => false)).rejects.toThrow('no longer active')
    expect(commandsMock.lark).not.toHaveBeenCalled()
    let checks = 0
    await expect(findSettingsCard(commands([page([])]), target, view, identity, () => ++checks < 3)).rejects.toThrow('no longer active')
    expect(checks).toBe(3)
  })
})
