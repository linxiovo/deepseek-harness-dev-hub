/** Durable, session-local token accounting. A request snapshot is not a billing receipt or a live context measurement. */
import type { Context } from '@deepseek-ai/cordis'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

export type Range = { from: number; through: number }
type Missing = Range & { reason: 'no-usage' | 'coverage-gap' }
type LogCoverage = {
  created_at?: string
  sampled_at: string
  status: 'current' | 'unavailable'
  range: Range
  missing: Missing[]
  in_flight: Range | null
}

/** All ranges are half-open event sequence ranges. Cursor and context refer to the currently read physical log. */
export interface SessionMeterView {
  session_id: string
  inherited_events: number
  cursor: number
  context: {
    model: string | null
    provider: string | null
    capacity_tokens: number | null
    occupied_tokens: number | null
    quality: 'measured' | 'estimated' | 'unknown'
    source: 'dsh-token-meter' | 'session-events' | 'none'
    sampled_at: string
    range: Range
    /** Last reported uncached input component, not an occupancy or a complete cached-input count. */
    last_input_tokens: number | null
    last_input_at: string | null
    last_input_range: Range | null
    stale: boolean
  }
  usage: {
    input_tokens: number | null
    cache_read_tokens: number | null
    cache_write_tokens: number | null
    output_tokens: number | null
    reasoning_tokens: number | null
    known_components_total_tokens: number | null
    reported_total_tokens: number | null
    reported_total_calls: number
    total_complete: boolean
    counted_calls: number
    /** Totals span logs; these unqualified coverage fields describe only the current log. */
    missing: Missing[]
    in_flight: Range | null
    range: Range
    /** Per-log known prefixes. An unavailable log has no verified tail past its recorded range. */
    logs?: LogCoverage[]
    sampled_at: string
    source: 'session-events'
    quality: 'measured' | 'partial' | 'unknown'
    billing_status: 'not-final'
  }
}

interface Projection { view: SessionMeterView; compaction_from: number | null; awaiting_retry?: boolean }
interface PriorProjection extends Projection { createdAt?: number }
interface LogProjection extends PriorProjection { createdAt: number }
interface MeterLedger { latest: LogProjection; previous?: PriorProjection[] }

/** One KV record commits each log's cursor with its usage. Older records have no identity yet. */
export type SessionMeterState = Projection | MeterLedger

const sampledAt = (time: number) => new Date(time).toISOString()
const range = (from: number, through: number): Range => ({ from, through })

function initial(sessionId: string, inherited: number, createdAt: number): LogProjection {
  const sampled_at = sampledAt(createdAt)
  const covered = range(inherited, inherited)
  return { createdAt, compaction_from: null, view: {
    session_id: sessionId, inherited_events: inherited, cursor: inherited,
    context: { model: null, provider: null, capacity_tokens: null, occupied_tokens: null, quality: 'unknown', source: 'none',
      sampled_at, range: covered, last_input_tokens: null, last_input_at: null, last_input_range: null, stale: true },
    usage: { input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: null, reasoning_tokens: null,
      known_components_total_tokens: null, reported_total_tokens: null, reported_total_calls: 0, total_complete: false,
      counted_calls: 0, missing: [], in_flight: null, range: covered, sampled_at, source: 'session-events', quality: 'unknown',
      billing_status: 'not-final' },
  } }
}

/** Add only reported numeric components; null represents an entirely unreported bucket, not zero. */
function add(known: number | null, value: number | undefined): number | null {
  return value === undefined ? known : (known ?? 0) + value
}

const TOKEN_FIELDS = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens',
  'known_components_total_tokens', 'reported_total_tokens'] as const

function logCoverage({ createdAt, view: { usage } }: PriorProjection, status: LogCoverage['status']): LogCoverage {
  return { ...(createdAt === undefined ? {} : { created_at: sampledAt(createdAt) }), sampled_at: usage.sampled_at, status,
    range: usage.range, missing: usage.missing, in_flight: usage.in_flight }
}

/** Also used for the project meter's cached-prefix fallback when the host log cannot be read. */
export function sessionMeterView(state: SessionMeterState): SessionMeterView {
  if ('view' in state) return state.view
  const { latest, previous } = state
  if (!previous?.length) return latest.view
  const logs: LogCoverage[] = []
  const usage = { ...latest.view.usage, logs }
  for (const log of previous) {
    const past = log.view.usage
    for (const field of TOKEN_FIELDS) usage[field] = add(usage[field], past[field] ?? undefined)
    usage.counted_calls += past.counted_calls
    usage.reported_total_calls += past.reported_total_calls
    logs.push(logCoverage(log, 'unavailable'))
  }
  usage.total_complete = false
  usage.quality = usage.counted_calls ? 'partial' : 'unknown'
  logs.push(logCoverage(latest, 'current'))
  return { ...latest.view, usage }
}

