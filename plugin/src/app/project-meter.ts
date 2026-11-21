/** Business attribution over SessionMeter's durable, session-local usage. */
import { KV } from '../kv.ts'
import type { Plan } from '../core/plan.ts'
import type { Range, SessionMeter, SessionMeterView } from './session-meter.ts'
import type { Store } from './store.ts'

const ROLES = ['hub', 'implementation', 'review', 'retro', 'retry', 'inspection', 'planner', 'splitter'] as const
type MeterRole = typeof ROLES[number]
export interface MeterBinding {
  session_id: string
  role: MeterRole
  ticket_id?: string
  plan_id?: string
  parent_session_id?: string
}

/** The business identity never changes; subsequent bindings can only add roles. */
export interface MeterSessionBinding {
  session_id: string
  roles: MeterRole[]
  ticket_id: string | null
  plan_id: string | null
  parent_session_id: string | null
}

type Scope = 'project' | 'plan' | 'ticket'
type Usage = SessionMeterView['usage']
const TOKEN_FIELDS = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens',
  'known_components_total_tokens', 'reported_total_tokens'] as const
type SessionRange = Range & { session_id: string }
type UsageUnknown = {
  session_id: string
  reason: 'log-not-found' | 'log-unavailable' | 'no-observed-usage' | 'unreported-total'
  range: Range | null
}
export interface MeterSubtotal extends Pick<Usage, typeof TOKEN_FIELDS[number] | 'counted_calls' | 'reported_total_calls'
  | 'total_complete' | 'billing_status' | 'quality'> {
  range: SessionRange[]
  missing: (Usage['missing'][number] & { session_id: string })[]
  in_flight: SessionRange[]
  unknown: UsageUnknown[]
  /** Latest contributing usage sample, not wall clock at query time. Ranges remain per Session. */
  sampled_at: string | null
  source: Usage['source'] | 'none'
}

type LogStatus = 'available' | 'not-found' | 'unavailable'
interface MeterSessionView extends MeterSessionBinding {
  log_status: LogStatus
  cursor: number | null
  inherited_events: number | null
  context: SessionMeterView['context'] | null
  own: MeterSubtotal
  including_children: MeterSubtotal
}

export interface ProjectMeterView {
  scope: Scope
  id: string | null
  attributed: MeterSubtotal
  shared: MeterSubtotal
  /** Attributed plus shared for a project; attributed only for a plan or ticket. */
  total: MeterSubtotal
  sessions: MeterSessionView[]
}

type MeterStore = Pick<Store, 'atomic' | 'get' | 'keys' | 'set' | 'tickets'>
interface Sample {
  binding: MeterSessionBinding
  log_status: LogStatus
  view: SessionMeterView | undefined
}

const shared = (binding: MeterSessionBinding): boolean => binding.ticket_id === null && binding.plan_id === null

function subtotal(samples: Iterable<Sample>): MeterSubtotal {
  const result: MeterSubtotal = { input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: null,
    reasoning_tokens: null, known_components_total_tokens: null, reported_total_tokens: null, counted_calls: 0,
    reported_total_calls: 0, total_complete: false, billing_status: 'not-final', range: [], missing: [], in_flight: [],
    unknown: [], sampled_at: null, source: 'none', quality: 'unknown' }
  let sessions = 0, complete = true, anyTokens = false, allMeasured = true
  for (const { binding: { session_id }, log_status, view } of samples) {
    sessions++
    const usage = view?.usage
    complete &&= log_status === 'available' && usage?.total_complete === true
    allMeasured &&= usage?.quality === 'measured'
    if (log_status !== 'available') {
      // The unobserved tail's end is not known; the durable prefix is reported separately in `range`.
      result.unknown.push({ session_id, reason: log_status === 'not-found' ? 'log-not-found' : 'log-unavailable', range: null })
    }
    if (!usage) continue
    let sessionTokens = false
    for (const field of TOKEN_FIELDS) {
      const value = usage[field]
      if (value === null) continue
      result[field] = (result[field] ?? 0) + value
      sessionTokens = true
    }
    anyTokens ||= sessionTokens
    result.counted_calls += usage.counted_calls
    result.reported_total_calls += usage.reported_total_calls
    result.range.push({ session_id, ...usage.range })
    for (const missing of usage.missing) result.missing.push({ session_id, ...missing })
    if (usage.in_flight) result.in_flight.push({ session_id, ...usage.in_flight })
    if (!sessionTokens) result.unknown.push({ session_id, reason: 'no-observed-usage', range: usage.range })
    if (usage.reported_total_calls < usage.counted_calls) {
      result.unknown.push({ session_id, reason: 'unreported-total', range: usage.range })
    }
    if (result.sampled_at === null || result.sampled_at < usage.sampled_at) result.sampled_at = usage.sampled_at
    result.source = usage.source
  }
  result.total_complete = sessions > 0 && complete
  if (anyTokens) {
    result.quality = allMeasured && !result.unknown.length && !result.missing.length && !result.in_flight.length ? 'measured' : 'partial'
  }
  return result
}

