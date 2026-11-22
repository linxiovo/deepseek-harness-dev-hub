/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { PROJECT_SCOPE_HEADER, THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { InstallationError, type GithubIdentity, type InstallationApi, type OnboardingView, type ProjectView, type RuntimeView }
  from './installation-api.ts'
import { bundledSkills } from './skill-files.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { PolicyConfigSchema, policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { ProjectMeter } from './project-meter.ts'
import type { RunLimitStatus } from './run-limits.ts'
import type { ScopedAttention } from './scoped-attention.ts'
import type { SessionMeter } from './session-meter.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import { actorIdPattern, TopicBindingError, type TopicBinding } from './topic-binding.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

export interface HttpHost {
  readonly installation?: InstallationApi
  readonly topicBinding?: Pick<TopicBinding, 'view' | 'bind' | 'unbind'> | undefined
  /** Verify the workspace under the write lock, before the final scope check and bind. */
  readonly verifyTopicBinding?: (() => Promise<void>) | undefined
  assertNewWork?(): void
  ownsSession?(id: string): boolean | Promise<boolean>
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  /** Session context snapshots and cumulative usage, shared with the Hub's `session/<id>` resource. */
  readonly meter: Pick<SessionMeter, 'read'>
  readonly projectMeter: Pick<ProjectMeter, 'read'>
  readonly runLimits?: { view(ticketId?: string): RunLimitStatus | undefined }
  readonly attention: Pick<ScopedAttention, 'summary' | 'entry' | 'verify'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function isEmptyJsonObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  for (const key in value) if (Object.hasOwn(value, key)) return false
  return true
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof InstallationError) return [error.status, { error: error.message, code: error.code }]
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError || error instanceof TopicBindingError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  const projectId = runtime.installation?.projects().activeProjectId
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health, ...(projectId ? { projectId } : {}) }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(bundledSkills).filter(name => SKILL_NAME.test(name)), skillPrefix: SKILL_PREFIX, parts,
    defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
  write<T>(operation: () => T | Promise<T>, verify?: () => Promise<void>): T | Promise<T>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const nonBlank = z.string().refine(value => value.trim().length > 0 && !/[\u0000\r\n]/.test(value))
const VerifyRequest = z.strictObject({ cli: nonBlank })
const CreateProjectRequest = z.strictObject({ repository: nonBlank, workspace: nonBlank, baseRef: nonBlank,
  policy: PolicyConfigSchema.optional() })
const TopicBindingRequest = z.strictObject({ triggerId: nonBlank, allowedActors: z.array(z.string().regex(actorIdPattern)) })

function installationInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new InstallationError(400, 'invalidRequest')
  return result.data
}

function installationOf(runtime: HttpHost): InstallationApi {
  if (!runtime.installation) throw new InstallationError(404, 'installationUnavailable')
  return runtime.installation
}

function topicBindingOf(runtime: HttpHost): NonNullable<HttpHost['topicBinding']> {
  if (!runtime.topicBinding) throw new RouteError(404, 'Topic binding is not available')
  return runtime.topicBinding
}

function publicSetupProblem({ code, values }: SetupProblem): SetupProblem {
  const safe: Record<string, string> = {}
  for (const [key, pattern] of Object.entries({ account: /^[\w-]+$/, repository: /^[\w.-]+\/[\w.-]+$/ })) {
    const value = values[key]
    if (value && value.length <= 200 && pattern.test(value)) safe[key] = value
  }
  return new SetupError(code, safe).problem
}

function identityView({ id, login, noreply }: GithubIdentity): GithubIdentity { return { id, login, noreply } }

function onboardingView(view: OnboardingView): OnboardingView {
  if (view.status === 'unconfigured') return { status: view.status }
  if (view.status === 'ready') return { status: view.status, identity: identityView(view.identity) }
  return { status: view.status, ...(view.identity && { identity: identityView(view.identity) }),
    ...(view.problem && { problem: publicSetupProblem(view.problem) }) }
}

function projectView({ id, repository, workspace, hubSessionId }: ProjectView): ProjectView {
  return { id, repository, workspace, hubSessionId }
}