function logProjection(state: SessionMeterState | undefined, createdAt: number): LogProjection | undefined {
  if (!state || !('latest' in state)) return undefined
  const log = state.latest.createdAt === createdAt ? state.latest : state.previous?.find(log => log.createdAt === createdAt)
  return log?.createdAt === undefined ? undefined : log as LogProjection
}

function checkForkCut(projection: Projection | undefined, inherited: number, sessionId: string): void {
  if (projection && projection.view.inherited_events !== inherited) throw new Error(`Session ${sessionId} fork cut changed`)
}

function account(view: SessionMeterView, usage: TokenUsage | undefined, event: SessionEvent, sampleInput: boolean): void {
  const total = view.usage
  if (usage === undefined) {
    total.missing.push({ ...range(event.seq, event.seq + 1), reason: 'no-usage' })
    return
  }
  total.counted_calls++
  total.input_tokens = add(total.input_tokens, usage.inputTokens)
  total.cache_read_tokens = add(total.cache_read_tokens, usage.cacheReadTokens)
  total.cache_write_tokens = add(total.cache_write_tokens, usage.cacheWriteTokens)
  total.output_tokens = add(total.output_tokens, usage.outputTokens)
  total.reasoning_tokens = add(total.reasoning_tokens, usage.reasoningTokens)
  // Reasoning is a subset of output, never an extra component of the total.
  for (const part of [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]) {
    total.known_components_total_tokens = add(total.known_components_total_tokens, part)
  }
  if (usage.totalTokens !== undefined) {
    total.reported_total_tokens = add(total.reported_total_tokens, usage.totalTokens)
    total.reported_total_calls++
  }
  if (sampleInput && usage.inputTokens !== undefined) {
    view.context.last_input_tokens = usage.inputTokens
    view.context.last_input_at = sampledAt(event.time)
    view.context.last_input_range = range(event.seq, event.seq + 1)
  }
}

function uncovered(view: SessionMeterView, start: number, end: number): void {
  view.usage.missing.push({ ...range(start, end), reason: 'coverage-gap' })
}

/** DSH 0.2.1 compaction emits this field without exporting its event extension to this plugin. */
function summaryUsage(event: SessionEvent): TokenUsage | undefined {
  const data: unknown = event.data
  if (!data || typeof data !== 'object') throw new TypeError('Invalid compaction summary')
  if (!('usage' in data) || data.usage === undefined) return undefined
  const usage: unknown = data.usage
  if (!usage || typeof usage !== 'object') throw new TypeError('Invalid compaction summary usage')
  // Object identity is already checked; property values remain unknown until validated below.
  const fields = usage as Record<string, unknown>
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
    if (!(key in fields)) {
      if (key === 'inputTokens' || key === 'outputTokens') throw new TypeError('Incomplete compaction summary usage')
      continue
    }
    const count = fields[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid compaction summary usage')
  }
  return usage as TokenUsage
}

/** Ancestor history supplies routing only; neither its accounting nor its sampling clock belongs to the fork. */
function route(view: SessionMeterView, event: SessionEvent<'request/context' | 'request/header'>): void {
  if (event.type === 'request/context') {
    view.context.provider = event.data.provider
    view.context.model = event.data.model
    view.context.capacity_tokens = event.data.contextWindow ?? null
  } else {
    const { provider, model } = event.data.header.config
    if (view.context.provider !== provider || view.context.model !== model) view.context.capacity_tokens = null
    view.context.provider = provider
    view.context.model = model
  }
  view.context.source = 'session-events'
}