/** Reachability is by explicitly bound business edges within the selected scope, never by the host fork graph. */
function* subtree(root: Sample, children: ReadonlyMap<string, Sample[]>): Iterable<Sample> {
  const seen = new Set<string>(), pending = [root]
  while (pending.length) {
    const sample = pending.pop()!
    const id = sample.binding.session_id
    if (seen.has(id)) continue
    seen.add(id)
    yield sample
    for (const child of children.get(id) ?? []) pending.push(child)
  }
}

/** The mounted project Store isolates binding identities and is the authority for plans and tickets. */
export class ProjectMeter {
  private readonly store: MeterStore
  private readonly meter: Pick<SessionMeter, 'read'>
  private readonly canSample: ((binding: MeterSessionBinding) => boolean | Promise<boolean>) | undefined

  constructor(options: { store: MeterStore; meter: Pick<SessionMeter, 'read'>; masterId: string;
    /** Runtime may require independent proof of log identity after reserving a business binding. */
    canSample?: (binding: MeterSessionBinding) => boolean | Promise<boolean> }) {
    this.store = options.store
    this.meter = options.meter
    this.canSample = options.canSample
    this.bind({ session_id: options.masterId, role: 'hub' })
  }

  /** Trusted lifecycle callers bind actual delegations before launch. Omitted identities on a replay retain their previous values. */
  bind(binding: MeterBinding): void {
    const { session_id, role } = binding
    for (const id of [session_id, binding.ticket_id, binding.plan_id, binding.parent_session_id]) {
      if (id !== undefined && (typeof id !== 'string' || !id.trim())) throw new Error('Meter bindings require non-blank IDs')
    }
    if (!session_id || !ROLES.includes(role)) throw new Error('Meter bindings require a session ID and a known role')
    this.store.atomic(() => {
      const key = KV.projectMeter.binding(session_id)
      const prior = this.store.get(key)
      const ticket_id = binding.ticket_id ?? prior?.ticket_id ?? null
      const parent_session_id = binding.parent_session_id ?? prior?.parent_session_id ?? null
      let plan_id = binding.plan_id ?? prior?.plan_id ?? null
      if (ticket_id !== null) {
        const ticket = this.store.tickets.get(ticket_id)
        if (!ticket || ticket.id !== ticket_id) throw new Error(`Unknown meter ticket ${ticket_id}`)
        const association = ticket.plan
        if (plan_id !== null && plan_id !== association?.planId) throw new Error(`Meter ticket ${ticket_id} belongs to a different plan`)
        plan_id = association?.planId ?? null
        if (association && !this.plan(association.planId)?.nodes.some(node => node.id === association.nodeId && node.role === association.role)) {
          throw new Error(`Meter ticket ${ticket_id} has no matching registered plan node`)
        }
      } else if (plan_id !== null && !this.plan(plan_id)) {
        throw new Error(`Unknown meter plan ${plan_id}`)
      }
      if ((role === 'hub' || prior?.roles.includes('hub')) && (ticket_id !== null || plan_id !== null)) {
        throw new Error('Hub usage must remain project shared')
      }
      if (prior) {
        if (prior.ticket_id !== ticket_id || prior.plan_id !== plan_id || prior.parent_session_id !== parent_session_id) {
          throw new Error(`Session ${session_id} already has a different meter binding`)
        }
        if (!prior.roles.includes(role)) this.store.set(key, { ...prior, roles: [...prior.roles, role] })
        return
      }
      if (parent_session_id !== null) {
        if (parent_session_id === session_id) throw new Error(`Session ${session_id} cannot be its own business parent`)
        const parent = this.store.get(KV.projectMeter.binding(parent_session_id))
        if (!parent) throw new Error(`Unknown meter business parent ${parent_session_id}`)
        if (!shared(parent) && (parent.plan_id !== plan_id || parent.ticket_id !== null && parent.ticket_id !== ticket_id)) {
          throw new Error(`Session ${session_id} and its business parent have incompatible meter scopes`)
        }
      }
      this.store.set(key, { session_id, roles: [role], ticket_id, plan_id, parent_session_id })
    })
  }

