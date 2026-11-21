/** Effective run authorization and budget projections for the mounted project. */
import { randomUUID } from 'node:crypto'
import { liveTicket, type Ticket } from '../core/model.ts'
import { KV } from '../kv.ts'
import { effectiveRunLimits, type EffectiveRunLimits } from '../policy.ts'
import type { ModelAdmission } from './model-admission.ts'
import type { MeterSessionBinding } from './project-meter.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import type { Store } from './store.ts'

export interface PendingUsage {
  sessionId: string
  ticketId: string | null
  maximumTokens: number | null
  startedAt: string
}

export interface BudgetLedger {
  accountedTokens: number | null
  reportedCalls: number
  missing: { sessionId: string; calls: number; interrupted: number; lastAt: string }[]
}

type BudgetState = 'unlimited' | 'available' | 'reserved' | 'exhausted' | 'usage-missing'
export type QuotaHold = Extract<BudgetState, 'exhausted' | 'usage-missing'>

const EMPTY: BudgetLedger = { accountedTokens: null, reportedCalls: 0, missing: [] }
function quotaHold(limit: number | null, ledger: BudgetLedger): QuotaHold | undefined {
  if (limit === null) return undefined
  if ((ledger.accountedTokens ?? 0) >= limit) return 'exhausted'
  if (ledger.missing.length) return 'usage-missing'
  return undefined
}

interface BudgetView extends BudgetLedger {
  state: BudgetState
  limitTokens: number | null
  reservedTokens: number
  availableTokens: number | null
  trackedSince: string
  inFlight: PendingUsage[]
}

export interface RunLimitStatus {
  configuration: EffectiveRunLimits
  scope: 'project' | 'ticket'
  ticketId: string | null
  budget: BudgetView
  projectBudget?: BudgetView
}

interface RunLimitsHost {
  store: Pick<Store, 'get' | 'set' | 'delete' | 'keys' | 'atomic' | 'afterCommit' | 'settings' | 'tickets'>
  relay(message: Relay): void
  changed(): void
}

/** Reserves both applicable pools before provider I/O, atomically settles one stream, and projects the same budget for dispatch and reads. */
export class RunLimits {
  private readonly since: string
  private closed = false

  constructor(private readonly host: RunLimitsHost) {
    const { store } = host
    this.since = store.get(KV.runLimits.since) ?? new Date().toISOString()
    store.set(KV.runLimits.since, this.since)
  }
  /** An unreceipted call may already have reached the provider. Never release it as if it had cost zero. */
  recover(): void {
    const { store } = this.host
    store.atomic(() => {
      for (const key of store.keys(KV.runLimits.pending)) {
        const request = store.get(key)
        if (request) this.record(request, null, true)
        store.delete(key)
      }
      this.configurationChanged()
    })
  }

  close(): void { this.closed = true }

  configurationChanged(): void {
    const { store } = this.host
    store.atomic(() => {
      const configuration = effectiveRunLimits(store.settings().executor)
      const projectHeld = this.updateHold(null, configuration.effective.projectTokens)
      for (const ticket of store.tickets.open()) this.updateHold(ticket.id, this.ticketLimit(configuration, ticket.plan), !projectHeld)
      store.afterCommit(this.host.changed)
    })
  }

