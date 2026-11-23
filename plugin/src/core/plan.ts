/** Plan DAG data and the domain rules for converting a published specification into dispatchable slices. */
import { UserError } from './errors.ts'

export const PLAN_ROLES = ['backend', 'frontend'] as const
export const PLAN_FEATURE_KINDS = [...PLAN_ROLES, 'cross-end'] as const
export type PlanRole = typeof PLAN_ROLES[number]
export type PlanNodeExecutionStatus = 'claimed' | 'running' | 'awaiting-delivery' | 'delivered' | 'failed' | 'stopped'

export interface PlanNodeClaim {
  planId: string
  nodeId: string
  ticketId: string
  assignmentId: string
  session: string
  role: PlanRole
  pendingAction: 'launch' | 'resume' | null
  claimedAt: string
  startedAt?: string
}

/** The host closed this Ticket after matching candidate evidence to an observed mainline integration. */
export interface PlanDeliveryReceipt {
  ticketId: string
  assignmentId: string
  receiptId: string
  base: string
  generation: number
  candidate: string
  integration: string
  actual: string
  verifiedAt: string
}

export interface PlanNodeState {
  planId: string
  nodeId: string
  status: PlanNodeExecutionStatus
  claim: PlanNodeClaim
  delivery?: PlanDeliveryReceipt
}

export interface PlanFeature {
  id: string
  kind: typeof PLAN_FEATURE_KINDS[number]
}

export interface PlanNode {
  id: string
  featureId: string
  title: string
  role: PlanRole
  /** One-based indices into the immutable specification's acceptance block. */
  acceptance: number[]
  demonstration: string
  blockedBy: string[]
  interfaceContract?: { path: string } & (
    { requirements: string; previousRequirements?: never } |
    { previousRequirements: string; requirements?: never }
  )
}

export interface PlanDraft { features: PlanFeature[]; nodes: PlanNode[] }
export type PlanTarget = { kind: 'background' } | { kind: 'node'; nodeId: string }
export interface PlanMessage { sessionId: string; messageId: string; text: string }
export interface Plan extends PlanDraft { id: string; handoffId: string; specId: string; status: 'registered' }

/** A graph or specification constraint failure at a field in the submitted draft. */
class PlanValidationError extends UserError {
  constructor(path: string, message: string) {
    super('invalidPlan', { detail: `${path}: ${message}` })
  }
}

