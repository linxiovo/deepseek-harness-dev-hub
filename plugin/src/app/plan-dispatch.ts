/** Frontier selection and durable Plan-node dispatch into the existing Ticket Executor. */
import { UserError } from '../core/errors.ts'
import { latestAssignment, waitsForPerson } from '../core/model.ts'
import { key } from '../core/ids.ts'
import { PLAN_ROLES, type PlanNode, type PlanNodeClaim, type PlanNodeState, type PlanRole } from '../core/plan.ts'
import type { Engine } from '../core/engine.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Store } from './store.ts'
import type { Plans } from './plans.ts'
import type { PlanControl } from './plan-control.ts'
import type { CredentialAction, ScopedAttention } from './scoped-attention.ts'
import type { DispatchLimits, RunLimits } from './run-limits.ts'

export type PlanDispatchResult = {
  planId: string
  nodeId: string
  role: PlanRole
  limits: DispatchLimits
  status: PlanNodeState['status'] | 'blocked' | 'waiting-for-slot' | 'quota-paused' | 'waiting-for-budget'
  reused: boolean
  claim?: PlanNodeClaim
  attention?: CredentialAction
  waitingOn?: string[]
  reason?: string
}

interface PlanDispatcherHost {
  readonly store: Pick<Store, 'tickets'>
  readonly plans: Pick<Plans, 'get' | 'state' | 'waitingOn' | 'waitingForWriters' | 'claim' | 'list' | 'rearm'>
  readonly engine: Pick<Engine, 'createPlanTicket'>
  readonly executor: Pick<DshExecutor, 'reserveLaunch' | 'releaseLaunch' | 'start'>
  readonly attention: Pick<ScopedAttention, 'forTicket' | 'blocked'>
  readonly limits: Pick<RunLimits, 'forDispatch'>
  readonly control: Pick<PlanControl, 'blocksWorker' | 'dispatchBlocked'>
  paused(): boolean
  bindWorker(ticketId: string, sessionId: string): void
  readonly now?: () => string
}

/** Selects only a registered, formally-unblocked node and atomically binds it to one Ticket/Assignment. */
export class PlanDispatcher {
  constructor(private readonly host: PlanDispatcherHost) {}

  dispatch(planId: string, nodeId: string): PlanDispatchResult {
    const plan = this.host.plans.get(planId)
    if (!plan || plan.status !== 'registered') throw new UserError('unknownPlan', { id: planId })
    const node = plan.nodes.find(item => item.id === nodeId)
    if (!node) throw new UserError('unknownPlanNode', { id: planId, node: nodeId })
    if (!PLAN_ROLES.includes(node.role)) throw new UserError('invalidPlan', { detail: `Node ${planId}/${nodeId} has an untrusted execution role` })
    const ticketId = key('plan-ticket', planId, nodeId), role = node.role
    const { limits, block } = this.host.limits.forDispatch(ticketId, { planId, nodeId, role })
    const request = { planId, nodeId, role, limits }
    const current = this.host.plans.state(planId, nodeId)
    if (current) {
      this.bindClaim(current, node.role)
      const replay = this.result(request, current, true)
      if (this.host.control.blocksWorker(ticketId) &&
          (current.status === 'claimed' || current.status === 'running' || current.status === 'awaiting-delivery')) {
        return { ...replay, status: 'blocked', reason: 'Paused by Plan control' }
      }
      if (block && block.state !== 'reserved' && (current.status === 'claimed' || current.status === 'running' || current.status === 'awaiting-delivery')) {
        return { ...replay, status: 'quota-paused', reason: `${block.scope} budget: ${block.state}` }
      }
      return replay
    }
    const waitingOn = this.host.plans.waitingOn(planId, node)
    if (waitingOn.length) return { ...request, status: 'blocked', reused: false, waitingOn,
      reason: `Waiting for formal delivery of ${waitingOn.join(', ')}` }
    if (this.host.control.dispatchBlocked(plan, nodeId)) {
      return { ...request, status: 'blocked', reused: false, reason: 'Paused by Plan control' }
    }
    const draining = this.host.plans.waitingForWriters(planId, nodeId)
    if (draining.length) return { ...request, status: 'blocked', reused: false, waitingOn: draining,
      reason: `Waiting for superseded writers to drain: ${draining.join(', ')}` }

    if (block) return { ...request, status: block.state === 'reserved' ? 'waiting-for-budget' : 'quota-paused',
      reused: false, reason: `${block.scope} budget: ${block.state}` }
    if (!this.host.executor.reserveLaunch(ticketId)) {
      return { ...request, status: 'waiting-for-slot', reused: false, reason: 'No worker slot is free' }
    }
    let committed = false
    try {
      const assignmentId = key('assignment', ticketId, '0')
      const claim: PlanNodeClaim = { planId, nodeId, ticketId, assignmentId, session: `worker-${ticketId}`, role: node.role,
        pendingAction: 'launch', claimedAt: this.host.now?.() ?? new Date().toISOString() }
      const state = this.host.plans.claim(planId, nodeId, claim, () => {
        const ticket = this.host.engine.createPlanTicket(planId, node, claim.claimedAt)
        if (ticket.id !== ticketId || latestAssignment(ticket)?.id !== assignmentId) {
          throw new Error(`Plan node ${planId}/${nodeId} did not create its stable Ticket and Assignment`)
        }
        this.host.bindWorker(ticket.id, claim.session)
      })
      committed = true
      return this.result(request, state, false)
    } finally {
      if (!committed) this.host.executor.releaseLaunch(ticketId)
    }
  }

