/** Settings approval cards and their native Feishu callbacks; no message text or card update token grants authority. */
import { z } from 'zod'
import { SETTINGS_CONFIRMATION_LIFETIME_MS, type SettingsCardAction, type SettingsConfirmationView } from '../confirmed-settings.ts'
import type { Commands } from '../infra/commands.ts'
import { feishuBoundThread } from './feishu-read.ts'

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
const historicalPage = z.object({ items: z.array(z.unknown()).max(50), has_more: z.boolean(), page_token: z.string().optional() })
const historicalMessage = z.object({ message_id: messageId, chat_id: chatId, root_id: messageId.optional(), thread_id: z.string().optional(),
  msg_type: z.string(), create_time: z.string().regex(/^\d{1,16}$/), deleted: z.boolean().optional(),
  sender: z.object({ id: z.string(), id_type: z.enum(['app_id', 'open_id']), sender_type: z.enum(['app', 'user', 'anonymous', 'unknown']) }),
  body: z.object({ content: z.string() }).optional() })
const botIdentitySchema = z.string().regex(/^cli_[A-Za-z0-9]+:ou_[A-Za-z0-9]+$/)
const MAX_HISTORY_PAGES = 20

function cardContent(view: SettingsConfirmationView) {
  const plain = (content: string) => ({ tag: 'plain_text', content })
  const description = [`Project: ${view.repository} (${view.projectId})`, `Setting: ${view.object}${view.chatId ? ` (${view.chatId})` : ''}`,
    `Current: ${view.currentValue ?? 'unlimited'} → Proposed: ${view.proposedValue ?? 'unlimited'}`,
    `Effective: ${view.effectiveValue ?? 'unlimited'} (revision ${view.effectiveRevision})`,
    `Impact: ${view.impact}`, `Status: ${view.status}. Approval expires: ${view.expiresAt}`, `Request: ${view.id}`].join('\n')
  const base = { projectId: view.projectId, requestId: view.id, revision: view.revision }
  return { schema: '2.0', config: { enable_forward: false }, header: { title: plain('Project settings approval'), template: 'blue' },
    body: { elements: [{ tag: 'div', text: plain(description) }, ...(['approve', 'status'] as const).map(action => ({ tag: 'button',
      text: plain(action === 'approve' ? 'Approve change' : 'Check current status'), type: action === 'approve' ? 'primary_filled' : 'default',
      behaviors: [{ type: 'callback', value: { ...base, action } }] }))] } }
}
function cardMatches(content: string, view: SettingsConfirmationView): boolean {
  try {
    const parsed = JSON.parse(content)
    const shape = z.strictObject({ schema: z.literal('2.0'), config: z.strictObject({ enable_forward: z.literal(false) }),
      header: z.strictObject({ title: z.strictObject({ tag: z.literal('plain_text'), content: z.string() }), template: z.string() }),
      body: z.strictObject({ elements: z.array(z.unknown()).length(3) }) }).safeParse(parsed)
    if (!shape.success) return false
    const elements = parsed.body.elements
    const description = z.strictObject({ tag: z.literal('div'), text: z.strictObject({ tag: z.literal('plain_text'), content: z.string() }) }).safeParse(elements[0])
    if (!description.success || description.data.text.content.split('\n').filter(line => line === `Request: ${view.id}`).length !== 1) return false
    const button = z.strictObject({ tag: z.literal('button'), text: z.strictObject({ tag: z.literal('plain_text'), content: z.string() }),
      type: z.string(), behaviors: z.array(z.strictObject({ type: z.literal('callback'), value: payload })).length(1) })
    const actions = new Map<string, z.infer<typeof payload>>()
    for (const raw of elements.slice(1)) {
      const result = button.safeParse(raw)
      if (!result.success) return false
      const value = result.data.behaviors[0]!.value
      if (actions.has(value.action)) return false
      actions.set(value.action, value)
    }
    return actions.size === 2 && ['approve', 'status'].every(action => {
      const value = actions.get(action)
      return value?.action === action && value.projectId === view.projectId && value.requestId === view.id && value.revision === view.revision
    })
  } catch { return false }
}

