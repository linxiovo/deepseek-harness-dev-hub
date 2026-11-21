/** Frontier selection and durable Plan-node dispatch into the existing Ticket Executor. */
import { UserError } from '../core/errors.ts'
import { latestAssignment } from '../core/model.ts'
import { key } from '../core/ids.ts'
import { PLAN_ROLES, type PlanNodeClaim, type PlanNodeState, type PlanRole } from '../core/plan.ts'
import type { Engine } from '../core/engine.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Store } from './store.ts'
import type { Plans } from './plans.ts'

export type PlanDispatchResult = {
  planId: string
  nodeId: string
  role: PlanRole
  status: PlanNodeState['status'] | 'blocked' | 'waiting-for-slot'
  reused: boolean
  claim?: PlanNodeClaim
  waitingOn?: string[]
  reason?: string
}

interface PlanDispatcherHost {
  readonly store: Pick<Store, 'tickets'>
  readonly plans: Pick<Plans, 'get' | 'state' | 'waitingOn' | 'claim' | 'list' | 'rearm'>
  readonly engine: Pick<Engine, 'createPlanTicket'>
  readonly executor: Pick<DshExecutor, 'reserveLaunch' | 'releaseLaunch' | 'start'>
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
    const current = this.host.plans.state(planId, nodeId)
    const expectedTicketId = key('plan-ticket', planId, nodeId), expectedAssignmentId = key('assignment', expectedTicketId, '0')
    if (current) {
      if (current.claim.role !== node.role || current.claim.ticketId !== expectedTicketId || current.claim.assignmentId !== expectedAssignmentId
        || current.claim.session !== `worker-${expectedTicketId}`) throw new UserError('invalidPlan', { detail: `Node state ${planId}/${nodeId} has an untrusted claim identity` })
      return this.result(planId, nodeId, node.role, current, true)
    }
    const waitingOn = this.host.plans.waitingOn(planId, node)
    if (waitingOn.length) return { planId, nodeId, role: node.role, status: 'blocked', reused: false, waitingOn,
      reason: `Waiting for formal delivery of ${waitingOn.join(', ')}` }

    const ticketId = key('plan-ticket', planId, nodeId)
    if (!this.host.executor.reserveLaunch(ticketId)) {
      return { planId, nodeId, role: node.role, status: 'waiting-for-slot', reused: false, reason: 'No worker slot is free' }
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
      })
      committed = true
      return this.result(planId, nodeId, node.role, state, false)
    } finally {
      if (!committed) this.host.executor.releaseLaunch(ticketId)
    }
  }

  /** Rearm durable launch intents before the normal Executor recovery pass. */
  resume(): void {
    for (const plan of this.host.plans.list()) {
      if (plan.status !== 'registered') continue
      for (const node of plan.nodes) {
        if (!PLAN_ROLES.includes(node.role)) continue
        const state = this.host.plans.state(plan.id, node.id)
        if (!state || ['delivered', 'failed', 'stopped'].includes(state.status)) continue
        const ticket = this.host.store.tickets.get(state.claim.ticketId)
        const assignment = ticket && latestAssignment(ticket)
        if (!ticket || !assignment || assignment.state !== 'pending') continue
        const action = ticket.execution?.active_writer || assignment.writer?.state === 'active' ? 'resume' : 'launch'
        this.host.plans.rearm(plan.id, node.id, action)
        this.host.executor.start(ticket, assignment)
      }
    }
  }

  private result(planId: string, nodeId: string, role: PlanNodeClaim['role'], state: PlanNodeState, reused: boolean): PlanDispatchResult {
    return { planId, nodeId, role, status: state.status, reused, claim: state.claim }
  }
}
