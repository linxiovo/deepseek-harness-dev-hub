/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: the answer to a person's question once the worker reported it, the result of a ticket
 * that is `ready`, `completed`, `merged`, or `dropped`, or the ticket's current `question` for a person (`attention`). When
 * `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest = {
  purpose: 'answer' | 'result' | 'attention'
  ticketId?: string
  triggerId?: string
  question?: string
  text: string
}
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }
/** A worker's internal take-up of a person's message: the ticket and Trigger it joins, and whether the ticket had recorded it already. */
export interface TakeUp { ticketId: string; triggerId: string; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: the acknowledgement an accept carries, the
 * answer to a person's question, a ticket's result, and its question for a person, each only when its rule allows it, under a
 * deterministic id that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the
 * acknowledgement an accept carries, and Assignments asks it to withdraw a question a report replaced. It also records a
 * worker's internal take-up of a person's message without writing to any Channel (`takeUpInternally`).
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an answer goes where that person's message was written, attention
   * where the message that raised the question was (or to the ticket's starting conversation), and a result to the
   * conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`, `merged`, or
   * `dropped`). Each message is queued at most once (idempotent).
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply { return this.answer(request) }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  /**
   * Record that a ticket's worker takes a person's message up as within its ticket, without sending, queueing, or refreshing
   * any message to the person: only the Trigger's disposition records it, and repeating a recorded take-up records nothing.
   * @throws UserError when the ticket or trigger is unknown, the ticket ended, or the trigger is not a person's message that
   * reached the ticket on a thread it may write to.
   */
  takeUpInternally(ticketId: string, triggerId: string): TakeUp {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only: their messages cannot be taken up as this ticket's work.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.human) throw new UserError('ackNotPerson')
    const reused = !!this.repo.triggers.disposition(triggerId)?.acked?.includes(ticketId)
    if (!reused) this.takeUp(ticketId, triggerId)
    return { ticketId, triggerId, reused }
  }
  private answer(request: ReplyRequest): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
