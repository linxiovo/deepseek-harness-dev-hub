import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'
import type { Handoff, Spec } from '../core/handoff.ts'
import { key } from '../core/ids.ts'
import type { Ticket } from '../core/model.ts'
import type { Plan, PlanMessage, PlanNode, PlanNodeState } from '../core/plan.ts'
import { KV } from '../kv.ts'
import type { Handoffs } from './handoffs.ts'
import { mainlineAttempts, type MainlineIntent } from './mainline-queue.ts'
import type { Plans } from './plans.ts'
import type { RunLimits } from './run-limits.ts'
import { promptFile } from './skill-files.ts'
import type { Store } from './store.ts'

const Text = z.string().max(4000).regex(/\S/, 'Expected non-blank text')
const RequirementRequestSchema = z.strictObject({
  intent: z.literal('change-plan-requirements'),
  planId: Text,
  authorizedScope: z.string().min(1),
  goal: Text.optional(),
  changes: z.array(z.strictObject({ criterion: z.number().int().positive(), statement: Text, observable: Text })).max(100),
})
const RequirementApprovalSchema = z.strictObject({ approved: z.literal(true), proposalId: z.uuid(),
  requestMessageId: Text, scopeDecision: z.enum(['within-handoff', 'new-handoff']), scopeReviewId: z.uuid() })
export const RequirementScopeVerdictSchema = z.strictObject({
  status: z.enum(['within-handoff', 'outside-handoff', 'uncertain']), reason: Text,
})
export type ScopeVerdict = z.infer<typeof RequirementScopeVerdictSchema>
type ScopeReview = { status: 'pending' } | ScopeVerdict & { reviewId: string; reviewerSessionId: string; at: string }
type OperatorMessage = PlanMessage & { seq: number; at: number }

const PROPOSAL_TTL = 30 * 60_000
const targetQuestion = promptFile('plan-requirements-target')
const demonstration = promptFile('plan-requirements-revalidate')

type CriterionChange = { criterion: number; before: Spec['acceptance'][number]; after: Spec['acceptance'][number] }
type EvidenceRef = {
  kind: 'failure' | 'tests' | 'docs' | 'retrospective' | 'acceptance' | 'repair' | 'review' | 'mainline' | 'formal-delivery'
  read: string
  status: string
  at: string
  evidenceId?: string
  candidate?: string
  integration?: string
  actual?: string
}
type AffectedTicket = { ticketId: string; nodeId: string; open: boolean; evidence: EvidenceRef[] }
type AffectedNode = Pick<PlanNode, 'featureId' | 'role' | 'interfaceContract'> & {
  nodeId: string
  replacementId: string
  impact: 'direct' | 'transitive'
  status: PlanNodeState['status'] | 'unclaimed'
  blockedBy: string[]
  replacementBlockedBy: string[]
  instructions: 'historical-only'
  revalidate: { criteria: number[]; demonstration: string; interfaceContract?: PlanNode['interfaceContract']; freshEvidence: true }
  tickets: AffectedTicket[]
}

/** The approval applies to the exact published impact, not a fresh proposal reconstructed after a restart. */
export type RequirementPreview = {
  proposalId: string
  ownerSession: string
  requestMessageId: string
  requestSequence: number
  requestDigest: string
  planId: string
  handoffId: string
  expectedRevision: number
  createdAt: string
  expiresAt: string
  previousGoal: string
  goal: string
  invalidated: CriterionChange[]
  affected: AffectedNode[]
  retained: Pick<Handoff, 'authorization' | 'constraints' | 'acceptanceScope'> & Pick<Spec, 'testInterfaces' | 'outOfScope'> & {
    handoff: string; spec: string
  }
  evidenceFingerprint: string
  scopeReview: ScopeReview
} & ({ status: 'preview' } | {
  status: 'applied'; revision: number; appliedAt: string; approvedBy: Pick<PlanMessage, 'sessionId' | 'messageId'>
})
type PendingPreview = Extract<RequirementPreview, { status: 'preview' }>
type AppliedPreview = Extract<RequirementPreview, { status: 'applied' }>
type NeedsTarget = { status: 'needs-target'; planId: string; question: string; criteria: { criterion: number; statement: string }[] }

