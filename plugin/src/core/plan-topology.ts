import { UserError } from './errors.ts'
import { key } from './ids.ts'
import type { PlanDraft, PlanFeature, PlanNode } from './plan.ts'

export type TechnicalChange =
  | { kind: 'dependencies'; updates: { nodeId: string; blockedBy: string[] }[] }
  | { kind: 'split'; nodeId: string; groups: number[][] }
  | { kind: 'merge'; nodeIds: string[] }

export interface PlanTopology { draft: PlanDraft; replacements: Record<string, string[]> }

type TopologyContext = {
  revision: number
  hasClaim(nodeId: string): boolean
  delivered(nodeId: string): boolean
  pool(nodeId: string): string
}

function invalid(detail: string): never {
  throw new UserError('invalidPlan', { detail })
}

function requireNode(nodes: ReadonlyMap<string, PlanNode>, id: string): PlanNode {
  return nodes.get(id) ?? invalid(`Unknown node "${id}"`)
}

function requireUnclaimed(id: string, context: TopologyContext): void {
  if (context.hasClaim(id) || context.delivered(id)) invalid(`Cannot change claimed or delivered node "${id}"`)
}

/** Transform a registered graph. The Host validates the resulting draft against the immutable Spec. */
export function technicalReplan(plan: PlanDraft, change: TechnicalChange, context: TopologyContext): PlanTopology {
  if (!Number.isSafeInteger(context.revision) || context.revision < 1) invalid('Expected a positive target revision')
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const planId = 'id' in plan && typeof plan.id === 'string' ? plan.id : ''

  switch (change.kind) {
    case 'dependencies': {
      if (!change.updates.length) invalid('Expected at least one dependency update')
      const updates = new Map<string, string[]>()
      for (const { nodeId, blockedBy } of change.updates) {
        if (updates.has(nodeId)) invalid(`Duplicate dependency update for "${nodeId}"`)
        const node = requireNode(nodes, nodeId)
        requireUnclaimed(nodeId, context)
        const next = new Set<string>()
        for (const id of blockedBy) {
          if (id === nodeId) invalid(`Node "${nodeId}" cannot block itself`)
          if (next.has(id)) invalid(`Duplicate dependency "${id}" for "${nodeId}"`)
          const predecessor = requireNode(nodes, id)
          if (node.role === 'frontend' && predecessor.role === 'backend' && !predecessor.interfaceContract) {
            invalid(`Backend dependency "${id}" for "${nodeId}" has no interface contract`)
          }
          next.add(id)
        }
        let unchanged = blockedBy.length === node.blockedBy.length
        for (const id of node.blockedBy) {
          if (next.has(id)) continue
          unchanged = false
          if (!context.delivered(id)) invalid(`Cannot remove undelivered dependency "${id}" from "${nodeId}"`)
          if (node.role === 'frontend' && requireNode(nodes, id).role === 'backend') {
            invalid(`Cannot remove interface contract dependency "${id}" from "${nodeId}"`)
          }
        }
        if (unchanged) invalid(`No dependency changes for "${nodeId}"`)
        updates.set(nodeId, [...blockedBy])
      }
      return {
        draft: { features: plan.features, nodes: plan.nodes.map(node => {
          const blockedBy = updates.get(node.id)
          return blockedBy ? { ...node, blockedBy } : node
        }) },
        replacements: {},
      }
    }
    case 'split': {
      const node = requireNode(nodes, change.nodeId)
      requireUnclaimed(node.id, context)
      const feature = plan.features.find(item => item.id === node.featureId) ?? invalid(`Unknown feature "${node.featureId}"`)
      if (feature.kind === 'cross-end' || node.interfaceContract) invalid(`Cannot split cross-end or contract node "${node.id}"`)
      if (change.groups.length < 2) invalid('A split requires at least two acceptance groups')
      const remaining = new Set(node.acceptance)
      const addedNodes: PlanNode[] = [], addedFeatures: PlanFeature[] = []
      for (const group of change.groups) {
        if (!group.length) invalid('A split acceptance group cannot be empty')
        for (const criterion of group) {
          if (!remaining.delete(criterion)) invalid(`Unknown or repeated split acceptance ${criterion} for "${node.id}"`)
        }
        const acceptance = group.toSorted((a, b) => a - b)
        const token = key('plan-replan', planId, String(context.revision), 'split', node.id, acceptance.join(','))
        const featureId = `feature-${token}`
        addedFeatures.push({ id: featureId, kind: feature.kind })
        addedNodes.push({ ...node, id: `node-${token}`, featureId, acceptance })
      }
      if (remaining.size) invalid(`Split groups must cover every acceptance of "${node.id}"`)
      return replace(plan, [node], addedNodes, addedFeatures, context)
    }
    case 'merge': {
      const selected = new Set(change.nodeIds)
      if (selected.size !== change.nodeIds.length) invalid('Duplicate nodes in merge')
      if (selected.size < 2) invalid('A merge requires at least two nodes')
      for (const id of selected) requireNode(nodes, id)
      // Use Plan order for the resulting text and IDs, independent of the order of nodeIds.
      const originals = plan.nodes.filter(node => selected.has(node.id))
      const first = originals[0]!
      const features = new Map(plan.features.map(feature => [feature.id, feature]))
      const pool = context.pool(first.id)
      const acceptance = new Set<number>(), blockedBy = new Set<string>(), titles = new Set<string>(), demonstrations = new Set<string>()
      let interfaceContract: PlanNode['interfaceContract']
      let pairedFeature: PlanFeature | undefined
      for (const node of originals) {
        requireUnclaimed(node.id, context)
        if (node.role !== first.role) invalid('Cannot merge nodes with different roles')
        if (!pool || (node !== first && context.pool(node.id) !== pool)) invalid('Cannot merge nodes from different budget pools')
        const feature = features.get(node.featureId) ?? invalid(`Unknown feature "${node.featureId}"`)
        if (feature.kind === 'cross-end') {
          // One node cannot occupy the role slot of two cross-end features.
          if (pairedFeature) invalid('Cannot merge nodes from different cross-end features')
          pairedFeature = feature
        }
        if (node.interfaceContract) {
          if (interfaceContract && (interfaceContract.path !== node.interfaceContract.path ||
            interfaceContract.requirements !== node.interfaceContract.requirements ||
            interfaceContract.previousRequirements !== node.interfaceContract.previousRequirements)) invalid('Cannot merge conflicting interface contracts')
          interfaceContract = node.interfaceContract
        }
        for (const id of node.blockedBy) {
          // One claim cannot produce a formal predecessor receipt before itself starts.
          if (selected.has(id)) invalid(`Cannot merge "${node.id}" with its undelivered prerequisite "${id}"`)
          blockedBy.add(id)
        }
        for (const criterion of node.acceptance) acceptance.add(criterion)
        titles.add(node.title)
        demonstrations.add(node.demonstration)
      }
      const token = key('plan-replan', planId, String(context.revision), 'merge', ...originals.map(node => node.id))
      const featureId = pairedFeature?.id ?? `feature-${token}`
      const merged: PlanNode = {
        id: `node-${token}`, featureId, role: first.role, title: [...titles].join(' + '),
        acceptance: [...acceptance], demonstration: [...demonstrations].join('\n\n'), blockedBy: [...blockedBy],
        ...(interfaceContract && { interfaceContract }),
      }
      return replace(plan, originals, [merged], pairedFeature ? [] : [{ id: featureId, kind: first.role }], context)
    }
    default:
      return invalid('Unknown technical change')
  }
}

