/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { UserError, key, latestReport, reached, reviewStatus, runningAssignment, threadKey, viewDelivery, type Assignment, type Ticket,
  type Trigger } from '../core/index.ts'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { inspectWorktree } from '../executor/worktree.ts'
import { docTreeImpactSchema, docTreeScopeSchema } from '../executor/doc-tree.ts'
import { readGithub } from '../sources/github-read.ts'
import { actionsEvidence, type ActionsEvidence } from '../sources/actions-evidence.ts'
import { githubKind, type GithubConfig } from '../sources/github.ts'
import { feishuReferences, feishuRead } from '../sources/feishu-read.ts'
import { feishuRef } from '../sources/feishu.ts'
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
import { threadTitle } from './views/records.ts'
import { transcriptEntry } from './context.ts'
import { builtInParts, defaultPrompts, SKILL_PREFIX } from './prompts.ts'
import { bundledSkills, isBundledSkill } from './skill-files.ts'
import type { Context } from '@deepseek-ai/cordis'
import { CliError, type Commands } from '../infra/commands.ts'
import { sameDirectory } from '../infra/environment.ts'
import { KV } from '../kv.ts'
import type { Handoffs } from './handoffs.ts'
import { PlanDeliveryReceiptSchema, type Plans } from './plans.ts'
import { mainlineAttempts, mainlineIntent, type CheckDeliveryTarget, type DeliveryTargetObservation,
  type MainlineCiBinding, type MainlineIntent, type MergeApproval } from './mainline-queue.ts'
import type { ProjectMeter } from './project-meter.ts'
import type { ScopedAttention } from './scoped-attention.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { SessionMeter } from './session-meter.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'newest ticket cards and their current stage' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'handoff/<id>', holds: 'confirmed project, intent and planner question/answer' },
  { name: 'spec/<id>', holds: 'published acceptance and test interfaces, or pending' },
  { name: 'plan/<id>', holds: 'Plan graph, role totals, Frontier and claims with background' },
  { name: 'plan/<id>/node/<node-id>', holds: 'node claim or waiting reason, delivery and instructions' },
  { name: 'plan/<id>/attention', holds: 'Plan status counts and credential actions' },
  { name: 'ticket/<id>', holds: 'ticket, claim, worktree, active writer and work history', executor: true },
  { name: 'ticket/<id>/mainline', holds: 'mainline attempts, actual Git verification and formal delivery blockers (not a receipt)', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/delivery-check', holds: 'candidate queue readiness, separate formal_delivery status for Plan tickets, and paginated acceptance, evidence and required CI', executor: true },
  { name: 'ticket/<id>/delivery-observation/<n>', holds: 'one durable delivery observation', executor: true },
  { name: 'retro-followups', holds: 'optional retro backlog, independent of Plan delivery' },
  { name: 'ticket/<id>/reviews', holds: 'reviews', executor: true },
  { name: 'ticket/<id>/review/<id>', holds: 'one review', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'assignment pages, newest first', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to and the messages around it on its thread',
    executor: true },
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized' },
  { name: 'settings/<block>', holds: 'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or '
    + 'source:<id>' },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  { name: 'session/<id>', holds: 'context window sample and cumulative token buckets, including coverage gaps; not a bill' },
  { name: 'project/meter', holds: 'deduplicated usage including shared overhead and Session details' },
  { name: 'project/attention', holds: 'project Plan status counts and credential actions' },
  { name: 'plan/<id>/meter', holds: 'Plan usage with shared overhead separate' },
  { name: 'ticket/<id>/meter', holds: 'Ticket usage with shared overhead separate' },
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  { name: 'github/…', holds: 'a GitHub original, as the dsh-superagent-github skill describes', executor: true },
  { name: 'actions/<ticket|plan>/<id>/commit/<40 lowercase hex SHA>', holds: 'GitHub Actions jobs and artifacts for one owned ticket or handoff at exactly this commit; reports missing required checks, without CI logs' },
]
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(({ name, holds }) => executor ? `${name}:` : `${name}: ${holds}`).join('; ')

