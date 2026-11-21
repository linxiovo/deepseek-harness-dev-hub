import { Context } from '@deepseek-ai/cordis'
import { type TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, buildForkSeed, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionMeter } from '../src/app/session-meter.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

const AT = Date.UTC(2026, 0, 1)
const usageChunk = (usage: TokenUsage) => [{ type: 'chunk' as const, time: AT, chunk: { type: 'usage' as const, usage } }]

function fixture(id = 'meter-test', inherited = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'session-meter-'))
  const file = join(directory, 'state.sqlite')
  const ctx = new Context()
  let log = { createdAt: AT, inherited, settled: [] as SessionEvent[], pending: [] as SessionEvent[] }
  const closeHandle = vi.fn(async () => {})
  const flush = vi.fn(async () => { log.settled.push(...log.pending.splice(0)) })
  const open = vi.fn(async (sessionId: string) => {
    if (sessionId !== id) throw new SessionPersistenceNotFoundError(SessionId(sessionId))
    const { createdAt, inherited, settled } = log
    const header = { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt, isSeeded: inherited > 0 }
    return {
      header, inheritedEventCount: SessionLogOffset(inherited),
      read: async (offset = 0, length = 512) => ({ events: settled.slice(offset, offset + length), eventState: 'detached' as const }),
      [Symbol.asyncDispose]: closeHandle,
    }
  })
  ctx.reflect.provide('sessionPersistence', { flush, open })
  let store = new Store(file)
  const make = () => new SessionMeter({ context: ctx, store, lifetime: new AbortController().signal })
  const useLog = (createdAt: number, inherited = 0, settled: SessionEvent[] = []) => {
    log = { createdAt, inherited, settled, pending: [] }
  }
  const emit = (type: string, data: unknown, staged = false) => {
    const { createdAt, settled, pending } = log
    const event = { type, seq: SessionSeq(settled.length + pending.length), time: createdAt + settled.length + pending.length + 1, data } as SessionEvent
    ;(staged ? pending : settled).push(event)
    return event
  }
  const restart = () => { store.close(); store = new Store(file); return make() }
  const stop = () => { store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { ctx, get settled() { return log.settled }, get pending() { return log.pending }, get store() { return store },
    emit, make, restart, stop, flush, open, closeHandle, useLog }
}

it('distinguishes an absent Session from corrupt persisted history and closes read handles', async () => {
  const host = fixture()
  try {
    expect(await host.make().read('missing')).toBeUndefined()
    host.emit('request/context', { provider: 'test', model: 'example', contextWindow: 4096 })
    expect((await host.make().read('meter-test'))?.context.capacity_tokens).toBe(4096)
    expect(host.closeHandle).toHaveBeenCalledOnce()
    host.open.mockImplementationOnce(async () => { throw new Error('corrupt session log') })
    await expect(host.make().read('meter-test')).rejects.toThrow('corrupt session log')
  } finally { host.stop() }
})

it('reports combined context capacity, but never equates last input or shadow price with current occupancy', async () => {
  const host = fixture()
  try {
    const meter = host.make()
    let view = await meter.read('meter-test')
    expect(view?.context).toMatchObject({ model: null, provider: null, capacity_tokens: null, occupied_tokens: null, quality: 'unknown', source: 'none' })
    host.emit('request/context', { provider: 'provider-a', model: 'model-a', contextWindow: 8192 })
    host.emit('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [] }, stream: usageChunk({ inputTokens: 11, outputTokens: 3 }), usage: { inputTokens: 11, outputTokens: 3 } })
    view = await meter.read('meter-test')
    expect(view?.context).toMatchObject({ model: 'model-a', provider: 'provider-a', capacity_tokens: 8192, occupied_tokens: null, last_input_tokens: 11, quality: 'unknown' })
    expect(view?.context).toMatchObject({ last_input_at: new Date(AT + 2).toISOString(), last_input_range: { from: 1, through: 2 }, stale: false })
    host.emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } })
    host.emit('compaction/prune', { shadowedTokenCount: 400, shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0] })
    view = await meter.read('meter-test')
    expect(view?.context).toMatchObject({ occupied_tokens: null, stale: true, quality: 'unknown', last_input_tokens: 11 })
    host.emit('request/context', { provider: 'provider-a', model: 'model-a' })
    view = await meter.read('meter-test')
    expect(view?.context).toMatchObject({ capacity_tokens: null, occupied_tokens: null, quality: 'unknown' })
  } finally { host.stop() }
})

