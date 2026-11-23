import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import type { Spec } from '../core/handoff.ts'
import { latestAssignment } from '../core/model.ts'
import { PLAN_FEATURE_KINDS, PLAN_ROLES, validatePlanDraft, type Plan, type PlanDeliveryReceipt, type PlanDraft, type PlanMessage, type PlanNode,
  type PlanNodeClaim, type PlanNodeState, type PlanTarget } from '../core/plan.ts'
import type { PlanTopology } from '../core/plan-topology.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import { mainlineIntent } from './mainline-queue.ts'
import { unrepairedChecks, type PlanCheck } from './plan-stagnation.ts'
import type { Store } from './store.ts'

const SlugSchema = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a lowercase slug')
const TextSchema = z.string().max(4000).regex(/\S/, 'Expected non-blank text')
const DELIVERY_AUTHORITY = Symbol('plan-delivery-authority')
const RepoPathSchema = z.string().max(260).refine(
  path => !/[\\:"'<>|?*\p{Cc}]/u.test(path) && path.split('/').every(segment =>
    /\S/.test(segment) && !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)),
  'Expected a portable repository-relative path using forward slashes',
)

/** Draft shape shared with the splitter tool. Specification and graph constraints are checked by register. */
export const PlanDraftSchema = z.strictObject({
  features: z.array(z.strictObject({ id: SlugSchema, kind: z.enum(PLAN_FEATURE_KINDS) })).min(1).max(100),
  nodes: z.array(z.strictObject({
    id: SlugSchema,
    featureId: SlugSchema,
    title: TextSchema.max(200),
    role: z.enum(PLAN_ROLES),
    acceptance: z.array(z.number().int().min(1)).min(1).max(100),
    demonstration: TextSchema.max(1000),
    blockedBy: z.array(SlugSchema).max(100),
    interfaceContract: z.strictObject({ path: RepoPathSchema, requirements: TextSchema.max(1000) }).optional(),
  })).min(1).max(100),
}) satisfies z.ZodType<PlanDraft>
const PlanRecordSchema = z.strictObject({ id: TextSchema, handoffId: TextSchema, specId: TextSchema, status: z.literal('registered'),
  features: PlanDraftSchema.shape.features, nodes: PlanDraftSchema.shape.nodes }) satisfies z.ZodType<Plan>


export const PlanTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('background') }),
  z.strictObject({ kind: z.literal('node'), nodeId: SlugSchema }),
])
const MessageSchema = z.strictObject({ sessionId: TextSchema, messageId: TextSchema, text: TextSchema })
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/)
export const PlanDeliveryReceiptSchema = z.strictObject({ ticketId: TextSchema, assignmentId: TextSchema, receiptId: TextSchema,
  base: CommitSchema, generation: z.number().int().positive(), candidate: CommitSchema, integration: CommitSchema,
  actual: CommitSchema, verifiedAt: z.iso.datetime() }) satisfies z.ZodType<PlanDeliveryReceipt>
const PlanNodeClaimSchema = z.strictObject({ planId: TextSchema, nodeId: SlugSchema, ticketId: TextSchema, assignmentId: TextSchema,
  session: TextSchema, role: z.enum(PLAN_ROLES), pendingAction: z.enum(['launch', 'resume']).nullable(), claimedAt: TextSchema, startedAt: TextSchema.optional() })
const PlanNodeStateSchema = z.strictObject({ planId: TextSchema, nodeId: SlugSchema,
  status: z.enum(['claimed', 'running', 'awaiting-delivery', 'delivered', 'failed', 'stopped']), claim: PlanNodeClaimSchema,
  delivery: PlanDeliveryReceiptSchema.optional() }) satisfies z.ZodType<PlanNodeState>

function parse<T extends z.ZodType>(schema: T, input: unknown, label: string): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues.map(({ path, message }) => `${path.length ? path.join('.') : label}: ${message}`).join('; ')
    throw new UserError('invalidPlan', { detail })
  }
  return result.data
}