type CriterionText = Pick<Spec['acceptance'][number], 'statement' | 'observable'>
export type RequirementScopeTask = {
  planId: string
  workspace: string
  input: {
    proposalId: string
    planId: string
    expectedRevision: number
    currentGoal: string
    desiredGoal: string
    changedCriteria: { criterion: number; before: CriterionText; after: CriterionText }[]
    originalHandoff: Pick<Handoff, 'goal' | 'authorization' | 'constraints' | 'acceptanceScope'> & Pick<Spec, 'outOfScope'>
  }
}

 type Host = {
  store: Pick<Store, 'atomic' | 'get' | 'set' | 'tickets'>
  plans: Pick<Plans, 'current' | 'state' | 'requiredDelivery' | 'revision' | 'revise'>
  migrateHolds(planId: string, replacements: Record<string, string[]>): void
  mainlineHeld(ticketId: string): boolean
  cancelQueuedMerge(ticketId: string): void
  handoffs: Pick<Handoffs, 'get'>
  limits: Pick<RunLimits, 'forDispatch'>
  stop: (ticketId: string, reason: string) => void
  authorize: () => void
  requestScopeReview: (proposalId: string) => void
  isHubGeneration: (sessionId: string) => boolean
  isCurrentHub: (sessionId: string) => boolean
 }
type ActivePlan = { plan: Plan; revision: number; goal: string; acceptance: Spec['acceptance']; handoff: Handoff; spec: Spec; waitingFor: string[] }

function criterionText({ statement, observable }: Spec['acceptance'][number]): CriterionText { return { statement, observable } }

function refuse(detail: string): never { throw new UserError('invalidPlan', { detail }) }

function operatorPayload<T>(schema: z.ZodType<T>, message: OperatorMessage, detail: string): T {
  if (!message.sessionId || !message.messageId || !Number.isSafeInteger(message.seq) || message.seq < 0) refuse(detail)
  let raw: unknown
  try { raw = JSON.parse(message.text) } catch { refuse(detail) }
  const result = schema.safeParse(raw)
  if (!result.success) refuse(detail)
  return result.data
}

function evidenceRefs(ticket: Ticket, state: PlanNodeState | undefined, attempts: MainlineIntent[]): EvidenceRef[] {
  const read = `ticket/${ticket.id}`, refs: EvidenceRef[] = []
  if (ticket.delivery) refs.push({ kind: 'failure', read, status: 'input-delivery-failed', at: ticket.delivery.at })
  if (ticket.ended && ticket.ended.outcome !== 'merged' && ticket.ended.outcome !== 'completed') {
    refs.push({ kind: 'failure', read, status: ticket.ended.outcome, at: ticket.ended.at })
  }
  for (const assignment of ticket.assignments) {
    const report = assignment.report
    if (report?.state === 'failed' || report?.state === 'blocked' || report?.state === 'dropped') {
      refs.push({ kind: 'failure', read: `${read}/report/${assignment.id}`, status: report.state, at: report.at })
    }
    for (const review of assignment.reviews?.evidence ?? []) {
      refs.push({ kind: 'review', read: `${read}/review/${review.id}`, evidenceId: review.id,
        status: review.conclusion, at: review.at, candidate: review.candidate })
    }
  }
  for (const [index, event] of (ticket.deliveryCheck?.events ?? []).entries()) {
    const observation = `${read}/delivery-observation/${index}`
    const { at, revision: { candidate } } = event
    if (event.kind === 'tests') refs.push({ kind: 'tests', read: observation, status: event.result, at, candidate })
    else if (event.kind === 'docs') refs.push({ kind: 'docs', read: observation, status: event.structure, at, candidate })
    else if (event.kind === 'acceptance') {
      for (const result of event.results) refs.push({ kind: 'acceptance', read: observation, evidenceId: result.id,
        status: result.status, at, candidate })
    } else if (event.kind === 'repair') {
      for (const fix of event.fixes) refs.push({ kind: 'repair', read: observation, evidenceId: fix.id,
        status: 'recorded', at, candidate })
    } else if (event.kind === 'first-retro' || event.kind === 'final-retro') {
      refs.push({ kind: 'retrospective', read: observation, status: event.kind, at, candidate })
    }
  }
  for (const attempt of attempts) {
    refs.push({ kind: 'mainline', read: `${read}/mainline`, evidenceId: attempt.id, status: attempt.status,
      at: attempt.observed_at ?? attempt.applying_at ?? attempt.queued_at, candidate: attempt.candidate,
      ...(attempt.integration ? { integration: attempt.integration } : {}), ...(attempt.actual ? { actual: attempt.actual } : {}) })
  }
  const delivery = state?.delivery
  if (state?.status === 'delivered' && delivery && delivery.ticketId === ticket.id &&
      ticket.ended?.by === 'delivery' && ticket.ended.outcome === 'merged' && ticket.assignments.at(-1)?.id === delivery.assignmentId) {
    refs.push({ kind: 'formal-delivery', read: `plan/${state.planId}/node/${state.nodeId}`, evidenceId: delivery.receiptId,
      status: 'delivered', at: delivery.verifiedAt, candidate: delivery.candidate, integration: delivery.integration, actual: delivery.actual })
  }
  return refs
}

