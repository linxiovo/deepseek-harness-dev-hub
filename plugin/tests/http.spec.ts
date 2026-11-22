import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { PlanIntegrationView } from '../src/core/plan-integration.ts'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import type { SessionMeterView } from '../src/app/session-meter.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { InstallationError, type InstallationApi, type RuntimeView } from '../src/app/installation-api.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import type { Ticket } from '../src/core/index.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Minimal ServerResponse-shaped stream for the management router's JSON and binary outputs. */
class TestResponse extends PassThrough {
  headersSent = false
  constructor(private readonly recordHeaders: (code: number, headers: Record<string, unknown>) => void) { super() }
  writeHead(code: number, headers: Record<string, unknown> = {}) {
    this.recordHeaders(code, headers)
    this.headersSent = true
    return this
  }
}
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}, beforeBody?: () => Promise<void>) => {
    let status = 0, responseHeaders: Record<string, unknown> = {}
    const output: Buffer[] = []
    const response = new TestResponse((code, fields) => { status = code; responseHeaders = fields })
    response.on('data', chunk => output.push(Buffer.from(chunk)))
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() {
      if (beforeBody) await beforeBody()
      yield* chunks
    } }
    const complete = finished(response)
    await handler(req, response)
    await complete
    const bytes = Buffer.concat(output), text = bytes.toString('utf8')
    let result: unknown
    try { result = JSON.parse(text) as unknown } catch { result = bytes }
    return { status, body: result, ...(responseHeaders['content-disposition'] ? { headers: responseHeaders } : {}) }
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

