import { randomBytes, randomUUID } from 'node:crypto'
import type { Handoff } from '../core/handoff.ts'
import { key, type ChannelRef, type Outbox, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { feishuThreadId, feishuTriggerId, SOURCE } from '../sources/feishu-trigger.ts'
import type { Handoffs } from './handoffs.ts'
import type { Store } from './store.ts'

interface Target { chatId: string; direct: boolean; rootId?: string }
interface Binding extends Target {
  projectId: string
  epoch: string
  boundAt: string
  triggerId: string
  allowedActors: string[]
}
export type TopicBindingView = Binding | null
export interface TopicBindingRecord {
  binding: Binding
  botIdentity: string
  pending?: { handoffId: string; questionId: string; token: string; noticeId: string }
}
interface Options {
  store: Store
  handoffs: Pick<Handoffs, 'current' | 'answer'>
  outbox: Outbox
  projectId: string
  projectLink: string
  settingsLink: string
  available: () => boolean
  botIdentity: () => string | undefined
}
/** An operator binding request was invalid, referenced unknown input, or conflicted with current project or bot state. */
export class TopicBindingError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

const chatIdPattern = /^oc_[A-Za-z0-9]+$/
const messageIdPattern = /^om_[A-Za-z0-9_-]+$/
const actorIdPattern = /^ou_[A-Za-z0-9]+$/
const replyPrefix = /^answer ([0-9a-f]{24}):/u
const approvalOnly = /^(?:同意|批准|确认批准|approve[d]?|i approve|agree[d]?|i agree)[.!。！]?$/iu

function sameTarget(a: Target, b: Target): boolean {
  return a.chatId === b.chatId && a.direct === b.direct && a.rootId === b.rootId
}

/** Never use display labels, addressed/mention status, a caller's channel, or the last message as routing authority. */
function targetOf(trigger: Trigger): Target | undefined {
  const { chatId, direct, messageId, rootId } = trigger.meta
  if (trigger.source !== SOURCE || typeof chatId !== 'string' || !chatIdPattern.test(chatId) || typeof direct !== 'boolean' ||
      typeof messageId !== 'string' || !messageIdPattern.test(messageId) ||
      (rootId !== undefined && (typeof rootId !== 'string' || !messageIdPattern.test(rootId)))) return
  return direct ? { chatId, direct } : { chatId, direct, rootId: rootId ?? messageId }
}

/** Only accept the Source normalizer's consistent native message, thread and channel tuple. */
function normalized(trigger: Trigger, target: Target): boolean {
  const { chatId, direct } = target, messageId = trigger.meta.messageId as string
  const channel = trigger.channel, primary = trigger.threads[0]
  return trigger.id === feishuTriggerId(messageId) && trigger.actor.source === SOURCE &&
    primary?.source === SOURCE && primary.id === feishuThreadId(chatId, trigger.meta.rootId as string | undefined, messageId) &&
    channel?.source === SOURCE && channel.thread === `feishu:${chatId}` && channel.address.chatId === chatId &&
    channel.address.messageId === messageId && channel.address.direct === (direct ? 'true' : undefined)
}

const summary = (handoff?: Handoff): string => !handoff ? 'No current handoff.' : {
  confirmed: 'Handoff confirmed.', planning: 'Planning is in progress.', awaiting: 'A product clarification is pending.',
  specified: 'The project specification has been published.',
}[handoff.status]

/** A project-selected second entrance to the canonical handoff, not a source of general work or approval. */
export class TopicBinding {
  constructor(private readonly options: Options) {}

  private active(): TopicBindingRecord | undefined {
    const record = this.options.store.get(KV.topicBinding.active)
    if (record && record.binding.projectId !== this.options.projectId) throw new TopicBindingError(409, 'Binding belongs to a different project')
    return record
  }

  private available(record: TopicBindingRecord): boolean {
    return this.options.available() && !!record.botIdentity && record.botIdentity === this.options.botIdentity()
  }
  view(): TopicBindingView { return this.active()?.binding ?? null }

  /** Unlike the operator view, a poll must not read the old target through a replacement bot's credentials. */
  pollTarget(): TopicBindingView {
    const record = this.active()
    return record && this.available(record) ? record.binding : null
  }

  bind(triggerId: string, allowedActors: string[]): Binding {
    if (typeof triggerId !== 'string' || !triggerId.trim() || !Array.isArray(allowedActors) ||
        allowedActors.some(id => typeof id !== 'string' || !actorIdPattern.test(id))) {
      throw new TopicBindingError(400, 'Supply an observed Feishu trigger and an explicit list of Feishu user open_ids')
    }
    const actors = [...new Set(allowedActors)].sort()
    const { store, projectId, handoffs } = this.options
    return store.atomic(() => {
      const botIdentity = this.options.botIdentity()
      if (!this.options.available() || !botIdentity) throw new TopicBindingError(409, 'Feishu is unavailable for this project')
      const trigger = store.triggers.get(triggerId)
      if (!trigger) throw new TopicBindingError(404, 'Trigger not observed in this project')
      const target = targetOf(trigger)
      if (trigger.id !== triggerId || !target || !normalized(trigger, target)) throw new TopicBindingError(400, 'Not a normalized Feishu trigger')
      if (!target.direct && trigger.meta.parentId && !trigger.meta.rootId) throw new TopicBindingError(400, 'This group reply has no observed topic root')
      if (trigger.meta.botIdentity !== botIdentity) throw new TopicBindingError(409, 'Observe a message from the current Feishu bot before binding')
      const active = this.active()
      if (active) {
        const prior = active.binding
        if (active.botIdentity === botIdentity && sameTarget(prior, target) && prior.allowedActors.length === actors.length &&
            prior.allowedActors.every((id, i) => id === actors[i])) return prior
        throw new TopicBindingError(409, 'Unbind the existing topic before changing its target or participants')
      }
      const binding: Binding = { ...target, projectId, triggerId, epoch: randomUUID(), boundAt: new Date().toISOString(), allowedActors: actors }
      const record = { binding, botIdentity }
      store.set(KV.topicBinding.active, record)
      const current = handoffs.current(projectId)
      this.notice(binding, 'binding', `Project topic bound. ${summary(current)} Use Harness settings for approvals.`)
      if (current?.status === 'awaiting') this.projectQuestion(record, current)
      return binding
    })
  }

  unbind(): null {
    const { store, outbox } = this.options
    return store.atomic(() => {
      const binding = this.view()
      if (binding) {
        store.delete(KV.topicBinding.active)
        for (const receipt of store.receipts.waiting()) {
          if (receipt.channel.source === SOURCE && receipt.channel.address.bindingEpoch === binding.epoch) outbox.withdraw(receipt.id)
        }
      }
      return null
    })
  }

  matches(trigger: Trigger): boolean {
    const target = targetOf(trigger), binding = this.view()
    return !!target && !!binding && sameTarget(binding, target)
  }

  /** A read pinned to this binding was rejected before intake (e.g. unbind across an await). Its replay is not general work. */
  discard(trigger: Trigger): void {
    const target = targetOf(trigger)
    if (target && normalized(trigger, target)) this.options.store.set(KV.topicBinding.received(trigger.id), true)
  }

  /** Separate from generic chat scope. Outbox rechecks this immediately before sending an epoch-tagged receipt. */
  allows(channel: Pick<ChannelRef, 'source' | 'address'>): boolean {
    const record = this.active(), address = channel.address
    if (!record || !this.available(record) || channel.source !== SOURCE) return false
    const { binding } = record
    return address.bindingEpoch === binding.epoch && address.chatId === binding.chatId && address.messageId === binding.rootId &&
      address.delivery === (binding.direct ? 'direct-chat' : 'group-topic') && address.direct === (binding.direct ? 'true' : undefined)
  }

  /** Hook called synchronously *inside* the canonical handoff transaction. Never mirror user-, planner- or spec-authored text. */
  changed(handoff: Handoff): void {
    const record = this.active()
    if (!record || record.binding.projectId !== handoff.project.id) return
    if (handoff.status === 'awaiting') { this.projectQuestion(record, handoff); return }
    if (record.pending) {
      this.options.outbox.withdraw(record.pending.noticeId)
      const { pending: _pending, ...active } = record
      this.options.store.set(KV.topicBinding.active, active)
    }
    if (handoff.status === 'specified' || handoff.status === 'confirmed') {
      this.notice(record.binding, `${handoff.id}:${handoff.status}`, summary(handoff))
    }
  }

  /** An unguessable challenge identifies this exact question in this binding epoch even across delayed/backfilled events. */
  private projectQuestion(record: TopicBindingRecord, handoff: Handoff): void {
    const question = handoff.question
    if (!question || question.status !== 'awaiting' || record.pending?.questionId === question.id) return
    const token = randomBytes(12).toString('hex')
    const noticeId = this.notice(record.binding, `${handoff.id}:${question.id}`,
      `A product clarification is pending. Read the question in Harness. To answer here, type \`answer ${token}:\` followed by your answer.`)
    this.options.store.set(KV.topicBinding.active, { ...record, pending: { handoffId: handoff.id, questionId: question.id, token, noticeId } })
  }

  /** True means consumed (including rejection). Only an explicit participant's fresh, correlated clarification reaches Handoffs.answer. */
  receive(trigger: Trigger): boolean {
    const target = targetOf(trigger)
    if (!target) return false
    const { store, handoffs, projectId } = this.options
    return store.atomic(() => {
      const receipt = KV.topicBinding.received(trigger.id)
      if (store.get(receipt)) return true
      const record = this.active()
      if (!record || !sameTarget(target, record.binding)) {
        // Protocol traffic for a retired or differently mounted binding must never become a general request.
        return replyPrefix.test(trigger.text.trimStart())
      }
      store.set(receipt, true) // Do not store rejected message text in the general Trigger timeline.
      if (!normalized(trigger, target) || trigger.human !== true || !record.binding.allowedActors.includes(trigger.actor.id) ||
          !this.available(record) || trigger.meta.botIdentity !== record.botIdentity || store.triggers.get(trigger.id)) return true
      const text = trigger.text.trim()
      if (/^(?:status|状态)$/iu.test(text)) {
        if (Date.parse(trigger.at) >= Date.parse(record.binding.boundAt)) this.notice(record.binding, `status:${trigger.id}`, summary(handoffs.current(projectId)))
        return true
      }
      const reply = replyPrefix.exec(text), pending = record.pending
      if (!reply || !pending || reply[1] !== pending.token) return true
      const answer = text.slice(reply[0].length).trim()
      if (!answer || approvalOnly.test(answer)) return true
      const current = handoffs.current(projectId)
      if (current?.id === pending.handoffId && current.status === 'awaiting' && current.question?.id === pending.questionId && current.question.status === 'awaiting') {
        handoffs.answer(current.id, pending.questionId, answer, { source: SOURCE, actorId: trigger.actor.id, triggerId: trigger.id })
      }
      return true
    })
  }

  private notice(binding: Binding, event: string, text: string): string {
    const { outbox, projectLink, settingsLink } = this.options
    const id = key('topic-binding', binding.epoch, event)
    const address = { chatId: binding.chatId, bindingEpoch: binding.epoch, ...(binding.direct ? { direct: 'true', delivery: 'direct-chat' }
      : { messageId: binding.rootId!, delivery: 'group-topic' }) }
    outbox.send({ id, kind: 'notice', channel: { source: SOURCE, thread: `feishu:${binding.chatId}`, address },
      text: `${text}\n[Project](${projectLink}) · [Settings](${settingsLink})` })
    return id
  }
}