type PlanVersion = { plan: Plan; revision: number; goal: string; acceptance: Spec['acceptance'] }
type ReplanCause = { kind: 'technical'; nodeId: string; failureId: string; reason: string; scope: string[]; repair?: true }
  | { kind: 'requirements'; proposalId: string; approval: PlanMessage; goal: string; acceptance: Spec['acceptance'] }
export type PlanRevision = Omit<PlanVersion, 'plan'> & PlanTopology & { at: string; cause: ReplanCause }
export interface PlanRepairSource { nodeId: string; ticketId: string; failureId: string; summary: string; checks: PlanCheck[] }

type PlanNodeView = PlanNode & {
  status: PlanNodeState['status'] | 'blocked' | 'waiting-for-slot' | 'superseded'
  waiting_for?: 'predecessors' | 'superseded-writers'
  waiting_on?: string[]
  claim?: PlanNodeState['claim']
  delivery?: PlanNodeState['delivery']
  superseded?: { revision: number; replacements: string[] }
}

/** Owns immutable Plan versions, node claims, formal delivery gates and targeted context. */
export class Plans {
  constructor(private readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'keys' | 'tickets'>, private readonly handoffs: Pick<Handoffs, 'get'>,
    private readonly effects: Pick<Effects, 'cancel'>) {}

  get(id: string): Plan | undefined { return this.current(id)?.plan }

  current(id: string): PlanVersion | undefined { return this.at(id, this.store.get(KV.plans.head(id)) ?? 1) }

  at(id: string, revision: number): PlanVersion | undefined {
    const result = PlanRecordSchema.safeParse(this.store.get(KV.plans.record(id)))
    if (!result.success || result.data.id !== id) return undefined
    const handoff = this.handoffs.get(result.data.handoffId), spec = handoff?.spec
    if (!handoff || handoff.id !== result.data.handoffId || !spec || spec.id !== result.data.specId || spec.handoffId !== handoff.id) return undefined
    const update = revision === 1 ? undefined : this.store.get(KV.plans.revision(id, revision))
    if (revision !== 1 && (!update || update.revision !== revision)) return undefined
    const parsed = update ? PlanDraftSchema.safeParse(update.draft) : undefined
    if (parsed && !parsed.success) return undefined
    const plan = parsed ? { ...result.data, ...parsed.data } : result.data
    const goal = update?.goal ?? handoff.goal, acceptance = update?.acceptance ?? spec.acceptance
    const delivery = acceptance.map(item => item.delivery)
    if (delivery.length !== spec.acceptance.length || delivery.some((item, i) => !item || item !== spec.acceptance[i]?.delivery)) return undefined
    try { validatePlanDraft(plan, delivery as (typeof PLAN_FEATURE_KINDS[number])[]) }
    catch { return undefined }
    return { plan, revision, goal, acceptance }
  }

  revision(id: string, revision: number) { return this.store.get(KV.plans.revision(id, revision)) }