it('serves stored Plan delivery only within the required project scope', async () => {
  const view: PlanIntegrationView = { planId: 'plan-a', status: 'delivered',
    version: { repository: 'org/repo', ref: 'refs/heads/main', sha: 'a'.repeat(40), context: 'b'.repeat(64),
      workflowId: 'ci.yml', configuration: 'Release', environment: 'production' },
    run: { id: 17, attempt: 1, url: 'https://github.com/org/repo/actions/runs/17', checks: [] },
    artifact: { id: 5, name: 'release', url: 'https://github.com/org/repo/actions/runs/17/artifacts/5',
      fileName: 'release.tgz', contentType: 'application/gzip', size: 12, sha256: 'c'.repeat(64) }, verifiedAt: '2026-11-22T12:00:00.000Z' }
  const lookedUp: string[] = []
  const call = serve({ installation: bindingInstallation(),
    planIntegration: { view: (id: string) => { lookedUp.push(id); return id === view.planId ? view : undefined } } })
  expect(await call('GET', 'plans/plan-a/delivery', undefined, projectHeader(alpha.id)))
    .toEqual({ status: 200, body: view })
  expect(lookedUp).toEqual(['plan-a'])
  expect(await call('GET', 'plans/plan-a/delivery')).toEqual({ status: 409, body: expect.objectContaining({ code: 'projectScopeRequired' }) })
  expect(await call('GET', 'plans/plan-a/delivery', undefined, projectHeader(beta.id)))
    .toEqual({ status: 409, body: { error: 'The request does not target the mounted project.', code: 'staleProject' } })
  expect(await call('GET', 'plans/plan-a/delivery?refresh=1', undefined, projectHeader(alpha.id)))
    .toEqual({ status: 400, body: { error: 'Invalid plan delivery query' } })
  expect(await call('GET', 'plans/unknown/delivery', undefined, projectHeader(alpha.id)))
    .toEqual({ status: 404, body: { error: 'Unknown Plan unknown', code: 'unknownPlan', values: { id: 'unknown' } } })
  expect(await call('GET', 'plans/plan-a/delivery', undefined,
    { ...projectHeader(alpha.id), 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  expect(lookedUp).toEqual(['plan-a', 'unknown'])
})

it('returns the established unknown-plan refusal when plan integration is unavailable', async () => {
  const call = serve({ installation: bindingInstallation() })
  expect(await call('GET', 'plans/plan-a/delivery', undefined, projectHeader(alpha.id)))
    .toEqual({ status: 404, body: { error: 'Unknown Plan plan-a', code: 'unknownPlan', values: { id: 'plan-a' } } })
})

it('streams a verified executable with its declared media type to the selected project', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-http-artifact-'))
  const bytes = Buffer.from('verified package')
  const path = join(directory, 'worker.exe')
  writeFileSync(path, bytes)
  const call = serve({ installation: bindingInstallation(), planArtifact: async (id: string) => id === 'plan-a'
    ? { path, fileName: 'worker.exe', contentType: 'application/vnd.microsoft.portable-executable', size: bytes.length, sha256: 'c'.repeat(64) } : undefined })
  try {
    expect(await call('GET', 'plans/plan-a/artifact', undefined, projectHeader(alpha.id))).toEqual({ status: 200, body: bytes,
      headers: { 'content-type': 'application/vnd.microsoft.portable-executable', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-length': bytes.length, 'content-disposition': 'attachment; filename="worker.exe"', 'x-artifact-sha256': 'c'.repeat(64) } })
    expect(await call('GET', 'plans/plan-a/artifact', undefined, projectHeader(beta.id)))
      .toMatchObject({ status: 409, body: { code: 'staleProject' } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('returns the localized missing-artifact refusal under the selected project', async () => {
  const call = serve({ installation: bindingInstallation(), planIntegration: { view: () => undefined }, planArtifact: async () => undefined })
  expect(await call('GET', 'plans/plan-a/artifact', undefined, projectHeader(alpha.id)))
    .toEqual({ status: 404, body: { error: 'Verified Plan artifact plan-a is unavailable', code: 'planArtifactUnavailable', values: { id: 'plan-a' } } })
})
it('answers a corrupt Session log with 500 instead of claiming the Session is missing', async () => {
  const read = async (id: string): Promise<SessionMeterView | undefined> => {
    throw new Error(`Session log for ${id} is corrupt`)
  }
  const call = serve({ meter: { read } })
  expect(await call('GET', 'sessions/worker-t1/meter'))
    .toEqual({ status: 500, body: { error: 'Session log for worker-t1 is corrupt' } })
})

it('reports lifecycle status while startup is pending, and recovery once ready', async () => {
  let finishStartup!: () => void
  const ready = new Promise<void>(resolve => { finishStartup = resolve })
  const starting: RuntimeView = { mode: 'desktop', status: 'starting', reason: null, projectId: 'alpha', resumedFrom: null }
  const running: RuntimeView = { ...starting, status: 'ready', resumedFrom: { reason: 'projectSwitched', at: '2026-11-18T00:00:00.000Z',
    recoverable: { assignments: 2, handoffs: 1, effects: 3 } } }
  let view: RuntimeView = starting
  const call = serve({ ready, installation: { runtime: () => view } })
  try {
    const result = await Promise.race([call('GET', 'runtime'), new Promise(resolve => setImmediate(() => resolve('waiting for startup')))])
    expect(result).toEqual({ status: 200, body: starting })
  } finally { finishStartup() }
  view = running
  expect(await call('GET', 'runtime')).toEqual({ status: 200, body: running })
  view = { ...running, status: 'paused', reason: 'recoveryPending' }
  expect(await call('GET', 'runtime')).toEqual({ status: 200, body: view })
})

const idleRuntime = (): RuntimeView => ({ mode: 'desktop', status: 'paused', reason: 'noProject', projectId: null, resumedFrom: null })

it('lets the panel verify GitHub and create or select projects without returning private service fields', async () => {
  const identity = { id: 12, login: 'agent', noreply: '12+agent@users.noreply.github.com' }
  const project = { id: 'repo/local', repository: 'org/repo', workspace: 'D:/repos/repo', hubSessionId: 'hub-1' }
  const privateProject = { ...project, credential: 'private' }
  const installation: InstallationApi = {
    onboarding: () => ({ status: 'unconfigured' }),
    runtime: idleRuntime,
    verifyGithub: ({ cli }) => cli === 'gh-agent'
      ? { status: 'ready', identity: Object.assign({ ...identity }, { cli }) }
      : { status: 'blocked', problem: new SetupError('agentCliSignedOut', { output: 'token=private' }).problem },
    projects: () => ({ activeProjectId: null, projects: [privateProject] }),
    createProject: input => {
      expect(input).toEqual({ repository: 'org/repo', workspace: 'D:/repos/repo', baseRef: 'main', policy: { rules: [], sources: {} } })
      return { project: privateProject, reused: false, restarting: true }
    },
    selectProject: id => {
      if (id !== project.id) throw new InstallationError(404, 'projectNotFound')
      return { project: privateProject, restarting: true }
    },
  }
  const call = serve({ installation })
  expect(await call('GET', 'onboarding')).toEqual({ status: 200, body: { status: 'unconfigured' } })
  expect(await call('POST', 'onboarding/github/verify', { cli: 'gh-agent' })).toEqual({ status: 200, body: { status: 'ready', identity } })
  expect(await call('POST', 'onboarding/github/verify', { cli: 'bad' })).toEqual({ status: 200, body: { status: 'blocked',
    problem: { place: 'github', code: 'agentCliSignedOut', values: {}, detail: 'The agent GitHub CLI cannot read its account.' } } })
  expect(await call('GET', 'projects')).toEqual({ status: 200, body: { activeProjectId: null, projects: [project] } })
  expect(await call('POST', 'projects/other/select')).toMatchObject({ status: 404, body: { code: 'projectNotFound' } })
  expect(await call('POST', 'projects', { repository: 'org/repo', workspace: 'D:/repos/repo', baseRef: 'main', policy: { rules: [] } }))
    .toEqual({ status: 200, body: { project, reused: false, restarting: true } })
  expect(await call('POST', 'projects', { repository: 'org/repo', workspace: 'D:/repos/repo' }))
    .toMatchObject({ status: 400, body: { code: 'invalidRequest' } })
  const callNewMount = serve({ installation })
  expect(await callNewMount('POST', 'projects/repo%2Flocal/select')).toEqual({ status: 200, body: { project, restarting: true } })
  expect(await call('POST', 'projects/repo%2Flocal/select', undefined, { origin: 'http://evil.example' })).toMatchObject({ status: 403 })
})

it('hides unexpected onboarding failures and reports an unavailable installation explicitly', async () => {
  const call = serve({ installation: { runtime: idleRuntime, verifyGithub: () => { throw new Error('token=private') } } })
  expect(await call('POST', 'onboarding/github/verify', { cli: 'gh' })).toEqual({ status: 500, body: { error: 'Installation operation failed.' } })
  expect(await serve({})('GET', 'projects')).toMatchObject({ status: 404, body: { code: 'installationUnavailable' } })
})

const projectHeader = (id: string) => ({ 'x-orchestrator-project-id': id })
const alpha = { id: 'alpha', repository: 'org/alpha', workspace: 'D:/repos/alpha', hubSessionId: 'hub-alpha' }
const beta = { id: 'beta', repository: 'org/beta', workspace: 'D:/repos/beta', hubSessionId: 'hub-beta' }
const bindingInstallation = (activeProjectId: () => string = () => alpha.id) => ({
  projects: () => ({ activeProjectId: activeProjectId(), projects: [alpha, beta] }),
  runtime: (): RuntimeView => ({ mode: 'desktop', status: 'ready', reason: null, projectId: activeProjectId(), resumedFrom: null }),
})

it('rejects a topic binding when the project changes before the request body finishes', async () => {
  let activeProjectId = alpha.id
  const binds: unknown[] = []
  const call = serve({
    installation: bindingInstallation(() => activeProjectId),
    topicBinding: { bind: (...args: unknown[]) => { binds.push(args) } },
  })
  const result = await call('POST', 'topic-binding', { triggerId: 'e1', allowedActors: ['ou_alice'] }, projectHeader(alpha.id), async () => {
    activeProjectId = beta.id
  })
  expect(result).toMatchObject({ status: 409, body: { code: 'staleProject' } })
  expect(binds).toEqual([])
})

it('reads, binds, and unbinds only within the trusted mounted project', async () => {
  const topic = { projectId: alpha.id, epoch: 'binding-1', boundAt: '2026-11-18T00:00:00Z', triggerId: 'e1', chatId: 'oc_team',
    rootId: 'om_topic', direct: false, allowedActors: ['ou_alice'] }
  let current: typeof topic | null = null
  const topicBinding: NonNullable<HttpHost['topicBinding']> = {
    view: () => current,
    bind: (triggerId, allowedActors) => {
      expect({ triggerId, allowedActors }).toEqual({ triggerId: 'e1', allowedActors: ['ou_alice'] })
      return current = topic
    },
    unbind: () => current = null,
  }
  const call = serve({ installation: bindingInstallation(), topicBinding })
  const headers = projectHeader(alpha.id)
  const body = { triggerId: 'e1', allowedActors: ['ou_alice'] }
  expect(await call('GET', 'topic-binding', undefined, headers)).toEqual({ status: 200, body: null })
  expect(await call('POST', 'topic-binding', body, { ...headers, origin: 'http://untrusted.example' })).toMatchObject({ status: 403 })
  expect(await call('POST', 'topic-binding', body)).toMatchObject({ status: 409, body: { code: 'projectScopeRequired' } })
  expect(await call('POST', 'topic-binding', body, headers)).toEqual({ status: 200, body: topic })
  expect(await call('GET', 'topic-binding')).toMatchObject({ status: 409, body: { code: 'projectScopeRequired' } })
  expect(await call('GET', 'topic-binding', undefined, projectHeader(beta.id))).toMatchObject({ status: 409, body: { code: 'staleProject' } })
  expect(await call('POST', 'topic-binding/unbind', undefined, projectHeader(beta.id)))
    .toMatchObject({ status: 409, body: { code: 'staleProject' } })
  expect(await call('GET', 'topic-binding', undefined, headers)).toEqual({ status: 200, body: topic })
  expect(await call('POST', 'topic-binding/unbind', undefined, headers)).toEqual({ status: 200, body: null })
  expect(await call('GET', 'topic-binding', undefined, headers)).toEqual({ status: 200, body: null })
})

it('refuses caller-supplied destinations and implicit or invalid Feishu actor grants', async () => {
  let bound = false
  const call = serve({
    installation: bindingInstallation(),
    topicBinding: { bind: () => { bound = true; return null } },
  })
  const body = { triggerId: 'e1', allowedActors: ['ou_alice'] }
  for (const invalid of [{ ...body, chatId: 'oc_other' }, { ...body, rootId: 'om_other' }, { ...body, actor: 'ou_bob' },
    { triggerId: 'e1' }, { ...body, allowedActors: ['*'] }, { ...body, allowedActors: ['oc_team'] }]) {
    expect(await call('POST', 'topic-binding', invalid, projectHeader(alpha.id))).toEqual({ status: 400,
      body: { error: 'Invalid topic binding request' } })
  }
  expect(bound).toBe(false)
})

it('rechecks topic binding scope at mutation after asynchronous project verification', async () => {
  let activeProjectId = alpha.id, bound = false
  const call = serve({
    installation: bindingInstallation(() => activeProjectId),
    verifyTopicBinding: async () => { activeProjectId = beta.id },
    topicBinding: { bind: () => { bound = true; return null } },
  })
  const result = await call('POST', 'topic-binding', { triggerId: 'e1', allowedActors: ['ou_alice'] }, projectHeader(alpha.id))
  expect(result).toMatchObject({ status: 409, body: { code: 'staleProject' } })
  expect(bound).toBe(false)
})

it('fences project writes and blocks new work without blocking a scoped pause change', async () => {
  let setupReady = false, retries = 0, requeues = 0
  const call = serve({
    installation: { projects: () => ({ activeProjectId: alpha.id, projects: [alpha] }), runtime: () => ({ reason: null }) },
    assertNewWork: () => { if (!setupReady) throw new InstallationError(409, 'projectSetupRequired') },
    store: { tickets: { get: () => ({}) } },
    engine: { retryTicket: () => { retries++ }, reevaluate: () => { requeues++; return true } },
    requestPass: () => {}, settings: { pause: (paused: boolean) => ({ paused }) },
  })
  expect(await call('POST', 'tickets/t1/retry')).toMatchObject({ status: 409, body: { code: 'projectScopeRequired' } })
  expect(await call('POST', 'triggers/e1/requeue', undefined, projectHeader(beta.id))).toMatchObject({ status: 409, body: { code: 'staleProject' } })
  for (const path of ['tickets/t1/retry', 'triggers/e1/requeue']) {
    expect(await call('POST', path, undefined, projectHeader(alpha.id))).toMatchObject({ status: 409, body: { code: 'projectSetupRequired' } })
  }
  expect([retries, requeues]).toEqual([0, 0])
  expect(await call('POST', 'executor/pause', { paused: false }, projectHeader(alpha.id))).toEqual({ status: 200, body: { paused: false } })

  setupReady = true
  expect(await call('POST', 'tickets/t1/retry', undefined, projectHeader(alpha.id))).toEqual({ status: 200, body: { retried: true } })
  expect(await call('POST', 'triggers/e1/requeue', undefined, projectHeader(alpha.id))).toEqual({ status: 200, body: { queued: true } })
  expect([retries, requeues]).toEqual([1, 1])
})

it('rejects a body-bearing project mutation whose mounted runtime starts switching during parsing', async () => {
  const bodyStarted = Promise.withResolvers<void>(), sendBody = Promise.withResolvers<void>()
  let switching = false, paused = false
  const call = serve({
    installation: { projects: () => ({ activeProjectId: alpha.id, projects: [alpha, beta] }),
      runtime: () => ({ reason: switching ? 'switching' : null }),
      selectProject: () => { switching = true; return { project: beta, restarting: true } } },
    settings: { pause: (value: boolean) => ({ paused: paused = value }) },
  })
  expect(await call('POST', 'projects/beta/select', undefined, projectHeader(beta.id)))
    .toMatchObject({ status: 409, body: { code: 'staleProject' } })
  const pending = call('POST', 'executor/pause', { paused: true }, projectHeader(alpha.id), () => {
    bodyStarted.resolve(); return sendBody.promise
  })
  await bodyStarted.promise
  try { expect(await call('POST', 'projects/beta/select')).toEqual({ status: 200, body: { project: beta, restarting: true } }) }
  finally { sendBody.resolve() }
  expect(await pending).toMatchObject({ status: 409, body: { code: 'switching' } })
  expect(paused).toBe(false)
})

it('does not start a project switch during an asynchronous project write or admit a write during selection', async () => {
  const writeStarted = Promise.withResolvers<void>(), finishWrite = Promise.withResolvers<void>()
  const selectStarted = Promise.withResolvers<void>(), finishSelect = Promise.withResolvers<void>()
  let retries = 0
  const call = serve({
    installation: { projects: () => ({ activeProjectId: alpha.id, projects: [alpha, beta] }), runtime: () => ({ reason: null }),
      selectProject: async () => { selectStarted.resolve(); await finishSelect.promise; return { project: beta, restarting: true } } },
    store: { tickets: { get: () => ({}) } }, engine: { retryTicket: () => { retries++ } },
    settings: { pause: async (paused: boolean) => { writeStarted.resolve(); await finishWrite.promise; return { paused } } },
  })
  const write = call('POST', 'executor/pause', { paused: true }, projectHeader(alpha.id))
  await writeStarted.promise
  const selectionDuringWrite = call('POST', 'projects/beta/select')
  try {
    const result = await Promise.race([selectionDuringWrite, new Promise(resolve => setImmediate(() => resolve('waiting for write')))])
    expect(result).toMatchObject({ status: 409, body: { code: 'projectConflict' } })
  } finally { finishWrite.resolve() }
  expect(await write).toEqual({ status: 200, body: { paused: true } })

  const select = call('POST', 'projects/beta/select')
  await selectStarted.promise
  try {
    expect(await call('POST', 'tickets/t1/retry', undefined, projectHeader(alpha.id)))
      .toMatchObject({ status: 409, body: { code: 'switching' } })
    expect(retries).toBe(0)
  } finally { finishSelect.resolve() }
  expect(await select).toEqual({ status: 200, body: { project: beta, restarting: true } })
})

it('fences executor settings from the old mount during selection and after recovery with the same block revision', async () => {
  const revision = 4
  const value = (projectTokens: number) => SettingsSchema.parse({ executor: { runLimits: { projectTokens } } }).executor
  const saves: unknown[] = []
  const settingsHost = (projectTokens: number) => ({
    store: { settings: () => SettingsSchema.parse({ executor: value(projectTokens) }), blockRevision: () => revision },
    sources: { instances: () => [], environments: () => [], declarations: () => [] },
    machine: { stateDir: 'D:/state' }, configured: () => false,
    settings: { save: (...args: unknown[]) => { saves.push(args); return { saved: true, revision: revision + 1, restarting: false } } },
  })
  const expectedBlock = (projectTokens: number) => ({ status: 200, body: { blocks: { executor: { revision, value: value(projectTokens) } } } })
  const unmounted = serve({ ...settingsHost(300), installation: {
    projects: () => ({ activeProjectId: null, projects: [] }), runtime: idleRuntime,
  } })
  expect(await unmounted('GET', 'settings')).toMatchObject(expectedBlock(300))

  const selectionStarted = Promise.withResolvers<void>(), finishSelection = Promise.withResolvers<void>()
  const bodyStarted = Promise.withResolvers<void>(), finishBody = Promise.withResolvers<void>()
  const oldMount = serve({ ...settingsHost(100), installation: { ...bindingInstallation(), selectProject: async () => {
    selectionStarted.resolve()
    await finishSelection.promise
    return { project: beta, restarting: true }
  } } })
  const oldScope = projectHeader(alpha.id)
  expect(await oldMount('GET', 'settings', undefined, oldScope)).toMatchObject(expectedBlock(100))
  const update = { revision, value: value(101) }
  const pending = oldMount('PUT', 'settings/executor', update, oldScope, () => {
    bodyStarted.resolve()
    return finishBody.promise
  })
  await Promise.race([bodyStarted.promise, pending])
  const selection = oldMount('POST', 'projects/beta/select')
  await Promise.race([selectionStarted.promise, selection])
  let duringSelection
  try { duringSelection = await oldMount('GET', 'settings', undefined, oldScope) }
  finally { finishSelection.resolve() }
  const selectionResult = await selection.finally(finishBody.resolve)
  const pendingResult = await pending
  const retiredRead = await oldMount('GET', 'settings', undefined, oldScope)

  const newMount = serve({ ...settingsHost(200), installation: { ...bindingInstallation(() => beta.id), runtime: (): RuntimeView => ({
    mode: 'desktop', status: 'paused', reason: 'recoveryPending', projectId: beta.id, resumedFrom: null,
  }) } })
  const newReadWithOldScope = await newMount('GET', 'settings', undefined, oldScope)
  const newWriteWithOldScope = await newMount('PUT', 'settings/executor', update, oldScope)
  expect(selectionResult).toEqual({ status: 200, body: { project: beta, restarting: true } })
  for (const response of [duringSelection, retiredRead, pendingResult]) {
    expect(response).toMatchObject({ status: 409, body: { code: 'switching' } })
  }
  for (const response of [newReadWithOldScope, newWriteWithOldScope]) {
    expect(response).toMatchObject({ status: 409, body: { code: 'staleProject' } })
  }
  expect(saves).toEqual([])
  expect(await newMount('GET', 'settings', undefined, projectHeader(beta.id))).toMatchObject(expectedBlock(200))
})

it('rejects a stale scoped read and hides meters from outside the mounted project', async () => {
  const call = serve({
    installation: { projects: () => ({ activeProjectId: alpha.id, projects: [alpha, beta] }) },
    ownsSession: (id: string) => id === alpha.hubSessionId,
    meter: { read: async (id: string) => ({ session_id: id }) },
  })
  expect(await call('GET', 'sessions/hub-alpha/meter', undefined, projectHeader(beta.id)))
    .toMatchObject({ status: 409, body: { code: 'staleProject' } })
  expect(await call('GET', 'sessions/hub-beta/meter')).toEqual({ status: 404, body: { error: 'Session not found' } })
  expect(await call('GET', 'sessions/hub-alpha/meter')).toEqual({ status: 200, body: { session_id: alpha.hubSessionId } })
})

it('does not return the old project meter if the project changes while sampling', async () => {
  let activeProjectId = alpha.id
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const call = serve({
    installation: bindingInstallation(() => activeProjectId),
    projectMeter: { read: async () => {
      entered.resolve()
      await release.promise
      return { scope: 'project', sessions: [{ session_id: alpha.hubSessionId }] }
    } },
  })
  const response = call('GET', 'project/meter', undefined, projectHeader(alpha.id))
  await Promise.race([entered.promise, response])
  activeProjectId = beta.id
  release.resolve()
  expect(await response).toMatchObject({ status: 409, body: { code: 'staleProject' } })
})