function installationFailure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof InstallationError || error instanceof RouteError) return failure(error)
  if (error instanceof z.ZodError) return failure(new InstallationError(400, 'invalidRequest'))
  if (error instanceof SetupError) {
    const setup = publicSetupProblem(error.problem)
    return [400, { error: setup.detail, setup }]
  }
  return [500, { error: 'Installation operation failed.' }]
}

function attentionFailure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof RouteError) return failure(error)
  if (error instanceof InstallationError) return failure(new InstallationError(error.status, error.code))
  if (error instanceof UserError && error.code === 'unknownPlan') return failure(error)
  return [500, { error: 'Attention operation failed.' }]
}

function runtimeView({ mode, status, reason, projectId, resumedFrom }: RuntimeView): RuntimeView {
  if (!resumedFrom) return { mode, status, reason, projectId, resumedFrom: null }
  const { reason: via, at, recoverable: { assignments, handoffs, effects } } = resumedFrom
  return { mode, status, reason, projectId, resumedFrom: { reason: via, at, recoverable: { assignments, handoffs, effects } } }
}

const installationRoutes: ReadonlySet<keyof Api> = new Set(['GET runtime', 'GET onboarding', 'POST onboarding/github/verify',
  'GET projects', 'POST projects', 'POST projects/:projectId/select'])

const topicBindingRoutes: Partial<Record<keyof Api, true>> = {
  'GET topic-binding': true, 'POST topic-binding': true, 'POST topic-binding/unbind': true,
}

const projectMeterRoutes: Partial<Record<keyof Api, true>> = {
  'GET project/meter': true, 'GET plans/:id/meter': true, 'GET tickets/:id/meter': true,
}

const runLimitRoutes: Partial<Record<keyof Api, true>> = {
  'GET project/run-limits': true, 'GET tickets/:id/run-limits': true,
}

const attentionRoutes: Partial<Record<keyof Api, true>> = {
  'GET attention/summary': true, 'GET attention/credentials/:id': true, 'POST attention/credentials/:id/verify': true,
}

