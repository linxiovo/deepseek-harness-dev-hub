/** Durable Git-target FIFO and reconciliation of interrupted mainline writes. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { UserError } from '../core/errors.ts'
import { KV } from '../kv.ts'
import type { DeliveryTargetResult, MainlineTarget } from '../executor/mainline-git.ts'
import type { DocTreeScope } from '../executor/doc-tree.ts'
import { GitLeaseRejected } from '../infra/commands.ts'
import type { MainlineRepair } from '../core/model.ts'
import type { PlanDeliveryReceipt } from '../core/plan.ts'
import { Later, Park, type Effects } from './effects.ts'
import type { Store } from './store.ts'

/** Exact Actions lookup authorized before the Git write, independent of later PR state. */
export type MainlineCiBinding = { pull: number; runs: Record<string, number> } | { branch: string }

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
  readonly rulesRevision?: number
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
  controlBlocked(ticketId: string): boolean
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
  advance(target: MainlineTarget, base: string, candidate: string, prepareWrite: () => Promise<() => void>): Promise<'advanced' | 'unchanged'>
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
    if (intent.status === 'verified' && !this.host.controlBlocked(intent.ticket_id)
      && store.tickets.get(intent.ticket_id)?.ended?.by !== 'delivery' && !effects.pending('mainlineDelivery', intent.id)) {
      effects.enqueue('mainlineDelivery', intent.id, { ticketId: intent.ticket_id })
    }
    return intent
  }

  async enqueue(ticketId: string, candidate: string, signal?: AbortSignal): Promise<MainlineIntent> {
    const { store, effects } = this.host
    signal?.throwIfAborted()
    const existing = this.existing(ticketId, candidate)
    if (existing) return this.replay(existing)
    if (this.host.controlBlocked(ticketId)) throw new UserError('mainlineRefused', { reason: 'Ticket is paused by Plan control' })
    const approval = await this.host.approve(ticketId, candidate, signal)
    signal?.throwIfAborted()
    if (this.host.controlBlocked(ticketId)) throw new UserError('mainlineRefused', { reason: 'Ticket is paused by Plan control' })
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
      const intent: MainlineIntent = { id: randomUUID(), ticket_id: ticketId, queued_at: now(), status: 'queued', target, base, candidate, assignment, generation,
        ...approval.rulesRevision === undefined ? {} : { rulesRevision: approval.rulesRevision } }
      const key = targetKey(target), pending = KV.mainline.pending(key)
      store.set(KV.mainline.ticket(ticketId), [...mainlineAttempts(store, ticketId), intent])
      const queue = store.get(pending) ?? []
      store.set(pending, [...queue, ticketId])
      effects.enqueue('mainline', key, {})
      return intent
    })
  }

  /** Rearm only the durable work of one resumed Ticket. */
  resumeTicket(ticketId: string): void {
    if (this.host.controlBlocked(ticketId)) return
    const intent = mainlineIntent(this.host.store, ticketId)
    if (!intent) return
    if (intent.status === 'verified') {
      if (this.host.store.tickets.get(ticketId)?.ended?.by !== 'delivery') {
        this.host.effects.enqueue('mainlineDelivery', intent.id, { ticketId })
      }
    } else if (intent.status === 'repair' && !intent.repair_requested) {
      this.host.effects.enqueue('mainlineRepair', intent.id, { ticketId })
    } else if (intent.status === 'queued' || intent.status === 'applying') {
      this.host.effects.enqueue('mainline', targetKey(intent.target), {})
    }
  }

  /** Retire an unadmitted candidate in the same transaction that supersedes its Ticket. */
  cancelQueued(ticketId: string): void {
    const intent = mainlineIntent(this.host.store, ticketId)
    if (intent?.status !== 'queued') return
    if (!this.host.controlBlocked(ticketId)) throw new Error('Cannot retire an unpaused mainline candidate')
    this.finish(intent, 'waiting', { reason: 'The approved requirement revision superseded the queued candidate before Git authorization' })
  }

  private current(intent: MainlineIntent): boolean {
    const latest = mainlineIntent(this.host.store, intent.ticket_id)
    return latest?.id === intent.id && latest.status === intent.status
  }

  private update(intent: MainlineIntent, status: MainlineIntent['status'], fields: Partial<MainlineIntent> = {}): void {
    const { store } = this.host
    const attempts = mainlineAttempts(store, intent.ticket_id)
    const current = attempts.at(-1)
    if (current?.id !== intent.id || (current.status === 'verified' && intent.status !== 'verified')) {
      throw new Error('Mainline intent changed during processing')
    }
    attempts[attempts.length - 1] = { ...intent, ...fields, status }
    store.set(KV.mainline.ticket(intent.ticket_id), attempts)
  }

  private finish(intent: MainlineIntent, status: 'verified' | 'waiting' | 'repair', fields: Partial<MainlineIntent>): void {
    const { store, effects } = this.host
    store.atomic(() => {
      const pending = KV.mainline.pending(targetKey(intent.target)), queue = store.get(pending) ?? []
      const index = queue.indexOf(intent.ticket_id)
      if (index < 0) throw new Error('Mainline intent is not in its target queue')
      this.update(intent, status, fields)
      const remaining = [...queue.slice(0, index), ...queue.slice(index + 1)]
      if (remaining.length) store.set(pending, remaining)
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
  private async deliver(ticketId: string, id: string): Promise<void | typeof Park> {
    const { host } = this, { store } = host
    const intent = mainlineIntent(store, ticketId)
    if (intent?.id !== id || intent.status !== 'verified' || store.tickets.get(ticketId)?.ended?.by === 'delivery') return
    if (host.controlBlocked(ticketId)) return Park
    const { missing, approval, observation } = await host.inspectDelivery(intent, scope => this.verifyDeliveryTarget(intent, scope))
    const integration = intent.integration
    host.lifetime.throwIfAborted()
    if (host.controlBlocked(ticketId)) return Park
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

  private async repair(ticketId: string, id: string): Promise<void | typeof Park> {
    const intent = mainlineIntent(this.host.store, ticketId)
    if (!intent?.actual || intent.id !== id || intent.status !== 'repair' || intent.repair_requested) return
    if (this.host.controlBlocked(ticketId)) return Park
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
    const deferred = new Set<string>()
    for (;;) {
      this.host.lifetime.throwIfAborted()
      let next: MainlineIntent | undefined
      for (const id of this.host.store.get(KV.mainline.pending(key)) ?? []) {
        const intent = mainlineIntent(this.host.store, id)
        if (!intent || targetKey(intent.target) !== key || (intent.status !== 'queued' && intent.status !== 'applying')) {
          throw new Error('Inconsistent durable mainline queue')
        }
        // Reconcile admitted writes first. An unconfirmed paused write cannot start again, and each later write still needs an exact lease.
        if (intent.status === 'applying') {
          if (deferred.has(intent.id)) continue
          next = intent
          break
        }
        if (!next && !this.host.controlBlocked(id)) next = intent
      }
      if (!next) {
        if (deferred.size) throw new Later()
        return
      }
      if (await this.process(next)) deferred.add(next.id)
    }
  }

  private async observe(intent: MainlineIntent, readOnly = false): Promise<MainlineIntent | undefined> {
    const { host } = this
    const reconcileOnly = () => intent.status === 'applying' && (readOnly || host.controlBlocked(intent.ticket_id))
    let live = intent
    let observedAt: string
    let outcome: { status: 'verified' | 'waiting' | 'repair'; reason: string } | undefined
    try {
      const actual = await host.read(intent.target)
      observedAt = now()
      live = { ...intent, actual, observed_at: observedAt }
      if (actual !== intent.base) {
        if (intent.integration !== undefined && (actual === intent.integration || await host.precedes(intent.target, intent.integration, actual))) {
          outcome = { status: 'verified', reason: 'Observed the intent-specific integration commit on the actual target' }
        } else if (!reconcileOnly()) {
          if (actual === intent.candidate || await host.precedes(intent.target, intent.candidate, actual)) {
            outcome = { status: 'waiting', reason: 'The target contains the candidate but not the queued integration commit' }
          } else if (await host.precedes(intent.target, intent.base, actual)) {
            outcome = { status: 'repair', reason: 'The target advanced; refresh the candidate and all required evidence on the actual base' }
          } else {
            outcome = { status: 'waiting', reason: 'Target history moved away from the reviewed baseline; no queued write is safe' }
          }
        }
      }
    } catch (error) {
      host.lifetime.throwIfAborted()
      if (!this.current(intent)) return undefined
      this.update(live, intent.status, { reason: 'Cannot verify the actual Git target; will check again' })
      if (reconcileOnly()) return live
      throw error
    }
    host.lifetime.throwIfAborted()
    if (!this.current(intent)) return undefined
    if (outcome?.status === 'verified') {
      this.finish(live, 'verified', { reason: outcome.reason,
        verification: { status: 'passed', at: observedAt, method: 'integration_on_target' } })
    } else if (reconcileOnly()) {
      this.update(live, 'applying', { reason: 'Git write result is unconfirmed; the actual target does not prove the queued integration' })
      return live
    } else if (outcome) {
      this.finish(live, outcome.status, { reason: outcome.reason })
    } else {
      return live
    }
    return undefined
  }

  /** Return true when an admitted write remains unconfirmed and must be observed again. */
  private async process(intent: MainlineIntent): Promise<boolean> {
    const { host } = this
    const blocked = host.controlBlocked(intent.ticket_id)
    if (intent.status === 'queued') {
      if (blocked) return false
      if (host.paused()) throw new Later()
    }
    const observed = await this.observe(intent, blocked)
    if (!observed) return false
    // The old base does not prove an admitted receive-pack has stopped, even before any pause.
    if (intent.status === 'applying') return true
    if (blocked || host.controlBlocked(intent.ticket_id)) return false
    if (host.paused()) throw new Later()
    let applying = observed
    try {
      const integration = await host.prepare(intent.target, intent.candidate, intent.id, intent.queued_at)
      if (intent.integration && intent.integration !== integration) throw new Error('The prepared integration commit does not match the persisted intent')
      await host.advance(intent.target, intent.base, integration, async () => {
        const approval = await host.approve(intent.ticket_id, intent.candidate, host.lifetime, intent)
        if (approval.base !== intent.base || targetKey(approval.target) !== targetKey(intent.target) || approval.target.repository !== intent.target.repository ||
            approval.assignment !== intent.assignment || approval.generation !== intent.generation || approval.rulesRevision !== intent.rulesRevision) {
          throw new UserError('mainlineRefused', { reason: 'Queued candidate no longer has matching delivery evidence' })
        }
        return () => {
          host.lifetime.throwIfAborted()
          if (!this.current(intent)) throw new Later()
          if (host.controlBlocked(intent.ticket_id) || host.paused()) throw new Later()
          host.authorize(intent.ticket_id, approval)
          const admitted: MainlineIntent = { ...observed, status: 'applying', applying_at: observed.applying_at ?? now(), integration, ci: approval.ci }
          // The synchronous fence is the last step before starting the mutating subprocess.
          this.update(admitted, 'applying', { reason: 'Git write may be in flight; compare the actual target before retrying' })
          applying = admitted
        }
      })
      host.lifetime.throwIfAborted()
    } catch (error) {
      host.lifetime.throwIfAborted()
      if (!this.current(applying)) return false
      const rejected = error instanceof GitLeaseRejected
      if (host.controlBlocked(intent.ticket_id) && rejected) {
        this.finish(applying, 'waiting', { reason: error.message })
        return false
      }
      if (error instanceof Later) {
        if (host.controlBlocked(intent.ticket_id)) return false
        throw error
      }
      const live = await this.observe(applying)
      if (!live) return false
      if (applying.status === 'applying' && !rejected) {
        this.update(live, 'applying', { reason: 'Git write result is unconfirmed; the actual target does not prove the queued integration' })
        return true
      }
      if (rejected || !host.controlBlocked(intent.ticket_id)) this.finish(live, 'waiting', { reason: message(error) })
      return false
    }
    return !!await this.observe(applying, true)
  }
}

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 280) : 'Mainline check did not succeed'
