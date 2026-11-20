import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuRead, readFeishu, readFeishuLink } from '../src/sources/feishu-read.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'
import { pollBoundTopic } from '../src/sources/feishu.ts'
import type { FeishuTopic, SourceContext } from '../src/sources/host.ts'
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const event: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const source = { message_id: 'om_source', chat_id: 'oc_chat', parent_id: 'om_parent', root_id: 'om_root', thread_id: 'omt_thread' }
const message = { message_id: 'om_root', chat_id: 'oc_chat', msg_type: 'merge_forward', content: '<forwarded_messages>Earlier discussion ![Image](img_one)</forwarded_messages>', sender: { id: 'ou_user', name: 'User', sender_type: 'user' }, create_time: '2026-09-11 12:00' }
afterEach(() => vi.restoreAllMocks())
it('resolves legacy source metadata and reads merged forwards without embedding automatic thread expansion', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, thread_replies: [{ content: 'Automatic expansion omitted' }] }] })
  const result = await readFeishu(commands, event, 'feishu/source/root', 20)
  expect(result).toMatchObject({ status: 'available', message: { content: message.content } })
  // The read response states no limitations of its own; the skill states them once.
  expect(result).not.toHaveProperty('limitations')
  expect(JSON.stringify(result)).not.toContain('Automatic expansion omitted')
  expect(lark.mock.calls[1]![0]).toEqual(['im', '+messages-mget', '--message-ids', 'om_root', '--no-reactions'])
})
it('paginates source thread messages with opaque cursors and retains authors and edited timestamps', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, page_token: 'a/b+next=', messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', updated: true, update_time: '2026-09-11 12:01' }] })
  const first = await readFeishu(commands, event, 'feishu/source/thread', 2)
  expect(first).toMatchObject({ next_resource: 'feishu/source/thread/a%2Fb%2Bnext%3D', messages: [{ sender: message.sender, updated: true }] })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false, messages: [] })
  await readFeishu(commands, event, 'feishu/source/thread/a%2Fb%2Bnext%3D', 2)
  expect(lark.mock.lastCall![0]).toContain('a/b+next=')
})
it('skips and counts a topic message it cannot read, and reads the others', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread' }, { ...message, message_id: 'om_odd',
      sender: { sender_type: 'app' } }] })
  const page = await readFeishu(commands, event, 'feishu/source/thread', 20)
  expect(page).toMatchObject({ skipped: 1, messages: [{ message_id: 'om_reply' }] })
})
it('rejects unrelated paths, missing sources, cross-chat results, and incomplete pagination', async () => {
  const lark = vi.spyOn(commands, 'lark')
  await expect(readFeishu(commands, event, 'feishu/other/thread', 20)).rejects.toThrow('source trigger')
  await expect(readFeishu(commands, event, 'feishu/source/root/cursor', 20)).rejects.toThrow('Use feishu')
  expect(lark).not.toHaveBeenCalled()
  lark.mockResolvedValueOnce({ items: [] })
  await expect(readFeishu(commands, event, 'feishu/source/message', 20)).rejects.toThrow('unavailable')
  lark.mockResolvedValueOnce({ items: [{ ...source, chat_id: 'oc_elsewhere' }] })
  await expect(readFeishu(commands, event, 'feishu/source/root', 20)).rejects.toThrow('chat does not match')
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, messages: [] })
  await expect(readFeishu(commands, event, 'feishu/source/thread', 20)).rejects.toThrow('did not advance')
})
it('reports absent parent/thread and deleted content explicitly', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ items: [{ message_id: 'om_source', chat_id: 'oc_chat' }] })
  expect(await readFeishu(commands, event, 'feishu/source/thread', 20)).toMatchObject({ status: 'no_thread', next_resource: null })
  expect(await readFeishu(commands, event, 'feishu/source/parent', 20)).toMatchObject({ status: 'no_parent', message: null })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, deleted: true }] })
  expect(await readFeishu(commands, event, 'feishu/source/root', 20)).toMatchObject({ status: 'deleted' })
})