it('uses only a fresh DSH context projection for estimated occupancy, never durable billing totals', async () => {
  const host = fixture()
  try {
    host.emit('request/context', { provider: 'provider-a', model: 'model-a', contextWindow: 8192 })
    host.emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] },
      stream: usageChunk({ inputTokens: 11, outputTokens: 3, totalTokens: 14 }),
      usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } })
    const id = SessionId('meter-test')
    const session = Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: AT, isSeeded: false })
    const agents = new Map([[session.id, { id: session.id, session }]])
    host.ctx.reflect.provide('agents', agents as never)
    let projection: unknown = { asOfSeq: 1, values: { contextPressure: { projectedTokens: 128 } } }
    const snapshot = vi.fn(() => projection)
    host.ctx.reflect.provide('sessionProjections', { snapshot } as never)
    const meter = host.make()
    const fresh = await meter.read('meter-test')
    expect(snapshot).toHaveBeenCalledWith(session, ['contextPressure'])
    expect(fresh?.context).toMatchObject({ occupied_tokens: 128, quality: 'estimated', source: 'dsh-token-meter',
      last_input_tokens: 11, capacity_tokens: 8192 })
    expect(fresh?.usage).toMatchObject({ input_tokens: 11, output_tokens: 3, reported_total_tokens: 14, counted_calls: 1 })
    const other = Session.create(id, [], { ...session.header, createdAt: AT + 1 })
    agents.set(id, { id, session: other })
    expect((await meter.read('meter-test'))?.context.occupied_tokens).toBeNull()
    agents.set(id, { id, session })
    projection = { asOfSeq: 0, values: { contextPressure: { projectedTokens: 900 } } }
    expect((await meter.read('meter-test'))?.context).toMatchObject({ occupied_tokens: null, quality: 'unknown', source: 'session-events' })
    projection = { asOfSeq: 1, values: { contextPressure: { projectedTokens: Number.POSITIVE_INFINITY } } }
    expect((await meter.read('meter-test'))?.context.occupied_tokens).toBeNull()
    projection = { asOfSeq: 1, values: { contextPressure: { projectedTokens: -1 } } }
    expect((await meter.read('meter-test'))?.context.occupied_tokens).toBeNull()
    projection = { asOfSeq: 1, values: { contextPressure: { projectedTokens: 0 } } }
    expect((await meter.read('meter-test'))?.context).toMatchObject({ occupied_tokens: 0, quality: 'estimated', source: 'dsh-token-meter' })
    agents.clear()
    expect((await meter.read('meter-test'))?.context).toMatchObject({ occupied_tokens: null, quality: 'unknown', source: 'session-events' })
    agents.set(session.id, { id: session.id, session })
    host.emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } })
    expect((await host.restart().read('meter-test'))?.context).toMatchObject({ occupied_tokens: null, quality: 'unknown' })
  } finally { host.stop() }
})

it('counts each message/stream settlement once and keeps attempt and compaction usage separate', async () => {
  const host = fixture()
  try {
    host.emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2, totalTokens: 19 },
      stream: usageChunk({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2, totalTokens: 19 }) })
    host.emit('assistant/attempt', { turn: 1, step: 1,
      stream: usageChunk({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1, totalTokens: 7 }) })
    host.emit('compaction/summary', { compactionId: 'compaction-1', summary: [], rawOutput: [], llmStreamCall: true,
      shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 500, provider: 'provider-a', model: 'model-a',
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 1, totalTokens: 13 } })
    const view = await host.make().read('meter-test')
    expect(view?.usage).toMatchObject({ input_tokens: 23, cache_read_tokens: 6, cache_write_tokens: 3, output_tokens: 7,
      reasoning_tokens: 4, known_components_total_tokens: 39, reported_total_tokens: 39, reported_total_calls: 3,
      total_complete: true, counted_calls: 3, missing: [], quality: 'measured', billing_status: 'not-final' })
    expect(view?.context.occupied_tokens).toBeNull()
    expect(view?.context.stale).toBe(true)
  } finally { host.stop() }
})