export interface ResourceHost {
  ownsSession?(id: string): boolean | Promise<boolean>
  reviewGeneration?(ticketId: string): number | undefined
  credentialBlocked?(ticketId: string): boolean
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly handoffs?: Pick<Handoffs, 'spec'>
  readonly plans?: Pick<Plans, 'get'>
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  readonly context: Context
  readonly meter: Pick<SessionMeter, 'read'>
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
export interface MainResourceHost extends ResourceHost {
  readonly projectMeter: Pick<ProjectMeter, 'read'>
  readonly attention: Pick<ScopedAttention, 'summary' | 'forTicket'>
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
  readonly handoffs: Pick<Handoffs, 'get' | 'spec'>
  readonly plans: Pick<Plans, 'get' | 'view' | 'node'>
}

/** Resolve only this Slice Ticket's registered acceptance, never criteria supplied with a report. */
export function deliveryAcceptance(host: ResourceHost, ticket: Ticket): readonly { id: string; text: string }[] {
  const binding = ticket.plan
  if (!binding) return []
  const plan = host.plans?.get(binding.planId)
  if (!plan || plan.id !== binding.planId || plan.status !== 'registered') return []
  const node = plan.nodes.find(node => node.id === binding.nodeId && node.role === binding.role)
  const spec = host.handoffs?.spec(plan.handoffId)
  if (!node || !spec || spec.id !== plan.specId || spec.handoffId !== plan.handoffId) return []
  const criteria: { id: string; text: string }[] = []
  for (const index of node.acceptance) {
    const item = spec.acceptance[index - 1]
    if (!item?.statement.trim() || !item.observable.trim()) return []
    criteria.push({ id: String(index), text: `${item.statement}\nObservable: ${item.observable}` })
  }
  return criteria
}

interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
const DEFAULT_LIST_SIZE = 20, MAX_LIST_SIZE = 50
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? DEFAULT_LIST_SIZE, MAX_LIST_SIZE)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}