/** An acceptance change invalidates all direct consumers and their transitive successors, never their predecessors. */
function impactedNodes(plan: Plan, targets: ReadonlySet<number>) {
  const successors = new Map<string, string[]>(), direct = new Set<string>()
  for (const node of plan.nodes) {
    if (node.acceptance.some(criterion => targets.has(criterion))) direct.add(node.id)
    for (const predecessor of node.blockedBy) {
      const items = successors.get(predecessor)
      if (items) items.push(node.id)
      else successors.set(predecessor, [node.id])
    }
  }
  const queue = [...direct], affected = new Set(direct)
  for (let i = 0; i < queue.length; i++) for (const successor of successors.get(queue[i]!) ?? []) {
    if (!affected.has(successor)) { affected.add(successor); queue.push(successor) }
  }
  return { direct, affected }
}

/** Product reapproval is explicit and replayable; evidence and graph writes are fenced by one Store transaction. */
export class PlanRequirements {
  constructor(private readonly host: Host) {}

  get(proposalId: string): RequirementPreview | undefined {
    const preview = this.host.store.get(KV.planRequirements.preview(proposalId))
    return preview?.scopeReview ? preview : undefined
  }

  scopeTask(proposalId: string): RequirementScopeTask | undefined {
    const preview = this.get(proposalId)
    if (preview?.status !== 'preview' || preview.scopeReview.status !== 'pending') return undefined
    const handoff = this.currentScopePreview(preview)
    if (!handoff) return undefined
    const { planId, expectedRevision, previousGoal, goal, invalidated, retained } = preview
    const { authorization, constraints, outOfScope, acceptanceScope } = retained
    return { planId, workspace: handoff.project.workspace, input: {
      proposalId, planId, expectedRevision, currentGoal: previousGoal, desiredGoal: goal,
      changedCriteria: invalidated.filter(({ before, after }) => before.statement !== after.statement || before.observable !== after.observable)
        .map(({ criterion, before, after }) => ({ criterion, before: criterionText(before), after: criterionText(after) })),
      originalHandoff: { goal: handoff.goal, authorization, constraints, outOfScope, acceptanceScope },
    } }
  }

  /** Runtime authenticates the reviewer Session; only the exact current preview can receive its verdict. */
  recordScopeReview(proposalId: string, reviewerSessionId: string, verdict: ScopeVerdict): RequirementPreview {
    const { store } = this.host
    return store.atomic(() => {
      const preview = this.get(proposalId)
      if (preview?.status !== 'preview' || !this.currentScopePreview(preview)) refuse('Scope review no longer applies to a current requirement preview')
      if (!reviewerSessionId || reviewerSessionId === preview.ownerSession) refuse('The product owner cannot attest to the scope of this preview')
      this.host.authorize()
      const parsed = RequirementScopeVerdictSchema.safeParse(verdict)
      if (!parsed.success) refuse('Invalid requirement scope verdict')
      const review = preview.scopeReview
      if (review.status !== 'pending') {
        if (review.reviewerSessionId !== reviewerSessionId || review.status !== parsed.data.status || review.reason !== parsed.data.reason) {
          refuse('The scope verdict already recorded for this preview is immutable')
        }
        return preview
      }
      const reviewed: PendingPreview = { ...preview, scopeReview: { ...parsed.data,
        reviewId: randomUUID(), reviewerSessionId, at: new Date().toISOString() } }
      store.set(KV.planRequirements.preview(proposalId), reviewed)
      return reviewed
    })
  }