  /** Atomically publish the validated successor without rewriting the registered graph or a retired claim. */
  revise(id: string, expected: number, topology: PlanTopology, cause: ReplanCause): { planId: string; revision: number } {
    return this.store.atomic(() => {
      const current = this.current(id)
      if (!current) throw new UserError('unknownPlan', { id })
      const refuse = (detail: string): never => { throw new UserError('invalidPlan', { detail }) }
      if (current.revision !== expected) refuse(`Plan revision changed from ${expected} to ${current.revision}; read it again`)
      if (!this.requiredDelivery(id)?.waitingFor.length) refuse('A fully delivered Plan cannot be replanned')
      const draft = parse(PlanDraftSchema, topology.draft, 'draft')
      const { replacements } = topology
      const { plan } = current
      const goal = cause.kind === 'requirements' ? cause.goal : current.goal
      const acceptance = cause.kind === 'requirements' ? cause.acceptance : current.acceptance
      if (acceptance.length !== current.acceptance.length || acceptance.some((item, i) => item.delivery !== current.acceptance[i]?.delivery)) {
        refuse('A revision cannot change which roles verify a registered acceptance criterion')
      }
      validatePlanDraft(draft, acceptance.map(item => item.delivery!))
      const previous = new Map(plan.nodes.map(node => [node.id, node]))
      const next = new Map(draft.nodes.map(node => [node.id, node]))
      const origins = new Map<string, string>()
      const handovers = new Map<string, Set<string>>()
      const repairs = new Map<string, PlanRepairSource>()
      const instructions = new Map<string, Map<string, PlanMessage>>()
      for (const [oldId, successorIds] of Object.entries(replacements)) {
        if (!previous.has(oldId) || next.has(oldId) || !successorIds.length) refuse(`Invalid replacement of node ${oldId}`)
        const origin = this.store.get(KV.plans.budgetOrigin(id, oldId)) ?? oldId
        const messages = cause.kind === 'technical' ? this.store.get(KV.plans.instructions(id, oldId)) ?? [] : []
        const claim = this.state(id, oldId)?.claim
        const oldTicket = claim && this.store.tickets.get(claim.ticketId)
        if (claim && !oldTicket) refuse(`Cannot verify the claimed Ticket of node ${oldId}`)
        if (oldTicket?.assignments.some(item => item.writer && item.writer.state !== 'idle' && (!item.startedAt || !item.writer.session))) {
          refuse(`Plan node ${oldId} has an unconfirmed Worker launch; wait for preparation to finish before replacing it`)
        }
        const draining = this.waitingForWriters(id, oldId)
        if (claim) draining.push(oldId)
        let source = cause.kind === 'technical' ? this.repairSource(id, oldId) : undefined
        if (cause.kind === 'technical' && cause.repair && cause.nodeId === oldId) {
          const failure = claim && this.store.get(KV.planStagnation.ticket(claim.ticketId))?.failures.find(item => item.id === cause.failureId)
          if (!oldTicket || oldTicket.ended || !failure || successorIds.length !== 1 || Object.keys(replacements).length !== 1 ||
              !isDeepStrictEqual({ ...previous.get(oldId), id: successorIds[0] }, next.get(successorIds[0]!))) {
            throw new UserError('invalidPlan', { detail: 'A repair must preserve one active node and its recorded failure' })
          }
          source = { nodeId: oldId, ticketId: oldTicket.id, failureId: failure.id, summary: failure.summary.slice(0, 500),
            checks: unrepairedChecks(oldTicket, undefined) }
        }
        for (const successor of successorIds) {
          if (!next.has(successor) || previous.has(successor) || this.store.get(KV.plans.retired(id, successor)) || this.state(id, successor)) {
            refuse(`Replacement node ${successor} is not new`)
          }
          if (origins.has(successor) && origins.get(successor) !== origin) refuse(`Replacement node ${successor} would combine separate budget pools`)
          origins.set(successor, origin)
          if (source) repairs.set(successor, source)
          if (draining.length) {
            const writers = handovers.get(successor) ?? new Set<string>()
            for (const node of draining) writers.add(node)
            handovers.set(successor, writers)
          }
          if (messages.length) {
            const unique = instructions.get(successor) ?? new Map<string, PlanMessage>()
            for (const message of messages) unique.set(key(message.sessionId, message.messageId), message)
            instructions.set(successor, unique)
          }
        }
      }
      for (const [nodeId, node] of previous) {
        if (!next.has(nodeId) && !Object.hasOwn(replacements, nodeId)) refuse(`Missing replacement for ${nodeId}`)
        if (cause.kind === 'technical' && this.state(id, nodeId) && !isDeepStrictEqual(node, next.get(nodeId)) &&
            !(cause.repair && cause.nodeId === nodeId && Object.hasOwn(replacements, nodeId))) {
          refuse(`Technical replan cannot change claimed node ${nodeId}`)
        }
      }
      for (const nodeId of next.keys()) if (!previous.has(nodeId) && !origins.has(nodeId)) refuse(`Replacement has no prior scope: ${nodeId}`)
      if (cause.kind === 'technical' && isDeepStrictEqual(draft, { features: plan.features, nodes: plan.nodes })) refuse('Technical replan has no changes')
      const revision = expected + 1
      for (const [oldId, successors] of Object.entries(replacements)) {
        this.store.set(KV.plans.retired(id, oldId), { revision: expected, replacements: successors })
      }
      for (const [nodeId, origin] of origins) this.store.set(KV.plans.budgetOrigin(id, nodeId), origin)
      for (const [nodeId, writers] of handovers) this.store.set(KV.plans.handover(id, nodeId), [...writers])
      for (const [nodeId, source] of repairs) this.store.set(KV.plans.repairSource(id, nodeId), source)
      for (const [nodeId, messages] of instructions) this.store.set(KV.plans.instructions(id, nodeId), [...messages.values()])
      this.store.set(KV.plans.revision(id, revision), { revision, draft, replacements, cause, goal, acceptance, at: new Date().toISOString() })
      this.store.set(KV.plans.head(id), revision)
      return { planId: id, revision }
    })
  }

