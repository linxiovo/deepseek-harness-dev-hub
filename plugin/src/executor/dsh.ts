/** DSH executor: reserves and verifies one Git worktree and worker session per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, ExecutionClaim, ExecutionIdentity, Executor, MainlineRepair, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, sameDirectory, verifyDirectory } from '../infra/environment.ts'
import { physicalPath } from '../infra/paths.ts'
import { worktreePreparationConfig, type Settings } from '../policy.ts'
import type { Commands } from '../infra/commands.ts'
import { CliError } from '../infra/commands.ts'
import type { Store } from '../app/store.ts'
import { Later, Park, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { RUN_LIMIT_REFUSAL } from '../app/model-admission.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { promptFile } from '../infra/prompt-file.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'
import { checkDocTree } from './doc-tree.ts'
import { validateRepositoryIdentity } from './repository-identity.ts'
import { inspectRepository, inspectWorktree, validateWorktreeDestination, WorktreeRejected } from './worktree.ts'

const recoveryNote = promptFile('worker-recovery')
const repairInstructions = promptFile('mainline-repair')
const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const repairOf = (ticket: Ticket) => ticket.inputs.findLast(input => input.kind === 'mainline-repair')
const credentialResumeNote = promptFile('worker-credential-resume')
const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 10_000
/** Verification may wait briefly for a drain already in progress; timing out never releases the blocker. */
const CREDENTIAL_DRAIN_WAIT_MS = 1000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/** A launch refusal that requires a person to fix its configuration, worktree, or ownership before retrying. */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Canonicalize the target through its nearest existing parent without creating or reading the ticket directory. */
async function targetPath(directory: string): Promise<string> {
  const target = resolve(directory)
  const missing: string[] = [basename(target)]
  let parent = dirname(target)
  for (;;) {
    try { return resolve(await physicalPath(parent), ...missing.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
      missing.push(basename(parent)); parent = dirname(parent)
    }
  }
}
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used for custom prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
    | 'assignmentInterrupted' | 'resumeVerifiedCredential' | 'report' | 'reserveExecution' | 'recordExecutionVerified' | 'rejectExecution'
    | 'pinMainlineRepair' | 'acquireExecutionWriter' | 'releaseExecutionWriter'>
  readonly commands: Pick<Commands, 'git' | 'repository'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'retry' | 'promptedId' | 'relay' | 'holds' | 'bindWorker'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Live read of this ticket's durable credential blocker, including inside the verification transaction. */
  credentialBlocked?(ticketId: string): boolean
  quota?: { blocked(ticketId: string): boolean; inFlight(ticketId: string): boolean }
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  if (input.kind === 'mainline-repair') {
    const { kind, id, base, candidate, ref } = input
    return JSON.stringify({ kind, id, base, candidate, ref, instructions: repairInstructions.replace('{base}', base) })
  }
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/** Local fence between a committed credential blocker, actual shutdown of its writer, and verified resumption. */
interface WorkHold { drain: Promise<void>; drained: boolean; slot: boolean; resumeAfterQuota: boolean; resuming?: boolean }
interface TurnRetry { timer?: NodeJS.Timeout; sending?: Promise<void> }

/** A restored Agent must be the ticket's root Worker, not another Session returned by a stale binding. */
function matchesWorker(ticket: Ticket, agent: Agent): boolean {
  const { header } = agent.session
  return agent.id === workerSessionId(ticket.id) && header.id === agent.id && header.parentSession === undefined
    && header.origin !== 'subagent' && !!header.cwd && !!ticket.execution && sameDirectory(header.cwd, ticket.execution.directory)
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Each admitted passing failure owns its backoff and send until it finishes or the Assignment is suspended. */
  private readonly resuming = new Map<string, Set<TurnRetry>>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** Claims and in-flight preparations created by this executor instance; a restarted process never inherits permission to release a writer. */
  private readonly claims = new Map<string, ExecutionClaim>()
  /** Restored claims can be cleaned up, but cannot authorize turns until Git is inspected in this process. */
  private readonly restoredClaims = new Set<ExecutionClaim>()
  private readonly launching = new Map<string, Promise<void>>()
  /** The effect queue runs at most one delivery per ticket. A suspension joins an already admitted Session send. */
  private readonly delivering = new Map<string, Promise<void | typeof Park>>()
  private readonly holds = new Map<string, WorkHold>()
  /** Short failed/blocked handoffs; runtime idle waits for their writer-release decision, not for long-running jobs. */
  private readonly handoffs = new Set<Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', async ({ ticketId }) => {
      const delivery = this.deliverQueued(ticketId)
      this.delivering.set(ticketId, delivery)
      try { return await delivery } finally { this.delivering.delete(ticketId) }
    }, { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /** Wait for failed or blocked worker handoffs already observed by the status listener. */
  async idleHandoffs(): Promise<void> { await Promise.all([...this.handoffs]) }
  /** Prepare only an absent ticket path; custom commands must create a real worktree at the reserved pinned base. */
  private async prepareDirectory(ticket: Ticket, claim: ExecutionClaim): Promise<void> {
    const directory = ticket.execution!.directory
    await mkdir(dirname(directory), { recursive: true })
    this.requireWorkAllowed(ticket.id)
    const command = this.host.store.settings().executor.prepare.trim()
    if (!command) {
      await this.host.commands.git(['worktree', 'add', '-b', claim.branch, directory, claim.base.sha], claim.repository)
      return
    }
    const reserved = this.host.store.tickets.get(ticket.id)!
    const env = Object.fromEntries(this.host.environment(reserved).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    try { await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env) }
    catch (error) { throw new PrepareFailed(`The prepare command failed; its files were preserved: ${error instanceof Error ? error.message : String(error)}`) }
  }
  /** Reclaim an idle running Assignment only from its previously verified worktree, never from directory existence. */
  private async reclaim(ticket: Ticket, assignment: Assignment): Promise<void> {
    const saved = ticket.execution?.ownership
    if (!saved?.verified) throw new PrepareFailed('The worker has no previously verified worktree to reclaim')
    const workspace = ticket.execution!.directory
    const config = worktreePreparationConfig(this.host.store.settings().executor)
    if (!config.ok) throw new PrepareFailed(config.reason)
    const configured = await inspectRepository(this.host.commands, config.repository)
    const repository = await inspectRepository(this.host.commands, saved.identity.repository)
    const identity: ExecutionIdentity = { ...repository, worktree: saved.identity.worktree,
      branch: saved.identity.branch, base: saved.identity.base }
    this.requireWorkAllowed(ticket.id)
    const reserved = this.host.engine.reserveExecution(ticket.id, assignment.id, identity)
    if (!reserved.ok) throw new PrepareFailed(reserved.reason)
    const claim = reserved.value
    this.claims.set(assignment.id, claim)
    try {
      const expectedSlug = this.host.commands.repository
      await validateRepositoryIdentity(this.host.commands, configured.repository, expectedSlug)
      await validateRepositoryIdentity(this.host.commands, claim.repository, expectedSlug)
      if (!isAbsolute(workspace) || !sameDirectory(await targetPath(workspace), await targetPath(claim.worktree))
        || claim.branch !== `agent/${ticket.execution!.name}`) {
        throw new WorktreeRejected('invalid-target', `Ticket ${ticket.id} no longer points at its verified worktree and branch`)
      }
      const inspected = await inspectWorktree(this.host.commands, { repository: claim.repository, directory: workspace,
        branch: claim.branch, base: claim.base, ticket: ticket.id, assignment: assignment.id,
        session: workerSessionId(ticket.id), mode: 'reuse', previous: claim, repairCandidate: repairOf(ticket)?.candidate })
      await verifyDirectory(workspace, this.host.context.subprocess, this.host.lifetime)
      this.requireWorkAllowed(ticket.id)
      const verified = this.host.engine.recordExecutionVerified(claim, inspected)
      if (!verified.ok) throw new PrepareFailed(verified.reason)
      if (!this.host.engine.acquireExecutionWriter(claim, workerSessionId(ticket.id))) {
        throw new PrepareFailed('The running worker could not reacquire its verified writer grant')
      }
    } catch (error) {
      if (this.workHeld(ticket.id)) throw error // Suspension owns the drain and release.
      this.host.engine.rejectExecution(claim, String(error))
      await this.releaseClaim(claim, `Reclaim failed: ${String(error)}`, true)
      throw error
    }
  }
  /** Recover a durable Plan writer; only repair may inspect a claim whose writer is already idle. */
  private persistedPlanClaim(ticket: Ticket, assignment: Assignment, includeIdle = false): ExecutionClaim | undefined {
    if (!ticket.plan) return undefined
    const execution = ticket.execution, ownership = execution?.ownership, writer = assignment.writer
    if (!execution || !ownership || !writer || (!includeIdle && writer.state === 'idle') || ownership.ticket !== ticket.id || writer.generation !== ownership.generation) return undefined
    return { ...ownership.identity, ticket: ticket.id, assignment: assignment.id, generation: ownership.generation, verified: ownership.verified }
  }
  /** Accept one durable repair Input; neither inbox delivery nor the later Worker reconciliation is a merge receipt. */
  async requestMainlineRepair(ticketId: string, repair: MainlineRepair): Promise<void> {
    const { store, commands } = this.host
    const session = workerSessionId(ticketId)
    if (!repair.id.trim() || !fullCommit.test(repair.base) || !fullCommit.test(repair.candidate) || !repair.ref.startsWith('refs/heads/'))
      throw new Error('Mainline repair requires a stable request ID, two full commit hashes and a target branch ref')
    const receiver = () => {
      this.host.lifetime.throwIfAborted()
      this.requireWorkAllowed(ticketId)
      const ticket = store.tickets.get(ticketId), assignment = ticket && runningAssignment(ticket)
      if (!ticket?.plan || !liveTicket(ticket) || !assignment || assignment !== latestAssignment(ticket))
        throw new Error('Mainline repair requires an open Plan ticket with its running Assignment')
      if (assignment.id !== repair.assignment) throw new PrepareFailed('The queued repair belongs to a different Assignment')
      if (waitsForPerson(ticket)) throw new Error(`Worker ${assignment.report!.state}: ${assignment.report!.summary}`)
      if (ticket.delivery) throw new Error(`Worker Input delivery failed: ${ticket.delivery.error}`)
      const saved = ticket.inputs.find(input => input.id === repair.id)
      if (saved && (saved.kind !== 'mainline-repair' || saved.assignment !== repair.assignment || saved.previousBase !== repair.previousBase ||
          saved.base !== repair.base || saved.candidate !== repair.candidate || saved.ref !== repair.ref))
        throw new Error('The repair request ID already belongs to a different Input')
      return { ticket, assignment, saved }
    }
    if (receiver().saved) return
    // Startup reconciliation may be stopping the interrupted Plan writer. Never infer idle from the process restart.
    await this.stopped(ticketId)
    const { ticket, assignment, saved } = receiver()
    if (saved) return
    const execution = ticket.execution, previous = this.persistedPlanClaim(ticket, assignment, true)
    const config = worktreePreparationConfig(store.settings().executor)
    if (!config.ok) throw new PrepareFailed(config.reason)
    if (!execution || !previous?.verified || execution.preparation?.state !== 'verified' || execution.session !== session
      || assignment.writer?.session !== session || previous.branch !== `agent/${execution.name}`
      || previous.base.ref !== repair.ref || config.baseRef !== repair.ref || previous.base.sha !== repair.previousBase || previous.base.sha === repair.base
      || !sameDirectory(execution.directory, previous.worktree)) throw new PrepareFailed('Repair does not match the verified Worker, worktree or target base ref')
    const configured = await inspectRepository(commands, config.repository)
    if (!sameDirectory(configured.repository, previous.repository) || !sameDirectory(configured.commonDir, previous.commonDir))
      throw new PrepareFailed('The configured repository no longer owns the repair worktree')
    await validateRepositoryIdentity(commands, configured.repository, commands.repository)
    const inspect = () => inspectWorktree(commands, { mode: 'reuse', previous, repository: previous.repository, directory: execution.directory,
      branch: previous.branch, base: previous.base, ticket: ticketId, assignment: assignment.id, session })
    if ((await inspect()).head !== repair.candidate) throw new PrepareFailed('The queued repair candidate is no longer the verified worktree HEAD')
    await commands.git(['merge-base', '--is-ancestor', previous.base.sha, repair.base], previous.worktree)
    if (receiver().saved) return
    const local = this.claims.get(assignment.id)
    if (local && (local.generation !== previous.generation || local.base.sha !== previous.base.sha))
      throw new PrepareFailed('The inspected Worker generation was replaced before repair')
    if (local) await this.releaseClaim(local, 'Mainline advanced; stop the previous writer before repair', true)
    // Stop can overlap the last Worker operation. Prove the actual clean candidate again before recording the pin.
    if ((await inspect()).head !== repair.candidate || (await commands.git(['status', '--porcelain=v1', '--untracked-files=all'], previous.worktree)).trim())
      throw new PrepareFailed('The repair requires the unchanged clean queued candidate in its verified worktree')
    if (receiver().saved) return
    const settings = worktreePreparationConfig(store.settings().executor)
    if (!settings.ok || settings.repository !== config.repository || settings.baseRef !== config.baseRef || this.host.paused())
      throw new PrepareFailed('Mainline repair was paused or its configured target changed during inspection')
    this.host.engine.pinMainlineRepair(previous, repair)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Reserve a launch slot synchronously before a Plan claim is committed; the effect handler reuses this reservation. */
  reserveLaunch(ticketId: string): boolean {
    if (this.workHeld(ticketId)) return false
    try { this.slots.reserve(ticketId, 'launch'); return true }
    catch (error) { if (error instanceof Later) return false; throw error }
  }
  /** Roll back a pre-claim launch reservation when the durable claim transaction fails. */
  releaseLaunch(ticketId: string): void { this.slots.free(ticketId) }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launch only a current pending assignment; each claim is released only after its preparation and worker are idle. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void | typeof Park> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    if (this.workHeld(ticketId)) { this.slots.free(ticketId); return Park }
    this.slots.reserve(ticketId, 'launch')
    const attempt = this.launch(ticket, assignment)
    this.launching.set(assignmentId, attempt)
    try { await attempt; this.transient.delete(`launch:${assignmentId}`) }
    catch (failure) {
      if (this.workHeld(ticketId)) return Park // Clearing the hold rearms the same pending Assignment.
      let error: unknown = failure
      const claim = this.claims.get(assignmentId)
      if (claim) {
        this.host.engine.rejectExecution(claim, String(error))
        try { await this.releaseClaim(claim, `Launch failed: ${String(error)}`, true) }
        catch (stopError) { error = new AggregateError([error, stopError], `Could not safely stop the writer of ticket ${ticketId}`) }
      }
      if (this.host.closing() || error instanceof Later) throw error
      // An incomplete prepare must never be retried automatically against whatever it left at the reserved path.
      if (!claim && !(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally {
      if (this.launching.get(assignmentId) === attempt) this.launching.delete(assignmentId)
      this.slots.free(ticketId)
    }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void | typeof Park> {
    if (this.workHeld(ticketId)) return Park
    // A prior writer must really stop before this worker's Inputs can wake it.
    try { await this.stopped(ticketId) }
    catch (error) {
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (assignment) this.host.engine.deliveryFailed(ticketId, assignment.id, `Previous writer still active: ${String(error)}`)
      throw error
    }
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        if (this.workHeld(ticketId)) return Park // Leave all remaining IDs in the durable input queue.
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        if (!ticket || !assignment) return
        let inputId = ticket.undelivered[0]
        if (inputId === undefined) return
        let input = ticket.inputs.find(item => item.id === inputId)
        if (input?.kind === 'mainline-repair' && waitsForPerson(ticket)) {
          inputId = ticket.undelivered.find(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          if (inputId === undefined) throw new Later()
          input = ticket.inputs.find(item => item.id === inputId)
        }
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => id !== assignment.recoveryInputId && fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        try {
          const loaded = this.host.context.agents.get(sessionId as SessionId)
          if (ticket.plan && loaded && !matchesWorker(ticket, loaded)) throw new PrepareFailed('The loaded Session is not the Plan ticket Worker')
          // Recreate the worker session if it was externally deleted.
          if (!this.writerAuthorized(ticketId, sessionId)) {
            const attempt = this.reclaim(ticket, assignment)
            this.launching.set(assignment.id, attempt)
            try { await attempt }
            finally { if (this.launching.get(assignment.id) === attempt) this.launching.delete(assignment.id) }
          }
          if (this.workHeld(ticketId)) return Park
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (inputId === assignment.recoveryInputId) {
            const agent = this.host.context.agents.get(sessionId as SessionId)
            // Keep the recovery note ahead of unread Triggers, with exactly one copy available to the Worker.
            // A retained inbox copy needs a real wake. A history copy instead needs its missing ack and a fresh wake ID.
            if (agent?.status === 'idle') {
              agent.inbox.remove(this.host.sessions.promptedId(inputId))
              if (await this.host.sessions.holds(sessionId, inputId)) {
                this.requireWorkAllowed(ticketId)
                if (!this.writerAuthorized(ticketId, sessionId) || this.host.context.agents.get(sessionId as SessionId) !== agent) {
                  throw new Later('The worker changed while reconciling its recovery message')
                }
                this.host.store.atomic(() => {
                  const current = this.host.store.tickets.get(ticketId), active = current && runningAssignment(current)
                  if (active?.id !== assignment.id || active.recoveryInputId !== inputId || !current?.undelivered.includes(inputId)) return
                  this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
                  if (agent.status === 'idle') this.host.engine.assignmentInterrupted(ticketId, assignment.id, recoveryNote)
                })
                continue
              }
            }
            for (const waiting of ticket.inputs) {
              if ((waiting.kind === 'trigger' || waiting.kind === 'mainline-repair') && waiting.readAt === null && waiting.deliveredTo === assignment.id) {
                agent?.inbox.remove(this.host.sessions.promptedId(waiting.id))
              }
            }
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.workHeld(ticketId)) return Park
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        if (this.workHeld(ticketId)) return Park
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      this.requireWorkAllowed(ticket.id)
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      if (input.kind === 'mainline-repair' && waitsForPerson(current)) throw new Later('Worker repair is blocked')
      if (!this.writerAuthorized(ticket.id, workerSessionId(ticket.id))) {
        throw new PrepareFailed('The worker writer grant ended before Input delivery')
      }
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, input.id === assignment.recoveryInputId ? 'queue' : 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  private workHeld(ticketId: string): boolean {
    return this.holds.has(ticketId) || this.host.credentialBlocked?.(ticketId) === true || this.host.quota?.blocked(ticketId) === true
  }
  private requireWorkAllowed(ticketId: string): void {
    if (this.workHeld(ticketId)) throw new Later('Ticket work is suspended')
  }
  /** Install the local fences and start cleanup even if normal startup reconciliation will be skipped. */
  recoverCredentialPauses(): void {
    for (const ticket of this.host.store.tickets.open()) {
      if (this.host.credentialBlocked?.(ticket.id)) this.suspendForCredential(ticket.id)
    }
  }
  /** Called after the trusted report commits. Revoke tool authority immediately. Never join the reporting turn here. */
  suspendForCredential(ticketId: string): void {
    if (this.host.credentialBlocked && !this.host.credentialBlocked(ticketId)) return // A delayed report after verification.
    this.suspend(ticketId, 'credential')
  }

  /** Pause only affected Tickets. Already admitted model streams can settle before the drain. */
  reconcileQuotaPauses(): void {
    const { quota, store, engine } = this.host
    if (!quota || this.host.closing()) return
    for (const ticket of store.tickets.open()) {
      const { id } = ticket
      if (quota.blocked(id)) {
        if (!quota.inFlight(id)) this.suspend(id, 'quota')
        continue
      }
      const hold = this.holds.get(id)
      if (!hold?.resumeAfterQuota || hold.resuming || this.host.credentialBlocked?.(id)) continue
      hold.resuming = true
      void this.background(hold.drain.then(() => {
        if (!hold.drained || this.host.closing() || this.holds.get(id) !== hold || quota.blocked(id) || this.host.credentialBlocked?.(id)) return
        this.holds.delete(id)
        const current = store.tickets.get(id)
        if (!current || !liveTicket(current)) return
        const assignment = latestAssignment(current)
        if (assignment?.state === 'running') engine.assignmentInterrupted(id, assignment.id, recoveryNote)
        else if (assignment?.state === 'pending') this.start(current, assignment)
      }).finally(() => { hold.resuming = false }))
    }
  }

  private suspend(ticketId: string, cause: 'credential' | 'quota'): void {
    if (this.holds.has(ticketId)) return
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    const assignment = latestAssignment(ticket), sessionId = workerSessionId(ticketId)
    const agent = this.host.context.agents.get(sessionId as SessionId)
    const reason = cause === 'credential' ? 'Ticket suspended for credential verification' : 'Ticket suspended by its run limits'
    const prior = this.stopping.get(ticketId), launch = assignment && this.launching.get(assignment.id)
    const delivery = this.delivering.get(ticketId)
    const stop = () => stopBackground(this.host.context, sessionId, reason, true, cause === 'credential' ? 'credential-suspension' : undefined)
    const slot = this.running(ticket) || runningJobs(this.host.context, sessionId).length > 0
    // Runtime can reconcile a loaded blocked Worker before the ordinary startup recovery pass.
    if (assignment && !this.claims.has(assignment.id)) {
      const persisted = this.persistedPlanClaim(ticket, assignment)
      if (persisted) this.claims.set(assignment.id, persisted)
    }
    const sends = assignment && this.cancelRetries(assignment.id)
    if (assignment) {
      this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    }
    this.settling.get(ticketId)?.abort()
    this.left.get(ticketId)?.collect.abort(); this.left.delete(ticketId); this.personal.delete(ticketId)
    // Publish the fence before cancel/stop can re-enter us via an Agent event. Never join the reporting tool on its own turn.
    const drain = Promise.resolve().then(async () => {
      if (agent && !matchesWorker(ticket, agent)) throw new Error(`Unexpected Worker Session for ticket ${ticketId}`)
      agent?.cancel({ kind: 'user' }, { keepInbox: true })
      // Launch and delivery handlers own their errors. Their settlement, not success, is needed before the final sweep.
      await Promise.allSettled([stop(), prior, launch, delivery, sends])
      // An already admitted tool can register a job/child while unwinding. Sweep again after the old turn exits.
      await agent?.whenIdle()
      const loaded = this.host.context.agents.get(sessionId as SessionId)
      if (loaded && loaded !== agent) {
        if (!matchesWorker(ticket, loaded)) throw new Error(`Unexpected Worker Session for ticket ${ticketId}`)
        loaded.cancel({ kind: 'user' }, { keepInbox: true })
        await loaded.whenIdle()
      }
      await stop()
      const current = this.host.store.tickets.get(ticketId), latest = current && latestAssignment(current)
      if (cause === 'credential' && (!assignment || latest?.id !== assignment.id || current?.execution?.session !== sessionId || latest.writer?.session !== sessionId)) {
        throw new Error(`Cannot confirm the suspended writer of ticket ${ticketId}`)
      }
      const claim = assignment && this.claims.get(assignment.id)
      if (claim) await this.releaseClaim(claim, reason, true, true)
      if (cause === 'credential' && !this.credentialWriterIdle(ticketId)) throw new Error(`The suspended writer of ticket ${ticketId} is not idle`)
      hold.drained = true
    })
    const hold: WorkHold = { drain, drained: false, slot, resumeAfterQuota: cause === 'quota' }
    this.holds.set(ticketId, hold)
    this.track(ticketId, drain)
  }
  private credentialWriterIdle(ticketId: string): boolean {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    const sessionId = workerSessionId(ticketId), agent = this.host.context.agents.get(sessionId as SessionId)
    return !!ticket && liveTicket(ticket) && ticket.execution?.session === sessionId && !ticket.execution.active_writer
      && assignment?.writer?.session === sessionId && assignment.writer.state === 'idle'
      && (!agent || (matchesWorker(ticket, agent) && agent.status === 'idle')) && !runningJobs(this.host.context, sessionId).length
  }
  /** Fail closed on a missing, failed, timed-out or superseded drain. Does not initiate a new stop. */
  async drainedForCredential(ticketId: string): Promise<boolean> {
    const hold = this.holds.get(ticketId)
    if (!hold || this.host.closing()) return false
    try {
      return await until(hold.drain, this.host.lifetime, CREDENTIAL_DRAIN_WAIT_MS) !== false
        && !this.host.closing() && this.holds.get(ticketId) === hold && hold.drained && this.credentialWriterIdle(ticketId)
    } catch { return false } // The tracked drain reports its stop failure to worker health.
  }
  /** Called synchronously INSIDE the transaction that cleared this exact blocker. No external work precedes commit. */
  resumeAfterCredential(ticketId: string, blockerId: string): void {
    const { store } = this.host
    store.atomic(() => {
      if (this.host.credentialBlocked?.(ticketId)) return
      const hold = this.holds.get(ticketId)
      if (!hold?.drained || !this.credentialWriterIdle(ticketId)) throw new Error('The credential suspension has not drained')
      this.host.engine.resumeVerifiedCredential(ticketId, blockerId, credentialResumeNote)
      store.afterCommit(() => {
        if (this.host.quota?.blocked(ticketId)) hold.resumeAfterQuota = true
        else this.holds.delete(ticketId)
      })
    })
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // Its shell jobs and subagents stop with it; the claim stays held until their stop and the old turn finish.
      this.stopWork(ticket.id, reason, false, assignment.id)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** Stop a writer's work and release only this executor instance's matching claim after actual idle. */
  private stopWork(ticketId: string, reason: string, keepInbox = false, assignmentId?: string): void {
    const stop = (async () => {
      const work = stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox)
      // Observe an early job-stop failure even when the prepare subprocess has not finished yet.
      void work.catch(() => {})
      const launch = assignmentId && this.launching.get(assignmentId)
      if (launch) await launch.catch(() => { /* The launch handler reports its failure; its subprocess is now done. */ })
      await work
      const claim = assignmentId && this.claims.get(assignmentId)
      if (claim) await this.releaseClaim(claim, reason, keepInbox, true)
    })()
    this.track(ticketId, stop)
  }
  /** Confirm the worker turn, jobs and subagents are idle before clearing a generation- and session-matched writer. */
  private async releaseClaim(claim: ExecutionClaim, reason: string, keepInbox = false, stopped = false): Promise<void> {
    if (this.claims.get(claim.assignment) !== claim) return
    const sessionId = workerSessionId(claim.ticket)
    const ticket = this.host.store.tickets.get(claim.ticket)
    const writerSession = ticket?.assignments.find(item => item.id === claim.assignment)?.writer?.session
    if (writerSession !== undefined && writerSession !== sessionId) throw new Error(`Ticket ${claim.ticket} has another writer Session`)
    let agent = this.host.context.agents.get(sessionId as SessionId)
    if (!agent && writerSession) {
      // A Session unloaded in this process can be restored and checked; another process has no local claim to release.
      const resolved = await this.host.context.sessionController.resolveAgent(sessionId as SessionId)
      if ('error' in resolved) throw new Error(`Cannot confirm worker ${sessionId} idle: ${String(resolved.error)}`)
      if (resolved.agent.id !== sessionId || (ticket?.plan && !matchesWorker(ticket, resolved.agent))) {
        throw new Error(`Cannot confirm worker ${sessionId}: another Session was resolved`)
      }
      agent = resolved.agent
      agent.cancel({ kind: 'user' }, { keepInbox })
      await stopBackground(this.host.context, sessionId, reason, keepInbox, this.host.credentialBlocked?.(claim.ticket) ? 'credential-suspension' : undefined)
    }
    if (!stopped) {
      agent?.cancel({ kind: 'user' }, { keepInbox })
      await stopBackground(this.host.context, sessionId, reason, keepInbox)
    }
    if (agent) {
      await agent.whenIdle()
      if (!await untilQuiet(this.host.context, agent, AbortSignal.timeout(SHUTDOWN_STOP_MS))) {
        throw new Error(`Worker ${sessionId} still has an active turn, job or subagent; its writer remains held`)
      }
    }
    if (runningJobs(this.host.context, sessionId).length) throw new Error(`Worker ${sessionId} still owns jobs; its writer remains held`)
    if (this.claims.get(claim.assignment) !== claim) return
    if (!this.host.engine.releaseExecutionWriter(claim, writerSession)) {
      throw new Error(`The writer of ticket ${claim.ticket} could not be released for its matching Session`)
    }
    this.claims.delete(claim.assignment)
    this.restoredClaims.delete(claim)
  }
  /** A stop of the ticket's background work, which a launch or delivery waits for. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(entry)
  }
  /** Wait for a prior writer's stop, including its lease release, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /** Queue recovery may use its already approved pair only after the previous Worker is proved idle or live again. */
  async settleMainlineWriter(ticketId: string): Promise<void> {
    await this.stopped(ticketId)
    this.host.lifetime.throwIfAborted()
  }
  /** Only a grant from this running executor instance authorizes a worker turn; persisted leases alone do not. */
  writerAuthorized(ticketId: string, sessionId: string): boolean {
    if (this.workHeld(ticketId)) return false
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    const claim = assignment && this.claims.get(assignment.id)
    return !!ticket && liveTicket(ticket) && !!assignment && !!claim && !this.restoredClaims.has(claim) && claim.ticket === ticketId
      && sessionId === workerSessionId(ticketId) && ticket.execution?.preparation?.state === 'verified'
      && ticket.execution.ownership?.generation === claim.generation
      && ticket.execution.active_writer?.assignment === assignment.id && ticket.execution.active_writer.session === sessionId
      && assignment.writer?.state === 'active' && assignment.writer.session === sessionId
  }
  /** Current worker lease generation; absent means a persisted lease has no live in-process writer. */
  reviewGeneration(ticketId: string): number | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    const generation = assignment?.writer?.generation
    if (generation === undefined || !ticket || !assignment) return undefined
    if (ticket.ended && assignment.writer?.state === 'idle') return generation
    return this.writerAuthorized(ticketId, workerSessionId(ticketId)) ? generation : undefined
  }
  private async inspectCandidate<T>(ticketId: string, sessionId: string, candidate: string, purpose: string, signal: AbortSignal,
    collect: (worktree: string, base: string, signal: AbortSignal) => Promise<T>) {
    const { store, commands, lifetime } = this.host
    const stopped = AbortSignal.any([signal, lifetime])
    const active = store.tickets.get(ticketId)?.execution?.active_writer
    const claim = active && this.claims.get(active.assignment)
    const authorize = () => {
      stopped.throwIfAborted()
      const ownership = store.tickets.get(ticketId)?.execution?.ownership
      if (!claim || !ownership?.verified || this.claims.get(claim.assignment) !== claim || !this.writerAuthorized(ticketId, sessionId)) {
        throw new Error(`${purpose} evidence requires the active writer for this ticket worktree`)
      }
      return { ...ownership.identity, ticket: ownership.ticket, assignment: claim.assignment, generation: ownership.generation, verified: ownership.verified }
    }
    const inspect = () => {
      const previous = authorize()
      return inspectWorktree(commands, { mode: 'reuse', previous, repository: previous.repository, directory: previous.worktree,
        branch: previous.branch, base: previous.base, ticket: ticketId, assignment: previous.assignment, session: sessionId })
    }
    const repair = store.tickets.get(ticketId)?.deliveryCheck?.events.findLast(event => event.kind === 'repair')?.revision.candidate
    const { worktree, head, base } = await inspect()
    if (candidate !== head) throw new Error(`${purpose} candidate must match the ticket worktree HEAD`)
    authorize()
    const queuedCandidate = repairOf(store.tickets.get(ticketId)!)?.candidate
    for (const ancestor of new Set([repair, queuedCandidate])) if (ancestor && ancestor !== candidate) {
      try { await commands.git(['merge-base', '--is-ancestor', ancestor, candidate], worktree) }
      catch (error) { throw new Error('Candidate must retain the recorded repair lineage', { cause: error }) }
    }
    const checked = await collect(worktree, base.sha, stopped)
    if ((await inspect()).head !== head) throw new Error(`${purpose} candidate changed while collecting evidence`)
    const { generation } = authorize()
    return { candidate: head, base: base.sha, generation, checked }
  }

  async inspectDocImpact(ticketId: string, sessionId: string, candidate: string, scope: Parameters<typeof checkDocTree>[4], signal: AbortSignal) {
    const { checked, ...revision } = await this.inspectCandidate(ticketId, sessionId, candidate, 'Doc Tree', signal,
      (worktree, base, stopped) => checkDocTree(this.host.commands, worktree, base, candidate, scope, stopped))
    return { ...revision, ...checked }
  }

  async inspectTestEvidence(ticketId: string, sessionId: string, candidate: string, red: readonly string[], signal: AbortSignal) {
    const git = this.host.commands.git.bind(this.host.commands)
    const { candidate: head, base, generation } = await this.inspectCandidate(ticketId, sessionId, candidate, 'Test', signal,
      async (worktree, base, stopped) => {
        for (const revision of new Set(red)) {
          stopped.throwIfAborted()
          if (revision === candidate) throw new Error('Red revision must precede the candidate')
          if ((await git(['rev-parse', '--verify', `${revision}^{commit}`], worktree)).trim() !== revision) {
            throw new Error('Red revision must name a commit hash')
          }
          try {
            await git(['merge-base', '--is-ancestor', base, revision], worktree)
            await git(['merge-base', '--is-ancestor', revision, candidate], worktree)
          } catch (error) {
            if (error instanceof CliError && error.exitCode === 1) throw new Error('Red revision must be between the pinned base and candidate')
            throw error
          }
        }
        if (await git(['status', '--porcelain=v1', '--untracked-files=all'], worktree)) {
          throw new Error('Test evidence requires a clean candidate worktree')
        }
      })
    return { candidate: head, base, generation }
  }
  /** Bind a retro observation to the clean current candidate, and prove a recorded repair changes its predecessor's tree. */
  async inspectDeliveryCandidate(ticketId: string, sessionId: string, candidate: string, prior: string | undefined, signal: AbortSignal) {
    const { checked: worktree, ...revision } = await this.inspectCandidate(ticketId, sessionId, candidate, 'Delivery', signal,
      async (directory, _base, stopped) => {
        const git = this.host.commands.git.bind(this.host.commands)
        stopped.throwIfAborted()
        if (prior) {
          try { await git(['merge-base', '--is-ancestor', prior, candidate], directory) }
          catch (error) {
            if (error instanceof CliError && error.exitCode === 1) throw new Error('Repair must descend from the candidate with the finding')
            throw error
          }
          const before = await git(['rev-parse', '--verify', `${prior}^{tree}`], directory)
          const after = await git(['rev-parse', '--verify', `${candidate}^{tree}`], directory)
          if (before === after) throw new Error('Repair must change the committed candidate tree')
        }
        return directory
      })
    const { commands } = this.host
    if ((await commands.git(['rev-parse', '--verify', 'HEAD'], worktree)).trim() !== candidate
      || (await commands.git(['status', '--porcelain=v1', '--untracked-files=all'], worktree)).trim()) {
      throw new Error('Delivery evidence requires an unchanged, clean candidate worktree')
    }
    signal.throwIfAborted()
    if (!this.writerAuthorized(ticketId, sessionId) || this.reviewGeneration(ticketId) !== revision.generation)
      throw new Error('Delivery evidence requires the active writer for this ticket worktree')
    return revision
  }
  /** Verify a review candidate is the clean current ticket HEAD and return its pinned base. */
  async inspectReviewCandidate(ticketId: string, _reviewerSession: string, candidate: string, signal: AbortSignal) {
    const revision = await this.inspectCandidate(ticketId, workerSessionId(ticketId), candidate, 'Review', signal,
      async (worktree, _base, stopped) => {
        stopped.throwIfAborted()
        if (await this.host.commands.git(['status', '--porcelain=v1', '--untracked-files=all'], worktree))
          throw new Error('Review requires a clean candidate worktree')
      })
    const worktree = this.host.store.tickets.get(ticketId)?.execution?.directory
    if (!worktree || (await this.host.commands.git(['rev-parse', '--verify', 'HEAD'], worktree)).trim() !== candidate
      || (await this.host.commands.git(['status', '--porcelain=v1', '--untracked-files=all'], worktree)).trim()) {
      throw new Error('Review candidate changed or became dirty before submission')
    }
    return { candidate: revision.candidate, base: revision.base }
  }
  /** Stop every loaded worker and release only claims this instance can prove fully idle before Store closes. */
  async shutdown(): Promise<void> {
    const sends = [...this.resuming.keys()].map(id => this.cancelRetries(id))
    const tickets = this.host.store.tickets.list()
    const agents = tickets.map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    for (const { collect } of this.left.values()) collect.abort()
    await Promise.allSettled(tickets.map(ticket => stopBackground(this.host.context, workerSessionId(ticket.id), 'dsh-superagent stopped', true)))
    const running = agents.filter(agent => agent.status !== 'idle')
    for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
    await Promise.allSettled(running.map(agent => agent.whenIdle()))
    await Promise.allSettled([...sends, ...[...this.holds.values()].map(hold => hold.drain)])
    const claims = [...this.claims.values()]
    const releases = await Promise.allSettled(claims.map(async claim => {
      if (this.holds.get(claim.ticket)?.drained === false) throw new Error('Ticket suspension could not confirm idle')
      await this.launching.get(claim.assignment)?.catch(() => {})
      await this.releaseClaim(claim, 'dsh-superagent stopped', true, true)
    }))
    for (const [index, release] of releases.entries()) if (release.status === 'rejected') {
      const claim = claims[index]!
      this.host.engine.rejectExecution(claim, `Shutdown could not confirm the writer idle: ${String(release.reason)}`)
      this.host.health.set({ state: 'error', detail: `Ticket ${claim.ticket} still holds its writer: ${String(release.reason)}`, at: now() })
    }
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    const held = this.holds.get(ticket.id)
    if (held?.slot && !held.drained) return true
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      if (!updated.plan) this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      this.requireWorkAllowed(ticket.id)
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    if (!current()) return
    // A ready/dropped report lets its own turn finish naturally. A later Assignment cannot wait forever for
    // that turn: request its cancellation now, preserving queued follow-ups, and still wait for actual idle.
    if (this.stopping.has(ticket.id)) {
      const old = this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)
      if (old?.status !== 'idle') old?.cancel({ kind: 'user' }, { keepInbox: true })
    }
    // The prior writer must finish its turn, jobs, subagents and preparation before another claim is reserved.
    await this.stopped(ticket.id)
    if (!current()) return
    const config = worktreePreparationConfig(this.host.store.settings().executor)
    if (!config.ok) throw new PrepareFailed(config.reason)
    const workspace = ticket.execution?.directory
    if (!workspace) throw new PrepareFailed('The ticket has no execution directory')
    if (!isAbsolute(workspace)) throw new PrepareFailed(`Ticket execution directory ${workspace} must be absolute`)
    const previous = ticket.execution?.ownership?.identity
    const persisted = this.claims.get(assignment.id) ?? this.persistedPlanClaim(ticket, assignment)
    const configured = await inspectRepository(this.host.commands, config.repository)
    const repository = previous ? await inspectRepository(this.host.commands, previous.repository) : configured
    const base = previous?.base ?? { ref: config.baseRef,
      sha: (await this.host.commands.git(['rev-parse', '--verify', `${config.baseRef}^{commit}`], repository.repository)).trim() }
    const identity: ExecutionIdentity = { ...repository, worktree: previous?.worktree ?? resolve(workspace),
      branch: previous?.branch ?? `agent/${ticket.execution!.name}`, base }
    if (!current()) return
    let claim: ExecutionClaim
    if (persisted) claim = persisted
    else {
      const reserved = this.host.engine.reserveExecution(ticket.id, assignment.id, identity)
      if (!reserved.ok) throw new PrepareFailed(reserved.reason)
      claim = reserved.value
    }
    this.claims.set(assignment.id, claim)
    // A saved ownership claim does not authorize a newly configured clone, or excuse a changed origin on reuse.
    const expectedSlug = this.host.commands.repository
    await validateRepositoryIdentity(this.host.commands, configured.repository, expectedSlug)
    if (previous) await validateRepositoryIdentity(this.host.commands, repository.repository, expectedSlug)
    if (!current()) throw new PrepareFailed('The ticket ended after reservation; its directory was not prepared')
    if (claim.branch !== `agent/${ticket.execution!.name}`) {
      throw new WorktreeRejected('wrong-branch', `Ticket branch ${claim.branch} differs from agent/${ticket.execution!.name}.`)
    }
    if (!sameDirectory(await targetPath(workspace), await targetPath(claim.worktree))) {
      throw new WorktreeRejected('invalid-target', `Ticket directory ${workspace} aliases another path; use its canonical absolute path.`)
    }
    let fresh: boolean
    try { await lstat(workspace); fresh = false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fresh = true }
    if (fresh && (persisted?.verified || repairOf(ticket))) throw new PrepareFailed('The previously verified Plan worktree no longer exists; refusing to create a replacement')
    if (fresh) {
      await validateWorktreeDestination(this.host.commands, claim.repository, workspace)
      if (!current()) throw new PrepareFailed('The ticket ended before its directory was prepared')
      await this.prepareDirectory(ticket, claim)
    }
    // Existing paths, including retries and recovered Plan claims, must pass Git inspection; never infer ownership from a directory.
    const inspected = await inspectWorktree(this.host.commands, { repository: claim.repository, directory: workspace,
      branch: claim.branch, base: claim.base, ticket: ticket.id, assignment: assignment.id, session: workerSessionId(ticket.id),
      ...fresh ? { mode: 'fresh' as const } : { mode: 'reuse' as const, previous: claim, repairCandidate: repairOf(ticket)?.candidate } })
    await verifyDirectory(workspace, this.host.context.subprocess, this.host.lifetime)
    const writer = this.host.store.tickets.get(ticket.id)?.assignments.find(item => item.id === assignment.id)?.writer
    const active = writer?.state === 'active' && writer.session === workerSessionId(ticket.id)
    if (active) {
      if (!claim.verified || ticket.execution?.preparation?.state !== 'verified') throw new PrepareFailed('The recovered Plan writer is not verified')
    } else {
      const verified = this.host.engine.recordExecutionVerified(claim, inspected)
      if (!verified.ok) throw new PrepareFailed(verified.reason)
      if (!current()) throw new PrepareFailed('The ticket ended while its worktree was verified')
      const sessionId = workerSessionId(ticket.id)
      if (!this.host.engine.acquireExecutionWriter(claim, sessionId)) {
        throw new PrepareFailed('The worker writer grant was refused; the Session was not started')
      }
    }
    this.restoredClaims.delete(claim)
    if (!current()) throw new PrepareFailed('The ticket ended before its worker Session was created')
    const sessionId = workerSessionId(ticket.id)
    const source = sourceTrigger(this.host, ticket)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) throw new PrepareFailed('The ticket ended while its worker Session was created')
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current() || !this.writerAuthorized(ticket.id, sessionId)) throw new PrepareFailed('The worker writer grant ended before delivery')
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current() || !this.writerAuthorized(ticket.id, sessionId)) throw new PrepareFailed('The worker writer grant ended before delivery')
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current() || !this.writerAuthorized(ticket.id, sessionId)) throw new Error('Launch authorization changed before worker delivery') },
      () => { if (retried.note) this.host.sessions.bindWorker(ticket.id, sessionId, true) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
      const id = ticketOfSession(agent.id)
      return id !== undefined && this.workHeld(id) ? { kind: 'reject' } : next()
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      const id = ticketOfSession(agent.id)
      if (id !== undefined && this.workHeld(id)) {
        if (status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
        else cancelled.delete(agent)
        return
      }
      if (status === 'running') { if (id !== undefined) this.settling.get(id)?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) {
        if (!waitsForPerson(ticket)) { void this.background(this.workerIdle(ticket, assignment, agent)); return }
        const { promise: handoff, resolve: done } = Promise.withResolvers<void>()
        this.handoffs.add(handoff)
        void handoff.then(() => { this.handoffs.delete(handoff) })
        const idle = this.workerIdle(ticket, assignment, agent, done)
        void idle.then(done, done)
        void this.background(idle)
      }
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => (input.kind === 'trigger' || input.kind === 'mainline-repair') && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing() || this.workHeld(ticket.id)
        || (error instanceof Error && 'code' in error && error.code === RUN_LIMIT_REFUSAL)) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { if (!this.workHeld(ticket.id)) this.failed(ticket.id, String(error)) }))
    }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const id of this.resuming.keys()) void this.cancelRetries(id)
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (latest && !this.claims.has(latest.id)) {
        const persisted = this.persistedPlanClaim(ticket, latest)
        if (persisted) {
          this.claims.set(latest.id, persisted)
          this.restoredClaims.add(persisted)
        }
      }
      if (this.host.credentialBlocked?.(ticket.id)) {
        this.suspendForCredential(ticket.id)
        continue // No interruption note, retry or launch while the durable blocker is active.
      }
      if (this.workHeld(ticket.id)) continue
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true, running.id)
        this.host.engine.assignmentInterrupted(ticket.id, running.id, recoveryNote)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    const retries = this.resuming.get(assignmentId) ?? new Set<TurnRetry>()
    const retry: TurnRetry = {}
    retries.add(retry)
    this.resuming.set(assignmentId, retries)
    const finish = () => {
      retries.delete(retry)
      if (!retries.size && this.resuming.get(assignmentId) === retries) this.resuming.delete(assignmentId)
    }
    const after = (ms: number) => {
      retry.timer = setTimeout(go, ms)
      retry.timer.unref?.()
    }
    const go = () => {
      delete retry.timer
      if (this.host.closing() || !retries.has(retry) || this.workHeld(ticketId)) { finish(); return }
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { finish(); return }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) { after(SLOT_WAIT_MS); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        after(SLOT_WAIT_MS); return
      }
      // Register the promise before entering Sessions so a reentrant suspension joins this send too.
      retry.sending = Promise.resolve().then(async () => {
        if (retries.has(retry)) await this.host.sessions.retry(ticketId, sessionId, `retry:${assignmentId}:${tries}`, text)
      }).catch(failure => {
        if (retries.has(retry) && !this.host.closing() && !this.workHeld(ticketId)) this.failed(ticketId, String(failure))
      }).finally(() => {
        if (waking) this.slots.free(ticketId)
        finish()
      })
      void this.background(retry.sending)
    }
    after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1))
  }
  /** Cancel every scheduled retry synchronously, and join sends that already crossed the timer boundary. */
  private async cancelRetries(assignmentId: string): Promise<void> {
    const retries = this.resuming.get(assignmentId)
    if (!retries) return
    this.resuming.delete(assignmentId)
    const sends: Promise<void>[] = []
    for (const retry of retries) {
      clearTimeout(retry.timer)
      if (retry.sending) sends.push(retry.sending)
    }
    retries.clear()
    await Promise.allSettled(sends)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended || left.collect.signal.aborted || this.workHeld(ticketId)) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent, handoffDone?: () => void): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      if (this.workHeld(ticket.id)) return undefined
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      // Failed or blocked work holds no writer once its turn and subagents have stopped. Jobs left to a person
      // keep ownership until they finish or the Assignment is stopped; a later routed Input re-verifies the tree.
      if (waitsForPerson(before)) {
        const prior = this.stopping.get(ticket.id)
        const release = (async () => {
          if (prior) await prior
          const current = live()
          if (current && waitsForPerson(current) && agent.status === 'idle' && !runningJobs(this.host.context, agent.id).length) {
            const claim = this.claims.get(idle.id)
            if (claim) await this.releaseClaim(claim, 'Worker handed off after a failed or blocked report', true, true)
          }
        })()
        this.track(ticket.id, release)
        await release
      }
      handoffDone?.()
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    handoffDone?.()
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      // Plan reports are queryable state; proactive Plan notices use the scoped attention route only.
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      if (updated.plan) return
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