  owns(sessionId: string): boolean { return this.store.get(KV.projectMeter.binding(sessionId)) !== undefined }

  async read(scope: Scope, id?: string, signal?: AbortSignal): Promise<ProjectMeterView | undefined> {
    signal?.throwIfAborted()
    // Snapshot identity and membership synchronously. A concurrent bind belongs to the next query.
    const bindings = this.store.atomic(() => {
      if (scope === 'project' ? id !== undefined : !id || (scope === 'plan' ? !this.plan(id) : !this.store.tickets.get(id))) return undefined
      const selected: MeterSessionBinding[] = []
      for (const key of this.store.keys(KV.projectMeter.binding).sort()) {
        const binding = this.store.get(key)
        if (!binding) continue
        const owner = scope === 'plan' ? binding.plan_id : binding.ticket_id
        if (scope === 'project' || owner === id || shared(binding)) selected.push(binding)
      }
      return selected
    })
    if (!bindings) return undefined

    // Bound open log handles even for a long-lived project. A Session is read once per query, regardless of roles or edges.
    const samples: Sample[] = [], attributedSamples: Sample[] = [], sharedSamples: Sample[] = []
    const children = new Map<string, Sample[]>()
    for (const binding of bindings) {
      const sample = await this.sample(binding, signal)
      samples.push(sample)
      const group = shared(binding) ? sharedSamples : attributedSamples
      group.push(sample)
      if (binding.parent_session_id !== null) {
        const siblings = children.get(binding.parent_session_id)
        if (siblings) siblings.push(sample)
        else children.set(binding.parent_session_id, [sample])
      }
    }
    const attributed = subtotal(attributedSamples)
    return { scope, id: id ?? null, attributed, shared: subtotal(sharedSamples), total: scope === 'project' ? subtotal(samples) : attributed,
      sessions: samples.map(sample => {
        const { binding, view, log_status } = sample
        const own = subtotal([sample])
        const context = view ? log_status === 'available' ? view.context : { ...view.context, stale: true } : null
        return { ...binding, log_status, cursor: view?.cursor ?? null, inherited_events: view?.inherited_events ?? null, context, own,
          including_children: children.has(binding.session_id) ? subtotal(subtree(sample, children)) : own }
      }) }
  }

  private plan(id: string): Plan | undefined {
    const plan = this.store.get(KV.plans.record(id))
    return plan?.status === 'registered' && plan.id === id && Array.isArray(plan.nodes) ? plan : undefined
  }

  private async sample(binding: MeterSessionBinding, signal?: AbortSignal): Promise<Sample> {
    if (this.canSample) {
      const allowed = await this.canSample(binding)
      signal?.throwIfAborted()
      if (!allowed) return { binding, log_status: 'unavailable', view: undefined }
    }
    let log_status: LogStatus = 'not-found'
    try {
      const view = await this.meter.read(binding.session_id, signal)
      signal?.throwIfAborted()
      if (view) return { binding, view, log_status: 'available' }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      log_status = 'unavailable'
    }
    // Retain independently committed usage if the host log disappeared or cannot be read. It is only a known prefix.
    const view = this.store.get(KV.meter.state(binding.session_id))?.view
    return { binding, view, log_status: view ? 'unavailable' : log_status }
  }
}