it('retains partial components and authoritative totals without inventing absent buckets', async () => {
  const host = fixture()
  try {
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 12, outputTokens: 5, totalTokens: 20 }) })
    const view = await host.make().read('meter-test')
    expect(view?.usage).toMatchObject({ input_tokens: 12, output_tokens: 5, cache_read_tokens: null, cache_write_tokens: null,
      reasoning_tokens: null, known_components_total_tokens: 17, reported_total_tokens: 20,
      reported_total_calls: 1, total_complete: false, counted_calls: 1, quality: 'partial',
      in_flight: { from: 0, through: 1 } })
  } finally { host.stop() }
})

it('keeps a settled failed attempt in flight across reads and restart, without inventing a second call at step end', async () => {
  const host = fixture()
  try {
    host.emit('step/start', { turn: 1, step: 1 })
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 7, outputTokens: 2, totalTokens: 9 }) })
    const meter = host.make()
    const pending = await meter.read('meter-test')
    expect(pending?.usage).toMatchObject({ counted_calls: 1, reported_total_tokens: 9, in_flight: { from: 1, through: 2 },
      missing: [], quality: 'partial', total_complete: false })
    expect((await meter.read('meter-test'))?.usage.in_flight).toEqual({ from: 1, through: 2 })
    const resumed = host.restart()
    expect((await resumed.read('meter-test'))?.usage.in_flight).toEqual({ from: 1, through: 2 })
    host.emit('step/end', { turn: 1, step: 1 })
    const closed = await resumed.read('meter-test')
    expect(closed?.usage).toMatchObject({ counted_calls: 1, reported_total_tokens: 9, missing: [], in_flight: null,
      quality: 'measured', total_complete: true })
  } finally { host.stop() }
})

it('marks an explicit unsettled retry as a gap across durable log pages', async () => {
  const host = fixture()
  try {
    for (let i = 0; i < 510; i++) host.emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } })
    host.emit('step/start', { turn: 1, step: 1 })
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 7, outputTokens: 2, totalTokens: 9 }) })
    const meter = host.make()
    expect((await meter.read('meter-test'))?.usage.in_flight).toEqual({ from: 511, through: 512 })
    host.emit('llm/retry-started', { retryId: 'retry-a', turn: 1, step: 1, retry: 1 })
    const pending = await meter.read('meter-test')
    expect(pending?.usage).toMatchObject({ counted_calls: 1, in_flight: { from: 512, through: 513 },
      missing: [], quality: 'partial', total_complete: false })
    const resumed = host.restart()
    host.emit('step/end', { turn: 1, step: 1 })
    const closed = await resumed.read('meter-test')
    expect(closed?.usage).toMatchObject({ counted_calls: 1, reported_total_tokens: 9,
      missing: [{ from: 512, through: 514, reason: 'coverage-gap' }], in_flight: null,
      quality: 'partial', total_complete: false })
  } finally { host.stop() }
})

it('counts a retried message and its stream once after settling the failed attempt', async () => {
  const host = fixture()
  try {
    host.emit('step/start', { turn: 1, step: 1 })
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 7, outputTokens: 2, totalTokens: 9 }) })
    host.emit('llm/retry-started', { retryId: 'retry-a', turn: 1, step: 1, retry: 1 })
    host.emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] },
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      stream: usageChunk({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }) })
    const view = await host.make().read('meter-test')
    expect(view?.usage).toMatchObject({ counted_calls: 2, input_tokens: 10, output_tokens: 3, reported_total_tokens: 13,
      reported_total_calls: 2, missing: [], in_flight: null, total_complete: true, quality: 'measured' })
  } finally { host.stop() }
})

