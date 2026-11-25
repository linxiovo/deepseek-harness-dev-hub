import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { latestAssignment } from '../core/model.ts'
import { UserError } from '../core/errors.ts'
import type { Plan } from '../core/plan.ts'
import { KV } from '../kv.ts'
import type { Handoffs } from './handoffs.ts'
import { mainlineAttempts } from './mainline-queue.ts'
import type { Plans } from './plans.ts'
import type { Store } from './store.ts'

const id = z.string().trim().min(1).max(200)
const ScopeInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ticket'), ticketId: id }),
  z.strictObject({ kind: z.literal('branch'), nodeId: id }),
  z.strictObject({ kind: z.literal('plan') }),
])
const Mutation = z.strictObject({ action: z.enum(['pause', 'resume']), planId: id, scope: ScopeInput })
export const PlanControlCommandSchema = z.union([Mutation, z.strictObject({ action: z.literal('status'), planId: id })])
type ScopeInput = z.infer<typeof ScopeInput>
type Mutation = z.infer<typeof Mutation>
type OperatorEvent = { sessionId: string; messageId: string; text: string }
type Worker = { ticketId: string; assignmentId: string; stopped: boolean }
type Hold = { scope: ScopeInput; roots: string[]; nodes: string[]; workers: Worker[] }
export type PlanControlState = Hold[]
type OperationStatus = 'stop-requested' | 'stopped' | 'already-happened'
type Operation = { kind: 'dispatch' | 'worker' | 'mainline' | 'release'; status: OperationStatus;
  ticketId?: string; nodeId?: string; operationId?: string }
const HoldsSchema = z.array(z.strictObject({ scope: ScopeInput, roots: z.array(id), nodes: z.array(id),
  workers: z.array(z.strictObject({ ticketId: id, assignmentId: id, stopped: z.boolean() })) }))

interface ControlHost {
  store: Pick<Store, 'atomic' | 'afterCommit' | 'get' | 'set' | 'delete' | 'tickets'>
  plans: Pick<Plans, 'get' | 'state'>
  handoffs: Pick<Handoffs, 'get'>
  isCurrentHub(sessionId: string): boolean
  isHubGeneration(sessionId: string): boolean
  authorize(): void
  suspend(ticketId: string): void
  rearm(planId: string, ticketIds: readonly string[]): void
  waiting(planId: string, nodeId: string): string | undefined
}

const refuse = (detail: string): never => { throw new UserError('invalidPlan', { detail }) }
const scopeKey = (scope: ScopeInput): string => scope.kind === 'plan' ? 'plan'
  : scope.kind === 'ticket' ? `ticket:${scope.ticketId}` : `branch:${scope.nodeId}`
const sameScope = (first: ScopeInput, second: ScopeInput): boolean => scopeKey(first) === scopeKey(second)

function successors(plan: Plan, roots: readonly string[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const node of plan.nodes) for (const parent of node.blockedBy) {
    const list = children.get(parent)
    if (list) list.push(node.id)
    else children.set(parent, [node.id])
  }
  const nodes = new Set(roots), pending = [...roots]
  for (let i = 0; i < pending.length; i++) for (const child of children.get(pending[i]!) ?? []) {
    if (nodes.has(child)) continue
    nodes.add(child)
    pending.push(child)
  }
  return nodes
}

function matches(command: Mutation, message: string): boolean {
  let value: unknown
  try { value = JSON.parse(message) }
  catch {
    const { action, planId, scope } = command
    const verb = action === 'pause' ? '暂停' : '恢复'
    const english = action === 'pause' ? 'Pause' : 'Resume'
    const text = message.trim()
    switch (scope.kind) {
      case 'ticket': return text === `${verb}工单 ${scope.ticketId}` || text === `${english} Ticket ${scope.ticketId}`
      case 'branch': return text === `${verb}计划 ${planId} 的分支 ${scope.nodeId}` || text === `${english} branch ${scope.nodeId} of Plan ${planId}`
      case 'plan': return text === `${verb}整个计划 ${planId}` || text === `${english} entire Plan ${planId}`
    }
  }
  const parsed = Mutation.safeParse(value)
  return parsed.success && isDeepStrictEqual(parsed.data, command)
}

/** Persists scoped operator holds separately from Ticket lifecycle and external-write receipts. */
export class PlanControl {
  constructor(private readonly host: ControlHost) {}