async function projectMeter(read: Read, scope: 'project' | 'plan' | 'ticket', id?: string) {
  const view = await main(read).projectMeter.read(scope, id, read.signal)
  if (!view) {
    if (scope === 'plan' && id) throw new UserError('unknownPlan', { id })
    if (scope === 'ticket') throw new UserError('unknownTicket')
    throw new Error('Unknown project')
  }
  // Page only the detail list. The totals and their coverage describe the full scope on every page.
  const end = read.offset + Math.min(read.limit ?? DEFAULT_LIST_SIZE, MAX_LIST_SIZE)
  if (read.offset === 0 && end >= view.sessions.length) return view
  return { ...view, sessions: view.sessions.slice(read.offset, end), next_offset: end < view.sessions.length ? end : null }
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
const pullEvidence = z.looseObject({
  head: z.looseObject({ sha: commitSha, ref: z.string().optional(), repo: z.looseObject({ full_name: z.string() }).nullable() }),
  base: z.looseObject({ sha: commitSha, ref: z.string().optional(), repo: z.looseObject({ full_name: z.string() }).nullable().optional() }),
  merge_commit_sha: commitSha.nullable(), state: z.string().optional(),
})
/** A local commit belongs to work only when its checkout root and GitHub remote match the configured repository. */
async function verifyCheckout(commands: Commands, directory: string | undefined, sha: string, kind: 'ticket' | 'plan'): Promise<void> {
  const refused = `Commit is not verified for this ${kind}`
  if (!directory?.trim()) throw new Error(refused)
  try {
    const root = (await commands.git(['rev-parse', '--show-toplevel'], directory)).trim()
    if (!sameDirectory(root, directory)) throw new Error(refused)
    const remote = (await commands.git(['remote', 'get-url', 'origin'], directory)).trim().replace(/\.git\/?$/i, '')
    const repository = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/i.exec(remote)?.[1]
    if (repository?.toLowerCase() !== commands.repository.toLowerCase()) throw new Error(refused)
    if ((await commands.git(['rev-parse', '--verify', 'HEAD'], directory)).trim() !== sha) throw new Error(refused)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new Error(refused, { cause: error })
  }
}

type RequiredChecks = readonly GithubConfig['requiredChecks'][number][]

interface TicketPull { number: unknown; own: boolean }
function ticketPull(host: ResourceHost, ticket: Ticket): TicketPull | undefined {
  // Only a persisted association can supply the PR used to match Actions runs.
  const ownPull = ticket.follows?.findLast(follow => follow.own && follow.thread.startsWith('github:'))
  if (ownPull) return { number: Number(ownPull.thread.slice('github:'.length)), own: true }
  const origin = host.store.triggers.get(ticket.origin.triggerId)
  if (origin?.source === 'github' && origin.meta.isPr === true) return { number: origin.meta.number, own: false }
}

/** The delivery reader supplies its pinned base and already-verified worktree candidate, not a caller SHA. */
async function ticketActions(commands: Commands, ticket: Ticket, sha: string, required: RequiredChecks,
  associatedPull: TicketPull | undefined, base?: string, checkout?: DeliveryCheckout): Promise<{ evidence: ActionsEvidence; ci?: MainlineCiBinding }> {
  const work = { kind: 'ticket', id: ticket.id } as const
  if (!associatedPull || base !== undefined) await verifyCheckout(commands, ticket.execution?.directory, sha, 'ticket')
  if (!associatedPull) return { evidence: await actionsEvidence(commands, work, sha, required, undefined, checkout?.branch),
    ...checkout ? { ci: { branch: checkout.branch } } : {} }
  const { number } = associatedPull
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error('Ticket has no verifiable pull request')
  const readPull = () => commands.api(pullEvidence, `pulls/${number}`)
  const matchesTarget = (pr: z.infer<typeof pullEvidence>) => !checkout || (
    `refs/heads/${pr.base.ref}` === checkout.baseRef && pr.base.repo?.full_name.toLowerCase() === commands.repository.toLowerCase() &&
    associatedPull.own && pr.head.ref === checkout.branch)
  const pull = await readPull()
  if (pull.head.sha !== sha || !pull.head.repo || (associatedPull.own && pull.head.repo.full_name.toLowerCase() !== commands.repository.toLowerCase()) ||
    (base !== undefined && (pull.base.sha !== base || pull.state !== 'open' || !matchesTarget(pull)))) throw new Error('Commit is not verified for this ticket')
  const evidence = await actionsEvidence(commands, work, sha, required,
    { number, baseSha: pull.base.sha, ...pull.merge_commit_sha ? { mergeSha: pull.merge_commit_sha } : {} })
  if (base !== undefined) {
    const current = await readPull()
    if (current.state !== 'open' || current.head.sha !== pull.head.sha || current.base.sha !== pull.base.sha
      || current.head.repo?.full_name !== pull.head.repo.full_name || !matchesTarget(current))
      throw new Error('Pull request changed while checking delivery CI')
  }
  return { evidence, ci: { pull: number } }
}

interface DeliveryState {
  ticket: Ticket
  assignment: Assignment | undefined
  generation: number | undefined
  criteria: readonly { id: string; text: string }[]
  paused: boolean
  credentialBlocked: boolean
  required: RequiredChecks
  pull: TicketPull | undefined
  stamp: string
}

function deliveryState(host: ResourceHost, id: string): DeliveryState {
  const ticket = host.store.tickets.get(id)
  if (!ticket) throw new UserError('unknownTicket')
  const assignment = ticket.assignments.at(-1)
  const criteria = deliveryAcceptance(host, ticket)
  const generation = host.reviewGeneration?.(id)
  const credentialBlocked = host.credentialBlocked?.(id) === true
  const settings = host.store.settings()
  const required = githubKind.schema.parse(settings.sources.github?.config ?? {}).requiredChecks
  const pull = required.length ? ticketPull(host, ticket) : undefined
  const stamp = createHash('sha256').update(JSON.stringify([host.store.get(KV.settings.revision), settings.paused, credentialBlocked,
    settings.executor, settings.sources.github, ticket.plan, ticket.ended, ticket.execution, ticket.assignments, ticket.deliveryCheck, generation, criteria, pull])).digest('hex')
  return { ticket, assignment, generation, criteria, paused: settings.paused, credentialBlocked, required, pull, stamp }
}

interface DeliveryCheckout {
  worktree: string
  base: string
  baseRef: string
  candidate: string
  branch: string
  clean: boolean
}

/** Read actual Git identities rather than using a previously reported candidate or PR status. */
async function deliveryCheckout(commands: Commands, { ticket, assignment }: DeliveryState, signal?: AbortSignal, formal?: true): Promise<DeliveryCheckout | undefined> {
  const { execution } = ticket
  const ownership = execution?.ownership, session = assignment?.writer?.session
  if (!execution || !ownership?.verified || !assignment || !session || execution.preparation?.state !== 'verified' ||
    !sameDirectory(execution.directory, ownership.identity.worktree) || execution.base?.sha !== ownership.identity.base.sha ||
    execution.base?.ref !== ownership.identity.base.ref) return undefined
  const { identity } = ownership
  try {
    const checkout = await inspectWorktree(commands, { ...identity, directory: identity.worktree, ticket: ticket.id,
      assignment: assignment.id, session, mode: 'reuse',
      previous: { ...identity, ticket: ownership.ticket, assignment: assignment.id, generation: ownership.generation, verified: true } })
    if (formal) await verifyCheckout(commands, checkout.worktree, checkout.head, 'ticket')
    // Sample branch, candidate and cleanliness together, after every other checkout read.
    const status = (await commands.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], checkout.worktree)).split('\0')
    if (!status.includes(`# branch.oid ${checkout.head}`) || !status.includes(`# branch.head ${checkout.branch}`)) return undefined
    const clean = status.every(record => record === '' || record.startsWith('# '))
    return { worktree: checkout.worktree, base: checkout.base.sha, baseRef: checkout.base.ref, candidate: checkout.head,
      branch: checkout.branch, clean }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'AbortError') throw error
    return undefined
  }
}

/** Compare the same ticket and checkout observations before and after remote evidence collection. */
const deliveryStamp = (state: DeliveryState, checkout: DeliveryCheckout | undefined) => JSON.stringify([state.stamp, checkout])