  /** Resolve old work against the contract under which it ran, not the goal that superseded it. */
  definition(id: string, nodeId: string) {
    const retired = this.store.get(KV.plans.retired(id, nodeId))
    const claimed = this.store.get(KV.plans.node(id, nodeId))
    const pinned = claimed ? this.store.get(KV.plans.claimRevision(id, nodeId)) ?? 1 : retired?.revision
    const version = pinned === undefined ? this.current(id) : this.at(id, pinned)
    const node = version?.plan.nodes.find(item => item.id === nodeId)
    const handoff = version && this.handoffs.get(version.plan.handoffId)
    return node && version && handoff?.spec ? { node, goal: version.goal, acceptance: version.acceptance, retired,
      constraints: handoff.constraints, authorization: handoff.authorization, testInterfaces: handoff.spec.testInterfaces } : undefined
  }

  /** The repair's immutable source of failed checks and audit history. */
  repairSource(id: string, nodeId: string): PlanRepairSource | undefined { return this.store.get(KV.plans.repairSource(id, nodeId)) }
  list(): Plan[] { return this.store.keys(KV.plans.record).map(name => this.get(name.slice(KV.plans.record.prefix.length))).filter((plan): plan is Plan => !!plan) }
  state(id: string, nodeId: string): PlanNodeState | undefined {
    const raw = this.store.get(KV.plans.node(id, nodeId))
    if (raw === undefined) return undefined
    const result = PlanNodeStateSchema.safeParse(raw)
    if (!result.success || result.data.planId !== id || result.data.nodeId !== nodeId || result.data.claim.planId !== id || result.data.claim.nodeId !== nodeId) {
      throw new UserError('invalidPlan', { detail: `Node state ${id}/${nodeId} is malformed or belongs to another Plan` })
    }
    const state = result.data
    if (state.status === 'running' || state.status === 'awaiting-delivery') {
      const ticket = this.store.tickets.get(state.claim.ticketId), assignment = ticket && latestAssignment(ticket)
      if (ticket && !ticket.ended && assignment && ticket.assignments[0]?.id === state.claim.assignmentId) {
        const merged = mainlineIntent(this.store, ticket.id)
        const repair = ticket.inputs.findLast(input => input.kind === 'mainline-repair')
        const ready = assignment.report?.state === 'ready' && (!repair || assignment.report.at > repair.at)
        state.status = ready || merged?.status === 'verified' ? 'awaiting-delivery' : 'running'
      }
    }
    return state
  }

  private requireNode(id: string, nodeId: string): { plan: Plan; node: PlanNode } {
    const plan = this.get(id)
    if (!plan) throw new UserError('unknownPlan', { id })
    const node = plan.nodes.find(item => item.id === nodeId)
    if (!node) throw new UserError('unknownPlanNode', { id, node: nodeId })
    return { plan, node }
  }

  waitingForWriters(id: string, nodeId: string): string[] {
    const previous = this.store.get(KV.plans.handover(id, nodeId)) ?? []
    return previous.filter(oldId => {
      const state = this.state(id, oldId), ticket = state && this.store.tickets.get(state.claim.ticketId)
      return !ticket?.ended || !!ticket.execution?.active_writer || ticket.assignments.some(assignment => assignment.writer && assignment.writer.state !== 'idle')
    })
  }