  preview(message: OperatorMessage): RequirementPreview | NeedsTarget {
    const { planId, authorizedScope, goal, changes } = operatorPayload(RequirementRequestSchema, message,
      'The latest direct Harness operator message must be an explicit, structured product change request')
    const { store } = this.host, ownerSession = message.sessionId
    const requestKey = KV.planRequirements.request(ownerSession, message.messageId)
    const requestDigest = createHash('sha256').update(message.text).digest('hex')
    return store.atomic(() => {
      const priorId = store.get(requestKey)
      if (priorId !== undefined) {
        const prior = this.get(priorId)
        if (!prior || prior.ownerSession !== ownerSession || prior.planId !== planId || prior.requestMessageId !== message.messageId ||
            prior.requestSequence !== message.seq || prior.requestDigest !== requestDigest) refuse('Product request does not match its recorded preview')
        this.requireOwner(prior.handoffId, ownerSession)
        return prior
      }
      const active = this.active(planId, ownerSession)
      if (authorizedScope !== active.handoff.authorization.scope) refuse('Changing the authorized scope requires a new handoff')
      const previousGoal = active.goal, nextGoal = goal ?? previousGoal
      const globalChange = nextGoal !== previousGoal
      if ((!changes.length && !globalChange) || changes.some(item => item.criterion > active.acceptance.length)) {
        return { status: 'needs-target', planId, question: targetQuestion,
          criteria: active.acceptance.map(({ statement }, index) => ({ criterion: index + 1, statement })) }
      }
      const edits = new Map<number, Spec['acceptance'][number]>()
      for (const { criterion, statement, observable } of changes) {
        if (edits.has(criterion)) refuse(`Acceptance criterion ${criterion} appears more than once`)
        edits.set(criterion, { ...active.acceptance[criterion - 1]!, statement, observable })
      }
      const invalidated: CriterionChange[] = []
      for (const [index, before] of active.acceptance.entries()) {
        const criterion = index + 1, after = edits.get(criterion) ?? before
        if (globalChange || after.statement !== before.statement || after.observable !== before.observable) {
          invalidated.push({ criterion, before, after })
        }
      }
      if (!invalidated.length) refuse('The proposed requirements make no change to the current Plan')
      this.host.authorize()
      const proposalId = randomUUID(), now = Date.now()
      const { affected, evidenceFingerprint } = this.impact(active, invalidated, proposalId)
      const preview: PendingPreview = {
        status: 'preview', proposalId, ownerSession, planId, handoffId: active.handoff.id,
        requestMessageId: message.messageId, requestSequence: message.seq, requestDigest,
        expectedRevision: active.revision, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PROPOSAL_TTL).toISOString(),
        previousGoal, goal: nextGoal, invalidated, affected, evidenceFingerprint,
        scopeReview: { status: 'pending' },
        retained: { handoff: `handoff/${active.handoff.id}`, spec: `spec/${active.handoff.id}`,
          authorization: active.handoff.authorization, constraints: active.handoff.constraints, acceptanceScope: active.handoff.acceptanceScope,
          testInterfaces: active.spec.testInterfaces, outOfScope: active.spec.outOfScope },
      }
      store.set(KV.planRequirements.preview(proposalId), preview)
      store.set(requestKey, proposalId)
      this.host.requestScopeReview(proposalId)
      return preview
    })
  }

  apply(proposalId: string, message: OperatorMessage): AppliedPreview {
    const approval = operatorPayload(RequirementApprovalSchema, message,
      'The latest direct Harness operator approval must identify the preview, source request, and scope review and decision')
    if (approval.proposalId !== proposalId) refuse('Approval identifies a different requirement preview')
    if (approval.scopeDecision !== 'within-handoff') refuse('A change outside the authorized scope requires a new handoff')
    const { store, plans } = this.host
    return store.atomic(() => {
      const preview = this.get(proposalId)
      if (!preview) refuse('Unknown requirement proposal')
      this.requireOwner(preview.handoffId, message.sessionId)
      if (!this.sameHub(preview.ownerSession, message.sessionId)) refuse('Requirement proposal belongs to another Session')
      const later = message.sessionId === preview.ownerSession ? message.seq > preview.requestSequence
        : Number.isFinite(message.at) && message.at > Date.parse(preview.createdAt)
      if (approval.requestMessageId !== preview.requestMessageId || message.messageId === preview.requestMessageId || !later
        || store.get(KV.planRequirements.request(preview.ownerSession, approval.requestMessageId)) !== proposalId) {
        refuse('Approval must be a separate, later direct message bound to this preview and its original product request')
      }
      const review = preview.scopeReview
      if (review.status === 'pending') refuse('Independent scope review is pending; read the requirement preview before approving')
      if (review.status === 'outside-handoff') refuse('Independent scope review found this change outside the original Handoff; read the requirement preview and start a new Handoff')
      if (review.status === 'uncertain') refuse('Independent scope review could not determine if this change is within the Handoff; read the requirement preview and clarify the request')
      if (approval.scopeReviewId !== review.reviewId) {
        refuse('Approval must be a later direct message bound to the exact independent scope review')
      }
      const approvalKey = KV.planRequirements.approval(message.sessionId, message.messageId)
      const priorApproval = store.get(approvalKey)
      if (priorApproval !== undefined && priorApproval !== proposalId) refuse('This user event already approved another requirement proposal')
      if (preview.status === 'applied') {
        if (priorApproval !== proposalId || preview.approvedBy.messageId !== message.messageId) refuse('A different event already approved this preview')
        return preview
      }
      const expires = Date.parse(preview.expiresAt), now = Date.now()
      if (!Number.isFinite(expires) || now >= expires) refuse('Requirement proposal expired; send a new explicit product change request')
      const active = this.active(preview.planId, message.sessionId)
      if (active.revision !== preview.expectedRevision || active.handoff.id !== preview.handoffId) {
        refuse('Plan revision changed after the preview; send a new explicit product change request')
      }
      const observed = this.impact(active, preview.invalidated, proposalId)
      if (observed.evidenceFingerprint !== preview.evidenceFingerprint || !isDeepStrictEqual(observed.affected, preview.affected)) {
        refuse('Plan evidence or in-flight state changed after the preview; send a new explicit product change request')
      }
      this.host.authorize()
      const { affected } = preview
      const planId = active.plan.id
      for (const { nodeId, role } of observed.affected) {
        const ticketId = key('plan-ticket', planId, nodeId)
        const { block } = this.host.limits.forDispatch(ticketId, { planId, nodeId, role })
        if (block) {
          const status = block.state === 'reserved' ? 'waiting-for-budget' : 'quota-paused'
          refuse(`Cannot apply requirement proposal: Plan node ${nodeId} is ${status} (${block.scope} budget: ${block.state})`)
        }
      }
      const byNode = new Map(affected.map(node => [node.nodeId, node]))
      const nodes = active.plan.nodes.map(node => {
        const replacement = byNode.get(node.id)
        return replacement ? { ...node, id: replacement.replacementId, blockedBy: replacement.replacementBlockedBy,
          demonstration: replacement.revalidate.demonstration,
          ...(replacement.revalidate.interfaceContract && { interfaceContract: replacement.revalidate.interfaceContract }) } : node
      })
      const acceptance = [...active.acceptance]
      for (const { criterion, after } of preview.invalidated) acceptance[criterion - 1] = after
      const replacements = Object.fromEntries(affected.map(node => [node.nodeId, [node.replacementId]]))
      const { revision } = plans.revise(preview.planId, preview.expectedRevision,
        { draft: { features: active.plan.features, nodes }, replacements },
        { kind: 'requirements', proposalId, approval: message, goal: preview.goal, acceptance })
      const handled = new Set<string>()
      for (const node of affected) for (const ticket of node.tickets) if (!handled.has(ticket.ticketId)) {
        handled.add(ticket.ticketId)
        this.host.cancelQueuedMerge(ticket.ticketId)
        if (!ticket.open) continue
        this.host.stop(ticket.ticketId, `Requirement proposal ${proposalId} superseded Plan node ${ticket.nodeId}`)
        if (!store.tickets.get(ticket.ticketId)?.ended) refuse(`Superseded Ticket ${ticket.ticketId} is still open`)
      }
      this.host.migrateHolds(planId, replacements)
      const applied: AppliedPreview = { ...preview, status: 'applied', revision, appliedAt: new Date(now).toISOString(),
        approvedBy: { sessionId: message.sessionId, messageId: message.messageId } }
      store.set(KV.planRequirements.preview(proposalId), applied)
      store.set(approvalKey, proposalId)
      return applied
    })
  }

  private sameHub(first: string, second: string): boolean {
    return first === second || (this.host.isHubGeneration(first) && this.host.isHubGeneration(second))
  }

  private currentScopePreview(preview: PendingPreview) {
    if (!(Date.now() < Date.parse(preview.expiresAt))) return undefined
    const { plans, handoffs } = this.host
    const active = plans.current(preview.planId)
    if (!active || active.revision !== preview.expectedRevision || active.plan.handoffId !== preview.handoffId) return undefined
    const handoff = handoffs.get(preview.handoffId)
    if (handoff?.status !== 'specified' || !this.sameHub(handoff.confirmedBy.sessionId, preview.ownerSession) || !handoff.spec ||
        !plans.requiredDelivery(preview.planId)?.waitingFor.length) return undefined
    return handoff
  }

  private requireOwner(handoffId: string, sessionId: string): Handoff {
    const handoff = this.host.handoffs.get(handoffId)
    if (!this.host.isCurrentHub(sessionId) || !handoff || handoff.status !== 'specified' || !this.sameHub(handoff.confirmedBy.sessionId, sessionId)) {
      refuse('Only the current Hub Session that confirmed the original Handoff can change its product requirements')
    }
    return handoff
  }

  private active(planId: string, ownerSession: string): ActivePlan {
    const active = this.host.plans.current(planId)
    if (!active) throw new UserError('unknownPlan', { id: planId })
    const handoff = this.requireOwner(active.plan.handoffId, ownerSession)
    const required = this.host.plans.requiredDelivery(planId)
    if (!required?.waitingFor.length) refuse('A fully delivered Plan cannot be replanned')
    if (!handoff.spec) refuse('The original published Specification is required for a product change')
    return { ...active, handoff, spec: handoff.spec, waitingFor: required.waitingFor }
  }

  private impact(active: ActivePlan, changes: CriterionChange[], proposalId: string) {
    const { plans, store } = this.host, { plan, revision } = active
    const targets = new Set(changes.map(change => change.criterion))
    const { direct, affected } = impactedNodes(plan, targets)
    if (!affected.size) refuse('No current Plan nodes implement the requested criteria')
    const lineage = this.lineage(plan.id, revision, affected)
    const nextIds = new Map<string, string>()
    for (const nodeId of affected) {
      const suffix = `-r${revision + 1}-${key('requirement-node', proposalId, nodeId)}`
      nextIds.set(nodeId, `${nodeId.slice(0, 80 - suffix.length).replace(/-$/, '')}${suffix}`)
    }
    const fingerprint = createHash('sha256')
    fingerprint.update(JSON.stringify([plan, active.goal, active.acceptance, active.handoff.constraints, active.handoff.authorization,
      active.handoff.acceptanceScope, active.spec.testInterfaces, active.spec.outOfScope,
      store.get(KV.plans.background(plan.id))]))
    const observations = new Map<string, { state: PlanNodeState | undefined; ticket: AffectedTicket | undefined }>()
    const observe = (nodeId: string, inScope: boolean) => {
      const prior = observations.get(nodeId)
      if (prior) return prior
      const state = plans.state(plan.id, nodeId)
      const ticketId = state?.claim.ticketId ?? key('plan-ticket', plan.id, nodeId)
      const ticket = store.tickets.get(ticketId)
      if ((state && !ticket) || (ticket && (ticket.plan?.planId !== plan.id || ticket.plan.nodeId !== nodeId))) {
        refuse(`Ticket or claim for Plan node ${nodeId} does not match the registered Plan`)
      }
      const attempts = ticket ? mainlineAttempts(store, ticketId) : []
      if (inScope && attempts.some(attempt => attempt.status === 'applying' ||
        (attempt.status === 'queued' && !this.host.mainlineHeld(ticketId)))) {
        refuse(`Ticket ${ticketId} has an active or unreconciled mainline write; pause or reconcile it before replanning`)
      }
      // Recovery reacquires a writer generation on the same Assignment. Evidence keeps its own recorded generation;
      // superseding this work requires fresh evidence and drains the actual writer, independent of its current lease.
      const assignments = ticket?.assignments.map(({ id, state, report, reviews }) => [id, state, report, reviews])
      fingerprint.update(JSON.stringify([nodeId, state?.status, state?.delivery, ticketId, ticket?.ended, ticket?.delivery, assignments,
        ticket?.deliveryCheck, ticket?.execution?.base, ticket?.execution?.ownership?.identity, attempts,
        store.get(KV.plans.instructions(plan.id, nodeId))]))
      const result = { state, ticket: ticket && inScope ? { ticketId, nodeId, open: !ticket.ended, evidence: evidenceRefs(ticket, state, attempts) } : undefined }
      observations.set(nodeId, result)
      return result
    }
    const result: AffectedNode[] = []
    const prerequisites = new Set<string>()
    for (const node of plan.nodes) {
      const replacementId = nextIds.get(node.id)
      if (!replacementId) continue
      const tickets: AffectedTicket[] = []
      for (const historical of lineage.get(node.id)!) {
        const { ticket } = observe(historical, true)
        if (ticket) tickets.push(ticket)
      }
      for (const predecessor of node.blockedBy) if (!affected.has(predecessor)) prerequisites.add(predecessor)
      const revised = direct.has(node.id)
      const contract = node.interfaceContract
      const previousRequirements = contract?.requirements ?? contract?.previousRequirements
      result.push({ nodeId: node.id, replacementId, impact: revised ? 'direct' : 'transitive',
        featureId: node.featureId, role: node.role, ...(node.interfaceContract ? { interfaceContract: node.interfaceContract } : {}),
        status: observations.get(node.id)?.state?.status ?? 'unclaimed', blockedBy: node.blockedBy,
        replacementBlockedBy: node.blockedBy.map(id => nextIds.get(id) ?? id), instructions: 'historical-only',
        revalidate: { criteria: node.acceptance, demonstration: revised || contract ? demonstration : node.demonstration,
          ...(contract && previousRequirements !== undefined && { interfaceContract: { path: contract.path, previousRequirements } }),
          freshEvidence: true }, tickets })
    }
    const waiting = new Set(active.waitingFor)
    for (const predecessor of prerequisites) {
      observe(predecessor, false)
      fingerprint.update(JSON.stringify([predecessor, waiting.has(predecessor)]))
    }
    return { affected: result, evidenceFingerprint: fingerprint.digest('hex') }
  }

  private lineage(planId: string, revision: number, affected: ReadonlySet<string>): Map<string, Set<string>> {
    const lineage = new Map<string, Set<string>>()
    const descendants = new Map<string, Set<string>>()
    for (const nodeId of affected) { lineage.set(nodeId, new Set([nodeId])); descendants.set(nodeId, new Set([nodeId])) }
    for (let version = revision; version > 1; version--) {
      const history = this.host.plans.revision(planId, version)
      if (!history) refuse(`Missing Plan revision ${version}; cannot reconstruct affected historical tickets`)
      for (const [oldNode, replacements] of Object.entries(history.replacements)) for (const replacement of replacements) {
        const currentIds = descendants.get(replacement)
        if (!currentIds) continue
        let roots = descendants.get(oldNode)
        if (!roots) { roots = new Set(); descendants.set(oldNode, roots) }
        for (const id of currentIds) { roots.add(id); lineage.get(id)!.add(oldNode) }
      }
    }
    return lineage
  }
}