  /** Only verified callers reach here. Business attribution is the same append-only binding as the project meter. */
  acquire({ session_id: sessionId, ticket_id: ticketId }: MeterSessionBinding, maximumTokens: number | null, signal?: AbortSignal): ModelAdmission {
    const { store } = this.host
    signal?.throwIfAborted()
    if (this.closed) return { admitted: false, reason: 'Run limits are closing' }
    if (maximumTokens !== null && (!Number.isSafeInteger(maximumTokens) || maximumTokens <= 0)) maximumTokens = null
    return store.atomic(() => {
      const config = effectiveRunLimits(store.settings().executor)
      const { projectTokens } = config.effective
      const owner = ticketId === null ? undefined : store.tickets.get(ticketId)
      if (ticketId !== null && (!owner || !liveTicket(owner))) return { admitted: false, reason: 'Run limit Ticket is not live' }
      const ticketTokens = owner ? this.ticketLimit(config, owner.plan) : null
      const pending = projectTokens === null && ticketTokens === null ? [] : this.pending()
      for (const budget of [projectTokens === null ? undefined : this.budget(projectTokens, store.get(KV.runLimits.project), pending),
        ticketTokens === null || ticketId === null ? undefined :
          this.budget(ticketTokens, store.get(KV.runLimits.ticket(ticketId)), pending.filter(item => item.ticketId === ticketId))]) {
        if (!budget) continue
        if (budget.state === 'exhausted' || budget.state === 'usage-missing') {
          return { admitted: false, reason: `Run limit paused: ${budget.state}` }
        }
        if (maximumTokens === null) return { admitted: false, reason: 'Run limit requires a verified request token bound' }
        if (budget.availableTokens === null || maximumTokens > budget.availableTokens) {
          return { admitted: false, reason: 'Run limit budget cannot cover this request and existing reservations' }
        }
      }
      const key = KV.runLimits.pending(randomUUID())
      const request: PendingUsage = { sessionId, ticketId, maximumTokens, startedAt: new Date().toISOString() }
      store.set(key, request)
      return { admitted: true, settle: totalTokens => {
        if (this.closed) return // A late old-mount completion cannot commit into a reopened Store.
        store.atomic(() => {
          if (!store.get(key)) return
          store.delete(key)
          this.record(request, totalTokens, false)
          const config = effectiveRunLimits(store.settings().executor)
          const projectHeld = this.updateHold(null, config.effective.projectTokens)
          const ticket = ticketId === null ? undefined : store.tickets.get(ticketId)
          const ticketHeld = ticket && liveTicket(ticket) && this.updateHold(ticket.id, this.ticketLimit(config, ticket.plan), !projectHeld)
          if (projectHeld || ticketHeld) store.afterCommit(this.host.changed)
        })
      } }
    })
  }

  /** New dispatch checks complete and transient balance before claiming the node or holding a slot. */
  dispatchBlock(ticketId: string, plan: NonNullable<Ticket['plan']>): { state: QuotaHold | 'reserved'; scope: 'project' | 'ticket' } | undefined {
    const { store } = this.host
    const config = effectiveRunLimits(store.settings().executor)
    const pending = this.pending()
    const project = this.budget(config.effective.projectTokens, store.get(KV.runLimits.project), pending)
    if (project.state !== 'unlimited' && project.state !== 'available') return { state: project.state, scope: 'project' }
    const ticket = this.budget(this.ticketLimit(config, plan), store.get(KV.runLimits.ticket(ticketId)), pending.filter(item => item.ticketId === ticketId))
    if (ticket.state !== 'unlimited' && ticket.state !== 'available') return { state: ticket.state, scope: 'ticket' }
    return undefined
  }

  blocked(ticketId: string): boolean {
    const { store } = this.host
    const config = effectiveRunLimits(store.settings().executor)
    if (quotaHold(config.effective.projectTokens, store.get(KV.runLimits.project) ?? EMPTY)) return true
    const ticket = store.tickets.get(ticketId)
    return !!ticket && !!quotaHold(this.ticketLimit(config, ticket.plan), store.get(KV.runLimits.ticket(ticketId)) ?? EMPTY)
  }

  /** An already approved call settles before this Ticket's pause drains its writer. */
  inFlight(ticketId: string): boolean { return this.pending().some(request => request.ticketId === ticketId) }

  view(ticketId?: string): RunLimitStatus | undefined {
    const { store } = this.host
    const ticket = ticketId === undefined ? undefined : store.tickets.get(ticketId)
    if (ticketId !== undefined && !ticket) return undefined
    const configuration = effectiveRunLimits(store.settings().executor)
    const inFlight = this.pending()
    const projectBudget = this.budget(configuration.effective.projectTokens, store.get(KV.runLimits.project), inFlight)
    return ticket ? { scope: 'ticket', ticketId: ticket.id, configuration, projectBudget,
      budget: this.budget(this.ticketLimit(configuration, ticket.plan), store.get(KV.runLimits.ticket(ticket.id)),
        inFlight.filter(item => item.ticketId === ticket.id)) }
      : { scope: 'project', ticketId: null, configuration, budget: projectBudget }
  }
  private pending(): PendingUsage[] {
    const { store } = this.host
    return store.keys(KV.runLimits.pending).flatMap(key => store.get(key) ?? [])
  }