  /** A predecessor unlocks only through a persisted formal delivery receipt, never through a Worker report. */
  waitingOn(id: string, node: PlanNode): string[] {
    const plan = this.get(id)
    return node.blockedBy.filter(blocked => {
      const predecessor = plan?.nodes.find(item => item.id === blocked)
      return !predecessor || !this.formalReceipt(id, predecessor)
    })
  }

  private formalReceipt(id: string, node: PlanNode): PlanDeliveryReceipt | undefined {
    const state = this.state(id, node.id), receipt = state?.delivery
    if (state?.status !== 'delivered' || state.claim.role !== node.role || receipt?.ticketId !== state.claim.ticketId) return undefined
    const ticket = this.store.tickets.get(receipt.ticketId)
    if (ticket?.ended?.by === 'delivery' && ticket.ended.outcome === 'merged' &&
        ticket.plan?.planId === id && ticket.plan.nodeId === node.id && ticket.plan.role === node.role) return receipt
    return undefined
  }

  /** Registered nodes carry immutable acceptance; optional retro backlog does not create Plan nodes. */
  requiredDelivery(id: string): { waitingFor: string[]; integrations: string[] } | undefined {
    const plan = this.get(id)
    if (!plan) return undefined
    const waitingFor: string[] = [], integrations: string[] = []
    for (const node of plan.nodes) {
      const receipt = this.formalReceipt(id, node)
      if (receipt) integrations.push(receipt.integration)
      else waitingFor.push(node.id)
    }
    return { waitingFor, integrations }
  }

  frontier(id: string): string[] {
    const plan = this.get(id)
    if (!plan) return []
    return plan.nodes.filter(node => !this.state(id, node.id) && this.waitingOn(id, node).length === 0 && !this.waitingForWriters(id, node.id).length).map(node => node.id)
  }

  /** Register against the exact published specification. Only an identical replay may reuse an existing Plan. */
  register(handoffId: string, specId: string, draft: PlanDraft): Plan {
    if (!handoffId?.trim() || !specId?.trim()) throw new UserError('invalidPlan', { detail: 'Expected handoffId and specId' })
    const parsed = parse(PlanDraftSchema, draft, 'draft')
    // Explicit undefined in a non-tool caller's optional field is also absent in the persisted JSON.
    for (const node of parsed.nodes) if (node.interfaceContract === undefined) delete node.interfaceContract
    return this.store.atomic(() => {
      const handoff = this.handoffs.get(handoffId)
      if (!handoff || handoff.id !== handoffId || handoff.status !== 'specified' || !handoff.spec) {
        throw new UserError('invalidPlan', { detail: `handoffId: Handoff ${handoffId} has no published specification` })
      }
      if (handoff.spec.id !== specId || handoff.spec.handoffId !== handoffId) {
        throw new UserError('invalidPlan', { detail: `specId: Specification ${specId} does not belong to handoff ${handoffId}` })
      }
      const delivery = handoff.spec.acceptance.map(({ delivery }, i) => {
        if (!delivery || !PLAN_FEATURE_KINDS.includes(delivery)) {
          throw new UserError('invalidPlan', { detail: `Spec acceptance ${i + 1} has no delivery classification` })
        }
        return delivery
      })
      validatePlanDraft(parsed, delivery)
      const plan: Plan = { id: handoffId, handoffId, specId, status: 'registered', ...parsed }
      const prior = this.at(handoffId, 1)?.plan
      if (prior && !isDeepStrictEqual(prior, plan)) {
        throw new UserError('invalidPlan', { detail: `Plan ${handoffId} is already registered and cannot be replaced` })
      }
      if (!prior) this.store.set(KV.plans.record(handoffId), plan)
      this.effects.cancel('splitting', handoffId)
      return plan
    })
  }

