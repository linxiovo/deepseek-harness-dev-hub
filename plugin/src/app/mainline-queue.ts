/** Durable Git-target FIFO and reconciliation of interrupted mainline writes. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { UserError } from '../core/errors.ts'
import { KV } from '../kv.ts'
import type { DeliveryTargetResult, MainlineTarget } from '../executor/mainline-git.ts'
import type { DocTreeScope } from '../executor/doc-tree.ts'
import type { MainlineRepair } from '../core/model.ts'
import type { PlanDeliveryReceipt } from '../core/plan.ts'
import { Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

/** Exact Actions lookup authorized before the Git write, independent of later PR state. */
export type MainlineCiBinding = { pull: number } | { branch: string }

export type DeliveryTargetObservation = { actual: string; verifiedAt: string } | { missing: string }
export type CheckDeliveryTarget = (scope: DocTreeScope) => Promise<DeliveryTargetObservation>

export interface MergeApproval {
  readonly target: MainlineTarget
  readonly base: string
  readonly candidate: string
  readonly assignment: string
  readonly generation: number
  readonly stamp: string
  readonly ci: MainlineCiBinding
}

export interface MainlineIntent extends Omit<MergeApproval, 'stamp' | 'ci'> {
  id: string
  ticket_id: string
  queued_at: string
  status: 'queued' | 'applying' | 'waiting' | 'repair' | 'verified'
  applying_at?: string
  integration?: string
  actual?: string
  observed_at?: string
  reason?: string
  repair_requested?: boolean
  verification?: { status: 'passed'; at: string; method: 'integration_on_target' }
  ci?: MainlineCiBinding
  delivery_missing?: string[]
}

interface QueueHost {
  store: Pick<Store, 'get' | 'set' | 'delete' | 'atomic' | 'tickets'>
  effects: Pick<Effects, 'handle' | 'enqueue' | 'pending'>
  lifetime: AbortSignal
  available(): boolean
  paused(): boolean
  approve(id: string, candidate: string, signal?: AbortSignal, replay?: MainlineIntent): Promise<MergeApproval>
  authorize(id: string, approval: MergeApproval): void
  inspectDelivery(intent: MainlineIntent, verify: CheckDeliveryTarget): Promise<{
    missing: string[]; approval?: MergeApproval; observation?: DeliveryTargetObservation
  }>
  closeDelivery(approval: MergeApproval, receipt: PlanDeliveryReceipt): string | undefined
  read(target: MainlineTarget): Promise<string>
  precedes(target: MainlineTarget, ancestor: string, descendant: string): Promise<boolean>
  verifyDelivery(target: MainlineTarget, base: string, integration: string, actual: string, scope: DocTreeScope): Promise<DeliveryTargetResult>
  prepare(target: MainlineTarget, candidate: string, intent: string, queuedAt: string): Promise<string>
  advance(target: MainlineTarget, base: string, candidate: string, authorize: () => Promise<void>): Promise<'advanced' | 'unchanged'>
  repair(id: string, repair: MainlineRepair): Promise<void>
  changed(intent: MainlineIntent, delivered?: boolean): void
}

type MainlineStore = Pick<Store, 'get'>
export const mainlineAttempts = (store: MainlineStore, ticketId: string) => store.get(KV.mainline.ticket(ticketId)) ?? []
export const mainlineIntent = (store: MainlineStore, ticketId: string) => mainlineAttempts(store, ticketId).at(-1)
const targetKey = ({ slug, ref }: MainlineTarget) => JSON.stringify([slug.toLowerCase(), ref])
const now = () => new Date().toISOString()

/** Serializes pushes for each GitHub repo/ref and verifies observed Git ancestry after an authorized write. */
export class MainlineQueue {
  constructor(private readonly host: QueueHost) {
    host.effects.handle('mainline', (_, key) => this.drain(key), { limit: () => host.available() ? 8 : 0 })
    host.effects.handle('mainlineRepair', ({ ticketId }, id) => this.repair(ticketId, id), { limit: () => host.available() && !host.paused() ? 8 : 0 })
    host.effects.handle('mainlineDelivery', ({ ticketId }, id) => this.deliver(ticketId, id), { limit: () => host.available() ? 8 : 0 })
  }

  private existing(ticketId: string, candidate: string) {
    const existing = mainlineIntent(this.host.store, ticketId)
    if (!existing || existing.status === 'repair' || existing.status === 'waiting') return undefined
    if (existing.candidate !== candidate) {
      // Preserve the real merge as history; an open Ticket can queue fresh, fully checked work after a refused closure.
      if (existing.status === 'verified' && existing.delivery_missing?.length && !this.host.store.tickets.get(ticketId)?.ended) return undefined
      throw new UserError('mainlineRefused', { reason: 'Ticket already has a queued or verified mainline candidate' })
    }
    return existing
  }

  /** Replaying an already verified intent can retry closure, but never queues another Git write. */
  private replay(intent: MainlineIntent): MainlineIntent {
    const { store, effects } = this.host
    if (intent.status === 'verified' && store.tickets.get(intent.ticket_id)?.ended?.by !== 'delivery' && !effects.pending('mainlineDelivery', intent.id)) {
      effects.enqueue('mainlineDelivery', intent.id, { ticketId: intent.ticket_id })
    }
    return intent
  }