it('shows missing settlements and in-flight request spans without fabricating usage', async () => {
  const host = fixture()
  try {
    host.emit('request/header', { header: { config: { model: 'model-a', provider: 'provider-a' } }, reason: 'initial' })
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: [] })
    host.emit('request/header', { header: { config: { model: 'model-a', provider: 'provider-a' } }, reason: 'series' })
    const meter = host.make()
    let view = await meter.read('meter-test')
    expect(view?.usage).toMatchObject({ input_tokens: null, output_tokens: null, known_components_total_tokens: null, reported_total_tokens: null,
      counted_calls: 0, missing: [{ from: 1, through: 2, reason: 'no-usage' }], in_flight: { from: 2, through: 3 }, quality: 'unknown' })
    host.emit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    view = await meter.read('meter-test')
    expect(view?.usage.missing).toContainEqual({ from: 2, through: 4, reason: 'coverage-gap' })
    expect(view?.usage.in_flight).toBeNull()
  } finally { host.stop() }
})
it('marks a summary without usage as unknown instead of treating shadowed tokens as usage', async () => {
  const host = fixture()
  try {
    host.emit('compaction/start', { compactionId: 'summarize-1', turn: null })
    host.emit('compaction/summary', { compactionId: 'summarize-1', summary: [], rawOutput: [], llmStreamCall: true,
      shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 600, provider: 'provider-a', model: 'model-a' })
    host.emit('compaction/end', { compactionId: 'summarize-1', turn: null })
    const view = await host.make().read('meter-test')
    expect(view?.usage).toMatchObject({ counted_calls: 0, input_tokens: null, reported_total_tokens: null,
      missing: [{ from: 1, through: 2, reason: 'no-usage' }], in_flight: null, quality: 'unknown' })
    expect(view?.context.occupied_tokens).toBeNull()
  } finally { host.stop() }
})

it('keeps the child creation clock when a fork has only inherited events', async () => {
  const parent = Session.create(SessionId('parent-only'))
  const history = [parent.append('turn/start', { turn: 1 }), parent.append('step/start', { turn: 1, step: 1 }),
    parent.append('request/context', { provider: 'parent-provider', model: 'parent-model', contextWindow: 16384 }),
    parent.append('request/header', { header: { config: { provider: 'parent-provider', model: 'parent-model' } }, reason: 'initial' }),
    parent.append('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 40, outputTokens: 5, totalTokens: 45 }) })]
  const host = fixture('inherited-only', history.length)
  try {
    host.settled.push(...history)
    const expected = new Date(AT).toISOString()
    const view = await host.make().read('inherited-only')
    expect(view).toMatchObject({ inherited_events: history.length, cursor: history.length,
      context: { model: 'parent-model', provider: 'parent-provider', capacity_tokens: 16384,
        sampled_at: expected, range: { from: history.length, through: history.length }, last_input_tokens: null,
        last_input_at: null, last_input_range: null, occupied_tokens: null, quality: 'unknown' },
      usage: { sampled_at: expected, range: { from: history.length, through: history.length },
        counted_calls: 0, reported_total_tokens: null, missing: [], in_flight: null, quality: 'unknown' } })
    expect((await host.restart().read('inherited-only'))?.usage.sampled_at).toBe(expected)
  } finally { host.stop() }
})

it('excludes a real fork-inherited prefix, then survives replay, restart, and concurrent readers', async () => {
  const parent = Session.create(SessionId('parent-meter'))
  const inherited = [parent.append('turn/start', { turn: 1 }), parent.append('step/start', { turn: 1, step: 1 }),
    parent.append('request/context', { provider: 'parent-provider', model: 'parent-model', contextWindow: 32768 }),
    parent.append('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 40, outputTokens: 5, totalTokens: 45 }) }),
    parent.append('step/end', { turn: 1, step: 1 }), parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })]
  const seed = buildForkSeed(inherited, SessionSeq(inherited.length - 1))
  const id = SessionId('forked-meter')
  const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: AT, parentSession: parent.id, isSeeded: true }
  const child = Session.create(id, seed, header, SessionLogOffset(inherited.length))
  const own = [child.append('turn/start', { turn: 2 }), child.append('step/start', { turn: 2, step: 1 }),
    child.append('assistant/attempt', { turn: 2, step: 1, stream: usageChunk({ inputTokens: 6, outputTokens: 2, totalTokens: 8 }) })]
  const host = fixture(id, child.inheritedEventCount)
  try {
    host.settled.push(...seed, ...own)
    const first = await host.make().read(id)
    expect(first).toMatchObject({ inherited_events: inherited.length, cursor: seed.length + own.length,
      context: { model: 'parent-model', provider: 'parent-provider', capacity_tokens: 32768, last_input_tokens: 6 },
      usage: { input_tokens: 6, output_tokens: 2, reported_total_tokens: 8, counted_calls: 1 } })
    const resumed = host.restart()
    const [again, concurrently] = await Promise.all([resumed.read(id), resumed.read(id)])
    expect(again?.usage.counted_calls).toBe(1)
    expect(concurrently?.usage.reported_total_tokens).toBe(8)
    const boundary = host.emit('assistant/attempt', { turn: 2, step: 1, stream: usageChunk({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }) })
    expect(boundary.seq).toBe(first?.cursor)
    const [updated, same] = await Promise.all([resumed.read(id), resumed.read(id)])
    expect(updated?.usage.reported_total_tokens).toBe(12)
    expect(same?.usage.counted_calls).toBe(2)
    expect((await resumed.read(id))?.usage.reported_total_tokens).toBe(12)
  } finally { host.stop() }
})

