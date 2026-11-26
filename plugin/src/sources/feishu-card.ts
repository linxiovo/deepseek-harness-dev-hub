/** Settings approval cards and their native Feishu callbacks; no message text or card update token grants authority. */
import { z } from 'zod'
import type { SettingsCardAction, SettingsConfirmationView } from '../confirmed-settings.ts'
import type { Commands } from '../infra/commands.ts'

export const cardEventKey = 'card.action.trigger'
const chatId = z.string().max(128).regex(/^oc_[A-Za-z0-9]+$/)
const messageId = z.string().max(128).regex(/^om_[A-Za-z0-9_-]+$/)
const opaqueId = z.string().max(128).regex(/^[A-Za-z0-9_-]+$/)
const envelope = z.object({ type: z.literal(cardEventKey), host: z.literal('im_message'), action_tag: z.literal('button'),
  event_id: opaqueId, operator_id: z.string().max(128).regex(/^ou_[A-Za-z0-9]+$/), chat_id: chatId, message_id: messageId,
  timestamp: z.string().regex(/^\d{1,15}$/), form_value: z.literal('').nullish(), action_value: z.string().max(1024) })
const payload = z.strictObject({ action: z.enum(['approve', 'status']), projectId: opaqueId, requestId: opaqueId.max(50), revision: z.number().int().nonnegative() })

export function settingsCardAction(line: string, botIdentity: string): SettingsCardAction | undefined {
  try {
    const event = envelope.safeParse(JSON.parse(line))
    if (!event.success) return
    const action = payload.safeParse(JSON.parse(event.data.action_value))
    if (!action.success) return
    const { event_id: eventId, chat_id: chatId, message_id: messageId, operator_id: actorId, timestamp } = event.data
    return { ...action.data, eventId, chatId, messageId, actorId, at: Number(timestamp), botIdentity }
  } catch { return } // Invalid JSON must not put raw CLI output in diagnostics.
}

const receipt = z.object({ message_id: messageId, chat_id: chatId })

/** Deliver one non-forwardable card only to the bound DM or root; a retry of the request uses the same native UUID. */
export async function sendSettingsCard(commands: Pick<Commands, 'lark'>, target: { chatId: string; direct: boolean; rootId?: string },
  view: SettingsConfirmationView): Promise<string> {
  if (!chatId.safeParse(target.chatId).success || (target.direct === true ? target.rootId !== undefined
    : target.direct !== false || !messageId.safeParse(target.rootId).success)) throw new Error('Invalid Feishu settings card target')
  const base = { projectId: view.projectId, requestId: view.id, revision: view.revision }
  if (!payload.safeParse({ ...base, action: 'approve' }).success) throw new Error('Invalid Feishu settings card reference')
  const plain = (content: string) => ({ tag: 'plain_text', content })
  const description = [`Project: ${view.repository} (${view.projectId})`, `Setting: ${view.object}${view.chatId ? ` (${view.chatId})` : ''}`,
    `Current: ${view.currentValue ?? 'unlimited'} → Proposed: ${view.proposedValue ?? 'unlimited'}`,
    `Effective: ${view.effectiveValue ?? 'unlimited'} (revision ${view.effectiveRevision})`,
    `Impact: ${view.impact}`, `Status: ${view.status}. Approval expires: ${view.expiresAt}`].join('\n')
  const content = { schema: '2.0', config: { enable_forward: false }, header: { title: plain('Project settings approval'), template: 'blue' },
    body: { elements: [{ tag: 'div', text: plain(description) }, ...(['approve', 'status'] as const).map(action => ({ tag: 'button',
      text: plain(action === 'approve' ? 'Approve change' : 'Check current status'), type: action === 'approve' ? 'primary_filled' : 'default',
      behaviors: [{ type: 'callback', value: { ...base, action } }] }))] } }
  const destination = target.direct ? ['+messages-send', '--chat-id', target.chatId]
    : ['+messages-reply', '--message-id', target.rootId!, '--reply-in-thread']
  const sent = receipt.safeParse(await commands.lark(['im', ...destination, '--msg-type', 'interactive', '--content', JSON.stringify(content),
    '--idempotency-key', view.id]))
  if (!sent.success || sent.data.chat_id !== target.chatId || sent.data.message_id === target.rootId) throw new Error('Invalid Feishu settings card receipt')
  return sent.data.message_id
}