/** Find exactly one still-present original card sent by this bot in the exact DM or bound group topic. */
export async function findSettingsCard(commands: Commands, target: { chatId: string; direct: boolean; rootId?: string },
  view: SettingsConfirmationView, botIdentity: string, active: () => boolean): Promise<string | undefined> {
  if (!chatId.safeParse(target.chatId).success || (target.direct === true ? target.rootId !== undefined
    : target.direct !== false || !messageId.safeParse(target.rootId).success)) throw new Error('Invalid Feishu settings card recovery target')
  const identity = botIdentitySchema.safeParse(botIdentity)
  if (!identity.success || !payload.safeParse({ projectId: view.projectId, requestId: view.id, revision: view.revision, action: 'approve' }).success)
    throw new Error('Invalid Feishu settings card recovery identity')
  const [appId, botId] = botIdentity.split(':')
  const ensureActive = () => { if (!active()) throw new Error('Feishu settings card recovery identity is no longer active') }
  let threadId: string | undefined
  if (!target.direct) {
    ensureActive()
    try { threadId = await feishuBoundThread(commands, target.chatId, target.rootId!) }
    catch { ensureActive(); throw new Error('Feishu settings card recovery scope could not be verified') }
    ensureActive()
    if (!threadId) throw new Error('Feishu settings card recovery topic could not be verified')
  }
  const now = Date.now(), createdAt = Date.parse(view.expiresAt) - SETTINGS_CONFIRMATION_LIFETIME_MS
  if (!Number.isFinite(createdAt) || createdAt > now || createdAt < 0) throw new Error('Invalid Feishu settings card recovery time window')
  const paramsBase = target.direct
    ? { container_id_type: 'chat', container_id: target.chatId, start_time: String(Math.floor(createdAt / 1000)), end_time: String(Math.ceil(now / 1000)) }
    : { container_id_type: 'thread', container_id: threadId! }
  const cursors = new Set<string>(), matches = new Set<string>()
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex++) {
    ensureActive()
    const params = { ...paramsBase, sort_type: 'ByCreateTimeAsc', page_size: 50, card_msg_content_type: 'user_card_content', ...(cursor ? { page_token: cursor } : {}) }
    let raw: unknown
    try { raw = await commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(params)]) }
    catch { ensureActive(); throw new Error('Feishu settings card history could not be verified') }
    ensureActive()
    const parsedPage = historicalPage.safeParse(raw)
    if (!parsedPage.success) throw new Error('Feishu settings card history page is incomplete or invalid')
    const page = parsedPage.data
    for (const item of page.items) {
      const parsedMessage = historicalMessage.safeParse(item)
      if (!parsedMessage.success) throw new Error('Feishu settings card history contains an unverifiable message')
      const message = parsedMessage.data
      if (message.chat_id !== target.chatId) throw new Error('Feishu settings card history escaped the requested chat')
      if (threadId && ((message.root_id && message.root_id !== target.rootId) || (message.thread_id && message.thread_id !== threadId)))
        throw new Error('Feishu settings card history returned a message outside the bound topic')
      if (message.message_id === target.rootId) continue
      const messageTime = Number(message.create_time)
      if (target.direct && (messageTime < createdAt || messageTime > now)) continue
      if (message.deleted) continue
      if (message.msg_type !== 'interactive' || message.sender.sender_type !== 'app' ||
        !((message.sender.id_type === 'app_id' && message.sender.id === appId) || (message.sender.id_type === 'open_id' && message.sender.id === botId))) continue
      if (!message.body) throw new Error('Feishu settings card history contains an incomplete app card')
      try { JSON.parse(message.body.content) } catch { throw new Error('Feishu settings card history contains an undecodable app card') }
      const marker = message.body.content.includes(`Request: ${view.id}`)
      if (marker && cardMatches(message.body.content, view)) matches.add(message.message_id)
      else if (marker) throw new Error('Feishu settings card history contains an ambiguous request marker')
    }
    if (!page.has_more) break
    if (!page.page_token || cursors.has(page.page_token)) throw new Error('Feishu settings card history pagination is incomplete')
    cursors.add(page.page_token)
    cursor = page.page_token
    if (pageIndex === MAX_HISTORY_PAGES - 1) throw new Error('Feishu settings card history exceeded its verification page limit')
  }
  ensureActive()
  if (matches.size > 1) throw new Error('Multiple Feishu settings cards match this request')
  return matches.values().next().value
}

/** Deliver one non-forwardable card only to the bound DM or root; a retry of the request uses the same native UUID. */
export async function sendSettingsCard(commands: Pick<Commands, 'lark'>, target: { chatId: string; direct: boolean; rootId?: string },
  view: SettingsConfirmationView): Promise<string> {
  if (!chatId.safeParse(target.chatId).success || (target.direct === true ? target.rootId !== undefined
    : target.direct !== false || !messageId.safeParse(target.rootId).success)) throw new Error('Invalid Feishu settings card target')
  const base = { projectId: view.projectId, requestId: view.id, revision: view.revision }
  if (!payload.safeParse({ ...base, action: 'approve' }).success) throw new Error('Invalid Feishu settings card reference')
  const content = cardContent(view)
  const destination = target.direct ? ['+messages-send', '--chat-id', target.chatId]
    : ['+messages-reply', '--message-id', target.rootId!, '--reply-in-thread']
  const sent = receipt.safeParse(await commands.lark(['im', ...destination, '--msg-type', 'interactive', '--content', JSON.stringify(content),
    '--idempotency-key', view.id]))
  if (!sent.success || sent.data.chat_id !== target.chatId || sent.data.message_id === target.rootId) throw new Error('Invalid Feishu settings card receipt')
  return sent.data.message_id
}