it('counts both same-name logs from their own boundaries without double-counting overlapping reads or replay', async () => {
  const host = fixture()
  const id = 'meter-test', recreatedAt = AT + 1000
  try {
    host.emit('request/context', { provider: 'old-provider', model: 'old-model', contextWindow: 8192 })
    host.emit('assistant/message', { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } })
    host.emit('assistant/attempt', { stream: [] })
    host.emit('step/end', { turn: 1, step: 1 })
    const oldLog = host.settled
    const meter = host.make()
    expect(await meter.read(id)).toMatchObject({ cursor: 4, usage: { counted_calls: 1, reported_total_tokens: 10 } })

    host.useLog(recreatedAt, 2)
    host.emit('request/context', { provider: 'new-provider', model: 'new-model', contextWindow: 16384 })
    host.emit('assistant/message', { usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 } })
    host.emit('assistant/message', { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
    host.flush.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('recreated log durability failed'))
    await expect(meter.read(id)).rejects.toThrow('recreated log durability failed')
    const expected = { inherited_events: 2, cursor: 3,
      context: { provider: 'new-provider', model: 'new-model', last_input_tokens: 3, range: { from: 2, through: 3 } },
      usage: { input_tokens: 10, output_tokens: 5, counted_calls: 2, reported_total_calls: 2, reported_total_tokens: 15,
        total_complete: false, quality: 'partial', range: { from: 2, through: 3 }, in_flight: null, missing: [],
        logs: [
          { created_at: new Date(AT).toISOString(), sampled_at: new Date(AT + 4).toISOString(), status: 'unavailable',
            range: { from: 0, through: 4 }, missing: [{ from: 2, through: 3, reason: 'no-usage' }], in_flight: null },
          { created_at: new Date(recreatedAt).toISOString(), sampled_at: new Date(recreatedAt + 3).toISOString(), status: 'current',
            range: { from: 2, through: 3 }, missing: [], in_flight: null },
        ] } }
    expect(await Promise.all([meter.read(id), host.make().read(id)])).toMatchObject([expected, expected])
    const newLog = host.settled
    const restarted = host.restart()
    expect(await restarted.read(id)).toMatchObject(expected)
    host.useLog(AT, 0, oldLog)
    expect(await restarted.read(id)).toMatchObject(expected)
    host.useLog(recreatedAt, 2, newLog)
    expect(await restarted.read(id)).toMatchObject(expected)
  } finally { host.stop() }
})