  private record(request: PendingUsage, total: number | null, interrupted: boolean): void {
    const { store } = this.host
    const { sessionId, ticketId } = request
    const at = new Date().toISOString()
    for (const key of ticketId === null ? [KV.runLimits.project] : [KV.runLimits.project, KV.runLimits.ticket(ticketId)]) {
      const ledger = store.get(key) ?? EMPTY
      if (total !== null && Number.isSafeInteger(total) && total >= 0) {
        const sum = (ledger.accountedTokens ?? 0) + total
        if (Number.isSafeInteger(sum)) {
          store.set(key, { ...ledger, accountedTokens: sum, reportedCalls: ledger.reportedCalls + 1 })
          continue
        }
      }
      const prior = ledger.missing.find(item => item.sessionId === sessionId)
      const missing = { sessionId, calls: (prior?.calls ?? 0) + 1, interrupted: (prior?.interrupted ?? 0) + Number(interrupted), lastAt: at }
      const others = ledger.missing.filter(item => item.sessionId !== sessionId)
      store.set(key, { ...ledger, missing: [...others, missing] })
    }
  }

  /** The active marker and its single normal Hub relay commit together. A new episode requires the hold to clear first. */
  private updateHold(ticketId: string | null, limit: number | null, notify = true): boolean {
    const { store } = this.host
    const key = ticketId === null ? KV.runLimits.projectHold : KV.runLimits.ticketHold(ticketId)
    const prior = store.get(key)
    const issue = quotaHold(limit, store.get(ticketId === null ? KV.runLimits.project : KV.runLimits.ticket(ticketId)) ?? EMPTY)
    if (!issue) {
      if (prior) store.delete(key)
      return false
    }
    if (notify && !prior) {
      store.set(key, true)
      const ticket = ticketId === null ? undefined : store.tickets.get(ticketId)
      const relay = projectPushRelay({ id: `quota-paused:${randomUUID()}`, kind: 'quota-paused', payload: {
        scope: ticketId === null ? 'project' : 'ticket', reason: issue, ticketId,
        ...(ticket && { title: ticket.title, planId: ticket.plan?.planId, nodeId: ticket.plan?.nodeId }),
        resource: ticketId === null ? 'project/run-limits' : `ticket/${ticketId}/run-limits`,
      } })
      if (relay) this.host.relay(relay)
    }
    return true
  }

  private ticketLimit({ effective }: EffectiveRunLimits, plan: Ticket['plan']): number | null {
    const override = plan && effective.ticketOverrides.find(entry => entry.planId === plan.planId && entry.nodeId === plan.nodeId)
    return override ? override.tokens : effective.ticketTokens
  }

  private budget(limitTokens: number | null, recorded: BudgetLedger | undefined, inFlight: PendingUsage[]): BudgetView {
    const ledger = recorded ?? EMPTY
    const reservedTokens = inFlight.reduce((sum, request) => sum + (request.maximumTokens ?? 0), 0)
    const spent = ledger.accountedTokens ?? 0
    const unknown = ledger.missing.length > 0
    const unbounded = inFlight.some(request => request.maximumTokens === null)
    const availableTokens = limitTokens === null || unknown || unbounded ? null : Math.max(0, limitTokens - spent - reservedTokens)
    const state = limitTokens === null ? 'unlimited'
      : quotaHold(limitTokens, ledger) ?? (unbounded || availableTokens === 0 ? 'reserved' : 'available')
    return { ...ledger, limitTokens, trackedSince: this.since, state, reservedTokens, availableTokens, inFlight }
  }
}
