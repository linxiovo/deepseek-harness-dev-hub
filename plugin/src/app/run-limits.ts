/** Effective run authorization and budget projections for the mounted project. */
import { randomUUID } from 'node:crypto'
import { liveTicket, type Ticket } from '../core/model.ts'
import { key as stableKey } from '../core/ids.ts'
import { KV, type Key } from '../kv.ts'
import { effectiveRunLimits, type EffectiveRunLimits, type InspectionGrant } from '../policy.ts'
import type { ModelAdmission } from './model-admission.ts'
import type { MeterSessionBinding } from './project-meter.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import type { Store } from './store.ts'

export interface PendingUsage {
  sessionId: string
  ticketId: string | null
  maximumTokens: number | null
  startedAt: string
  /** Ticket budget key, when work shares a retired Plan node's authorization. */
  poolId?: string
  /** Set only for a verified inspection; settlement keeps this path even if authorization changes. */
  inspectionScope?: string
}

export interface BudgetLedger {
  accountedTokens: number | null
  reportedCalls: number
  missing: { sessionId: string; calls: number; interrupted: number; lastAt: string }[]
}

type BudgetState = 'unlimited' | 'available' | 'reserved' | 'exhausted' | 'usage-missing'
export type QuotaHold = Extract<BudgetState, 'exhausted' | 'usage-missing'>
export type DispatchLimits = Pick<EffectiveRunLimits['effective'], 'maxWorkers' | 'projectTokens' | 'ticketTokens' | 'stagnation'>
type DispatchBlock = { state: QuotaHold | 'reserved'; scope: 'project' | 'ticket' }
type InspectionAllowance = Readonly<Pick<InspectionGrant, 'scope' | 'maxTokens'>>

const EMPTY: BudgetLedger = { accountedTokens: null, reportedCalls: 0, missing: [] }
function quotaHold(limit: number | null, ledger: BudgetLedger): QuotaHold | undefined {
  if (limit === null) return undefined
  if ((ledger.accountedTokens ?? 0) >= limit) return 'exhausted'
  if (ledger.missing.length) return 'usage-missing'
  return undefined
}

export interface BudgetView extends BudgetLedger {
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
  /** Persist a configuration refusal for the current inspection before the admission transaction returns. */
  inspectionRefused?(sessionId: string, reason: string): void
}

