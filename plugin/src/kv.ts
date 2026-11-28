/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Handoff, ProjectRef, Spec } from './core/handoff.ts'
import type { Plan, PlanMessage, PlanNodeState } from './core/plan.ts'
import type { HubAuthorityState } from './app/hub-authority.ts'
export type HubDeliveryReceipt = { hash: string; sessionId: string; at: string }
import type { TestHistory } from './core/delivery-check.ts'
import type { PlanIntegrationView, PlanReleaseIntent } from './core/plan-integration.ts'
import type { PromptVersion } from './app/prompts.ts'
import type { MainlineIntent } from './app/mainline-queue.ts'
import type { PlanRepairSource, PlanRevision } from './app/plans.ts'
import type { RequirementPreview } from './app/plan-requirements.ts'
import type { StagnationRecord } from './app/plan-stagnation.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SessionMeterState } from './app/session-meter.ts'
import type { MeterSessionBinding } from './app/project-meter.ts'
import type { BudgetLedger, PendingUsage } from './app/run-limits.ts'
import type { TopicBindingRecord } from './app/topic-binding.ts'
import type { SettingsConfirmationRecord } from './app/settings-confirmations.ts'
import type { CredentialBlocker } from './app/scoped-attention.ts'
import type { PlanControlState } from './app/plan-control.ts'
import type { MaintenanceEvent, MaintenanceTarget } from './app/maintenance.ts'
import type { InspectionRun, InspectionSchedule, InspectionTodo } from './app/idle-inspection.ts'
import type { SettingsSave } from './policy.ts'
import type { GithubConfig, Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    active: record<number>('prompt-active-revision'),
    snapshot: family<PromptVersion, [revision: number]>('prompt-snapshot:'),
    ticket: family<number>('ticket-prompt-revision:'),
    proposal: family<number>('ticket-prompt-proposal:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: authority is canonical; masterId mirrors its physical Session and seeds only one-time legacy import. */
  runtime: { masterId: record<string>('master-id'), authority: record<HubAuthorityState>('hub-authority'),
    delivery: family<HubDeliveryReceipt, [requestId: string]>('hub-delivery:'),
    transfer: family<UserMessage[], [fromSessionId: string]>('hub-inbox-transfer:'),
    transferred: family<string, [fromSessionId: string, messageId: string]>('hub-inbox-consumed:', (from, id) => JSON.stringify([from, id])),
    inboxTarget: family<string, [fromSessionId: string, messageId: string]>('hub-inbox-target:', (from, id) => JSON.stringify([from, id])),
    inboxRequest: family<{ sessionId: string; messageId: string }, [kind: 'rpc' | 'message', id: string]>(
      'hub-inbox-request:', (kind, id) => JSON.stringify([kind, id])),
    inboxFence: family<number, [sessionId: string]>('hub-inbox-fence:') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Session meter: durable exclusive log cursor and its cumulative, own-event projection. */
  meter: { state: family<SessionMeterState, [session: string]>('session-meter:') },
  /** Project meter: one append-only business identity per Session, with a cumulative set of roles. */
  projectMeter: { binding: family<MeterSessionBinding, [session: string]>('project-meter-binding:') },
  /** Run-limit ledger: aggregate project pool, per-Ticket pools and unreceipted authorized calls. */
  runLimits: { since: record<string>('run-limits-since'), project: record<BudgetLedger>('run-limits-project'),
    ticket: family<BudgetLedger>('run-limits-ticket:'), pending: family<PendingUsage>('run-limits-pending:'),
    inspection: family<BudgetLedger>('run-limits-inspection:'), inspectionHold: family<true>('run-limits-inspection-hold:'),
    projectHold: record<true>('run-limits-project-hold'), ticketHold: family<true>('run-limits-ticket-hold:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:'),
    maintenanceLookup: family<{ epoch: string; at: string; actorId: string; sourceRevision: number; policyVersion: string }>('feishu-maintenance-lookup:') },
  /** Mounted project: one active binding and text-free consumption receipts that survive unbind/rebind. */
  topicBinding: { active: record<TopicBindingRecord>('topic-binding'), received: family<true>('topic-binding-received:') },
  /** One immutable proposal per ID and the current proposal for each confirmable object in this mount. */
  settingsConfirmations: { request: family<SettingsConfirmationRecord>('settings-confirmation:'), latest: family<string>('settings-confirmation-latest:') },
  /** Maintenance: immutable source observations, pending review and durable associations. */
  maintenance: { event: family<MaintenanceEvent>('maintenance-event:'), pending: family<true>('maintenance-pending:'),
    feedback: family<MaintenanceTarget>('maintenance-feedback:'), recovery: record<string>('maintenance-recovery-relay') },
  /** Inspection scheduler and evidence; the Session adapter independently pins the native root at creation. */
  inspection: { schedule: record<InspectionSchedule>('inspection-schedule'), run: family<InspectionRun>('inspection-run:'),
    native: family<number>('inspection-native:'), todo: family<InspectionTodo>('inspection-todo:'),
    repairWake: family<string>('inspection-repair-wake:'),
    page: family<true, [string, string, number]>('inspection-page:', (id, path, offset) => `${id}:${JSON.stringify([path, offset])}`) },
  /** Handoffs: current record by project; immutable full records and specs; direct confirmation receipts. */
  handoffs: { current: family<string, [projectId: string]>('handoff-current:'),
    record: family<Handoff, [id: string]>('handoff:'),
    project: family<ProjectRef, [id: string]>('handoff-project:'),
    spec: family<Spec, [handoffId: string]>('handoff-spec:'),
    confirmationReceipt: family<{ handoffId: string }, [sessionId: string, messageId: string]>(
      'handoff-confirmation:', (sessionId, messageId) => JSON.stringify([sessionId, messageId])) },
  /** Plans: immutable DAG versions, mutable node execution claims and append-only context. */
  plans: { record: family<Plan, [id: string]>('plan:'),
    head: family<number>('plan-head:'),
    revision: family<PlanRevision, [planId: string, revision: number]>('plan-revision:'),
    retired: family<{ revision: number; replacements: string[] }, [planId: string, nodeId: string]>('plan-retired:'),
    handover: family<string[], [planId: string, nodeId: string]>('plan-handover:'),
    budgetOrigin: family<string, [planId: string, nodeId: string]>('plan-budget-origin:'),
    repairSource: family<PlanRepairSource, [planId: string, nodeId: string]>('plan-repair-source:'),
    testHistory: family<TestHistory, [planId: string, nodeId: string]>('plan-test-history:'),
    requiredChecks: family<GithubConfig['requiredChecks']>('plan-ticket-required-checks:'),
    claimRevision: family<number, [planId: string, nodeId: string]>('plan-claim-revision:'),
    node: family<PlanNodeState, [id: string, nodeId: string]>('plan-node:', (id, nodeId) => JSON.stringify([id, nodeId])),
    integration: family<PlanIntegrationView>('plan-integration:'),
    maintenanceStarted: record<{ deliveredPlan: string; startedAt: string }>('plan-maintenance-started'),
    integrationDispatch: family<true>('plan-integration-dispatch:'),
    releaseIntent: family<PlanReleaseIntent>('plan-release-intent:'),
    releaseActive: family<string, [projectId: string, environment: string, target: string]>('plan-release-active:',
      (projectId, environment, target) => JSON.stringify([projectId, environment, target])),
    background: family<PlanMessage[], [id: string]>('plan-background:'),
    instructions: family<PlanMessage[], [id: string, nodeId: string]>('plan-instructions:',
      (id, nodeId) => JSON.stringify([id, nodeId])),
    receipt: family<string, [id: string, sessionId: string, messageId: string]>('plan-message-receipt:',
      (id, sessionId, messageId) => JSON.stringify([id, sessionId, messageId])),
    control: family<PlanControlState>('plan-control:'),
    controlRequest: family<string, [sessionId: string, messageId: string]>('plan-control-request:',
      (sessionId, messageId) => JSON.stringify([sessionId, messageId])) },
  /** Only the product change flow writes previews and consumes direct operator approval events. */
  planRequirements: { preview: family<RequirementPreview>('plan-requirement-preview:'),
    reviewer: family<{ sessionId: string; createdAt: number }>('plan-requirement-reviewer:'),
    request: family<string, [sessionId: string, messageId: string]>('plan-requirement-request:',
      (sessionId, messageId) => JSON.stringify([sessionId, messageId])),
    approval: family<string, [sessionId: string, messageId: string]>('plan-requirement-approval:',
      (sessionId, messageId) => JSON.stringify([sessionId, messageId])) },
  /** Stagnation observations and scheduled recovery belong to the original Ticket. */
  planStagnation: { ticket: family<StagnationRecord>('plan-stagnation:') },
  /** Mainline: versioned Ticket attempts and the FIFO per GitHub repo/ref. */
  mainline: { ticket: family<MainlineIntent[], [ticketId: string]>('mainline-ticket:'),
    pending: family<string[], [target: string]>('mainline-pending:') },
  /** Scoped attention: durable action receipts and at most one active credential blocker per Ticket. */
  attention: { credential: family<CredentialBlocker>('credential-action:'), active: family<string>('active-credential-action:') },
}