it('reads only the source message link and rejects absent, deleted or cross-chat results', async () => {
  const linked = { message_id: 'om_source', chat_id: 'oc_chat', message_app_link: 'https://applink.feishu.cn/client/message/link/open?token=source' }
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ messages: [{ ...linked, message_id: 'om_other', message_app_link: 'https://example.com/other' }, linked] })
  await expect(readFeishuLink(commands, event)).resolves.toBe(linked.message_app_link)
  expect(lark).toHaveBeenCalledWith(['im', '+messages-mget', '--message-ids', 'om_source', '--no-reactions'])
  for (const row of [{ ...linked, deleted: true }, { ...linked, chat_id: 'oc_elsewhere' }, { ...linked, message_app_link: undefined }, { ...linked, message_id: 'om_other' }]) {
    lark.mockResolvedValueOnce({ messages: [row] })
    await expect(readFeishuLink(commands, event)).rejects.toThrow('unavailable')
  }
})
it('reads a topic page as messages a model reads: id, author, ISO time, text and the message each answers', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', parent_id: 'om_root', message_app_link: 'https://applink.feishu.cn/x' },
      { ...message, message_id: 'om_bot', sender: { id: 'cli_bot', name: 'Bot', sender_type: 'app' } }] })
  expect(await feishuRead(commands, event, 'feishu/source/thread', 20)).toEqual({ status: 'available', thread_id: 'omt_thread', next_resource: null,
    messages: [{ id: 'om_reply', from: 'User', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, reply_to: 'om_root',
      url: 'https://applink.feishu.cn/x' }, { id: 'om_bot', from: 'Bot', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, bot: true }] })
})
it('reads the chat around a message by time: five before it, the message and five after, then earlier pages', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n: number) => ({ message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000), sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `message ${n}` }) } })
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] })
    .mockResolvedValueOnce({ items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' })
    .mockResolvedValueOnce({ items: [0, 1, 2].map(item), has_more: false })
  const ref = { ...event, at: new Date(at).toISOString() }
  const around = await feishuRead(commands, ref, 'feishu/source/around', 20)
  expect(around).toMatchObject({ status: 'available', next_resource: 'feishu/source/around/older' })
  expect('messages' in around && around.messages.map(message => [message.id, message.text]))
    .toEqual([-5, -4, -3, -2, -1, 0, 1, 2].map(n => [`om_${n}`, `message ${n}`]))
  const params = (call: number) => JSON.parse(lark.mock.calls[call]![0].at(-1)!) as Record<string, unknown>
  expect(params(1)).toMatchObject({ container_id: 'oc_chat', sort_type: 'ByCreateTimeDesc', end_time: String(at / 1000), page_size: 6 })
  expect(params(2)).toMatchObject({ sort_type: 'ByCreateTimeAsc', start_time: String(at / 1000), page_size: 6 })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ items: [-6, -7].map(item), has_more: false })
  const earlier = await feishuRead(commands, ref, 'feishu/source/around/older', 20)
  expect('messages' in earlier && earlier.messages.map(message => message.id)).toEqual(['om_-7', 'om_-6'])
  expect(params(4)).toMatchObject({ page_token: 'older', page_size: 10 })
})

it.each(['bound', 'unbound while fetching', 'wrong root', 'aborted during replay', 'bot replaced during replay'] as const)(
  'recovers competing group answers oldest first across pages: %s', async scenario => {
    const topic: FeishuTopic = { epoch: 'epoch-1', sourceRevision: 1, since: new Date(1000).toISOString(),
      chatId: 'oc_chat', direct: false, rootId: 'om_root' }
    const deployment = testDeployment(), controller = new AbortController(), delivered: string[] = []
    let bound = true
    const ctx: Pick<SourceContext, 'commands' | 'deployment' | 'feishuTopic'> = { commands, deployment, feishuTopic: {
      target: () => bound ? topic : undefined, report: vi.fn(), receive: async trigger => {
        delivered.push(trigger.text)
        if (scenario === 'aborted during replay') controller.abort()
        if (scenario === 'bot replaced during replay') deployment.feishu!.botId = 'ou_replacement'
        return 'stored'
      },
    } }
    const item = (n: number, root = topic.rootId) => ({ message_id: `om_${n}`, chat_id: topic.chatId, thread_id: 'omt_thread', root_id: root,
      sender: { id: 'ou_user', sender_type: 'user' }, create_time: String(n * 1000), body: { content: JSON.stringify({ text: `answer abcdefabcdefabcdefabcdef: ${n}` }) } })
    const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValueOnce({ items: [{ message_id: topic.rootId, chat_id: topic.chatId, thread_id: 'omt_thread' }] })
      .mockResolvedValueOnce({ items: [item(3), item(2)], has_more: true, page_token: 'older' })
      .mockImplementationOnce(async () => {
        if (scenario === 'unbound while fetching') bound = false
        return { items: [item(1, scenario === 'wrong root' ? 'om_elsewhere' : topic.rootId), item(0)], has_more: true, page_token: 'too-old' }
      })
    const recovered = pollBoundTopic(ctx, topic, controller.signal, topic.since, new Date(4000).toISOString())
    if (scenario === 'wrong root') await expect(recovered).rejects.toThrow('outside the bound conversation')
    else await expect(recovered).resolves.toBe(scenario === 'bound')
    const expected = scenario === 'bound' ? [1, 2, 3] : scenario.endsWith('during replay') ? [1] : []
    expect(delivered).toEqual(expected.map(n => `answer abcdefabcdefabcdefabcdef: ${n}`))
    expect(lark).toHaveBeenCalledTimes(3) // The pre-cursor item on page two ends the descending scan.
    expect(JSON.parse(lark.mock.calls[2]![0].at(-1)!)).toMatchObject({ page_token: 'older', sort_type: 'ByCreateTimeDesc' })
  })