  /** Reconcile pre-meter reservations, including terminal and paused work, without starting any worker. */
  restoreBindings(): void {
    for (const plan of this.host.plans.list()) for (const node of plan.nodes) {
      const state = this.host.plans.state(plan.id, node.id)
      if (state) this.bindClaim(state, node.role)
    }
  }

  private bindClaim({ claim }: PlanNodeState, role: PlanRole): void {
    const { planId, nodeId } = claim
    const ticketId = key('plan-ticket', planId, nodeId), ticket = this.host.store.tickets.get(ticketId)
    if (claim.ticketId !== ticketId || claim.role !== role || claim.session !== `worker-${ticketId}`
      || claim.assignmentId !== key('assignment', ticketId, '0') || ticket?.assignments[0]?.id !== claim.assignmentId
      || ticket.plan?.planId !== planId || ticket.plan.nodeId !== nodeId || ticket.plan.role !== role) {
      throw new UserError('invalidPlan', { detail: `Node state ${planId}/${nodeId} has an untrusted claim identity` })
    }
    this.host.bindWorker(ticketId, claim.session)
  }

  /** Rearm durable launch intents before the normal Executor recovery pass. */
  resume(): void {
    for (const plan of this.host.plans.list()) {
      if (plan.status !== 'registered') continue
      for (const node of plan.nodes) {
        if (!PLAN_ROLES.includes(node.role)) continue
        const state = this.host.plans.state(plan.id, node.id)
        if (state) this.resumeNode(plan.id, node, state)
      }
    }
  }

  /** Explain the first current gate for a scoped resume without creating a claim. */
  resumeBlock(planId: string, nodeId: string): string | undefined {
    const { host } = this, plan = host.plans.get(planId), node = plan?.nodes.find(item => item.id === nodeId)
    if (!plan || !node) return 'Plan node is no longer current'
    const claim = host.plans.state(planId, nodeId)?.claim
    const ticketId = claim?.ticketId ?? key('plan-ticket', planId, nodeId)
    if (claim && host.store.tickets.get(ticketId)?.ended) return undefined
    if (claim ? host.control.blocksWorker(ticketId) : host.control.dispatchBlocked(plan, nodeId)) return 'Paused by Plan control'
    if (host.paused()) return 'Project processing is paused or unavailable'
    if (host.attention.blocked(ticketId)) return 'Awaiting credential verification'
    const predecessors = host.plans.waitingOn(planId, node)
    if (predecessors.length) return `Awaiting formal delivery of ${predecessors.join(', ')}`
    if (host.plans.waitingForWriters(planId, nodeId).length) return 'Awaiting superseded writers'
    const { block } = host.limits.forDispatch(ticketId, { planId, nodeId, role: node.role })
    if (block) return `${block.scope} budget: ${block.state}`
  }

  private resumeNode(planId: string, node: PlanNode, state: PlanNodeState): void {
    if (state.status === 'delivered' || state.status === 'failed' || state.status === 'stopped' || this.resumeBlock(planId, node.id)) return
    const ticket = this.host.store.tickets.get(state.claim.ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || ticket.ended || !assignment || assignment.state !== 'pending' || waitsForPerson(ticket)) return
    const action = ticket.execution?.active_writer || assignment.writer?.state === 'active' ? 'resume' : 'launch'
    this.host.plans.rearm(planId, node.id, action)
    this.host.executor.start(ticket, assignment)
  }

  private result(request: Pick<PlanDispatchResult, 'planId' | 'nodeId' | 'role' | 'limits'>, state: PlanNodeState, reused: boolean): PlanDispatchResult {
    const attention = this.host.attention.forTicket(state.claim.ticketId)
    return { ...request, status: state.status, reused, claim: state.claim, ...(attention ? { attention } : {}) }
  }
}
