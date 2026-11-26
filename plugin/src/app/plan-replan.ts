/** The Hub can revise pending topology only in response to a current, budget-admitted technical failure. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Engine } from '../core/engine.ts'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import { technicalReplan, type PlanTopology } from '../core/plan-topology.ts'
import { KV } from '../kv.ts'
import type { Plans } from './plans.ts'
import type { PlanStagnation } from './plan-stagnation.ts'
import type { RunLimits } from './run-limits.ts'
import type { PlanControl } from './plan-control.ts'
import type { Store } from './store.ts'

const id = z.string().min(1).max(200)
const nodeId = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const change = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dependencies'), updates: z.array(z.strictObject({ nodeId, blockedBy: z.array(nodeId).max(100) })).min(1).max(100) }),
  z.strictObject({ kind: z.literal('split'), nodeId, groups: z.array(z.array(z.number().int().min(1)).min(1).max(100)).min(2).max(100) }),
  z.strictObject({ kind: z.literal('merge'), nodeIds: z.array(nodeId).min(2).max(100) }),
  z.strictObject({ kind: z.literal('repair') }),
])
export const TechnicalReplanSchema = z.strictObject({ planId: id, nodeId, revision: z.number().int().positive(),
  failureId: id, reason: z.string().trim().min(1).max(400), change })

type TechnicalReplan = z.infer<typeof TechnicalReplanSchema>
interface ReplanHost {
  store: Pick<Store, 'get' | 'atomic'>
  plans: Pick<Plans, 'current' | 'state' | 'requiredDelivery' | 'revise'>
  engine: Pick<Engine, 'supersedePlanTicket'>
  stagnation: Pick<PlanStagnation, 'view'>
  runLimits: Pick<RunLimits, 'forDispatch'>
  planControl: Pick<PlanControl, 'dispatchBlocked'>
}

/** Validate the actual failure and applicable scope before publishing one new graph version. */
export function replanTechnical({ store, plans, stagnation, engine, runLimits, planControl }: ReplanHost, input: TechnicalReplan) {
  const { planId, nodeId: stalled, revision, failureId, reason, change } = input
  const repair = change.kind === 'repair'
  return store.atomic(() => {
    const current = plans.current(planId)
    if (!current) throw new UserError('unknownPlan', { id: planId })
    if (current.revision !== revision) throw new UserError('invalidPlan', { detail: `Plan revision changed to ${current.revision}; read it again` })
    const states = new Map(current.plan.nodes.map(node => [node.id, plans.state(planId, node.id)]))
    const stalledState = states.get(stalled)
    const recovery = stalledState && stagnation.view(stalledState.claim.ticketId)
    if (!stalledState || !recovery?.canReplan || recovery.failureId !== failureId) {
      throw new UserError('invalidPlan', { detail: 'This replan requires the current technical failure and available run authorization' })
    }
    let topology: PlanTopology
    if (repair) {
      if (recovery.status !== 'stalled') throw new UserError('invalidPlan', { detail: 'A repair requires a stalled node' })
      const origin = store.get(KV.plans.budgetOrigin(planId, stalled)) ?? stalled
      const replacement = `repair-${key('plan-repair', planId, origin)}`
      if (states.has(replacement) || store.get(KV.plans.retired(planId, replacement))) {
        throw new UserError('invalidPlan', { detail: 'A repair has already used this budget origin' })
      }
      const nodes = current.plan.nodes.map(node => {
        if (node.id === stalled) return { ...node, id: replacement }
        if (!node.blockedBy.includes(stalled)) return node
        if (states.get(node.id)) throw new UserError('invalidPlan', { detail: `Cannot repair a dependency of claimed node "${node.id}"` })
        return { ...node, blockedBy: node.blockedBy.map(id => id === stalled ? replacement : id) }
      })
      topology = { draft: { features: current.plan.features, nodes }, replacements: { [stalled]: [replacement] } }
    } else {
      const delivery = plans.requiredDelivery(planId)
      if (!delivery) throw new UserError('unknownPlan', { id: planId })
      const waiting = new Set(delivery.waitingFor)
      topology = technicalReplan(current.plan, change, {
        revision: revision + 1,
        hasClaim: node => states.get(node) !== undefined,
        delivered: node => !waiting.has(node),
        pool: node => store.get(KV.plans.budgetOrigin(planId, node)) ?? node,
      })
    }
    const next = new Map(topology.draft.nodes.map(node => [node.id, node]))
    const scope: string[] = []
    for (const node of current.plan.nodes) {
      if (isDeepStrictEqual(node, next.get(node.id))) continue
      // Repair only redirects surviving edges from the failed node to its replacement.
      if (planControl.dispatchBlocked(current.plan, node.id) && !(repair && next.has(node.id))) {
        throw new UserError('invalidPlan', { detail: `Cannot replan paused node "${node.id}"` })
      }
      const { block } = runLimits.forDispatch(key('plan-ticket', planId, node.id), { planId, nodeId: node.id, role: node.role })
      if (block) throw new UserError('invalidPlan', { detail: `Cannot replan node "${node.id}": ${block.scope} budget: ${block.state}` })
      scope.push(node.id)
    }
    const cause = { kind: 'technical' as const, nodeId: stalled, failureId, reason, scope }
    const result = plans.revise(planId, revision, topology, repair ? { ...cause, repair: true } : cause)
    if (repair) engine.supersedePlanTicket(stalledState.claim.ticketId, reason)
    return { ...result, scope, replacements: topology.replacements, read: `plan/${planId}/revision/${result.revision}` }
  })
}
