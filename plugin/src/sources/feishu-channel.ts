/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** Sends a bound DM to its chat, or replies in the exact topic of a message. Both operations use a stable idempotency key. */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { chatId, messageId, delivery, bindingEpoch, direct } = message.channel.address
  const text = checkedImText(message.text)
  const directChat = delivery === 'direct-chat'
  if (bindingEpoch !== undefined && (directChat !== (direct === 'true')
    || !/^oc_[A-Za-z0-9_-]+$/.test(chatId ?? '')
    || (!directChat && (delivery !== 'group-topic' || !/^om_[A-Za-z0-9_-]+$/.test(messageId ?? ''))))) {
    throw new Error('Invalid bound Feishu delivery target')
  }
  if (directChat && !bindingEpoch) throw new Error('A direct chat send requires a binding')
  if (!directChat && !messageId) throw new Error('Missing Feishu reply target')
  const target = directChat ? ['+messages-send', '--chat-id', chatId!] : ['+messages-reply', '--message-id', messageId!, '--reply-in-thread']
  try { await host.commands.lark(['im', ...target, '--markdown', text, '--idempotency-key', message.id]) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