  /** Atomically run the ticket creation callback and persist the node's claim before any queued launch can run. */
  claim(id: string, nodeId: string, claim: PlanNodeClaim, prepare: () => void): PlanNodeState {
    return this.store.atomic(() => {
      const { node } = this.requireNode(id, nodeId)
      const prior = this.state(id, nodeId)
      if (prior) return prior
      const waiting = this.waitingOn(id, node)
      if (waiting.length) throw new UserError('invalidPlan', { detail: `Node ${nodeId} waits for formal delivery of ${waiting.join(', ')}` })
      if (this.waitingForWriters(id, nodeId).length) throw new UserError('invalidPlan', { detail: `Node ${nodeId} waits for superseded writers to drain` })
      if (claim.planId !== id || claim.nodeId !== nodeId || claim.role !== node.role) {
        throw new UserError('invalidPlan', { detail: `Node ${nodeId} claim does not match its registered role` })
      }
      prepare()
      const state: PlanNodeState = { planId: id, nodeId, status: 'claimed', claim }
      const revision = this.store.get(KV.plans.head(id))
      if (revision !== undefined) this.store.set(KV.plans.claimRevision(id, nodeId), revision)
      this.store.set(KV.plans.node(id, nodeId), state)
      return state
    })
  }

  /** Reconciles the durable receipt that a Worker Assignment has started. Replays are idempotent. */
  assignmentStarted(ticketId: string, assignmentId: string, session: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId), plan = ticket?.plan
      if (!plan) return
      const state = this.state(plan.planId, plan.nodeId)
      if (!state || state.claim.ticketId !== ticketId || ticket.assignments[0]?.id !== state.claim.assignmentId ||
          latestAssignment(ticket)?.id !== assignmentId || this.store.get(KV.plans.retired(plan.planId, plan.nodeId))) return
      if (state.status === 'delivered' || state.status === 'failed' || state.status === 'stopped') return
      state.status = 'running'; state.claim.pendingAction = null; state.claim.startedAt ??= new Date().toISOString(); state.claim.session = session
      this.store.set(KV.plans.node(plan.planId, plan.nodeId), state)
    })
  }

  /** A Worker ready/failed/stopped result never becomes delivery; it only becomes an inspectable waiting state. */
  assignmentEnded(ticketId: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId), plan = ticket?.plan
      if (!plan || !ticket?.ended) return
      const state = this.state(plan.planId, plan.nodeId)
      if (!state || state.status === 'delivered' || state.status === 'failed' || state.status === 'stopped') return
      state.status = ticket.ended.outcome === 'stopped' ? 'stopped' : ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged'
        ? 'awaiting-delivery' : 'failed'
      state.claim.pendingAction = null
      this.store.set(KV.plans.node(plan.planId, plan.nodeId), state)
    })
  }

  /** Used by startup reconciliation to expose that the same durable claim is being resumed. */
  rearm(id: string, nodeId: string, pendingAction: 'launch' | 'resume'): PlanNodeState | undefined {
    return this.store.atomic(() => {
      const state = this.state(id, nodeId)
      if (!state || state.status === 'delivered' || state.status === 'failed' || state.status === 'stopped') return state
      state.claim.pendingAction = pendingAction
      this.store.set(KV.plans.node(id, nodeId), state)
      return state
    })
  }

  /** Persists the host-verified receipt inside the same transaction as the Ticket close. */
  deliver(authority: symbol, id: string, nodeId: string, receipt: PlanDeliveryReceipt, closeTicket: (id: string) => void): PlanNodeState {
    if (authority !== DELIVERY_AUTHORITY) throw new UserError('invalidPlan', { detail: 'Only the delivery gate may record formal Plan delivery' })
    return this.store.atomic(() => {
      const { node } = this.requireNode(id, nodeId)
      const state = this.state(id, nodeId)
      if (!state) throw new UserError('invalidPlan', { detail: `Node ${nodeId} has no dispatch claim` })
      if (state.status === 'delivered' && isDeepStrictEqual(state.delivery, receipt)) return state
      const ticket = this.store.tickets.get(receipt.ticketId), assignment = ticket && latestAssignment(ticket)
      if (state.claim.ticketId !== receipt.ticketId || state.claim.assignmentId !== ticket?.assignments[0]?.id ||
          ticket.plan?.planId !== id || ticket.plan.nodeId !== nodeId || ticket.plan.role !== node.role || state.claim.role !== node.role ||
          assignment?.id !== receipt.assignmentId || assignment.writer?.generation !== receipt.generation) {
        throw new UserError('invalidPlan', { detail: `Delivery receipt does not belong to the current Assignment of Plan node ${id}/${nodeId}` })
      }
      parse(PlanDeliveryReceiptSchema, receipt, 'delivery')
      if (ticket.ended || state.status !== 'awaiting-delivery') {
        throw new UserError('invalidPlan', { detail: `Node ${id}/${nodeId} is not awaiting formal delivery` })
      }
      state.status = 'delivered'; state.claim.pendingAction = null; state.delivery = receipt
      this.store.set(KV.plans.node(id, nodeId), state)
      closeTicket(ticket.id)
      return state
    })
  }

  private nodeView(id: string, node: PlanNode): PlanNodeView {
    const state = this.state(id, node.id)
    if (state) return { ...node, status: state.status, claim: state.claim, ...(state.delivery ? { delivery: state.delivery } : {}) }
    const waiting = this.waitingOn(id, node)
    if (waiting.length) return { ...node, status: 'blocked', waiting_for: 'predecessors', waiting_on: waiting }
    const writers = this.waitingForWriters(id, node.id)
    return writers.length ? { ...node, status: 'blocked', waiting_for: 'superseded-writers', waiting_on: writers }
      : { ...node, status: 'waiting-for-slot' }
  }

  /** Public graph shows node claims and formal delivery state, while ticket instructions stay behind node reads. */
  view(id: string) {
    const current = this.current(id)
    if (!current) return undefined
    const { plan, revision, goal } = current
    const stats = { backend: { total: 0, delivered: 0 }, frontend: { total: 0, delivered: 0 } }
    const nodes = plan.nodes.map(node => {
      stats[node.role].total++
      if (this.state(id, node.id)?.status === 'delivered') stats[node.role].delivered++
      return this.nodeView(id, node)
    })
    return { ...plan, revision, goal, nodes, frontier: this.frontier(id), stats, context: this.store.get(KV.plans.background(id)) ?? [] }
  }

  /** A node sees only its targeted instructions and its own durable dispatch state. */
  node(id: string, nodeId: string) {
    const definition = this.definition(id, nodeId)
    if (!definition) return undefined
    const { node, retired } = definition
    const detail: PlanNodeView = retired ? { ...node, ...this.state(id, nodeId), status: 'superseded', superseded: retired } : this.nodeView(id, node)
    return { ...detail, instructions: this.store.get(KV.plans.instructions(id, nodeId)) ?? [] }
  }

  /** The trusted caller selects a target from an authorized message. A source message cannot be retargeted on replay. */
  append(id: string, target: PlanTarget, message: PlanMessage): void {
    const selected = parse(PlanTargetSchema, target, 'target')
    const entry = parse(MessageSchema, message, 'message')
    this.store.atomic(() => {
      const plan = this.get(id)
      if (!plan) throw new UserError('unknownPlan', { id })
      if (selected.kind === 'node' && !plan.nodes.some(node => node.id === selected.nodeId)) {
        throw new UserError('unknownPlanNode', { id, node: selected.nodeId })
      }
      const receipt = KV.plans.receipt(id, entry.sessionId, entry.messageId)
      const fingerprint = key(selected.kind, selected.kind === 'node' ? selected.nodeId : '', entry.text)
      const prior = this.store.get(receipt)
      if (prior !== undefined) {
        if (prior === fingerprint) return
        throw new UserError('invalidPlan', { detail: 'messageId: This source message was already appended with a different target or text' })
      }
      const name = selected.kind === 'background' ? KV.plans.background(id) : KV.plans.instructions(id, selected.nodeId)
      const entries = this.store.get(name) ?? []
      entries.push(entry)
      this.store.set(name, entries)
      this.store.set(receipt, fingerprint)
    })
  }
}

export interface PlanDeliveryWriter {
  deliver(id: string, nodeId: string, receipt: PlanDeliveryReceipt): PlanNodeState
}

/** Exposes the formal-delivery write only to the Runtime's trusted delivery gate. */
export function planDeliveryWriter(plans: Plans, closeTicket: (id: string) => void): PlanDeliveryWriter {
  return { deliver: (id, nodeId, receipt) => plans.deliver(DELIVERY_AUTHORITY, id, nodeId, receipt, closeTicket) }
}
