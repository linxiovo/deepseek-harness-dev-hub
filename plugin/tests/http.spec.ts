import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import type { SessionMeterView } from '../src/app/session-meter.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import type { Ticket } from '../src/core/index.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('shows a Ticket\'s verified worktree facts and writer, and a rejected preparation reason', async () => {
  const at = '2026-09-22T00:00:00Z'
  const ticket = (id: string, execution: NonNullable<Ticket['execution']>): Ticket => ({ id, title: id, decisionId: `d-${id}`,
    channels: [], inputs: [], undelivered: [],
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
    assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at }],
    createdAt: at, updatedAt: at, origin: { triggerId: 'e1', triggerIds: ['e1'] }, execution })
  const base = { ref: 'refs/heads/main', sha: '0123456789abcdef0123456789abcdef01234567' }
  const tickets: Record<string, Ticket> = {
    t1: ticket('t1', { name: 'fix-regression', directory: '/srv/worktrees/fix-regression', assignment: 'Fix regression',
      repository: '/srv/widgets', worktree: '/srv/worktrees/fix-regression', branch: 'agent/fix-regression', base,
      session: 'actual-session-19', active_writer: { assignment: 'a1', session: 'actual-session-19' },
      preparation: { state: 'verified' } }),
    t2: ticket('t2', { name: 'fix-other', directory: '/srv/worktrees/fix-other', assignment: 'Fix other',
      repository: '/srv/widgets', worktree: '/srv/worktrees/fix-other', branch: 'agent/fix-other', base,
      active_writer: null, preparation: { state: 'rejected', reason: 'Another Ticket owns this worktree; nothing was changed.' } }),
  }
  const call = serve({
    store: { tickets: { get: (id: string) => tickets[id] }, decisions: { get: () => undefined }, triggers: { get: () => undefined },
      settings: () => SettingsSchema.parse({}), read: { subscribedThreads: () => [] } },
    sources: { kind: () => undefined }, links: () => () => ({ url: '', label: { zh: '', en: '' } }), configured: () => false,
  })
  expect(await call('GET', 'tickets/t1')).toMatchObject({ status: 200, body: { sessionId: 'actual-session-19', execution: {
    repository: '/srv/widgets', worktree: '/srv/worktrees/fix-regression', branch: 'agent/fix-regression', base,
    session: 'actual-session-19', active_writer: { assignment: 'a1', session: 'actual-session-19' },
    preparation: { state: 'verified' } } } })
  expect(await call('GET', 'tickets/t2')).toMatchObject({ status: 200, body: { execution: {
    repository: '/srv/widgets', worktree: '/srv/worktrees/fix-other', branch: 'agent/fix-other', base,
    active_writer: null, preparation: { state: 'rejected', reason: 'Another Ticket owns this worktree; nothing was changed.' } } } })
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('answers the Session meter view the Hub reads, decoded from the path, and 404 for an unknown Session', async () => {
  const range = { from: 1, through: 9 }
  const view: SessionMeterView = { session_id: 'worker/a b', inherited_events: 3, cursor: 9,
    context: { model: 'worker-model', provider: 'host', capacity_tokens: 128_000, occupied_tokens: 4_096, quality: 'measured',
      source: 'session-events', sampled_at: '2026-11-18T00:00:00.000Z', range, last_input_tokens: 12_000,
      last_input_at: '2026-11-18T00:00:00.000Z', last_input_range: range, stale: false },
    usage: { input_tokens: 10, cache_read_tokens: 2, cache_write_tokens: 0, output_tokens: 3, reasoning_tokens: 0,
      known_components_total_tokens: 15, reported_total_tokens: 15, reported_total_calls: 1, total_complete: true,
      counted_calls: 1, missing: [], in_flight: null, range, sampled_at: '2026-11-18T00:00:00.000Z', source: 'session-events',
      quality: 'measured', billing_status: 'not-final' } }
  const asked: string[] = []
  const read = async (id: string): Promise<SessionMeterView | undefined> => {
    asked.push(id); return id === view.session_id ? view : undefined
  }
  const call = serve({ meter: { read } })
  expect(await call('GET', `sessions/${encodeURIComponent(view.session_id)}/meter`)).toEqual({ status: 200, body: view })
  expect(asked).toEqual([view.session_id])
  expect(await call('GET', 'sessions/worker-t9/meter')).toEqual({ status: 404, body: { error: 'Session not found' } })
  expect(asked).toEqual([view.session_id, 'worker-t9'])
  // The meter route keeps the panel's same-origin protection.
  expect(await call('GET', `sessions/${encodeURIComponent(view.session_id)}/meter`, undefined, { 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  expect(asked).toEqual([view.session_id, 'worker-t9'])
})

it('answers a corrupt Session log with 500 instead of claiming the Session is missing', async () => {
  const read = async (id: string): Promise<SessionMeterView | undefined> => {
    throw new Error(`Session log for ${id} is corrupt`)
  }
  const call = serve({ meter: { read } })
  expect(await call('GET', 'sessions/worker-t1/meter'))
    .toEqual({ status: 500, body: { error: 'Session log for worker-t1 is corrupt' } })
})