it('adds a late old-handle observation without replacing the newer log context', async () => {
  const host = fixture()
  const id = 'meter-test', recreatedAt = AT + 1000
  try {
    const meter = host.make()
    host.emit('assistant/message', { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } })
    expect(await meter.read(id)).toMatchObject({ cursor: 1, usage: { reported_total_tokens: 10 } })
    host.emit('assistant/attempt', { stream: usageChunk({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }) })

    const open = host.open.getMockImplementation()!
    const opened = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>()
    host.open.mockImplementationOnce(async sessionId => {
      const handle = await open(sessionId)
      opened.resolve()
      await resumed.promise
      return handle
    })
    const late = meter.read(id)
    await opened.promise
    let oldHandleView: Awaited<typeof late>
    try {
      host.useLog(recreatedAt)
      host.emit('assistant/message', { usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } })
      expect(await host.make().read(id)).toMatchObject({ cursor: 1, usage: { counted_calls: 2, reported_total_tokens: 15 } })
    } finally {
      resumed.resolve()
      oldHandleView = await late
    }
    const expected = { cursor: 1, context: { last_input_tokens: 4 }, usage: {
      counted_calls: 3, reported_total_tokens: 19, in_flight: null,
      logs: [
        { status: 'unavailable', range: { from: 0, through: 2 }, in_flight: { from: 1, through: 2 } },
        { status: 'current', range: { from: 0, through: 1 }, in_flight: null },
      ] } }
    expect(oldHandleView).toMatchObject(expected)
    expect(await host.restart().read(id)).toMatchObject(expected)
  } finally { host.stop() }
})

it('rejects a changed fork cut for the same log identity without advancing its cursor', async () => {
  const host = fixture()
  try {
    const id = 'meter-test', meter = host.make()
    host.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    expect(await meter.read(id)).toMatchObject({ cursor: 1, usage: { reported_total_tokens: 2 } })
    const log = host.settled
    host.useLog(AT, 1, log)
    await expect(meter.read(id)).rejects.toThrow('fork cut changed')
    host.useLog(AT, 0, log)
    expect(await meter.read(id)).toMatchObject({ cursor: 1, usage: { counted_calls: 1, reported_total_tokens: 2 } })
  } finally { host.stop() }
})

it('resumes a matching legacy cursor but refuses to assign it to a different observed prefix', async () => {
  const host = fixture()
  try {
    const id = 'meter-test', meter = host.make()
    host.emit('assistant/message', { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } })
    const first = await meter.read(id)
    const legacy = { view: first!, compaction_from: null }
    host.store.set(KV.meter.state(id), legacy)
    const original = host.settled
    host.useLog(AT + 1000)
    host.emit('assistant/message', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })
    await expect(meter.read(id)).rejects.toThrow('legacy meter cursor')
    host.useLog(AT, 0, original)
    host.emit('assistant/message', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } })
    expect(await host.restart().read(id)).toMatchObject({ cursor: 2,
      usage: { counted_calls: 2, reported_total_tokens: 7, total_complete: true } })
  } finally { host.stop() }
})

it('flushes attached events before advancing the durable cursor and reports the exact persisted range', async () => {
  const host = fixture()
  try {
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }) }, true)
    const view = await host.make().read('meter-test')
    expect(host.flush).toHaveBeenCalledTimes(2)
    expect(view?.cursor).toBe(1)
    expect(view?.usage).toMatchObject({ range: { from: 0, through: 1 }, reported_total_tokens: 3 })
    expect(host.pending).toHaveLength(0)
    expect(host.closeHandle).toHaveBeenCalledOnce()
  } finally { host.stop() }
})

it('does not commit accepted but unflushed events when a durability barrier fails', async () => {
  const host = fixture()
  try {
    host.emit('assistant/attempt', { turn: 1, step: 1, stream: usageChunk({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }) }, true)
    host.flush.mockImplementationOnce(async () => { host.settled.push(...host.pending.splice(0)) })
      .mockImplementationOnce(async () => { host.pending.push(...host.settled.splice(0)); throw new Error('durability failed') })
      .mockImplementationOnce(async () => {})
    const meter = host.make()
    await expect(meter.read('meter-test')).rejects.toThrow('durability failed')
    const stillUnflushed = await meter.read('meter-test')
    expect(stillUnflushed).toMatchObject({ cursor: 0, usage: { reported_total_tokens: null, counted_calls: 0 } })
    const durable = await meter.read('meter-test')
    expect(durable).toMatchObject({ cursor: 1, usage: { reported_total_tokens: 3, counted_calls: 1 } })
  } finally { host.stop() }
})