/** Reserves both applicable pools before provider I/O, atomically settles one stream, and projects the same budget for dispatch and reads. */
export class RunLimits {
  private readonly since: string
  private closed = false
  private balanceChanged: PromiseWithResolvers<void> | undefined

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
      const executor = store.settings().executor
      const configuration = effectiveRunLimits(executor)
      if (executor.idleInspection) this.updateInspectionHold(executor.idleInspection)
      this.updateHold(null, configuration.effective.projectTokens)
      for (const ticket of store.tickets.open()) this.updateHold(ticket.id, this.ticketLimit(configuration, ticket.plan), this.pool(ticket.id, ticket.plan))
      store.afterCommit(() => { this.wakeWaiters(); this.host.changed() })
    })
  }

  /** Only verified callers reach here. Business attribution is the same append-only binding as the project meter. */
  acquire(binding: MeterSessionBinding, maximumTokens: number | null, signal?: AbortSignal, inspection?: InspectionAllowance): ModelAdmission {
    const { session_id: sessionId, ticket_id: ticketId, roles } = binding
    const { store } = this.host
    signal?.throwIfAborted()
    if (this.closed) return { admitted: false, reason: 'Run limits are closing' }
    if (maximumTokens !== null && (!Number.isSafeInteger(maximumTokens) || maximumTokens <= 0)) maximumTokens = null
    return store.atomic(() => {
      const executor = store.settings().executor
      if (inspection || roles.includes('inspection')) {
        const current = executor.idleInspection
        if (!inspection || !current || roles.length !== 1 || roles[0] !== 'inspection' || ticketId !== null || binding.plan_id !== null
          || current.scope !== inspection.scope || current.maxTokens !== inspection.maxTokens) {
          return { admitted: false, reason: 'Inspection requires its exclusive Session binding and current scoped grant' }
        }
      }
      const config = effectiveRunLimits(executor)
      const { projectTokens } = config.effective
      const owner = ticketId === null ? undefined : store.tickets.get(ticketId)
      if (ticketId !== null && (!owner || !liveTicket(owner))) return { admitted: false, reason: 'Run limit Ticket is not live' }
      const poolId = owner ? this.pool(owner.id, owner.plan) : undefined
      const ticketTokens = owner ? this.ticketLimit(config, owner.plan) : null
      const pending = projectTokens === null && ticketTokens === null && !inspection ? [] : this.pending()
      let waiting = false
      for (const budget of [projectTokens === null ? undefined : this.budget(projectTokens, store.get(KV.runLimits.project), pending),
        ticketTokens === null || poolId === undefined ? undefined : this.ticketBudget(poolId, ticketTokens, pending),
        inspection ? this.inspectionPool(inspection.scope, inspection.maxTokens, pending) : undefined]) {
        if (!budget || budget.limitTokens === null) continue
        if (budget.state === 'exhausted' || budget.state === 'usage-missing') {
          return { admitted: false, reason: `Run limit paused: ${budget.state}` }
        }
        if (maximumTokens === null || maximumTokens > budget.limitTokens - (budget.accountedTokens ?? 0)) {
          const reason = maximumTokens === null ? 'Run limits require a model route with a verified request token bound.'
            : 'The model request bound exceeds the settled run limit balance.'
          if (inspection) this.host.inspectionRefused?.(sessionId, reason)
          return { admitted: false, requiresOperator: true, reason }
        }
        waiting ||= budget.availableTokens === null || maximumTokens > budget.availableTokens
      }
      if (waiting) return { admitted: false, reason: 'Run limit balance is reserved by existing requests',
        wait: (this.balanceChanged ??= Promise.withResolvers<void>()).promise }
      const key = KV.runLimits.pending(randomUUID())
      const request: PendingUsage = { sessionId, ticketId, maximumTokens, startedAt: new Date().toISOString(),
        ...poolId && poolId !== ticketId ? { poolId } : {}, ...(inspection && { inspectionScope: inspection.scope }) }
      store.set(key, request)
      return { admitted: true, settle: totalTokens => {
        if (this.closed) return // A late old-mount completion cannot commit into a reopened Store.
        store.atomic(() => {
          if (!store.get(key)) return
          store.delete(key)
          this.record(request, totalTokens, false)
          const executor = store.settings().executor
          const config = effectiveRunLimits(executor)
          if (executor.idleInspection && request.inspectionScope === executor.idleInspection.scope) this.updateInspectionHold(executor.idleInspection)
          const projectHeld = this.updateHold(null, config.effective.projectTokens)
          const ticket = ticketId === null ? undefined : store.tickets.get(ticketId)
          const affected = ticket && (liveTicket(ticket) ? ticket : store.tickets.open().find(other => this.pool(other.id, other.plan) === poolId))
          const ticketHeld = affected && this.updateHold(affected.id, this.ticketLimit(config, affected.plan), poolId)
          store.afterCommit(() => {
            this.wakeWaiters()
            if (projectHeld || ticketHeld) this.host.changed()
          })
        })
      } }
    })
  }

  /** New dispatch checks complete and transient balance before claiming the node or holding a slot. */
  forDispatch(ticketId: string, plan: NonNullable<Ticket['plan']>): { limits: DispatchLimits; block?: DispatchBlock } {
    const { store } = this.host
    const config = effectiveRunLimits(store.settings().executor)
    const { maxWorkers, projectTokens, stagnation } = config.effective
    const ticketTokens = this.ticketLimit(config, plan)
    const limits = { maxWorkers, projectTokens, ticketTokens, stagnation }
    if (projectTokens === null && ticketTokens === null) return { limits }
    const pending = this.pending()
    const project = this.budget(projectTokens, store.get(KV.runLimits.project), pending)
    const ticket = this.ticketBudget(this.pool(ticketId, plan), ticketTokens, pending)
    if (project.state === 'exhausted' || project.state === 'usage-missing') return { limits, block: { scope: 'project', state: project.state } }
    if (ticket.state === 'exhausted' || ticket.state === 'usage-missing') return { limits, block: { scope: 'ticket', state: ticket.state } }
    if (project.state === 'reserved') return { limits, block: { scope: 'project', state: 'reserved' } }
    if (ticket.state === 'reserved') return { limits, block: { scope: 'ticket', state: 'reserved' } }
    return { limits }
  }

  blocked(ticketId: string): boolean {
    const { store } = this.host
    const config = effectiveRunLimits(store.settings().executor)
    if (quotaHold(config.effective.projectTokens, store.get(KV.runLimits.project) ?? EMPTY)) return true
    const ticket = store.tickets.get(ticketId)
    return !!ticket && !!quotaHold(this.ticketLimit(config, ticket.plan), store.get(KV.runLimits.ticket(this.pool(ticketId, ticket.plan))) ?? EMPTY)
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
      budget: this.ticketBudget(this.pool(ticket.id, ticket.plan), this.ticketLimit(configuration, ticket.plan), inFlight) }
      : { scope: 'project', ticketId: null, configuration, budget: projectBudget }
  }

  /** Read the cumulative ledger for this authorized path, independent of interval and Session identity. */
  inspectionBudget(scope: string, maxTokens: number): BudgetView {
    return this.inspectionPool(scope, maxTokens, this.pending())
  }

  private inspectionPool(scope: string, limit: number, inFlight: PendingUsage[]): BudgetView {
    return this.budget(limit, this.host.store.get(KV.runLimits.inspection(scope)), inFlight.filter(item => item.inspectionScope === scope))
  }

  private wakeWaiters(): void {
    const waiting = this.balanceChanged
    this.balanceChanged = undefined
    waiting?.resolve()
  }

  private ticketBudget(poolId: string, limit: number | null, inFlight: PendingUsage[]): BudgetView {
    return this.budget(limit, this.host.store.get(KV.runLimits.ticket(poolId)), inFlight.filter(item => (item.poolId ?? item.ticketId) === poolId))
  }

  private pending(): PendingUsage[] {
    const { store } = this.host
    return store.keys(KV.runLimits.pending).flatMap(key => store.get(key) ?? [])
  }

  private record(request: PendingUsage, total: number | null, interrupted: boolean): void {
    const { store } = this.host
    const { sessionId, ticketId } = request
    const at = new Date().toISOString()
    const pools = [KV.runLimits.project]
    if (request.inspectionScope !== undefined) pools.push(KV.runLimits.inspection(request.inspectionScope))
    else if (ticketId !== null) pools.push(KV.runLimits.ticket(request.poolId ?? ticketId))
    for (const key of pools) {
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

  private updateHold(ticketId: string | null, limit: number | null, poolId = ticketId): boolean {
    const { store } = this.host
    const key = poolId === null ? KV.runLimits.projectHold : KV.runLimits.ticketHold(poolId)
    const issue = quotaHold(limit, store.get(poolId === null ? KV.runLimits.project : KV.runLimits.ticket(poolId)) ?? EMPTY)
    return this.setHold(key, issue, () => {
      const ticket = ticketId === null ? undefined : store.tickets.get(ticketId)
      const affectedTickets = ticket?.plan && poolId !== null ? store.tickets.open().filter(other => other.id !== ticketId &&
        this.pool(other.id, other.plan) === poolId).map(other => other.id) : []
      return { scope: ticketId === null ? 'project' : 'ticket', ticketId,
        ...(ticket && { title: ticket.title, planId: ticket.plan?.planId, nodeId: ticket.plan?.nodeId }),
        ...(affectedTickets.length ? { affectedTickets } : {}),
        resource: ticketId === null ? 'project/run-limits' : `ticket/${ticketId}/run-limits`,
      }
    })
  }

  private updateInspectionHold({ scope, maxTokens }: InspectionAllowance): void {
    const issue = quotaHold(maxTokens, this.host.store.get(KV.runLimits.inspection(scope)) ?? EMPTY)
    this.setHold(KV.runLimits.inspectionHold(scope), issue, () => ({
      scope: 'inspection', inspectionScope: scope, ticketId: null, resource: 'project/inspection',
    }))
  }

  /** The active marker and its single normal Hub relay commit together. A new episode requires the hold to clear first. */
  private setHold(key: Key<true>, issue: QuotaHold | undefined, payload: () => Record<string, unknown>): boolean {
    const { store } = this.host
    const prior = store.get(key)
    if (!issue) {
      if (prior) store.delete(key)
      return false
    }
    if (!prior) {
      store.set(key, true)
      const relay = projectPushRelay({ id: `quota-paused:${randomUUID()}`, kind: 'quota-paused', payload: { ...payload(), reason: issue } })
      if (relay) this.host.relay(relay)
    }
    return true
  }

  private origin(plan: NonNullable<Ticket['plan']>): string {
    return this.host.store.get(KV.plans.budgetOrigin(plan.planId, plan.nodeId)) ?? plan.nodeId
  }

  private pool(ticketId: string, plan: Ticket['plan']): string {
    if (!plan) return ticketId
    const origin = this.origin(plan)
    return origin === plan.nodeId ? ticketId : stableKey('plan-ticket', plan.planId, origin)
  }

  private ticketLimit({ effective }: EffectiveRunLimits, plan: Ticket['plan']): number | null {
    const origin = plan && this.origin(plan)
    const override = plan && effective.ticketOverrides.find(entry => entry.planId === plan.planId && entry.nodeId === origin)
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