  change(command: Mutation, event: OperatorEvent) {
    if (!event.messageId || !matches(command, event.text)) return refuse('Control must match the latest direct operator message and its exact scope')
    const { store } = this.host, { planId, scope, action } = command
    const result = store.atomic(() => {
      const plan = this.plan(planId)
      this.requireOwner(plan, event.sessionId)
      this.host.authorize()
      const receipt = KV.plans.controlRequest(event.sessionId, event.messageId)
      const fingerprint = key('plan-control', action, planId, scopeKey(scope))
      const prior = store.get(receipt)
      if (prior !== undefined) {
        if (prior !== fingerprint) return refuse('This operator event already authorized a different Plan control command')
        return { status: 'unchanged' as const, nodes: [] }
      }

      const holds = this.holds(planId), existing = holds.find(item => sameScope(item.scope, scope))
      const nodes = existing ? this.nodes(plan, existing) : this.resolve(plan, scope)
      if (action === 'pause' && !existing) {
        const workers = this.workersFor(planId, nodes)
        store.set(KV.plans.control(planId), [...holds, { scope, roots: scope.kind === 'plan' ? [] : nodes.slice(0, 1),
          nodes: scope.kind === 'plan' ? [] : nodes, workers }])
        store.afterCommit(() => { for (const worker of workers) this.host.suspend(worker.ticketId) })
      } else if (action === 'resume' && existing) {
        const remaining = holds.filter(hold => hold !== existing)
        if (remaining.length) store.set(KV.plans.control(planId), remaining)
        else store.delete(KV.plans.control(planId))
        const ticketIds = new Set(existing.workers.map(worker => worker.ticketId))
        for (const nodeId of nodes) {
          const claim = this.host.plans.state(planId, nodeId)?.claim
          if (claim) ticketIds.add(claim.ticketId)
        }
        this.host.rearm(planId, [...ticketIds])
      }
      store.set(receipt, fingerprint)
      return { status: action === 'pause' ? 'paused' as const : existing ? 'resumed' as const : 'unchanged' as const,
        nodes: action === 'resume' && existing ? nodes : [] }
    })

    const waiting = result.nodes.flatMap(nodeId => {
      const reason = this.host.waiting(planId, nodeId)
      return reason ? [{ nodeId, reason }] : []
    })
    return { ...this.view(planId), action, status: result.status, scope, waiting }
  }

  blocksNode(planId: string, nodeId: string): boolean {
    return this.holds(planId).some(hold => hold.scope.kind === 'plan' || hold.nodes.includes(nodeId))
  }

  blocksTicket(ticketId: string): boolean {
    const binding = this.host.store.tickets.get(ticketId)?.plan
    return !!binding && this.blocksNode(binding.planId, binding.nodeId)
  }

  blocksRelease(planId: string): boolean { return this.holds(planId).length > 0 }

  /** A scoped hold also fences new dispatch downstream of its active graph roots. */
  dispatchBlocked(plan: Plan, nodeId: string): boolean {
    const holds = this.holds(plan.id)
    if (holds.some(hold => hold.scope.kind === 'plan' || hold.nodes.includes(nodeId))) return true
    const roots = holds.flatMap(hold => hold.roots)
    return roots.length > 0 && successors(plan, roots).has(nodeId)
  }

  stopped(ticketId: string, assignmentId: string): void {
    const planId = this.host.store.tickets.get(ticketId)?.plan?.planId
    if (!planId) return
    const holds = this.holds(planId)
    let changed = false
    for (const hold of holds) for (const worker of hold.workers) {
      if (worker.ticketId === ticketId && worker.assignmentId === assignmentId && !worker.stopped) {
        worker.stopped = true
        changed = true
      }
    }
    if (changed) this.host.store.set(KV.plans.control(planId), holds)
  }

  replaceNodes(planId: string, replacements: Record<string, string[]>): void {
    const holds = this.holds(planId)
    let changed = false
    for (const hold of holds) {
      if (hold.scope.kind === 'plan' || !hold.nodes.some(node => Object.hasOwn(replacements, node))) continue
      hold.nodes = [...new Set(hold.nodes.flatMap(node => replacements[node] ?? [node]))]
      hold.roots = [...new Set(hold.roots.flatMap(node => replacements[node] ?? [node]))]
      changed = true
    }
    if (changed) this.host.store.set(KV.plans.control(planId), holds)
  }

