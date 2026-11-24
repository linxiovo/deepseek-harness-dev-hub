/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { ProjectMeterView } from './project-meter.ts'
import type { RunLimitStatus } from './run-limits.ts'
import type { SessionMeterView } from './session-meter.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { CreateProjectInput, CreateProjectResult, OnboardingView, ProjectsView, RuntimeView, SelectProjectResult,
  VerifyGithubInput } from './installation-api.ts'
import type { TopicBindingView } from './topic-binding.ts'
import type { ScopedAttention } from './scoped-attention.ts'
import type { PlanIntegrationView } from '../core/plan-integration.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export const PROJECT_SCOPE_HEADER = 'x-orchestrator-project-id'
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET runtime': { response: RuntimeView }
  'GET onboarding': { response: OnboardingView }
  'POST onboarding/github/verify': { body: VerifyGithubInput; response: OnboardingView }
  'GET projects': { response: ProjectsView }
  'POST projects': { body: CreateProjectInput; response: CreateProjectResult }
  'POST projects/:projectId/select': { response: SelectProjectResult }
  'POST hub/rotate': { response: { hubSessionId: string } }
  /** Read-only successor for a completed retired Hub root of the mounted project. */
  'GET hub/conversation': { query: { sessionId: string };
    response: { target: null | { projectId: string; sessionId: string } } }
  'GET topic-binding': { response: TopicBindingView }
  'POST topic-binding': { body: { triggerId: string; allowedActors: string[] }; response: NonNullable<TopicBindingView> }
  'POST topic-binding/unbind': { response: null }
  'GET attention/summary': { query?: { planId?: string }; response: ReturnType<ScopedAttention['summary']> }
  'GET attention/credentials/:id': { response: NonNullable<ReturnType<ScopedAttention['entry']>> }
  'POST attention/credentials/:id/verify': { body: Record<string, never>; response: NonNullable<Awaited<ReturnType<ScopedAttention['verify']>>> }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  /** One Session's context snapshot and cumulative usage, the same view the Hub reads for `session/<id>`. */
  'GET sessions/:id/meter': { response: SessionMeterView }
  'GET project/meter': { response: ProjectMeterView }
  'GET plans/:id/meter': { response: ProjectMeterView }
  'GET plans/:id/artifact': { response: Blob }
  'GET plans/:id/delivery': { response: PlanIntegrationView }
  'GET tickets/:id/meter': { response: ProjectMeterView }
  'GET project/run-limits': { response: RunLimitStatus }
  'GET tickets/:id/run-limits': { response: RunLimitStatus }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number; maintenanceTicketId: string }; response: { revision: number; effect: 'pending-review' } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
