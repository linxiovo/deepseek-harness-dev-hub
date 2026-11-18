import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import { PLAN_FEATURE_KINDS, PLAN_ROLES, validatePlanDraft, type Plan, type PlanDraft, type PlanMessage, type PlanNode,
  type PlanTarget } from '../core/plan.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import type { Store } from './store.ts'

const SlugSchema = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a lowercase slug')
const TextSchema = z.string().max(4000).regex(/\S/, 'Expected non-blank text')
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

export const PlanTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('background') }),
  z.strictObject({ kind: z.literal('node'), nodeId: SlugSchema }),
])
const MessageSchema = z.strictObject({ sessionId: TextSchema, messageId: TextSchema, text: TextSchema })

function parse<T extends z.ZodType>(schema: T, input: unknown, label: string): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues.map(({ path, message }) => `${path.length ? path.join('.') : label}: ${message}`).join('; ')
    throw new UserError('invalidPlan', { detail })
  }
  return result.data
}

function nodeView(node: PlanNode): PlanNode & { status: 'blocked' | 'waiting-for-slot' } {
  return { ...node, status: node.blockedBy.length ? 'blocked' : 'waiting-for-slot' }
}

/** Durable Plan DAG registration and targeted context; registration retires the splitter without starting execution. */
export class Plans {
  constructor(private readonly store: Pick<Store, 'atomic' | 'get' | 'set'>, private readonly handoffs: Pick<Handoffs, 'get'>,
    private readonly effects: Pick<Effects, 'cancel'>) {}

  get(id: string): Plan | undefined { return this.store.get(KV.plans.record(id)) }

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

  /** Public graph shows only root context; ticket-specific instructions are absent. */
  view(id: string) {
    const plan = this.get(id)
    if (!plan) return undefined
    const stats = { backend: { total: 0, delivered: 0 }, frontend: { total: 0, delivered: 0 } }
    const nodes = plan.nodes.map(node => {
      stats[node.role].total++
      return nodeView(node)
    })
    return { ...plan, nodes, stats, context: this.store.get(KV.plans.background(id)) ?? [] }
  }

  /** A node sees only its targeted instructions, never root context or sibling instructions. */
  node(id: string, nodeId: string) {
    const node = this.get(id)?.nodes.find(node => node.id === nodeId)
    if (!node) return undefined
    return { ...nodeView(node), instructions: this.store.get(KV.plans.instructions(id, nodeId)) ?? [] }
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