function assertProjectScope(active: string | null, requested: string | string[] | undefined,
  requirement: 'optional' | 'when-active' | 'required'): void {
  if (requested !== undefined && requested !== active) throw new InstallationError(409, 'staleProject')
  if (active === null && requirement === 'required') throw new InstallationError(409, 'noProject')
  if (active !== null && requirement !== 'optional' && requested === undefined) throw new InstallationError(409, 'projectScopeRequired')
}

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const verifyBinding = runtime.verifyTopicBinding?.bind(runtime)
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  const meter = async (scope: 'project' | 'plan' | 'ticket', id?: string) => {
    const view = await runtime.projectMeter.read(scope, id)
    if (!view) throw new RouteError(404, `${scope === 'plan' ? 'Plan' : scope === 'ticket' ? 'Ticket' : 'Project'} not found`)
    return view
  }
  const runLimitStatus = (id?: string) => {
    if (!runtime.runLimits) throw new RouteError(404, 'Run limits are not available')
    const view = runtime.runLimits.view(id)
    if (!view) throw new RouteError(404, id === undefined ? 'Project not found' : 'Ticket not found')
    return view
  }
  return {
    'GET runtime': () => runtimeView(installationOf(runtime).runtime()),
    'GET onboarding': () => onboardingView(installationOf(runtime).onboarding()),
    'POST onboarding/github/verify': async ({ body, write }) => {
      const request = installationInput(VerifyRequest, await body())
      return write(async () => onboardingView(await installationOf(runtime).verifyGithub(request)))
    },
    'GET projects': () => {
      const { activeProjectId, projects } = installationOf(runtime).projects()
      return { activeProjectId, projects: projects.map(projectView) }
    },
    'POST projects': async ({ body, write }) => {
      const request = installationInput(CreateProjectRequest, await body())
      return write(async () => {
        const { project, reused, restarting } = await installationOf(runtime).createProject(request)
        return { project: projectView(project), reused, restarting }
      })
    },
    'POST projects/:projectId/select': ({ params, write }) => write(async () => {
      const { project, restarting } = await installationOf(runtime).selectProject(params.projectId)
      return { project: projectView(project), restarting }
    }),
    'GET topic-binding': () => topicBindingOf(runtime).view(),
    'POST topic-binding': async ({ body, write }) => {
      const request = TopicBindingRequest.safeParse(await body())
      if (!request.success) throw new RouteError(400, 'Invalid topic binding request')
      const { triggerId, allowedActors } = request.data
      return write(() => topicBindingOf(runtime).bind(triggerId, allowedActors), verifyBinding)
    },
    'POST topic-binding/unbind': ({ write }) => write(() => topicBindingOf(runtime).unbind()),
    'GET attention/summary': ({ query }) => runtime.attention.summary(query.planId),
    'GET attention/credentials/:id': ({ params }) => {
      const entry = runtime.attention.entry(params.id)
      if (!entry) throw new RouteError(404, 'Credential action not found')
      return entry
    },
    'POST attention/credentials/:id/verify': async ({ params, body, write }) => {
      if (!isEmptyJsonObject(await body())) throw new RouteError(400, 'Expected an empty JSON object')
      return write(async () => {
        const entry = await runtime.attention.verify(params.id)
        if (!entry) throw new RouteError(404, 'Credential action not found')
        return entry
      })
    },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params, write }) => write(() => runtime.settings.refreshLabels(params.id)),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': ({ params, write }) => write(async () => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    }),
    'POST triggers/:id/requeue': ({ params, write }) => write(() => {
      runtime.assertNewWork?.()
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    }),
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params, write }) => write(() => { runtime.engine.dismiss(params.id); return { dismissed: true } }),
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params, write }) => write(() => {
      runtime.assertNewWork?.()
      const id = ticket(params.id)
      runtime.engine.retryTicket(id)
      return { retried: true }
    }),
    'POST tickets/:id/stop': ({ params, write }) => write(() => {
      const id = ticket(params.id)
      runtime.engine.stopTicket(id)
      return { stopped: true }
    }),
    'POST executor/pause': async ({ body, write }) => {
      const { paused } = z.object({ paused: z.boolean() }).parse(await body())
      return write(() => runtime.settings.pause(paused, 'panel'))
    },
    'PUT settings/:block': async ({ params, body, write }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const request = SaveRequest.parse(await body())
      return write(() => {
        const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
        if (!known) throw new RouteError(404, 'Source not found')
        return runtime.settings.save(block, request.value, request.revision, 'panel')
      })
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': ({ params, write }) => write(async () => ({ policy: await runtime.settings.sync(params.id) })),
    'POST setup/check': ({ write }) => write(() => { runtime.checkSetup(); return { restarting: true } }),
    'GET models': () => runtime.models(),
    'GET sessions/:id/meter': async ({ params }) => {
      // The Hub reads the same view; a corrupt Session log is not a missing Session and keeps its 500.
      if (runtime.installation?.projects().activeProjectId && !(await runtime.ownsSession?.(params.id))) throw new RouteError(404, 'Session not found')
      const view = await runtime.meter.read(params.id)
      if (!view) throw new RouteError(404, 'Session not found')
      return view
    },
    'GET project/meter': () => meter('project'),
    'GET plans/:id/meter': ({ params }) => meter('plan', params.id),
    'GET tickets/:id/meter': ({ params }) => meter('ticket', params.id),
    'GET project/run-limits': () => runLimitStatus(),
    'GET tickets/:id/run-limits': ({ params }) => runLimitStatus(params.id),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return input.write(() => savePrompts(runtime, request.config, request.baseRevision, 'panel'))
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { key: route as keyof Api, run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  let writing: 'installation' | 'project' | undefined
  let activeWrite: Promise<unknown> | undefined
  let retiring = false
  let closed = false
  function readableMount(scope: string | string[] | undefined, requirement: 'optional' | 'required'): string | null {
    const { installation } = runtime
    if (retiring || writing === 'installation' || installation?.runtime().reason === 'switching') {
      throw new InstallationError(409, 'switching')
    }
    const active = installation?.projects().activeProjectId ?? null
    assertProjectScope(active, scope, requirement)
    return active
  }
  async function write<T>(route: keyof Api, scope: string | string[] | undefined, operation: () => T | Promise<T>,
    verify?: () => Promise<void>): Promise<T> {
    if (retiring) throw new InstallationError(409, 'switching')
    const installationRoute = installationRoutes.has(route)
    const requirement = topicBindingRoutes[route] || attentionRoutes[route] ? 'required' : 'when-active'
    const { installation } = runtime
    if (!installationRoute || scope !== undefined) {
      assertProjectScope(installation?.projects().activeProjectId ?? null, scope, requirement)
    }
    if (!installation) return operation()
    if (writing === 'installation' || installation.runtime().reason === 'switching') throw new InstallationError(409, 'switching')
    if (writing) throw new InstallationError(409, 'projectConflict')
    writing = installationRoute ? 'installation' : 'project'
    try {
      const pending = verify ? verify().then(() => {
        // Workspace verification may suspend; recheck the mounted scope at the mutation itself.
        if (retiring || installation.runtime().reason === 'switching') throw new InstallationError(409, 'switching')
        assertProjectScope(installation.projects().activeProjectId, scope, requirement)
        return operation()
      }) : Promise.resolve(operation())
      activeWrite = pending
      const result = await pending
      if (result && typeof result === 'object' && 'restarting' in result && result.restarting === true) retiring = true
      return result
    } finally { writing = undefined; activeWrite = undefined }
  }
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      let installationRoute = false
      let attentionRoute = false
      try {
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        installationRoute = installationRoutes.has(route.key)
        attentionRoute = attentionRoutes[route.key] === true
        if (!installationRoute) await runtime.ready
        const scope = req.headers[PROJECT_SCOPE_HEADER]
        const runLimitRoute = runLimitRoutes[route.key] === true
        const mountedRoute = attentionRoute || runLimitRoute || route.key === 'GET settings' || projectMeterRoutes[route.key]
        const requirement = attentionRoute || runLimitRoute ? 'required' : 'optional'
        const mounted = mountedRoute ? readableMount(scope, requirement) : undefined
        if (route.key === 'GET topic-binding') readableMount(scope, 'required')
        else if (!mountedRoute && !installationRoute && scope !== undefined && (route.key.startsWith('GET ') || route.key === 'POST prompts/preview')) {
          assertProjectScope(runtime.installation?.projects().activeProjectId ?? null, scope, 'optional')
        }
        const query = Object.fromEntries(url.searchParams)
        if (attentionRoute && (route.key === 'GET attention/summary'
          ? [...url.searchParams.keys()].some(key => key !== 'planId') || url.searchParams.getAll('planId').length > 1
          : url.searchParams.size !== 0)) throw new RouteError(400, 'Invalid attention query')
        if (runLimitRoute && url.searchParams.size !== 0) throw new RouteError(400, 'Invalid run limits query')
        if (route.key === 'POST attention/credentials/:id/verify'
          && req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          throw new RouteError(400, 'Expected Content-Type: application/json')
        }
        let result: unknown
        try {
          result = await route.run({ params: route.params as never, query, body: async maxBytes => {
            const body = await readBody(req, maxBytes)
            if (closed) throw new InstallationError(409, 'switching')
            return body
          }, write: (operation, verify) => write(route.key, scope, operation, verify) })
        } finally {
          // Do not deliver a sample or credential receipt from a retiring or replaced mount.
          if (mountedRoute && readableMount(scope, requirement) !== mounted) throw new InstallationError(409, 'staleProject')
        }
        json(res, 200, result)
      } catch (error) {
        const respond = attentionRoute ? attentionFailure : installationRoute ? installationFailure : failure
        json(res, ...respond(error))
      }
    } })]
  return async () => {
    retiring = true
    closed = true
    for (const dispose of disposers) dispose()
    if (activeWrite) await Promise.allSettled([activeWrite])
  }
}
