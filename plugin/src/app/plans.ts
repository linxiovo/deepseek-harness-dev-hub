import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import { latestAssignment } from '../core/model.ts'
import { PLAN_FEATURE_KINDS, PLAN_ROLES, validatePlanDraft, type Plan, type PlanDeliveryReceipt, type PlanDraft, type PlanMessage, type PlanNode,
  type PlanNodeClaim, type PlanNodeState, type PlanTarget } from '../core/plan.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import { mainlineIntent } from './mainline-queue.ts'
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
export const PlanDeliveryReceiptSchema = z.strictObject({ ticketId: TextSchema, assignmentId: TextSchema, receiptId: TextSchema,
  candidate: TextSchema, verifiedAt: TextSchema }) satisfies z.ZodType<PlanDeliveryReceipt>
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

type PlanNodeView = PlanNode & {
  status: PlanNodeState['status'] | 'blocked' | 'waiting-for-slot'
  waiting_for?: 'predecessors'
  waiting_on?: string[]
  claim?: PlanNodeState['claim']
  delivery?: PlanNodeState['delivery']
}

/** Durable Plan DAG registration, node claims, delivery gates and targeted context. */
export class Plans {
  constructor(private readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'keys' | 'tickets'>, private readonly handoffs: Pick<Handoffs, 'get'>,
    private readonly effects: Pick<Effects, 'cancel'>) {}

  get(id: string): Plan | undefined {
    const result = PlanRecordSchema.safeParse(this.store.get(KV.plans.record(id)))
    if (!result.success) return undefined
    const handoff = this.handoffs.get(result.data.handoffId)
    if (!handoff || handoff.id !== result.data.handoffId || handoff.spec?.id !== result.data.specId || handoff.spec.handoffId !== result.data.handoffId) return undefined
    const delivery = handoff.spec.acceptance.map(item => item.delivery)
    if (delivery.some(item => !item || !PLAN_FEATURE_KINDS.includes(item))) return undefined
    try { validatePlanDraft(result.data, delivery as (typeof PLAN_FEATURE_KINDS[number])[]) }
    catch { return undefined }
    return result.data
  }
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
      if (ticket && !ticket.ended && assignment?.id === state.claim.assignmentId) {
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

  /** A predecessor unlocks only through a persisted formal delivery receipt, never through a Worker report. */
  waitingOn(id: string, node: PlanNode): string[] {
    return node.blockedBy.filter(blocked => {
      const state = this.state(id, blocked), predecessor = this.get(id)?.nodes.find(item => item.id === blocked)
      return state?.status !== 'delivered' || state.claim.role !== predecessor?.role
    })
  }

  frontier(id: string): string[] {
    const plan = this.get(id)
    if (!plan) return []
    return plan.nodes.filter(node => !this.state(id, node.id) && this.waitingOn(id, node).length === 0).map(node => node.id)
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
      const prior = this.get(handoffId)
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
      if (claim.planId !== id || claim.nodeId !== nodeId || claim.role !== node.role) {
        throw new UserError('invalidPlan', { detail: `Node ${nodeId} claim does not match its registered role` })
      }
      prepare()
      const state: PlanNodeState = { planId: id, nodeId, status: 'claimed', claim }
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
      if (!state || state.claim.ticketId !== ticketId || state.claim.assignmentId !== assignmentId) return
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

  /** Records the later delivery-check gate; only a Runtime-issued delivery writer may call it. */
  deliver(authority: symbol, id: string, nodeId: string, receipt: PlanDeliveryReceipt): PlanNodeState {
    if (authority !== DELIVERY_AUTHORITY) throw new UserError('invalidPlan', { detail: 'Only the delivery gate may record formal Plan delivery' })
    return this.store.atomic(() => {
      const state = this.state(id, nodeId)
      if (!state) throw new UserError('invalidPlan', { detail: `Node ${nodeId} has no dispatch claim` })
      if (state.status === 'delivered' && isDeepStrictEqual(state.delivery, receipt)) return state
      if (state.claim.ticketId !== receipt.ticketId || state.claim.assignmentId !== receipt.assignmentId) {
        throw new UserError('invalidPlan', { detail: `Delivery receipt does not belong to Plan node ${id}/${nodeId}` })
      }
      if (!receipt.receiptId.trim() || !receipt.candidate.trim() || !receipt.verifiedAt.trim()) {
        throw new UserError('invalidPlan', { detail: `Delivery receipt for ${id}/${nodeId} is incomplete` })
      }
      if (state.status !== 'awaiting-delivery') {
        throw new UserError('invalidPlan', { detail: `Node ${id}/${nodeId} is not awaiting formal delivery` })
      }
      state.status = 'delivered'; state.claim.pendingAction = null; state.delivery = receipt
      this.store.set(KV.plans.node(id, nodeId), state)
      return state
    })
  }

  private nodeView(id: string, node: PlanNode): PlanNodeView {
    const state = this.state(id, node.id)
    if (state) return { ...node, status: state.status, claim: state.claim, ...(state.delivery ? { delivery: state.delivery } : {}) }
    const waiting = this.waitingOn(id, node)
    return { ...node, status: waiting.length ? 'blocked' : 'waiting-for-slot', ...(waiting.length ? { waiting_for: 'predecessors', waiting_on: waiting } : {}) }
  }

  /** Public graph shows node claims and formal delivery state, while ticket instructions stay behind node reads. */
  view(id: string) {
    const plan = this.get(id)
    if (!plan) return undefined
    const stats = { backend: { total: 0, delivered: 0 }, frontend: { total: 0, delivered: 0 } }
    const nodes = plan.nodes.map(node => {
      stats[node.role].total++
      if (this.state(id, node.id)?.status === 'delivered') stats[node.role].delivered++
      return this.nodeView(id, node)
    })
    return { ...plan, nodes, frontier: this.frontier(id), stats, context: this.store.get(KV.plans.background(id)) ?? [] }
  }

  /** A node sees only its targeted instructions and its own durable dispatch state. */
  node(id: string, nodeId: string) {
    const node = this.get(id)?.nodes.find(node => node.id === nodeId)
    if (!node) return undefined
    return { ...this.nodeView(id, node), instructions: this.store.get(KV.plans.instructions(id, nodeId)) ?? [] }
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
export function planDeliveryWriter(plans: Plans): PlanDeliveryWriter {
  return { deliver: (id, nodeId, receipt) => plans.deliver(DELIVERY_AUTHORITY, id, nodeId, receipt) }
}