/** Validate references and domain constraints after structural parsing, before any registration write. */
export function validatePlanDraft(draft: PlanDraft, delivery: readonly (typeof PLAN_FEATURE_KINDS[number])[]): void {
  const features = new Map<string, { index: number; count: number; backend?: number; frontend?: number }>()
  for (const [i, feature] of draft.features.entries()) {
    if (features.has(feature.id)) throw new PlanValidationError(`features.${i}.id`, `Duplicate feature ID "${feature.id}"`)
    features.set(feature.id, { index: i, count: 0 })
  }

  const nodes = new Map<string, number>()
  for (const [i, node] of draft.nodes.entries()) {
    if (nodes.has(node.id)) throw new PlanValidationError(`nodes.${i}.id`, `Duplicate node ID "${node.id}"`)
    nodes.set(node.id, i)
  }

  const covered = new Set<number>()
  for (const [i, node] of draft.nodes.entries()) {
    const feature = features.get(node.featureId)
    if (!feature) throw new PlanValidationError(`nodes.${i}.featureId`, `Unknown feature "${node.featureId}"`)
    feature.count++
    feature[node.role] ??= i
    if (node.role === 'frontend' && node.interfaceContract !== undefined) {
      throw new PlanValidationError(`nodes.${i}.interfaceContract`, 'Only backend nodes may define an interface contract')
    }

    for (const [j, criterion] of node.acceptance.entries()) {
      const required = delivery[criterion - 1]
      if (!required) {
        throw new PlanValidationError(`nodes.${i}.acceptance.${j}`, `Acceptance index ${criterion} is out of range (1–${delivery.length})`)
      }
      if (required !== 'cross-end' && required !== node.role) {
        throw new PlanValidationError(`nodes.${i}.acceptance.${j}`, `Specification acceptance ${criterion} requires a ${required} node`)
      }
      covered.add(criterion)
    }

    const blockers = new Set<string>()
    for (const [j, id] of node.blockedBy.entries()) {
      const path = `nodes.${i}.blockedBy.${j}`
      if (id === node.id) throw new PlanValidationError(path, `Node "${id}" cannot block itself`)
      if (blockers.has(id)) throw new PlanValidationError(path, `Duplicate dependency "${id}"`)
      if (!nodes.has(id)) throw new PlanValidationError(path, `Unknown prerequisite node "${id}"`)
      blockers.add(id)
    }
  }
  validateAcyclic(draft.nodes, nodes)

  for (const { index, count, backend, frontend } of features.values()) {
    const feature = draft.features[index]!
    if (feature.kind !== 'cross-end') {
      if (count !== 1 || (feature.kind === 'backend' ? backend : frontend) === undefined) {
        throw new PlanValidationError(`features.${index}.kind`, `Feature "${feature.id}" requires exactly one ${feature.kind} node`)
      }
      continue
    }
    if (count !== 2 || backend === undefined || frontend === undefined) {
      throw new PlanValidationError(`features.${index}.kind`, `Cross-end feature "${feature.id}" requires exactly one backend and one frontend node`)
    }
    const provider = draft.nodes[backend]!
    if (!draft.nodes[frontend]!.blockedBy.includes(provider.id)) {
      throw new PlanValidationError(`nodes.${frontend}.blockedBy`, `Cross-end frontend must explicitly depend on backend node "${provider.id}"`)
    }
  }

  const paired = new Set<number>()
  for (const node of draft.nodes) {
    if (node.role !== 'frontend') continue
    for (const id of node.blockedBy) {
      const index = nodes.get(id)!
      const provider = draft.nodes[index]!
      if (provider.role === 'backend' && !provider.interfaceContract) {
        throw new PlanValidationError(`nodes.${index}.interfaceContract`, `Backend node "${id}" must specify an interface contract for frontend node "${node.id}"`)
      }
      if (provider.role === 'backend') {
        for (const criterion of provider.acceptance) if (node.acceptance.includes(criterion)) paired.add(criterion)
      }
    }
  }

  for (const [index, required] of delivery.entries()) {
    const criterion = index + 1
    if (!covered.has(criterion)) throw new PlanValidationError('nodes', `No node references specification acceptance ${criterion}`)
    if (required === 'cross-end' && !paired.has(criterion)) {
      throw new PlanValidationError('nodes', `Specification acceptance ${criterion} is cross-end and requires both a backend contract node and a frontend node directly blocked by it`)
    }
  }
}

/** Iterative depth-first traversal: the edge into an active node locates an actual cycle. */
function validateAcyclic(nodes: PlanNode[], indices: ReadonlyMap<string, number>): void {
  const state = new Uint8Array(nodes.length) // 0 unseen, 1 active, 2 complete
  const stack: { index: number; next: number }[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (state[i] !== 0) continue
    state[i] = 1
    stack.push({ index: i, next: 0 })
    while (stack.length) {
      const frame = stack.at(-1)!
      const node = nodes[frame.index]!
      if (frame.next === node.blockedBy.length) {
        state[frame.index] = 2
        stack.pop()
        continue
      }
      const edge = frame.next++
      const id = node.blockedBy[edge]!
      const dependency = indices.get(id)!
      if (state[dependency] === 1) {
        throw new PlanValidationError(`nodes.${frame.index}.blockedBy.${edge}`, `Dependency cycle: "${node.id}" blocks on "${id}"`)
      }
      if (state[dependency] === 0) {
        state[dependency] = 1
        stack.push({ index: dependency, next: 0 })
      }
    }
  }
}