  view(planId: string) {
    const plan = this.plan(planId), holds = this.holds(planId), actions: Operation[] = []
    const workers = new Map(holds.flatMap(hold => hold.workers.map(worker => [worker.ticketId, worker] as const)))
    const descendants = successors(plan, holds.flatMap(hold => hold.roots))
    for (const node of plan.nodes) {
      const claim = this.host.plans.state(planId, node.id)?.claim
      const paused = holds.some(hold => hold.scope.kind === 'plan' || hold.nodes.includes(node.id))
      if (paused || (!claim && descendants.has(node.id))) actions.push({ kind: 'dispatch', nodeId: node.id,
        ...(claim ? { ticketId: claim.ticketId } : {}), status: claim?.startedAt ? 'already-happened'
          : claim && workers.get(claim.ticketId)?.stopped === false ? 'stop-requested' : 'stopped' })
      if (!claim) continue
      const merges = mainlineAttempts(this.host.store, claim.ticketId)
      for (const merge of merges) {
        if (merge.status !== 'verified' && !(paused && merge === merges.at(-1))) continue
        actions.push({ kind: 'mainline', nodeId: node.id, ticketId: claim.ticketId, operationId: merge.id,
          status: merge.status === 'verified' ? 'already-happened' : merge.status === 'applying' ? 'stop-requested' : 'stopped' })
      }
    }
    const seen = new Set<string>()
    for (const hold of holds) for (const worker of hold.workers) {
      if (seen.has(worker.assignmentId)) continue
      seen.add(worker.assignmentId)
      actions.push({ kind: 'worker', ticketId: worker.ticketId, operationId: worker.assignmentId,
        status: worker.stopped ? 'stopped' : 'stop-requested' })
    }
    const integration = this.host.store.get(KV.plans.integration(planId))
    const intent = this.host.store.get(KV.plans.releaseIntent(planId))
    if (intent || (holds.length && this.host.handoffs.get(plan.handoffId)?.authorization.release === 'authorized')) {
      const happened = integration && 'deployment' in integration
      actions.push({ kind: 'release', ...(intent ? { operationId: intent.request.id } : {}),
        status: happened ? 'already-happened' : integration?.status === 'releasing' ? 'stop-requested' : 'stopped' })
    }
    return { planId, activeScopes: holds.map(hold => hold.scope), actions, read: `plan/${planId}/control` }
  }

  private resolve(plan: Plan, scope: ScopeInput): string[] {
    if (scope.kind === 'plan') return plan.nodes.map(node => node.id)
    if (scope.kind === 'branch') {
      if (!plan.nodes.some(node => node.id === scope.nodeId)) throw new UserError('unknownPlanNode', { id: plan.id, node: scope.nodeId })
      return [...successors(plan, [scope.nodeId])]
    }
    const binding = this.host.store.tickets.get(scope.ticketId)?.plan
    if (binding?.planId !== plan.id || !plan.nodes.some(node => node.id === binding.nodeId) ||
      this.host.plans.state(plan.id, binding.nodeId)?.claim.ticketId !== scope.ticketId) {
      return refuse('The named Ticket is not a current claim in this Plan')
    }
    return [binding.nodeId]
  }

  private workersFor(planId: string, nodes: string[]): Hold['workers'] {
    return nodes.flatMap(nodeId => {
      const state = this.host.plans.state(planId, nodeId), ticket = state && this.host.store.tickets.get(state.claim.ticketId)
      const assignment = ticket && latestAssignment(ticket)
      return ticket && !ticket.ended && assignment && assignment.state !== 'ended'
        ? [{ ticketId: ticket.id, assignmentId: assignment.id, stopped: false }] : []
    })
  }

  private nodes(plan: Plan, hold: Hold): string[] { return hold.scope.kind === 'plan' ? plan.nodes.map(node => node.id) : hold.nodes }

  private requireOwner(plan: Plan, sessionId: string): void {
    const handoff = this.host.handoffs.get(plan.handoffId), owner = handoff?.confirmedBy.sessionId
    if (!this.host.isCurrentHub(sessionId) || handoff?.status !== 'specified' || !owner ||
      (owner !== sessionId && !this.host.isHubGeneration(owner))) return refuse('Only the current Hub of the confirming project can control this Plan')
  }

  private plan(planId: string): Plan {
    const plan = this.host.plans.get(planId)
    if (!plan) throw new UserError('unknownPlan', { id: planId })
    return plan
  }

  private holds(planId: string): PlanControlState {
    const raw = this.host.store.get(KV.plans.control(planId))
    if (raw === undefined) return []
    const result = HoldsSchema.safeParse(raw)
    if (!result.success) return refuse(`Plan ${planId} has invalid control state`)
    return result.data
  }
}