function fold(state: LogProjection, event: SessionEvent): void {
  const { view } = state
  const next = event.seq + 1
  const timestamp = sampledAt(event.time)
  if (event.type === 'request/context' || event.type === 'request/header') {
    route(view, event)
    if (event.type === 'request/header') {
      if (state.awaiting_retry) view.usage.in_flight = range(event.seq, next)
      else view.usage.in_flight ??= range(event.seq, next)
      state.awaiting_retry = false
    }
  } else if (event.type === 'step/start') {
    if (view.usage.in_flight && !state.awaiting_retry) uncovered(view, view.usage.in_flight.from, event.seq)
    state.awaiting_retry = false
    view.usage.in_flight = range(event.seq, next)
  } else if ((event.type as string) === 'llm/retry-started') {
    if (view.usage.in_flight && !state.awaiting_retry) uncovered(view, view.usage.in_flight.from, event.seq)
    state.awaiting_retry = false
    view.usage.in_flight = range(event.seq, next)
  } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const reported = event.type === 'assistant/message' ? event.data.usage : undefined
    account(view, reported ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage, event, true)
    state.awaiting_retry = event.type === 'assistant/attempt'
    view.usage.in_flight = state.awaiting_retry ? range(event.seq, next) : null
  } else if ((event.type as string) === 'compaction/start') {
    state.compaction_from = event.seq
    if (state.awaiting_retry) view.usage.in_flight = null
    state.awaiting_retry = false
    view.usage.in_flight ??= range(event.seq, next)
  } else if ((event.type as string) === 'compaction/summary') {
    account(view, summaryUsage(event), event, false)
    state.compaction_from = null
    view.usage.in_flight = null
    state.awaiting_retry = false
  } else if ((event.type as string) === 'compaction/end') {
    if (state.compaction_from !== null) {
      uncovered(view, state.compaction_from, next)
      state.compaction_from = null
      view.usage.in_flight = null
      state.awaiting_retry = false
    }
  } else if (event.type === 'step/end' || event.type === 'turn/end') {
    if (view.usage.in_flight) {
      if (!state.awaiting_retry) uncovered(view, view.usage.in_flight.from, next)
      view.usage.in_flight = null
    }
    state.awaiting_retry = false
  }
  if (view.usage.in_flight) view.usage.in_flight.through = next
  view.cursor = next
  view.context.range = view.usage.range = range(view.inherited_events, next)
  view.context.sampled_at = view.usage.sampled_at = timestamp
  view.context.stale = view.context.last_input_range?.through !== next
  view.usage.total_complete = view.usage.counted_calls > 0 && view.usage.reported_total_calls === view.usage.counted_calls
    && view.usage.missing.length === 0 && view.usage.in_flight === null
  view.usage.quality = view.usage.counted_calls === 0 ? 'unknown'
    : view.usage.missing.length || view.usage.in_flight ? 'partial' : 'measured'
}

/** A live projection is read-time context only; it must never enter durable usage state. */
function withOccupancy(ctx: Context, sessionId: string, createdAt: number, view: SessionMeterView): SessionMeterView {
  try {
    const projections = ctx.get('sessionProjections') as
      | { snapshot?: (session: Session, keys: readonly string[]) => unknown }
      | undefined
    if (typeof projections?.snapshot !== 'function') return view
    const session = ctx.agents?.get(SessionId(sessionId))?.session
    if (!session || session.header.createdAt !== createdAt || session.inheritedEventCount !== view.inherited_events) return view
    const raw = projections.snapshot(session, ['contextPressure'])
    if (!raw || typeof raw !== 'object') return view
    const snapshot = raw as { asOfSeq?: unknown; values?: { contextPressure?: { projectedTokens?: unknown } } }
    const occupied = snapshot.values?.contextPressure?.projectedTokens
    // DSH names the last included event; the durable meter cursor names the next event.
    if (snapshot.asOfSeq !== view.cursor - 1 || typeof occupied !== 'number'
      || !Number.isFinite(occupied) || occupied < 0) return view
    return { ...view, context: { ...view.context, occupied_tokens: occupied,
      quality: 'estimated', source: 'dsh-token-meter' } }
  } catch { return view } // Optional host capability may be absent or unable to project this Session.
}

/** A scoped reader's checked identity did not match the opened log. */
export class SessionMeterIdentityError extends Error {}

/** Read only the durable log. Never price surface replacements, retries, or live event notifications as extra calls. */
export class SessionMeter {
  private readonly ctx: Context
  private readonly store: Pick<Store, 'get' | 'set' | 'atomic'>
  private readonly lifetime: AbortSignal

  constructor(options: { context: Context; store: Pick<Store, 'get' | 'set' | 'atomic'>; lifetime: AbortSignal }) {
    this.ctx = options.context
    this.store = options.store
    this.lifetime = options.lifetime
  }