function replace(plan: PlanDraft, originals: PlanNode[], addedNodes: PlanNode[], addedFeatures: PlanFeature[], context: TopologyContext): PlanTopology {
  const originalIds = new Set(originals.map(node => node.id))
  const retiredFeatures = new Set(originals.map(node => node.featureId))
  for (const node of addedNodes) retiredFeatures.delete(node.featureId)

  const replacementIds = addedNodes.map(node => node.id)
  const newIds = new Set(replacementIds)
  if (newIds.size !== replacementIds.length) invalid('Replacement node IDs collide')
  const nodes: PlanNode[] = []
  let inserted = false
  for (const node of plan.nodes) {
    if (newIds.has(node.id)) invalid(`Replacement node ID "${node.id}" already exists`)
    if (originalIds.has(node.id)) {
      if (!inserted) nodes.push(...addedNodes)
      inserted = true
    } else if (node.blockedBy.some(id => originalIds.has(id))) {
      requireUnclaimed(node.id, context)
      const blockedBy = new Set<string>()
      for (const id of node.blockedBy) {
        if (originalIds.has(id)) for (const replacement of replacementIds) blockedBy.add(replacement)
        else blockedBy.add(id)
      }
      nodes.push({ ...node, blockedBy: [...blockedBy] })
    } else {
      nodes.push(node)
    }
  }

  const newFeatures = new Set(addedFeatures.map(feature => feature.id))
  const features = plan.features.filter(feature => {
    if (newFeatures.has(feature.id)) invalid(`Replacement feature ID "${feature.id}" already exists`)
    return !retiredFeatures.has(feature.id)
  })
  features.push(...addedFeatures)
  return { draft: { features, nodes }, replacements: Object.fromEntries(originals.map(node => [node.id, replacementIds])) }
}