const ciBinding = z.union([z.strictObject({ pull: z.number().int().positive() }), z.strictObject({ branch: z.string().min(1) })])

const scopedDocuments = z.object({ scope: docTreeScopeSchema, impact: docTreeImpactSchema })

async function inspectDelivery(host: ResourceHost, id: string, signal?: AbortSignal,
  scope?: { replay: MainlineIntent | undefined; formal?: never } | { replay: MainlineIntent; formal: true; verify: CheckDeliveryTarget }) {
  const replay = scope?.replay, formal = scope?.formal
  const commands = host.commands.withSignal(signal)
  let state = deliveryState(host, id)
  let checkout = await deliveryCheckout(commands, state, signal, formal)
  signal?.throwIfAborted()
  let latest = deliveryState(host, id)
  let changed = state.stamp !== latest.stamp

  const local = () => {
    const { ticket, assignment, generation, criteria, paused } = state
    const writer = assignment?.writer, active = ticket.execution?.active_writer
    const ownsLease = generation !== undefined && generation === writer?.generation &&
      generation === ticket.execution?.ownership?.generation &&
      (!formal || (writer.state === 'active' && active?.assignment === assignment?.id && active?.session === writer.session))
    // For an existing queued intent only, the exact originally approved pair can resume after the same writer was
    // confirmed idle. A held or replaced lease cannot stand in for a live generation.
    const idleReplay = replay && assignment?.id === replay.assignment && checkout?.base === replay.base &&
      checkout.candidate === replay.candidate && assignment.writer?.state === 'idle' && !ticket.execution?.active_writer &&
      assignment.writer.generation === replay.generation && ticket.execution?.ownership?.generation === replay.generation
    const approvedGeneration = ownsLease ? generation : idleReplay ? replay.generation : undefined
    const target = checkout?.clean && approvedGeneration !== undefined ?
      { base: checkout.base, candidate: checkout.candidate, generation: approvedGeneration } : undefined
    const reviews = ticket.assignments.flatMap(item => item.reviews?.evidence ?? [])
    const view = viewDelivery(ticket.deliveryCheck, target, reviews, criteria, id)
    const missing = new Set(view.missing)
    if (!view.ready && missing.size === 0) missing.add('delivery_evidence')
    if (!criteria.length) missing.add('registered_acceptance')
    if (approvedGeneration === undefined) missing.add('assignment_lease')
    if (!checkout) missing.add('verified_worktree')
    else if (!checkout.clean) missing.add('clean_worktree')
    if (checkout && ticket.plan) {
      const { baseRef, repository } = host.store.settings().executor
      const pinnedHome = ticket.execution?.ownership?.identity.repository
      if (!checkout.baseRef.startsWith('refs/heads/') || checkout.baseRef !== baseRef?.trim() ||
          !repository?.trim() || !pinnedHome || !sameDirectory(pinnedHome, repository)) missing.add('mainline_target')
    }
    if (changed) missing.add('delivery_target_changed')
    if (paused) missing.add('project_paused')
    if (state.credentialBlocked) missing.add('credential_blocked')
    const outcome = ticket.ended?.outcome, report = assignment?.report?.state
    if (outcome || report === 'failed' || report === 'blocked' || report === 'dropped') {
      missing.add('ticket_not_queueable')
    }
    if (scope?.formal) {
      const { replay } = scope
      if ((checkout && (checkout.base !== replay.base || checkout.candidate !== replay.candidate)) ||
          assignment?.id !== replay.assignment || writer?.generation !== replay.generation) missing.add('delivery_target_changed')
      if ((checkout && checkout.baseRef !== replay.target.ref) || ticket.execution?.ownership?.identity.repository !== replay.target.repository ||
          host.commands.repository.toLowerCase() !== replay.target.slug.toLowerCase()) missing.add('mainline_target')
      if (target && missing.has('dual-review')) {
        for (const axis of ['standards', 'spec'] as const) {
          const lane = view.reviews.find(review => review.axis === axis)
          if (!lane || lane !== view.reviews.findLast(review => review.axis === axis) ||
              lane.conclusion !== 'passed' || lane.blockers.length) missing.add(`dual-review:${axis}`)
        }
      }
    }
    return { view, missing, target }
  }

  if (changed) { state = latest; checkout = undefined }
  let result = local()
  let actions: ActionsEvidence | undefined
  let ci: MainlineCiBinding | undefined
  let ciFailure: { code?: number; exit_code?: number } | undefined
  let ciStatus = state.required.length ? 'pending_local_gate' : 'required_checks_unconfigured'
  let observation: DeliveryTargetObservation | undefined
  if (result.target && result.view.ready && result.missing.size === 0 && state.required.length) {
    const { base, candidate } = result.target
    try {
      if (!state.required.every(check => check.workflowId)) ciStatus = 'required_workflow_unconfigured'
      else if (!commitSha.safeParse(candidate).success || !commitSha.safeParse(base).success) ciStatus = 'unsupported_revision'
      else {
        if (scope?.formal) {
          // Only the final prewrite binding may select evidence. A push can itself close the PR or advance its base.
          const fixed = ciBinding.safeParse(scope.replay.ci)
          if (fixed.success) {
            const work = { kind: 'ticket', id } as const
            if ('pull' in fixed.data) actions = await actionsEvidence(commands, work, candidate, state.required,
              { number: fixed.data.pull, baseSha: scope.replay.base })
            else if (fixed.data.branch === checkout?.branch) actions = await actionsEvidence(commands, work, candidate, state.required,
              undefined, fixed.data.branch)
            if (actions) ci = fixed.data
          }
        } else {
          ({ evidence: actions, ci } = await ticketActions(commands, state.ticket, candidate, state.required, state.pull, base, checkout))
        }
        ciStatus = actions?.satisfied ? 'passed' : 'not_passed'
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      ciStatus = 'unavailable'
      if (error instanceof CliError) ciFailure = { ...error.code === undefined ? {} : { code: error.code },
        ...error.exitCode === undefined ? {} : { exit_code: error.exitCode } }
    }
    if (ciStatus === 'passed' && scope?.formal) {
      const docs = scopedDocuments.safeParse(result.view.docs?.evidence)
      if (docs.success) {
        const { scope: reviewed, impact } = docs.data
        observation = await scope.verify(impact.kind === 'updated' ? { ...reviewed, documents: impact.documents } : reviewed)
      } else observation = { missing: 'docs' }
    }
    // Re-read the worktree and lease after all external evidence, including the final Git target observation.
    const prior = deliveryStamp(state, checkout)
    latest = deliveryState(host, id)
    checkout = await deliveryCheckout(commands, latest, signal, formal)
    signal?.throwIfAborted()
    state = deliveryState(host, id)
    if (latest.stamp !== state.stamp) checkout = undefined
    changed = prior !== deliveryStamp(state, checkout) || (actions !== undefined &&
      actions.repository.toLowerCase() !== commands.repository.toLowerCase())
    result = local()
    if (changed) {
      actions = undefined
      ciFailure = undefined
      ciStatus = 'stale'
    }
  }
  if (observation && 'missing' in observation) result.missing.add(observation.missing)
  if (ciStatus !== 'passed' && (!formal || (ciStatus !== 'pending_local_gate' && ciStatus !== 'stale'))) result.missing.add('required_ci')
  const identity = state.ticket.execution?.ownership?.identity
  const approval: MergeApproval | undefined = scope && result.missing.size === 0 && checkout && identity && result.target && state.assignment && ci
    ? { target: { repository: identity.repository, slug: commands.repository, ref: checkout.baseRef }, base: checkout.base,
      candidate: checkout.candidate, generation: result.target.generation, assignment: state.assignment.id, stamp: state.stamp, ci }
    : undefined
  return { state, checkout, local: result.view, missing: [...result.missing], actions, ciStatus, ciFailure, approval, observation }
}

/** Obtain the actual queue authorization from fresh, version-matched evidence, never from a read page or Worker report. */
export async function approveMainline(host: ResourceHost, id: string, candidate: string, signal?: AbortSignal,
  replay?: MainlineIntent): Promise<MergeApproval> {
  const initial = deliveryState(host, id)
  if (!initial.ticket.plan) throw new UserError('mainlineRefused', { reason: 'Only candidates of registered Plan Tickets may enter the mainline queue' })
  const { approval, missing } = await inspectDelivery(host, id, signal, { replay })
  if (!approval || approval.candidate !== candidate) {
    throw new UserError('mainlineNotReady', { missing: missing.join(', ') || 'candidate changed' })
  }
  return approval
}

/** Bind the mainline observation to fresh candidate evidence before authorizing the closing transaction. */
export async function inspectFormalDelivery(host: ResourceHost, intent: MainlineIntent, verify: CheckDeliveryTarget, signal?: AbortSignal) {
  const { missing, approval, observation } = await inspectDelivery(host, intent.ticket_id, signal, { replay: intent, formal: true, verify })
  return { missing, ...(approval ? { approval } : {}), ...(observation ? { observation } : {}) }
}

/** Recheck non-Git authorization synchronously at the point that starts the Git write. */
export function authorizeMainline(host: ResourceHost, id: string, approval: MergeApproval): void {
  const state = deliveryState(host, id)
  if (state.stamp !== approval.stamp || host.commands.repository.toLowerCase() !== approval.target.slug.toLowerCase()) {
    throw new UserError('mainlineRefused', { reason: 'Mainline approval changed before the write' })
  }
}

function formalDeliverySummary(host: ResourceHost, ticket: Ticket, attempt: MainlineIntent | undefined, missing: string[]) {
  const plan = ticket.plan
  if (!plan) return undefined
  // Worker readers need no Plan administration access. A node receipt on its own cannot prove the ticket was closed.
  if (ticket.ended?.by === 'delivery' && ticket.ended.outcome === 'merged') {
    const node = host.store.get(KV.plans.node(plan.planId, plan.nodeId))
    if (node?.status === 'delivered' && node.planId === plan.planId && node.nodeId === plan.nodeId &&
        node.claim?.ticketId === ticket.id && node.claim.planId === plan.planId && node.claim.nodeId === plan.nodeId) {
      const receipt = PlanDeliveryReceiptSchema.safeParse(node.delivery)
      if (receipt.success && receipt.data.ticketId === ticket.id && receipt.data.assignmentId === ticket.assignments.at(-1)?.id) {
        return { status: 'delivered' as const, receipt: receipt.data }
      }
    }
    return { status: 'blocked' as const, missing: ['plan_claim'] }
  }
  if (attempt?.delivery_missing !== undefined) return { status: 'blocked' as const, missing: attempt.delivery_missing }
  if (attempt?.status === 'verified') return { status: 'pending' as const }
  return { status: 'blocked' as const, missing: [...missing, 'mainline_verification'] }
}

async function deliveryPage(read: Read, id: string) {
  const { host, signal, offset } = read
  const cacheKey = `${read.sessionId}:${read.resource}`
  // Later pages are historical evidence from this Session's offset 0; they never announce queue readiness.
  if (offset !== 0) {
    const cached = host.pages.get(cacheKey)
    if (!cached) throw new Error('Read this delivery-check from offset 0 first')
    return text(read, cached)
  }
  const { state, checkout, local, missing, actions, ciStatus, ciFailure } = await inspectDelivery(host, id, signal)
  const attempt = mainlineIntent(host.store, id)
  const mainline = attempt ?? { status: 'pending_merge' as const }
  // Read the ticket and receipt together: the formal gate can finish while the paginated candidate observation awaits Actions.
  const ticket = state.ticket.plan ? host.store.tickets.get(id) : state.ticket
  if (!ticket) throw new UserError('unknownTicket')
  const formal = formalDeliverySummary(host, ticket, attempt, missing)
  const ready = missing.length === 0 && ticket.ended?.by !== 'delivery'
  const header = { ticket_id: id, assignment_id: state.assignment?.id ?? null,
    base: checkout?.base ?? state.ticket.execution?.base?.sha ?? null, candidate: checkout?.candidate ?? null,
    generation: state.generation ?? null, clean: checkout?.clean ?? false, missing, ready, ci_status: ciStatus,
    status: ready ? 'ready_to_queue' as const : 'return_for_recheck' as const, mainline, ...formal ? { formal_delivery: formal } : {} }
  const body = JSON.stringify({ observed_at: new Date().toISOString(), ticket_id: id, assignment_id: header.assignment_id,
    base: header.base, candidate: header.candidate, generation: header.generation, mainline: header.mainline,
    criteria: state.criteria, local,
    revisions: checkout ? { base: { worktree: checkout.worktree, sha: checkout.base, ref: checkout.baseRef },
      candidate: { worktree: checkout.worktree, sha: checkout.candidate, ref: `refs/heads/${checkout.branch}` } } : null,
    ci: { status: ciStatus, required: state.required, evidence: actions ?? null, ...ciFailure ? { failure: ciFailure } : {} } })
  const page = text(read, body)
  host.pages.set(cacheKey, body)
  return { ...header, ...page }
}

const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events
}

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    const host = main(read), tickets = host.store.tickets.list()
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
  }],
  ['retro-followups', read => {
    const items = main(read).store.tickets.list().flatMap(ticket => {
      const backlog = new Map<string, { id: string; ticket_id: string; summary: string; created_at: string; read: string }>()
      for (const [index, event] of ticket.deliveryCheck?.events.entries() ?? []) {
        if (event.kind !== 'first-retro' && event.kind !== 'final-retro') continue
        for (const finding of event.findings) {
          if (finding.category !== 'optional' || backlog.has(finding.id)) continue
          backlog.set(finding.id, { id: key('retro-followup', ticket.id, finding.id), ticket_id: ticket.id,
            summary: finding.summary, created_at: event.at, read: `ticket/${ticket.id}/delivery-observation/${index}` })
        }
      }
      return [...backlog.values()]
    }).sort((a, b) => b.created_at.localeCompare(a.created_at))
    return list(read, (offset, count) => items.slice(offset, offset + count))
  }],
  ['triggers', read => {
    const { store } = main(read)
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Sessions may only read threads their own ticket subscribes to or follows.
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    // Worker sessions cannot inspect other tickets or decisions on a shared thread.
    if (ticketId) return { ...card, ...page }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  ['decisions', read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  ['handoff/', read => {
    const handoff = main(read).handoffs.get(read.rest)
    if (!handoff || !read.rest || read.rest.includes('/')) throw new Error('Unknown handoff')
    return handoff
  }],
  ['spec/', read => {
    const host = main(read), handoff = host.handoffs.get(read.rest)
    if (!handoff || !read.rest || read.rest.includes('/')) throw new Error('Unknown handoff')
    return host.handoffs.spec(read.rest) ?? { handoffId: read.rest, status: 'pending' }
  }],
  ['plan/', read => {
    const { plans, handoffs, attention } = main(read)
    const [id, section, nodeId, ...extra] = read.rest.split('/')
    if (id && section === 'meter' && nodeId === undefined) return projectMeter(read, 'plan', id)
    if (id && section === 'attention' && nodeId === undefined) return attention.summary(id)
    if (!id || extra.length || (section !== undefined && (section !== 'node' || !nodeId))) throw new Error('Unknown plan resource')
    if (nodeId) {
      const node = plans.node(id, nodeId)
      if (!node) throw new UserError('unknownPlanNode', { id, node: nodeId })
      const { instructions, ...detail } = node
      const page = list(read, (offset, count) => instructions.slice(offset, offset + count))
      const action = detail.claim && attention.forTicket(detail.claim.ticketId)
      return { ...detail, ...(action ? { attention: action } : {}), instructions: page.items, next_offset: page.next_offset }
    }
    const handoff = handoffs.get(id)
    if (!handoff) throw new UserError('unknownPlan', { id })
    const graph = plans.view(id)
    if (graph) {
      const { nodes, context, ...header } = graph
      const nodePage = list(read, (offset, count) => nodes.slice(offset, offset + count).map(node => {
        const action = node.claim && attention.forTicket(node.claim.ticketId)
        return action ? { ...node, attention: action } : node
      }))
      const contextPage = list(read, (offset, count) => context.slice(offset, offset + count))
      return { ...header, nodes: nodePage.items, context: contextPage.items, next_offset: nodePage.next_offset ?? contextPage.next_offset }
    }
    if (!handoff.spec) return { id, handoffId: id, status: 'awaiting-spec' }
    return { id, handoffId: id, specId: handoff.spec.id,
      status: handoff.spec.acceptance.every(item => item.delivery) ? 'pending' : 'unclassified-spec' }
  }],
  ['settings', read => main(read).settings.view()],
  ['settings/', read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
    // panel shows and the next save drops.
    const changes = host.prompts.defaultChanged(current.config)
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(isBundledSkill).map(name => bundledSkills[name].name),
        team: skills.filter(name => !isBundledSkill(name)).map(name => `${SKILL_PREFIX}${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    const bound = host.promptVersion(sessionId)
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('Unknown or inaccessible prompt version')
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('Unknown preview for this Session')
    return text(read, body)
  }],
  ['models', async read => {
    const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings()
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    return { default: catalog.default, roles, failures: catalog.failures,
      providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  ['models/', async read => {
    const models = (await main(read).context.sessionController.modelCatalog()).groups.find(group => group.id === read.rest)?.models
    if (!models) throw new Error('Unknown model provider')
    return list(read, (offset, count) => models.slice(offset, offset + count))
  }],
  // One reading for the Hub and the panel: the meter owns the persistence cursor, so neither entry recomputes usage.
  ['session/', async read => {
    const host = main(read)
    if ((await host.ownsSession?.(read.rest)) === false) throw new Error('Unknown session')
    const view = await host.meter.read(read.rest, read.signal)
    if (!view) throw new Error('Unknown session')
    return view
  }],
  ['project/meter', read => projectMeter(read, 'project')],
  ['project/attention', read => main(read).attention.summary()],
  ['feishu/', async read => {
    const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
    const ref = feishuRef(source)
    if (!ref) throw new Error('A Feishu source trigger is required')
    const commands = read.host.commands.withSignal(read.signal)
    return sourcePage(read, 'feishu', () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()))
  }],
  ['actions/', read => {
    const host = main(read)
    const match = /^(ticket|plan)\/([^/]+)\/commit\/([0-9a-f]{40})$/.exec(read.rest)
    if (!match || match[0] !== read.rest) throw new Error('Use actions/<ticket|plan>/<id>/commit/<40 lowercase hex SHA>')
    const [, kind, id, sha] = match
    if ((kind !== 'ticket' && kind !== 'plan') || !id || !sha) throw new Error('Use actions/<ticket|plan>/<id>/commit/<40 lowercase hex SHA>')
    const ticket = kind === 'ticket' ? host.store.tickets.get(id) : undefined
    const handoff = kind === 'plan' ? host.handoffs.get(id) : undefined
    if (!ticket && !handoff) throw new Error('Unknown ticket or handoff')
    const commands = host.commands.withSignal(read.signal)
    const required = githubKind.schema.parse(host.store.settings().sources.github?.config ?? {}).requiredChecks
    return sourcePage(read, 'github', async () => {
      if (ticket) return (await ticketActions(commands, ticket, sha, required, ticketPull(host, ticket))).evidence
      if (handoff) {
        if (handoff.project.repository.toLowerCase() !== commands.repository.toLowerCase()) throw new Error('Handoff repository differs from configured repository')
        await verifyCheckout(commands, handoff.project.workspace, sha, kind)
      }
      return actionsEvidence(commands, { kind, id }, sha, required)
    })
  }],
  ['github/', read => sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
    const found = trigger(host, rest, ticketId)
    const ref = feishuRef(found)
    // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    const disposition = host.store.triggers.disposition(found.id)
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) }
      : disposition
    // Omit card preview and self-reference because this resource returns the full text.
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    if (section === 'meter' && part === undefined) return projectMeter(read, 'ticket', id)
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (section === undefined) {
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      const mainline = mainlineIntent(host.store, id)
      return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry,
        ...mainline ? { mainline } : {},
        ...ticket.plan || ticket.deliveryCheck ? { delivery_check: { read: `ticket/${id}/delivery-check` } } : {} }
    }
    if (section === 'delivery-check') {
      if (part !== undefined) throw new Error('Unknown context resource')
      return deliveryPage(read, id)
    }
    if (section === 'mainline' && part === undefined) {
      const attempts = mainlineAttempts(host.store, id)
      return list(read, (offset, count) => attempts.slice().reverse().slice(offset, offset + count))
    }
    if (section === 'delivery-observation') {
      if (!part || !/^(?:0|[1-9]\d*)$/.test(part)) throw new Error('Unknown delivery observation')
      const item = ticket.deliveryCheck?.events[Number(part)]
      if (!item) throw new Error('Unknown delivery observation')
      return text(read, JSON.stringify(item))
    }
    if (section === 'reviews' || section === 'review') {
      const assignment = ticket.assignments.at(-1)
      const reviews = assignment?.reviews
      if (section === 'review' && !part || section === 'reviews' && part !== undefined) throw new Error('Unknown context resource')
      const item = section === 'review' ? assignment?.reviews?.evidence.find(review => review.id === part) : undefined
      if (section === 'review' && !item) throw new Error('Unknown ticket review')
      let currentHead: string | undefined
      let clean = false
      if (ticket.execution?.directory) {
        currentHead = (await host.commands.git(['rev-parse', '--verify', 'HEAD'], ticket.execution.directory)).trim()
        clean = !(await host.commands.git(['status', '--porcelain=v1', '--untracked-files=all'], ticket.execution.directory)).trim()
      }
      const base = ticket.execution?.base?.sha ?? reviews?.target?.base ?? null
      const candidate = currentHead ?? reviews?.target?.candidate ?? null
      const generation = host.reviewGeneration?.(id) ?? null
      const matches = !!reviews?.target && reviews.target.base === base && reviews.target.candidate === candidate
        && reviews.target.generation === generation && clean
      const evidence = reviews?.evidence ?? []
      const active = matches ? evidence.filter(review => review.base === base && review.candidate === candidate && review.generation === generation) : []
      const aggregate = !clean || !currentHead || !reviews?.target || reviews.target.base !== base || reviews.target.candidate !== candidate
        || reviews.target.generation !== generation ? 'pending' : reviewStatus(assignment!)
      if (section === 'review') return { ...item, current_base: base, current_candidate: candidate,
        stale: !matches, aggregate: matches ? aggregate : 'pending' }
      const history = list(read, (offset, count) => evidence.slice().reverse().slice(offset, offset + count).map(review => ({ ...review,
        read: `ticket/${id}/review/${review.id}` })))
      return { ticket_id: id, assignment_id: assignment?.id ?? null, base, candidate, generation, clean, stale: !matches,
        aggregate: matches ? aggregate : 'pending', standards: active.filter(review => review.axis === 'standards'),
        spec: active.filter(review => review.axis === 'spec'), history: history.items, next_offset: history.next_offset }
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      // Render the input on demand with its resolved source link, matching either its short key or full input ID.
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const trigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      const card = trigger && input?.kind === 'trigger' ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('Unknown transcript entry')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('Unknown assignment report')
      body = report.summary
    } else if (part !== undefined) throw new Error('Unknown context resource')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        const said = entry?.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    return text(read, body)
  }],
]

/** Canonical name for both reads and evidence validation, including stored legacy references. */
export const resourceName = (name: string) => name.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')

/**
 * Read a paginated resource for the main Session or a ticket's worker Session.
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  const name = resourceName(resource)
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}