  async read(sessionId: string, signal?: AbortSignal, verify?: (header: SessionHeader) => boolean): Promise<SessionMeterView | undefined> {
    signal?.throwIfAborted()
    this.lifetime.throwIfAborted()
    await this.ctx.sessionPersistence.flush()
    signal?.throwIfAborted()
    this.lifetime.throwIfAborted()
    const key = KV.meter.state(sessionId)
    const saved = this.store.get(key)
    const startedWith = saved && 'latest' in saved ? saved.latest.createdAt : undefined
    let handle: SessionHandle
    try { handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read', { signal }) }
    catch (error) { if (error instanceof SessionPersistenceNotFoundError) return undefined; throw error }
    await using owned = handle
    if (verify && !verify(owned.header)) throw new SessionMeterIdentityError('Opened Session log does not match the verified identity')
    const inherited = owned.inheritedEventCount
    const { createdAt } = owned.header
    // An old record with no own events has no usage to migrate; read the route from scratch.
    const untagged = saved && 'view' in saved && saved.view.cursor > saved.view.inherited_events ? saved : undefined
    // A log created after the old cursor's final event cannot contain that same own-event prefix.
    const retired = untagged && createdAt > Date.parse(untagged.view.usage.sampled_at) ? untagged : undefined
    const legacy = retired ? undefined : untagged
    if (saved && 'latest' in saved && !logProjection(saved, createdAt)
      && saved.previous?.some(log => log.createdAt === undefined && createdAt <= Date.parse(log.view.usage.sampled_at))) {
      throw new Error(`Session ${sessionId} legacy meter cursor cannot be safely identified`)
    }
    const prior = logProjection(saved, createdAt) ?? legacy
    checkForkCut(prior, inherited, sessionId)
    const offset = prior?.view.cursor ?? 0
    const events: SessionEvent[] = []
    for (let start = offset; ;) {
      signal?.throwIfAborted()
      this.lifetime.throwIfAborted()
      const { events: page } = await owned.read(start, 512, { signal })
      for (const event of page) {
        if (event.seq !== start++) throw new Error(`Session ${sessionId} log is not contiguous at seq ${start - 1}`)
        events.push(event)
      }
      if (!page.length) break
    }
    const readThrough = offset + events.length
    if (readThrough < inherited) throw new Error(`Session ${sessionId} fork cut exceeds its durable log`)
    // A prior cursor must still name a durable log prefix, even when there is no newer event to read.
    if (prior && offset) {
      const tail = (await owned.read(offset - 1, 1, { signal })).events[0]
      if (!tail || tail.seq !== offset - 1) throw new Error(`Session ${sessionId} durable log is shorter than its meter cursor`)
      // The old schema only kept a cursor and the clock of its last own event.
      if (legacy && sampledAt(tail.time) !== legacy.view.usage.sampled_at) {
        throw new Error(`Session ${sessionId} legacy meter cursor does not match the durable log`)
      }
    }
    // Reads can race with attached, accepted-but-not-flushed writes. Barrier again before recording their seqs in KV.
    if (events.length) await this.ctx.sessionPersistence.flush()
    signal?.throwIfAborted()
    this.lifetime.throwIfAborted()
    const ledger = this.store.atomic(() => {
      const saved = this.store.get(key)
      const current = saved && 'latest' in saved ? saved : undefined
      const projected = logProjection(current, createdAt)
      if (legacy && current && !projected) throw new Error(`Session ${sessionId} legacy meter cursor was bound to a different log`)
      checkForkCut(projected, inherited, sessionId)
      const state = projected ?? (legacy ? { ...legacy, createdAt } : initial(sessionId, inherited, createdAt))
      if (state.view.cursor < offset) throw new Error(`Session ${sessionId} meter cursor moved backwards`)
      if (current && projected && state.view.cursor >= readThrough) return current
      for (const event of events) {
        if (event.seq < inherited) {
          // Inherited events can advertise the route, but their clock and usage belong to the ancestor.
          // A racing read may already have projected this prefix and newer own routing.
          if (!projected && (event.type === 'request/context' || event.type === 'request/header')) route(state.view, event)
          continue
        }
        if (event.seq < state.view.cursor) continue
        fold(state, event)
      }
      let next: MeterLedger
      // A retired log may still be read by a handle opened before deletion. It may not replace the current context.
      // For a first sighting racing another generation's commit, use creation time to break the tie.
      if (current && (projected || (startedWith !== current.latest.createdAt && createdAt < current.latest.createdAt))) {
        if (!projected) (current.previous ??= []).push(state)
        next = current
      } else if (current) {
        const previous = current.previous ?? []
        previous.push(current.latest)
        next = { latest: state, previous }
      } else {
        next = retired ? { latest: state, previous: [retired] } : { latest: state }
      }
      this.store.set(key, next)
      return next
    })
    return withOccupancy(this.ctx, sessionId, ledger.latest.createdAt, sessionMeterView(ledger))
  }
}