  async enqueue(ticketId: string, candidate: string, signal?: AbortSignal): Promise<MainlineIntent> {
    const { store, effects } = this.host
    signal?.throwIfAborted()
    const existing = this.existing(ticketId, candidate)
    if (existing) return this.replay(existing)
    const approval = await this.host.approve(ticketId, candidate, signal)
    signal?.throwIfAborted()
    this.host.authorize(ticketId, approval)
    return store.atomic(() => {
      const latest = this.existing(ticketId, candidate)
      if (latest) return this.replay(latest)
      const { target, base, assignment, generation } = approval
      const previous = mainlineIntent(store, ticketId)
      if (previous?.status === 'repair' && (!previous.repair_requested || previous.actual !== base)) {
        throw new UserError('mainlineRefused', { reason: 'Candidate needs Worker repair and fresh evidence on the observed target baseline' })
      }
      if (base === candidate) throw new UserError('mainlineRefused', { reason: 'Mainline candidate must change the pinned base' })
      const intent: MainlineIntent = { id: randomUUID(), ticket_id: ticketId, queued_at: now(), status: 'queued', target, base, candidate, assignment, generation }
      const key = targetKey(target), pending = KV.mainline.pending(key)
      store.set(KV.mainline.ticket(ticketId), [...mainlineAttempts(store, ticketId), intent])
      const queue = store.get(pending) ?? []
      store.set(pending, [...queue, ticketId])
      if (!queue.length) effects.enqueue('mainline', key, {})
      return intent
    })
  }

  private update(intent: MainlineIntent, status: MainlineIntent['status'], fields: Partial<MainlineIntent> = {}): void {
    const { store } = this.host
    const attempts = mainlineAttempts(store, intent.ticket_id)
    if (attempts.at(-1)?.id !== intent.id) throw new Error('Mainline intent changed during processing')
    attempts[attempts.length - 1] = { ...intent, ...fields, status }
    store.set(KV.mainline.ticket(intent.ticket_id), attempts)
  }

  private finish(intent: MainlineIntent, status: 'verified' | 'waiting' | 'repair', fields: Partial<MainlineIntent>): void {
    const { store, effects } = this.host
    store.atomic(() => {
      const pending = KV.mainline.pending(targetKey(intent.target)), queue = store.get(pending)
      if (queue?.[0] !== intent.ticket_id) throw new Error('Mainline intent is not at the head of its queue')
      this.update(intent, status, fields)
      if (queue.length > 1) store.set(pending, queue.slice(1))
      else store.delete(pending)
      if (status === 'repair') effects.enqueue('mainlineRepair', intent.id, { ticketId: intent.ticket_id })
      if (status === 'verified') effects.enqueue('mainlineDelivery', intent.id, { ticketId: intent.ticket_id })
      else this.host.changed({ ...intent, ...fields, status })
    })
  }

  private async verifyDeliveryTarget(intent: MainlineIntent, scope: DocTreeScope): Promise<DeliveryTargetObservation> {
    const { host } = this, { integration, verification } = intent
    if (!intent.applying_at || !integration || integration === intent.candidate || !intent.actual ||
        verification?.status !== 'passed' || verification.method !== 'integration_on_target') return { missing: 'mainline_verification' }
    try {
      const actual = await host.read(intent.target)
      if (actual !== integration) {
        const check = await host.verifyDelivery(intent.target, intent.base, integration, actual, scope)
        if (check !== 'passed') return { missing: check }
      }
      host.lifetime.throwIfAborted()
      return { actual, verifiedAt: now() }
    } catch (error) {
      host.lifetime.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      return { missing: 'mainline_unavailable' }
    }
  }

  /** Close only after rechecking the exact approved evidence and reacquiring proof from the actual target. */
  private async deliver(ticketId: string, id: string): Promise<void> {
    const { host } = this, { store } = host
    const intent = mainlineIntent(store, ticketId)
    if (intent?.id !== id || intent.status !== 'verified' || store.tickets.get(ticketId)?.ended?.by === 'delivery') return
    const { missing, approval, observation } = await host.inspectDelivery(intent, scope => this.verifyDeliveryTarget(intent, scope))
    const integration = intent.integration
    host.lifetime.throwIfAborted()
    store.atomic(() => {
      const current = mainlineIntent(store, ticketId)
      if (current?.id !== id || current.status !== 'verified' || store.tickets.get(ticketId)?.ended?.by === 'delivery') return
      if (approval && integration && observation && 'actual' in observation && !missing.length) {
        const receipt: PlanDeliveryReceipt = { ticketId, assignmentId: intent.assignment, receiptId: id, base: intent.base,
          generation: intent.generation, candidate: intent.candidate, integration, ...observation }
        const refused = host.closeDelivery(approval, receipt)
        if (!refused) {
          if (current.delivery_missing) this.update(current, 'verified', { delivery_missing: undefined })
          host.changed(current, true)
          return
        }
        missing.push(refused)
      }
      if (!missing.length) throw new Error('Formal delivery was neither approved nor blocked')
      if (isDeepStrictEqual(current.delivery_missing, missing)) return
      this.update(current, 'verified', { delivery_missing: missing })
      host.changed({ ...current, delivery_missing: missing })
    })
  }

  private async repair(ticketId: string, id: string): Promise<void> {
    const intent = mainlineIntent(this.host.store, ticketId)
    if (!intent?.actual || intent.id !== id || intent.status !== 'repair' || intent.repair_requested) return
    try {
      await this.host.repair(ticketId, { id, assignment: intent.assignment, previousBase: intent.base, base: intent.actual,
        candidate: intent.candidate, ref: intent.target.ref })
      if (mainlineIntent(this.host.store, ticketId)?.id === id) this.update(intent, 'repair', { repair_requested: true, reason: undefined })
    } catch (error) {
      this.host.lifetime.throwIfAborted()
      if (mainlineIntent(this.host.store, ticketId)?.id === id) {
        this.update(intent, 'repair', { reason: `Worker repair request has not succeeded: ${message(error)}` })
      }
      throw error
    }
  }

  private async drain(key: string): Promise<void> {
    for (;;) {
      this.host.lifetime.throwIfAborted()
      const ticketId = this.host.store.get(KV.mainline.pending(key))?.[0]
      if (ticketId === undefined) return
      const intent = mainlineIntent(this.host.store, ticketId)
      if (!intent || targetKey(intent.target) !== key || (intent.status !== 'queued' && intent.status !== 'applying')) {
        throw new Error('Inconsistent durable mainline queue')
      }
      await this.process(intent)
    }
  }

  private async observe(intent: MainlineIntent): Promise<MainlineIntent | undefined> {
    const { host } = this
    let actual: string
    try { actual = await host.read(intent.target) }
    catch (error) {
      host.lifetime.throwIfAborted()
      this.update(intent, intent.status, { reason: 'Cannot verify the actual Git target; will check again' })
      throw error
    }
    host.lifetime.throwIfAborted()
    const observed = { actual, observed_at: now() }
    const live = { ...intent, ...observed }
    if (actual === intent.base) return live
    const integrated = intent.integration !== undefined && (actual === intent.integration ||
      await host.precedes(intent.target, intent.integration, actual))
    host.lifetime.throwIfAborted()
    if (integrated) {
      this.finish(live, 'verified', { reason: 'Observed the intent-specific integration commit on the actual target',
        verification: { status: 'passed', at: observed.observed_at, method: 'integration_on_target' } })
    } else if (actual === intent.candidate || await host.precedes(intent.target, intent.candidate, actual)) {
      this.finish(live, 'waiting', { reason: 'The target contains the candidate but not the queued integration commit' })
    } else if (await host.precedes(intent.target, intent.base, actual)) {
      host.lifetime.throwIfAborted()
      this.finish(live, 'repair', { reason: 'The target advanced; refresh the candidate and all required evidence on the actual base' })
    } else {
      this.finish(live, 'waiting', { reason: 'Target history moved away from the reviewed baseline; no queued write is safe' })
    }
    return undefined
  }

  private async process(intent: MainlineIntent): Promise<void> {
    const { host } = this
    if (host.paused() && intent.status === 'queued') throw new Later()
    const observed = await this.observe(intent)
    if (!observed) return
    if (host.paused()) throw new Later()
    let applying = observed
    try {
      const integration = await host.prepare(intent.target, intent.candidate, intent.id, intent.queued_at)
      if (intent.integration && intent.integration !== integration) throw new Error('The prepared integration commit does not match the persisted intent')
      await host.advance(intent.target, intent.base, integration, async () => {
        const approval = await host.approve(intent.ticket_id, intent.candidate, host.lifetime, intent)
        if (approval.base !== intent.base || targetKey(approval.target) !== targetKey(intent.target) || approval.target.repository !== intent.target.repository ||
            approval.assignment !== intent.assignment || approval.generation !== intent.generation) {
          throw new UserError('mainlineRefused', { reason: 'Queued candidate no longer has matching delivery evidence' })
        }
        host.lifetime.throwIfAborted()
        if (host.paused()) throw new Later()
        host.authorize(intent.ticket_id, approval)
        applying = { ...observed, status: 'applying', applying_at: observed.applying_at ?? now(), integration, ci: approval.ci }
        // Commit the intent before starting the mutating subprocess, including on its first attempt.
        this.update(applying, 'applying', { reason: 'Git write may be in flight; compare the actual target before retrying' })
      })
      host.lifetime.throwIfAborted()
    } catch (error) {
      host.lifetime.throwIfAborted()
      if (error instanceof Later) throw error
      const live = await this.observe(applying)
      if (live) this.finish(live, 'waiting', { reason: message(error) })
      return
    }
    const live = await this.observe(applying)
    if (live) this.finish(live, 'waiting', { reason: 'The target did not retain the candidate; no merge verification issued' })
  }
}

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 280) : 'Mainline check did not succeed'
