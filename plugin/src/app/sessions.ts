/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for managed DSH Sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key, latestAssignment, liveTicket, type ReviewAxis, type Ticket } from '../core/index.ts'
import { until } from '../executor/background.ts'
import { mandateInstructions, ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { physicalPath } from '../infra/paths.ts'
import { sameDirectory } from '../infra/environment.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import { Later, type Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import type { HubCreation, HubRotation } from './hub-authority.ts'
import { matchesNativeRoot, openNativeRoot } from './hub-session-root.ts'
import type { OperatorMessage } from './maintenance.ts'
import type { HubDeliveryReceipt } from '../kv.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills, isBundledSkill, promptFile, splitterSkill } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts, type Role as PromptRole } from './prompts.ts'
import type { ProjectMeter } from './project-meter.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import { matchesTaskMessage, registerScopeTool, sealedHistory, scopeProposalId, scopeRequest, scopeSessionId, scopeToolName } from './tools/requirement-scope.ts'
import { inspectionRequest, inspectionTools, registerInspection, type InspectionHost } from './tools/inspection.ts'
import type { InspectionTask } from './idle-inspection.ts'
import type { RequirementScopeTask, ScopeVerdict } from './plan-requirements.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys' | 'delete' | 'atomic'>
  readonly projectMeter: Pick<ProjectMeter, 'bind' | 'owns'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'effective' | 'forTicket' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending' | 'cancel'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  /** Legacy physical Hub ID used only as the initial fallback while authority is loaded. */
  readonly masterId: string
  /** Current physical Hub Session; undefined while a durable rotation is provisioning. */
  readonly currentHubId: () => string | undefined
  readonly readyHubId: () => string | undefined
  /** Deterministic target physical Session recorded by a rotation intent, if any. */
  readonly hubTargetId: () => string | undefined
  readonly hubGenerations: () => readonly string[]
  readonly isHubGeneration: (sessionId: string) => boolean
  readonly hubCreation: (sessionId: string) => HubCreation | undefined
  readonly hubRequiresProof: (sessionId: string) => boolean
  readonly hubRotation: () => HubRotation | undefined
  readonly beginHubRotation: (cwd: string, inboxOffset: number, drainingTurn?: number) => HubRotation
  readonly sealHubRotation: (cwd: string) => HubRotation
  readonly activateHub: (sessionId: string) => void
  readonly hubResume: () => { epoch: number; requestId: string; text: string } | undefined
  readonly hubResumeDelivered: (requestId: string) => void
  readonly recordOperator?: (input: OperatorMessage, transferred: boolean, historical: boolean) => void
  readonly lifetime: AbortSignal
  /** Called immediately before delivering an ordered relay to the Hub inbox. */
  relayAvailable(requestId: string): boolean
  closing(): boolean
  readonly boundWorkspace?: string | undefined
  environment(ticket: Ticket): Variable[]
  /** Whether the mounted project owns this persisted planning handoff, even when it is not active. */
  ownsPlanner(handoffId: string): boolean
  /** Whether the persisted handoff is in its active planning state; all other statuses deny planner tools. */
  plannerActive(handoffId: string): boolean
  /** Workspace authorized by a persisted published specification, including after registration for idempotent replay. */
  splitterWorkspace(handoffId: string): string | undefined
  scopeTask(proposalId: string): RequirementScopeTask | undefined
  verifyScopeWorkspace(task: RequirementScopeTask): Promise<void>
  recordScopeReview(proposalId: string, reviewer: string, verdict: ScopeVerdict): void
  readonly inspection?: InspectionHost
  /** In-process writer grant; a stored lease cannot authorize worker turns after a restart. */
  workerAuthorized(ticketId: string, sessionId: string): boolean
  credentialBlocked?(ticketId: string): boolean
  /** Handoff and review-subagent roles receive only their own tools, rather than Hub or Worker tools. */
  tools(agent: Agent, ticket?: Ticket, role?: 'planner' | 'splitter' | 'review'): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; names: Set<string>; dispose: () => void };
  role?: PromptRole; subagent?: true; ready?: Promise<void>; observeDelegation?: (initial?: UserMessage) => void; ticketId?: string;
  scopeReviewer?: true;
  inspection?: InspectionTask;
  review?: { ticketId: string; grant: z.infer<typeof ReviewAssignmentSchema> } }

/** The agent presets Executor, planner and main Sessions are created with, which the bundle's patch defines. */
const ReviewAssignmentSchema = z.strictObject({ axis: z.enum(['standards', 'spec']), base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  candidate: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), generation: z.number().int().positive() })

/** DSH appends this descriptor in native child setup; a fork can only copy its source's descriptor before the cut. */
function nativeDescriptor(events: readonly SessionEvent[], cut: number): boolean {
  const event = events.find(event => event.seq >= cut && (event.type as string) === 'subagent/descriptor')
  const data: unknown = event?.data
  return !!data && typeof data === 'object' && 'version' in data && data.version === 3
    && 'mode' in data && (data.mode === 'one-shot' || data.mode === 'continuable') && 'provider' in data && typeof data.provider === 'string'
}

function reviewTask(message: UserMessage) {
  if (message.source.kind !== 'user') return undefined
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const marker = /^DSH_REVIEW_ASSIGNMENT: (\{[^\n]+\})$/m.exec(text)?.[1]
  if (!marker) return undefined
  try { return ReviewAssignmentSchema.safeParse(JSON.parse(marker)).data } catch { return undefined }
}

function reviewSkillCall(event: SessionEvent): event is SessionEvent<'tool/call'> {
  if (event.type !== 'tool/call' || event.data.name !== 'skill') return false
  try { return JSON.parse(event.data.arguments)?.name === bundledSkills['worker/code-review'].name } catch { return false }
}

function loadedReviewSkill(events: readonly SessionEvent[], after: number): boolean {
  const calls = new Map<string, SessionEvent<'tool/call'>['data']>()
  for (const event of events) {
    if (event.seq <= after) continue
    if (reviewSkillCall(event)) calls.set(event.data.callId, event.data)
    if (event.type !== 'tool/result' || event.data.message.isError !== false || event.data.error) continue
    const call = calls.get(event.data.message.toolCallId)
    if (call?.turn === event.data.turn && call.step === event.data.step) return true
  }
  return false
}
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router', PLANNER_PRESET = 'dsh-superagent-planner'
export const INSPECTION_PRESET = 'dsh-superagent-inspection'
const INSPECTION_DENIED = promptFile('inspection-denied')
const inspectionCreation = (task: InspectionTask) => ({ cwd: task.sessionDirectory, token: task.creationToken, marker: 'dsh-superagent/inspection-root' as const })
const plannerHandoffId = (sessionId: string): string | undefined =>
  sessionId.startsWith('planner-') && sessionId.length > 'planner-'.length ? sessionId.slice('planner-'.length) : undefined
const SPLITTER_PREFIX = 'splitter-'
export const splitterSessionId = (handoffId: string): string => `${SPLITTER_PREFIX}${handoffId}`
export const splitterHandoffId = (sessionId: string): string | undefined =>
  sessionId.startsWith(SPLITTER_PREFIX) && sessionId.length > SPLITTER_PREFIX.length ? sessionId.slice(SPLITTER_PREFIX.length) : undefined
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools the main Session inherits from its read-only router preset: inspection only. Its own orchestrator_* tools
 * are registered on its scope, which `tools.restrict` does not mask, so reading tickets and resources, evaluating candidates,
 * routing, replying, requesting status and relaying summaries stay available.
 */
const HUB_TOOLS = ['skill', 'read', 'read_image', 'glob', 'grep']
/** Only read-only DSH capabilities and explicit specification tools are usable by a planner. */
const PLANNER_TOOLS: readonly string[] = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill']
const SHARED_HOST_TOOLS: readonly string[] = ['orchestrator_read']
const PLANNER_HOST_TOOLS: readonly string[] = ['orchestrator_spec_question', 'orchestrator_spec_publish']
const SPLITTER_TOOLS: readonly string[] = ['skill']
const SPLITTER_HOST_TOOLS: readonly string[] = ['orchestrator_plan_register']
const PLANNER_INACTIVE = promptFile('planner-inactive'), PLANNER_DENIED = promptFile('planner-denied')
const SPLITTER_INACTIVE = promptFile('splitter-inactive'), SPLITTER_DENIED = promptFile('splitter-denied')
const WORKER_TICKET_ENDED = promptFile('worker-ticket-ended')
const WORKER_WRITER_REQUIRED = promptFile('worker-writer-required')
const WORKER_ANCESTRY_PENDING = promptFile('worker-ancestry-pending')
const WORKER_SKILL_NOT_BOUND = promptFile('worker-skill-not-bound')
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other DSH tool the profile has, whenever it was registered: none that asks or shows a person
 * something, changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold,
 * starts or messages other Sessions, or edits documents. Its only MCP tools are the Context7 documentation lookups below.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'apply_patch', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list',
  'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents',
  'interrupt_agent']
/** Review descendants inspect Git and documentation and submit evidence; they do not receive file-write, job or delegation tools. */
const REVIEW_TOOLS = ['read', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'web_search', 'web_fetch', 'skill']
/**
 * The MCP tools an Executor Session may use, by the exact `mcp__<server>__<tool>` names Context7 registers: its read-only
 * documentation lookups. Messaging and other MCP servers stay out, so a Worker cannot send a person a message directly and
 * bypass the Hub. DSH's tool schema has no server or policy metadata, so the development server is named explicitly.
 */
const DEV_MCP_TOOLS = ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs']

const withdrawnRelay = Symbol('withdrawn relay')

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
 export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  /** A durable pin alone cannot open model admission before this mount verifies the checkout. */
  private readonly verifiedScopeRoots = new WeakSet<Agent>()
  private readonly readyWorkerModels = new WeakSet<Agent>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  private hubOperations = 0
  private hubIdle?: PromiseWithResolvers<void>
  private rotationTask?: Promise<string>
  private readonly hubTransferTasks = new Map<string, Promise<boolean>>()
  private readonly verifiedHubRoots = new WeakSet<Agent>()
  private readonly admittedHubTurns = new WeakMap<Agent, number>()
  private readonly claimedHubInputs = new WeakMap<Agent, Map<string, UserMessage>>()
  private readonly submittedHubInputs = new WeakMap<Agent, Set<string>>()
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.deliverRelay(requestId, text), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
    host.effects.handle('hubInbox', async (_, fromSessionId) => {
      const targetId = this.host.readyHubId()
      const target = targetId ? this.ctx.agents.get(targetId as SessionId) : undefined
      if (!target || !this.isHubRoot(target)) throw new Later('No verified Hub is ready for inbox transfer')
      if (!await this.transferHubInbox(fromSessionId, target)) throw new Later('Hub input has not reached durable history')
    }, { limit: () => this.host.closing() ? 0 : 1 })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    // A plugin restart while Sessions are live must protect them too, not only those announced after this listener.
    const live = ctx.agents.list()
    for (const agent of live) {
      void this.decorate(agent).catch((error: unknown) => {
        ctx.logger.warn('dsh-superagent could not decorate a live Session: %s', String(error))
      })
    }
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (this.isHubRoot(agent) && !this.acceptsHubInput(agent)) this.queueHubTransferMessage(agent.id, message, Date.now())
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (this.isHubRoot(agent)) {
        if (!this.acceptsHubInput(agent)) this.queueHubTransferMessage(agent.id, message)
        else {
          let claimed = this.claimedHubInputs.get(agent)
          if (!claimed) { claimed = new Map(); this.claimedHubInputs.set(agent, claimed) }
          claimed.set(message.id, message)
        }
      }
      this.bindings.get(agent)?.observeDelegation?.(message)
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent?.session === session && event.type === 'user/message') {
        this.claimedHubInputs.get(agent)?.delete(event.data.id)
        if (this.host.recordOperator && event.seq >= session.inheritedEventCount && this.acceptsHubInput(agent))
          this.recordOperator(agent.id, event.data, event.time, false)
      }
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (binding?.inspection && event.type === 'turn/end' && this.host.inspection?.task(session.id)) {
        this.host.inspection.abandon(session.id, `Inspection turn ended (${event.data.reason.kind}) without recording a conclusion`)
      }
      if (binding?.observeDelegation && (event.type === 'user/message' || (event.type as string) === 'subagent/descriptor' || event.type === 'tool/result')) {
        binding.observeDelegation()
      }
      if (!agent || !binding?.ready || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => {
      if (!this.host.lifetime.aborted) await this.decorate(agent)
      return undefined
    })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        if (this.host.lifetime.aborted) return
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const plannerId = plannerHandoffId(sessionId)
        const planner = plannerId !== undefined && this.host.ownsPlanner(plannerId)
        const ours = agent && this.isHubRoot(agent) && sessionId === this.host.currentHubId() ? ROUTER_PRESET
          : planner || (agent && this.isSplitterSession(agent)) ? PLANNER_PRESET
          : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
      if (agent.id.startsWith('inspection-')) {
        const allowed = (input: readonly UserMessage[]) => {
          try {
            const request = inspectionRequest(this.inspectionTaskFor(agent))
            const { taskSeq, ended } = sealedHistory(agent, request)
            return ended === undefined && (taskSeq === undefined ? input.length === 1 && matchesTaskMessage(input[0]!, request) : !input.length)
          } catch { return false }
        }
        if (!allowed(messages)) return { kind: 'reject' }
        const decision = await next()
        return decision.kind === 'enter' && !allowed(decision.messages) ? { kind: 'reject' } : decision
      }
      const ticketId = ticketOfSession(agent.id)
      if (ticketId && (this.host.closing() || this.host.store.tickets.get(ticketId))) {
        const allowed = () => this.readyWorkerModels.has(agent) && ctx.agents.get(agent.id) === agent && this.host.workerAuthorized(ticketId, agent.id)
        if (!allowed()) return { kind: 'reject' }
        const decision = await next()
        return decision.kind === 'enter' && !allowed() ? { kind: 'reject' } : decision
      }
      if (!this.host.isHubGeneration(agent.id)) return next()
      if (!this.isHubRoot(agent)) return { kind: 'reject' }
      const blockedInputs = (): Set<string> | undefined => {
        if (!this.acceptsHubInput(agent)) {
          for (const message of messages) this.queueHubTransferMessage(agent.id, message)
          const draining = this.host.hubRotation()
          return this.host.currentHubId() === agent.id && draining?.drainingTurn === turn
            ? new Set(messages.map(message => message.id)) : undefined
        }
        const blocked = new Set<string>()
        for (const message of messages) {
          if (message.source.kind === 'user' && this.isTransferredInput(agent.id, message)) blocked.add(message.id)
        }
        if (messages.length && blocked.size === messages.length && this.admittedHubTurns.get(agent) !== turn) return
        return blocked
      }
      if (!blockedInputs()) return { kind: 'reject' }
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      // Other hooks can suspend; recheck the durable fence immediately before admitting the step.
      const blocked = blockedInputs()
      if (!blocked) return { kind: 'reject' }
      this.admittedHubTurns.set(agent, turn)
      // The host may add runtime context in next(); it does not belong to the retiring inbox.
      return blocked.size ? { ...decision, messages: decision.messages.filter(message => !blocked.has(message.id)) } : decision
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      this.claimedHubInputs.delete(agent)
      if (!this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** A child of managed work cannot bypass admission while its own business binding is being verified. */
  hasManagedAncestry(id: string): boolean {
    const seen = new Set<string>([id])
    let parent = this.ctx.agents.get(id as SessionId)?.session.header.parentSession
    while (parent !== undefined && !seen.has(parent)) {
      if (this.host.projectMeter.owns(parent)) return true
      seen.add(parent)
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const agent = this.ctx.agents.get(id as SessionId)
    return agent !== undefined && this.bindings.get(agent)?.subagent === true
  }
  /** Ensure the persisted Hub, completing an interrupted rotation before publishing its conversation. */
  async ensureHub(cwd: string, title: string): Promise<Agent> {
    await this.recoverFencedHubInputs()
    if (this.host.hubRotation()) {
      const id = await this.rotateHub(cwd, title)
      const agent = this.ctx.agents.get(id as SessionId)
      if (!agent || !this.isHubRoot(agent)) throw new Error('The recovered Hub Session is not available')
      return agent
    }
    const agent = await this.ensure(this.host.currentHubId() ?? this.host.masterId, cwd, title, 'orchestrator')
    await this.resumeHub(agent)
    await this.transferHubInboxes(agent)
    if (this.host.recordOperator) {
      const history = agent.session.snapshotEvents()
      for (let i = history.length - 1; i >= agent.session.inheritedEventCount; i--) {
        const event = history[i]
        if (event?.type === 'turn/end') break
        if (event?.type === 'user/message') this.recordOperator(agent.id, event.data, event.time, false, true)
      }
    }
    return agent
  }

  private isHubRoot(agent: Agent): boolean {
    if (!this.host.isHubGeneration(agent.id)) return false
    const { header } = agent.session
    if (header.id !== agent.id || header.parentSession !== undefined || header.origin === 'subagent') return false
    if (this.verifiedHubRoots.has(agent) || !this.host.hubRequiresProof(agent.id)) return true
    const creation = this.host.hubCreation(agent.id)
    if (!creation || !matchesNativeRoot(this.ctx, agent, creation, ROUTER_PRESET)) return false
    this.verifiedHubRoots.add(agent)
    return true
  }

  private acceptsHubInput(agent: Agent): boolean {
    return this.host.readyHubId() === agent.id && this.ctx.agents.get(agent.id) === agent && this.isHubRoot(agent)
  }

  /** Whether this exact generation can be followed from a retired conversation. */
  isPublishedHub(id: string): boolean {
    const agent = this.ctx.agents.get(id as SessionId)
    return !!agent && this.acceptsHubInput(agent)
  }

  /** Quiesce the old physical Session, provision the deterministic target and atomically grant it Hub authority. */
  async rotateHub(cwd: string, title: string): Promise<string> {
    if (this.rotationTask) return this.rotationTask
    const task = this.performRotation(cwd, title)
    this.rotationTask = task
    try { return await task }
    finally { if (this.rotationTask === task) this.rotationTask = undefined }
  }

  private async performRotation(cwd: string, title: string): Promise<string> {
    const current = this.host.currentHubId()
    if (current && this.host.hubResume()) {
      const target = await this.ensure(current, cwd, title, 'orchestrator')
      await this.resumeHub(target)
      await this.transferHubInboxes(target)
      return target.id
    }
    if (this.host.closing()) throw new Error('Session dispatch is stopping')
    const existing = this.host.hubRotation()
    const from = existing?.fromSessionId ?? current
    const old = from ? this.ctx.agents.get(from as SessionId) : undefined
    if (old && !this.isHubRoot(old)) throw new Error('Cannot rotate an unverified Hub Session')
    // Persist the fence and everything still pending before yielding to any host work.
    this.host.store.atomic(() => {
      const rotation = existing ?? this.host.beginHubRotation(cwd, old?.session.snapshotEvents().length ?? 0,
        old?.status === 'running' ? this.admittedHubTurns.get(old) : undefined)
      if (!existing) this.host.store.set(KV.runtime.inboxFence(rotation.fromSessionId), rotation.inboxOffset ?? 0)
      this.persistHubInbox(rotation.fromSessionId, old)
    })
    if (old?.status === 'running' && await until(old.whenIdle(), this.host.lifetime) === false) {
      throw new Error('Session dispatch is stopping')
    }
    if (this.host.closing()) throw new Error('Session dispatch is stopping')
    const rotation = this.host.sealHubRotation(cwd)
    await this.waitHubOperations()
    this.persistHubInbox(rotation.fromSessionId, old)
    const target = await this.ensure(rotation.targetSessionId, cwd, title, 'orchestrator')
    if (!rotation.creation || !matchesNativeRoot(this.ctx, target, rotation.creation, ROUTER_PRESET)) {
      throw new Error('The provisioned Hub does not match the rotation intent')
    }
    this.host.activateHub(target.id)
    await this.resumeHub(target)
    await this.transferHubInboxes(target)
    return target.id
  }

  private originalRequestId(message: UserMessage): string | undefined {
    const source = message.source
    if (source.kind === 'dsh-superagent') return source.originalRequestId
    if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return source.rpcId
  }

  private hubInputKey(message: UserMessage) {
    const rpcId = this.originalRequestId(message)
    return rpcId !== undefined ? KV.runtime.inboxRequest('rpc', rpcId) : KV.runtime.inboxRequest('message', message.id)
  }

  private isTransferredInput(sessionId: string, message: UserMessage): boolean {
    return !!this.host.store.get(this.hubInputKey(message)) || !!this.host.store.get(KV.runtime.transferred(sessionId, message.id))
  }

  private continuationMessage(message: UserMessage): UserMessage {
    if (message.source.kind !== 'user') return message
    const originalRequestId = this.originalRequestId(message)
    return freezeMessage({ ...message, source: { kind: 'dsh-superagent', form: 'relay',
      ...(originalRequestId !== undefined ? { originalRequestId } : {}) } }) as UserMessage
  }

  private queueHubTransferMessage(fromSessionId: string, message: UserMessage, insertedAt?: number, historical = insertedAt === undefined): void {
    this.host.store.atomic(() => {
      if (this.isTransferredInput(fromSessionId, message)) return
      const transferKey = KV.runtime.transfer(fromSessionId)
      const saved = this.host.store.get(transferKey) ?? []
      this.host.store.set(this.hubInputKey(message), { sessionId: fromSessionId, messageId: message.id })
      if (!saved.some(item => item.id === message.id)) this.host.store.set(transferKey, [...saved, message])
      if (this.host.recordOperator && message.source.kind === 'user') {
        const session = this.ctx.agents.get(fromSessionId as SessionId)?.session
        const at = insertedAt ?? session?.snapshotEvents().find(event => event.type === 'agent/inbox/spliced' &&
          event.data.inserted?.some(item => item.id === message.id && item.source.kind === 'user'))?.time
        if (at !== undefined) this.recordOperator(fromSessionId, message, at, true, historical)
      }
      if (!this.host.effects.pending('hubInbox', fromSessionId)) this.host.effects.enqueue('hubInbox', fromSessionId, {})
    })
  }

  private recordOperator(sessionId: string, message: UserMessage, at: number, transferred: boolean, historical = false): void {
    const [block] = message.content
    if (message.source.kind === 'user' && message.content.length === 1 && block?.type === 'text')
      this.host.recordOperator?.({ sessionId, messageId: message.id, at, text: block.text }, transferred, historical)
  }

  /** Prove a previous logical relay reached native history before issuing a new recovery wake-up. */
  async relayConsumed(id: string): Promise<boolean> {
    const requestId = key(id)
    for (const sessionId of this.host.hubGenerations()) if (await this.agentDelivery.holdsIn(sessionId, requestId)) return true
    return false
  }

  private persistHubInbox(fromSessionId: string, agent: Agent | undefined): void {
    if (!agent) return
    for (const message of this.claimedHubInputs.get(agent)?.values() ?? []) this.queueHubTransferMessage(fromSessionId, message)
    for (const message of agent.inbox.nextStep) this.queueHubTransferMessage(fromSessionId, message)
    for (const message of agent.inbox.nextTurn) this.queueHubTransferMessage(fromSessionId, message)
  }

  /** Reconcile native inserts persisted while the plugin was down, without waking retired agents. */
  private async recoverFencedHubInputs(): Promise<void> {
    const fences = this.host.store.keys(KV.runtime.inboxFence.prefix)
    if (!fences.length) return
    await this.ctx.sessionPersistence.flush()
    for (const fence of fences) {
      const id = fence.slice(KV.runtime.inboxFence.prefix.length)
      if (!this.host.isHubGeneration(id)) throw new Error('Hub input fence belongs to an unknown generation')
      let offset = this.host.store.get(KV.runtime.inboxFence(id)) ?? 0
      const inputs = new Map<string, { message: UserMessage; at: number }>()
      await using log = await this.ctx.sessionPersistence.open(id as SessionId, 'read')
      if (log.inheritedEventCount) throw new Error('A Hub input fence cannot refer to a forked Session')
      for (;;) {
        const { events } = await log.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type === 'agent/inbox/spliced') {
            for (const message of event.data.inserted ?? []) {
              if (!inputs.has(message.id)) inputs.set(message.id, { message, at: event.time })
            }
          } else if (event.type === 'user/message') inputs.delete(event.data.id)
        }
        offset += events.length
      }
      this.host.store.atomic(() => {
        for (const { message, at } of inputs.values()) this.queueHubTransferMessage(id, message, at, true)
        this.host.store.set(KV.runtime.inboxFence(id), offset)
      })
    }
  }

  private async transferHubInboxes(target: Agent): Promise<void> {
    for (const key of this.host.store.keys(KV.runtime.transfer.prefix)) {
      await this.transferHubInbox(key.slice(KV.runtime.transfer.prefix.length), target)
    }
  }

  private async transferHubInbox(fromSessionId: string, target: Agent): Promise<boolean> {
    const previous = this.hubTransferTasks.get(target.id) ?? Promise.resolve(true)
    const task = previous.catch(() => false).then(() => this.moveHubInbox(fromSessionId, target))
    this.hubTransferTasks.set(target.id, task)
    try { return await task }
    finally { if (this.hubTransferTasks.get(target.id) === task) this.hubTransferTasks.delete(target.id) }
  }

  private async moveHubInbox(fromSessionId: string, target: Agent): Promise<boolean> {
    const store = this.host.store
    const transferKey = KV.runtime.transfer(fromSessionId)
    const old = this.ctx.agents.get(fromSessionId as SessionId)
    let submitted = this.submittedHubInputs.get(target)
    if (!submitted) { submitted = new Set(); this.submittedHubInputs.set(target, submitted) }
    for (;;) {
      const saved = store.get(transferKey)?.[0]
      if (!saved) return true
      if (!this.acceptsHubInput(target) || this.host.closing()) return false
      const message = this.continuationMessage(saved)
      const receipt = KV.runtime.transferred(fromSessionId, message.id)
      const intent = KV.runtime.inboxTarget(fromSessionId, message.id)
      let consumedBy = store.get(receipt)
      if (!consumedBy) {
        const previous = store.get(intent)
        if (fromSessionId !== target.id && (old && this.isHubRoot(old)
          ? await this.agentDelivery.consumed(old, saved) : await this.agentDelivery.consumedIn(fromSessionId, saved))) consumedBy = fromSessionId
        else if (previous && previous !== target.id && await this.agentDelivery.consumedIn(previous, message)) consumedBy = previous
        else if (await this.agentDelivery.consumed(target, message)) consumedBy = target.id
      }
      if (!consumedBy) {
        if (!this.acceptsHubInput(target) || this.host.closing()) return false
        const queued = target.inbox.nextTurn.find(item => item.id === message.id) ?? target.inbox.nextStep.find(item => item.id === message.id)
        // A cold inbox can contain an earlier submission without a running driver or receipt. Re-wake it under the saved intent.
        if (target.status !== 'idle' && (queued?.source.kind !== 'user' && queued || submitted.has(message.id))) return false
        if (queued) target.inbox.remove(message.id)
        store.set(intent, target.id)
        submitted.add(message.id)
        target.followup(message)
        if (!await this.agentDelivery.consumed(target, message)) return false
        consumedBy = target.id
      }
      const consumedSessionId = consumedBy
      if (old && old !== target && this.isHubRoot(old) && old.inbox.remove(message.id)) await this.ctx.sessionPersistence.flush()
      store.atomic(() => {
        store.set(receipt, consumedSessionId)
        store.delete(intent)
        const source = message.source as { kind: string; plugin?: unknown }
        if ((source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent'))
          && message.id.startsWith('dsh-superagent:')) {
          const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
          store.set(KV.runtime.delivery(message.id.slice('dsh-superagent:'.length)), {
            hash: key(text), sessionId: consumedSessionId, at: new Date().toISOString() })
        }
        const remaining = (store.get(transferKey) ?? []).filter(item => item.id !== message.id)
        if (remaining.length) store.set(transferKey, remaining)
        else { store.delete(transferKey); this.host.effects.cancel('hubInbox', fromSessionId) }
      })
      submitted.delete(message.id)
    }
  }

  private async resumeHub(agent: Agent): Promise<void> {
    const resume = this.host.hubResume()
    if (!resume) return
    const message = freezeMessage({ id: messageId(resume.requestId), role: 'user',
      source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: resume.text }] }) as UserMessage
    if (!await this.agentDelivery.consumed(agent, message)) {
      if (this.host.closing() || this.host.currentHubId() !== agent.id || !this.isHubRoot(agent)) throw new Error('The Hub resume target changed')
      // Injecting into DSH's inbox is not durable context. Record the summary before exposing input admission.
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      if (!await this.agentDelivery.consumed(agent, message)) throw new Error('The Hub resume did not reach durable history')
    }
    this.host.hubResumeDelivered(resume.requestId)
  }

  /** Deliver a logical Hub message to whichever physical Session currently owns the authority. */
  async promptHub(requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const id = this.host.readyHubId()
    if (!id) throw new Later('Hub Session is rotating')
    const release = this.beginHubOperation(id)
    try {
      const hash = key(text)
      const receipt = this.host.store.get(KV.runtime.delivery(requestId))
      if (receipt?.hash === hash) { accepted?.(); return }
      for (const generation of this.host.hubGenerations()) {
        if (generation === id) continue
        if (!await this.agentDelivery.holdsIn(generation, requestId)) continue
        const found: HubDeliveryReceipt = { hash, sessionId: generation, at: new Date().toISOString() }
        this.host.store.set(KV.runtime.delivery(requestId), found)
        accepted?.()
        return
      }
      const result = await this.ctx.sessionController.resolveAgent(id as SessionId)
      if ('error' in result) throw result.error
      await this.agentDelivery.send(result.agent, requestId, text, mode, this.host.lifetime, () => {
        authorize?.()
        if (!this.acceptsHubInput(result.agent)) throw new Later('Hub Session changed during delivery')
      }, () => { this.host.store.set(KV.runtime.delivery(requestId), { hash, sessionId: id, at: new Date().toISOString() }); accepted?.() })
    } finally { release() }
  }

  private beginHubOperation(id: string): () => void {
    if (!this.hubToolsAvailable(id)) throw new Later('Hub Session is not current')
    this.hubOperations++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.hubOperations === 0) this.hubIdle?.resolve()
    }
  }

  private hubToolsAvailable(id: string): boolean {
    return this.host.currentHubId() === id && (this.host.readyHubId() === id || this.host.hubRotation()?.fromSessionId === id)
  }

  private async waitHubOperations(): Promise<void> {
    if (!this.hubOperations) return
    this.hubIdle ??= Promise.withResolvers<void>()
    if (!this.hubOperations) { this.hubIdle.resolve(); return }
    await this.hubIdle.promise
    this.hubIdle = undefined
  }
  async idleHubTransfers(): Promise<void> {
    while (this.hubTransferTasks.size) await Promise.allSettled([...this.hubTransferTasks.values()])
  }


  /** Resolves or creates a role session in `cwd`, sets its preset and model, decorates it, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: PromptRole): Promise<Agent> {
    const plannerId = role === 'planner' ? plannerHandoffId(id) : undefined
    if (role === 'planner' && (!plannerId || !this.host.plannerActive(plannerId))) {
      throw new Error('A planner Session needs an active, persisted planning handoff and planner-<handoffId> session ID')
    }
    const splitterId = role === 'splitter' ? splitterHandoffId(id) : undefined
    if (role === 'splitter' && (!splitterId || this.host.splitterWorkspace(splitterId) !== cwd)) {
      throw new Error('A splitter Session needs its persisted published spec and project workspace')
    }
    const ticketId = role === 'worker' ? ticketOfSession(id) : undefined
    if (role === 'worker' && (!ticketId || !this.host.workerAuthorized(ticketId, id))) {
      throw new Error(`Worker ${id} has no verified writer grant; refusing to create its Session`)
    }
    const authorize = () => {
      if (this.host.closing()) throw new Error('Session dispatch is stopping')
      if (role === 'orchestrator') {
        const expected = this.host.hubTargetId() ?? this.host.currentHubId()
        if (id !== expected) throw new Error('The Hub Session is not the current persisted authority target')
      } else if (ticketId !== undefined) {
        if (!this.host.workerAuthorized(ticketId, id)) throw new Error(`Worker ${id} lost its writer grant before Session setup`)
      } else if (plannerId ? !this.host.plannerActive(plannerId) : !splitterId || this.host.splitterWorkspace(splitterId) !== cwd) {
        throw new Error('Planning dispatch changed before Session setup')
      }
    }
    const bind = (reserve = false) => {
      authorize()
      if (ticketId !== undefined) {
        if (reserve) this.reserveWorker(ticketId, id)
        else this.bindWorker(ticketId, id)
      } else if (role === 'planner' || role === 'splitter') {
        this.host.projectMeter.bind({ session_id: id, role,
          ...this.host.projectMeter.owns(id) ? {} : { parent_session_id: this.host.currentHubId() ?? this.host.masterId } })
      }
    }
    const ctx = this.ctx
    const creation = role === 'orchestrator' ? this.host.hubCreation(id) : undefined
    if (role === 'orchestrator' && this.host.hubRequiresProof(id) && !creation) throw new Error('The Hub Session has no creation proof')
    let result = creation
      ? { agent: await openNativeRoot(ctx, id as SessionId, creation, ROUTER_PRESET, this.host.hubTargetId() === id, authorize) }
      : await ctx.sessionController.resolveAgent(id as SessionId)
    if (creation && 'agent' in result) this.verifiedHubRoots.add(result.agent)
    if (!creation && 'error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      if (ticketId !== undefined) bind(true) // Plan Workers already have a durable reservation; standalone Workers reserve here.
      else authorize()
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'planner' || role === 'splitter' ? PLANNER_PRESET : role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    if (result.agent.session.header.parentSession !== undefined || result.agent.session.header.origin === 'subagent') {
      throw new Error(`Expected a root Session for ${role} dispatch`)
    }
    if (splitterId) {
      this.host.lifetime.throwIfAborted()
      if (!this.isSplitterSession(result.agent)) throw new Error(`Splitter ${id} is outside its published handoff workspace`)
    }
    if (plannerId && this.host.boundWorkspace) {
      const createdIn = result.agent.session.header.cwd
      if (!createdIn || relative(this.host.boundWorkspace, await physicalPath(createdIn)) !== '') {
        throw new Error(`Planner ${id} is outside its registered project workspace`)
      }
    }
    if (role === 'worker') {
      this.requireWorkerRoot(result.agent, id)
      const createdIn = result.agent.session.header.cwd
      if (!createdIn) throw new Error(`Worker ${id} has no recorded workspace directory`)
      const [sessionPath, expectedPath] = await Promise.all([physicalPath(createdIn), physicalPath(cwd)])
      const same = process.platform === 'win32' ? sessionPath.toLowerCase() === expectedPath.toLowerCase() : sessionPath === expectedPath
      if (!same) throw new Error(`Worker ${id} belongs to ${createdIn}, not the verified ticket worktree ${cwd}`)
    }
    bind()
    if (ticketId !== undefined) await this.prepareWorkerModel(result.agent, ticketId, authorize)
    else {
      const settings = this.host.store.settings()
      await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model, authorize)
    }
    await this.decorate(result.agent)
    authorize()
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Return only an original root, in its confirmed checkout and with the preset it was created under. */
  private scopeRoot(agent: Agent, task: RequirementScopeTask): boolean {
    const { header, inheritedEventCount } = agent.session
    const projections = this.ctx.get('sessionProjections') as { stateOf(session: Agent['session'], name: 'agentPreset'): unknown } | undefined
    const preset = projections ? projections.stateOf(agent.session, 'agentPreset') :
      agent.session.snapshotEvents().some(event => (event.type as string) === 'agent-preset/selected') ? undefined : header.agentPreset
    return agent.id === scopeSessionId(task.input.proposalId) && this.ctx.agents.get(agent.id) === agent && header.id === agent.id
      && header.agentPreset === PLANNER_PRESET && preset === PLANNER_PRESET && !header.isSeeded && header.origin === undefined && header.parentSession === undefined
      && inheritedEventCount === 0 && !!header.cwd && isAbsolute(header.cwd) && sameDirectory(task.workspace, header.cwd)
  }
  private scopeTaskFor(agent: Agent): RequirementScopeTask {
    const id = scopeProposalId(agent.id)
    const pin = id && this.host.store.get(KV.planRequirements.reviewer(id))
    const task = id && this.host.scopeTask(id)
    if (!task || !pin || pin.sessionId !== agent.id || pin.createdAt !== agent.session.header.createdAt || !this.scopeRoot(agent, task)) {
      throw new Error('The Session is not the assigned reviewer of a current requirement preview')
    }
    return task
  }
  /** Model admission rechecks the live native task, not just the append-only business binding. */
  scopeModelAllowed(id: string): boolean {
    const agent = this.ctx.agents.get(id as SessionId)
    if (!agent || !this.bindings.get(agent)?.scopeReviewer) return false
    try { return sealedHistory(agent, scopeRequest(this.scopeTaskFor(agent))).taskSeq !== undefined } catch { return false }
  }
  /** Resolve one sealed request, with the same pinned physical Session on every restart. */
  async deliverScope(id: string, admit: () => void): Promise<void> {
    const host = this.host, ctx = this.ctx
    const task = host.scopeTask(id)
    if (!task) return
    const sessionId = scopeSessionId(id) as SessionId, pinKey = KV.planRequirements.reviewer(id)
    const request = scopeRequest(task)
    const pending = () => {
      host.lifetime.throwIfAborted()
      admit()
      const current = host.scopeTask(id)
      if (!current || current.planId !== task.planId || current.workspace !== task.workspace || scopeRequest(current).text !== request.text) {
        throw new Error('Requirement preview is no longer available for review')
      }
    }
    await host.verifyScopeWorkspace(task)
    pending()
    const pin = host.store.get(pinKey)
    let result = await ctx.sessionController.resolveAgent(sessionId)
    pending()
    if ('error' in result && result.error.code === 'session/not-found' && !pin) {
      const workspace = await ctx.workspaceRegistry.create(task.workspace)
      pending()
      // This reservation authorizes no model request. A crash during create can recover only a clean original root.
      host.projectMeter.bind({ session_id: sessionId, plan_id: task.planId, parent_session_id: host.currentHubId() ?? host.masterId, role: 'review' })
      await ctx.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: PLANNER_PRESET })
      pending()
      result = await ctx.sessionController.resolveAgent(sessionId)
      pending()
    }
    if ('error' in result) throw result.error
    const { agent } = result
    const binding = host.store.get(KV.projectMeter.binding(sessionId))
    if (!this.scopeRoot(agent, task) || binding?.plan_id !== task.planId || binding.ticket_id !== null
      || !binding.parent_session_id || !host.isHubGeneration(binding.parent_session_id) || !binding.roles.includes('review')) throw new Error('Foreign requirement scope Session')
    if (!pin) {
      await ctx.sessionPersistence.flush()
      pending()
      if (!this.scopeRoot(agent, task)) throw new Error('Requirement scope Session changed before pinning')
      const { taskSeq, pending: inbox } = sealedHistory(agent, request)
      if (taskSeq !== undefined || inbox || agent.status !== 'idle' || agent.session.requestHeader()) throw new Error('Expected a fresh scope reviewer')
      host.store.set(pinKey, { sessionId, createdAt: agent.session.header.createdAt })
    }
    const authorize = () => { pending(); this.scopeTaskFor(agent); sealedHistory(agent, request) }
    authorize()
    this.verifiedScopeRoots.add(agent)
    await this.decorate(agent)
    authorize()
    await initializeRoleModel(ctx, agent, host.store.settings().executor.model, authorize)
    authorize()
    await ctx.sessionController.rename({ sessionId, title: `Requirement scope: ${id}` })
    authorize()
    const state = sealedHistory(agent, request)
    const next = state.taskSeq === undefined ? request : agent.status === 'idle' ? state.wake : undefined
    if (next && agent.status === 'idle' && state.pending && state.pending.id === this.promptedId(next.id) && agent.inbox.remove(state.pending.id)) {
      agent.followup(state.pending)
      await ctx.sessionPersistence.flush()
    } else if (next) {
      await this.agentDelivery.send(agent, key(next.id), next.text, 'queue', host.lifetime, authorize)
    }
    const received = sealedHistory(agent, request)
    if (received.taskSeq === undefined && !received.pending) throw new Error('The native scope reviewer did not receive its sealed task')
  }
  /** The persisted grant owns this exact business edge; neither a name nor a native parent chooses it. */
  private checkInspectionTask(task: InspectionTask): void {
    this.host.lifetime.throwIfAborted()
    const { sessionId, hubSessionId } = task, binding = this.host.store.get(KV.projectMeter.binding(sessionId))
    if (!sessionId.startsWith('inspection-') || this.host.closing() || !isDeepStrictEqual(this.host.inspection?.task(sessionId), task)
      || !this.host.isHubGeneration(hubSessionId) || binding?.session_id !== sessionId || binding.parent_session_id !== hubSessionId
      || binding.roles.length !== 1 || binding.roles[0] !== 'inspection' || binding.ticket_id !== null || binding.plan_id !== null) {
      throw new Error('Inspection no longer has its authorized project task and business binding')
    }
  }
  private inspectionTaskFor(agent: Agent): InspectionTask {
    const task = this.bindings.get(agent)?.inspection
    if (!task || task.sessionId !== agent.id || !Number.isSafeInteger(agent.session.header.createdAt)
      || this.host.store.get(KV.inspection.native(agent.id)) !== agent.session.header.createdAt
      || !matchesNativeRoot(this.ctx, agent, inspectionCreation(task), INSPECTION_PRESET)) throw new Error('Unverified native inspection Session')
    this.checkInspectionTask(task)
    return task
  }

  inspectionModelAllowed(id: string): boolean {
    const agent = this.ctx.agents.get(id as SessionId)
    if (!agent || agent.status !== 'running') return false
    try {
      const state = sealedHistory(agent, inspectionRequest(this.inspectionTaskFor(agent)))
      return state.taskSeq !== undefined && state.ended === undefined
    } catch { return false }
  }

  /** Open only the root minted under the saved intent. An inspection has one request and never resumes with new input. */
  async deliverInspection(sessionId: string): Promise<void> {
    const { host, ctx } = this, inspection = host.inspection, task = inspection?.task(sessionId)
    if (!task || !inspection) return
    if (task.sessionId !== sessionId) throw new Error('Inspection Session does not match the authorized task')
    const current = () => this.checkInspectionTask(task), id = sessionId as SessionId, pin = KV.inspection.native(id)
    current()
    const agent = await openNativeRoot(ctx, id, inspectionCreation(task), INSPECTION_PRESET, host.store.get(pin) === undefined, current)
    current()
    const request = inspectionRequest(task), state = sealedHistory(agent, request)
    if (host.store.get(pin) === undefined) {
      if (state.taskSeq !== undefined || state.pending || agent.status !== 'idle' || agent.session.requestHeader()) throw new Error('Expected a fresh inspection root')
      host.store.set(pin, agent.session.header.createdAt)
    }
    await this.decorate(agent, task)
    const authorize = () => sealedHistory(agent, inspectionRequest(this.inspectionTaskFor(agent)))
    const prior = authorize()
    if (prior.ended !== undefined || (prior.taskSeq !== undefined || prior.pending || prior.inserted) && agent.status === 'idle') {
      inspection.abandon(id, `Inspection stopped (${prior.ended ?? 'interrupted'}) without recording a conclusion`)
      return
    }
    if (prior.taskSeq !== undefined || prior.pending || prior.inserted) return
    await initializeRoleModel(ctx, agent, task.model, authorize)
    authorize()
    try { await this.agentDelivery.send(agent, key(request.id), request.text, 'queue', host.lifetime, authorize) }
    catch (error) {
      const received = sealedHistory(agent, request)
      if (received.taskSeq !== undefined || received.pending || received.inserted) throw new Later('Inspection delivery is awaiting its native persistence receipt', { cause: error })
      throw error
    }
    const received = sealedHistory(agent, request)
    if (received.taskSeq === undefined && !received.pending && !received.inserted) throw new Error('Inspection did not receive its sealed task')
  }

  /** Pin a new Worker's initial model in the same transaction as its business reservation. */
  reserveWorker(ticketId: string, sessionId: string): void {
    if (sessionId !== workerSessionId(ticketId)) throw new Error('Worker reservation does not match its Ticket')
    this.host.store.atomic(() => {
      this.bindWorker(ticketId, sessionId)
      this.initialWorkerModel(ticketId, sessionId)
    })
  }
  private initialWorkerModel(ticketId: string, sessionId: string) {
    const { store } = this.host
    const key = KV.sessions.workerModel(sessionId), pinned = store.get(key)
    if (pinned !== undefined) return pinned
    const ticket = store.tickets.get(ticketId)
    if (!ticket) throw new Error(`Unknown Worker Ticket ${ticketId}`)
    const { executor } = store.settings(), role = ticket.plan?.role
    const model = role === 'backend' ? executor.backendModel : role === 'frontend' ? executor.frontendModel : executor.model
    if (!model && (role === 'backend' || role === 'frontend')) throw new Error(`Missing executor.${role}Model for Worker ${sessionId}`)
    store.set(key, model ?? null)
    return model ?? null
  }
  /** A native turn may not use the host default while a reserved Worker route is still being initialized. */
  workerModelReady(sessionId: string): boolean {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    return !!agent && this.readyWorkerModels.has(agent)
  }
  private async prepareWorkerModel(agent: Agent, ticketId: string, authorize: () => void): Promise<void> {
    const current = () => { authorize(); this.requireWorkerRoot(agent, workerSessionId(ticketId)) }
    await initializeRoleModel(this.ctx, agent, () => this.initialWorkerModel(ticketId, agent.id), current)
    current()
    this.readyWorkerModels.add(agent)
  }
  private requireWorkerRoot(agent: Agent, sessionId: string): void {
    const { header } = agent.session
    if (this.ctx.agents.get(agent.id) !== agent || agent.id !== sessionId || header.id !== sessionId ||
      header.parentSession !== undefined || header.origin === 'subagent') {
      throw new Error(`Resolved Session is not the Ticket's root Worker ${sessionId}`)
    }
  }
  /** Trusted host dispatch/receipt seam. A binding records attribution, never permission to start a turn. */
  bindWorker(ticketId: string, sessionId: string, retry = false): void {
    const scope = { session_id: sessionId, ticket_id: ticketId,
      ...this.host.projectMeter.owns(sessionId) ? {} : { parent_session_id: this.host.currentHubId() ?? this.host.masterId } }
    this.host.projectMeter.bind({ ...scope, role: 'implementation' })
    if (retry) this.host.projectMeter.bind({ ...scope, role: 'retry' })
  }
  /** Automatic executor retries continue the very same Session and cumulative cursor. */
  async retry(ticketId: string, sessionId: string, requestId: string, text: string): Promise<void> {
    if (!this.host.workerAuthorized(ticketId, sessionId)) throw new Error(`No verified writer for retry of ${sessionId}`)
    await this.prompt(sessionId, requestId, text, 'queue', undefined, () => this.bindWorker(ticketId, sessionId, true))
  }
  /** Reads a delivered message by its stable request ID. Reconciliation requires the original Session to be readable. */
  async holds(sessionId: string, requestId: string, required = false): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) {
      if (required) throw new Error(`Cannot verify delivery to Session ${sessionId}: ${result.error.code}`)
      return false
    }
    return this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const ticketId = ticketOfSession(sessionId)
    if (!ticketId && this.host.isHubGeneration(sessionId)) {
      if (this.host.currentHubId() !== sessionId) throw new Later('Hub Session is inactive')
      await this.promptHub(key(requestId), text, mode, authorize, accepted)
      return
    }
    const granted = () => {
      if (ticketId && !this.host.workerAuthorized(ticketId, sessionId)) {
        throw new Error(`Worker ${sessionId} has no verified writer grant; refusing its turn`)
      }
      authorize?.()
    }
    granted()
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    if (ticketId !== undefined) await this.prepareWorkerModel(result.agent, ticketId, granted)
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, granted, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  private async deliverRelay(requestId: string, text: string): Promise<void> {
    try { await this.promptHub(key(requestId), text, 'steer', () => {
      if (!this.host.relayAvailable(requestId)) throw withdrawnRelay
    }) }
    catch (error) { if (error !== withdrawnRelay) throw error }
  }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the current Hub without waking it; unavailable authority keeps the effect durable for retry. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const text = JSON.stringify(value)
    await this.promptHub(`notice:${name}:${key(text)}`, text, { inject: summary })
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = this.ctx.agents.list().flatMap(agent => {
      const binding = this.bindings.get(agent)
      const revision = binding?.ticketId ? prompts.forTicket(binding.ticketId).revision : store.get(KV.sessions.prompts(agent.id))?.at(-1)
      return revision === undefined ? [] : [{ sessionId: agent.id, revision }]
    })
    return { revision: prompts.effective().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the pinned prompt version for ticket Sessions, otherwise the latest version worked under. */
  promptVersion(sessionId: string): PromptVersion {
    const ticketId = ticketOfSession(sessionId) ?? this.host.store.get(KV.projectMeter.binding(sessionId))?.ticket_id
    if (ticketId) return this.host.prompts.forTicket(ticketId)
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.effective() : this.host.prompts.version(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: async (args, execution) => {
          if ((name === 'orchestrator_lookup' || name === 'orchestrator_settings_save') && execution.agent !== agent) {
            throw new Error('Only the calling Hub may use this tool')
          }
          const release = binding.role === 'orchestrator' ? this.beginHubOperation(agent.id) : undefined
          try { return await execute(schema.parse(args), execution.signal, execution.callId) }
          finally { release?.() }
        } }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Reserve splitter tools for the live root Session in this published handoff's workspace. */
  isSplitterSession(agent: Agent): boolean {
    const id = splitterHandoffId(agent.id), { cwd, parentSession } = agent.session.header
    if (!id || !cwd || !isAbsolute(cwd) || parentSession !== undefined || this.ctx.agents.get(agent.id) !== agent) return false
    const workspace = this.host.splitterWorkspace(id)
    if (workspace === undefined) return false
    if (relative(workspace, cwd) === '') return true
    // DSH canonicalizes the workspace at creation; a confirmed path may name a directory symlink.
    try { return relative(realpathSync.native(workspace), realpathSync.native(cwd)) === '' } catch { return false }
  }
  private async decorate(agent: Agent, inspectionTask?: InspectionTask): Promise<void> {
    if (agent.id.startsWith('inspection-')) {
      let binding = this.bindings.get(agent)
      if (!binding) {
        binding = { disposers: [agent.ctx.tools.restrict({ allow: [] }), agent.ctx.tools.guard(({ name }) =>
          inspectionTools.includes(name) && this.ctx.agents.get(agent.id) === agent && this.inspectionModelAllowed(agent.id) ? undefined : INSPECTION_DENIED)] }
        this.bindings.set(agent, binding)
      }
      if (!inspectionTask || binding.inspection) return
      this.checkInspectionTask(inspectionTask)
      if (agent.id !== inspectionTask.sessionId || this.host.store.get(KV.inspection.native(agent.id)) !== agent.session.header.createdAt
        || !matchesNativeRoot(this.ctx, agent, inspectionCreation(inspectionTask), INSPECTION_PRESET)) throw new Error('Unverified inspection root')
      registerInspection(agent, this.host.inspection!, () => this.inspectionTaskFor(agent), binding.disposers)
      binding.inspection = inspectionTask
      return
    }
    const scopeId = scopeProposalId(agent.id)
    if (scopeId !== undefined) {
      let binding = this.bindings.get(agent)
      if (!binding) {
        binding = { disposers: [agent.ctx.tools.restrict({ allow: [] }), agent.ctx.tools.guard(({ name }) => {
          if (name !== scopeToolName || !this.scopeModelAllowed(agent.id)) return PLANNER_DENIED
          return undefined
        })] }
        this.bindings.set(agent, binding)
      }
      if (binding.scopeReviewer || !this.verifiedScopeRoots.has(agent)) return
      this.scopeTaskFor(agent)
      binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-scope-review', order: 9999, complete: true,
        interpolate: false, text: promptFile('plan-requirement-scope-review') }),
        registerScopeTool(agent, () => this.scopeTaskFor(agent), task => this.host.verifyScopeWorkspace(task),
          verdict => this.host.recordScopeReview(scopeId, agent.id, verdict)))
      binding.scopeReviewer = true
      binding.ready = Promise.resolve()
      this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
      if (agent.status === 'idle') this.retryHealth.clear(agent.id)
      this.updateModelHealth()
      return
    }
    const prior = this.bindings.get(agent)
    if (prior) {
      if (prior.role !== 'splitter' || prior.ready || !this.isSplitterSession(agent)) { await prior.ready; return }
      // A reserved Session seen before publication had only a denying guard, not the splitter registrations.
      this.release(agent)
    }
    const host = this.host
    // A native child can carry a caller-selected id. Never decorate one as a privileged root by its prefix.
    if (agent.session.header.parentSession !== undefined) {
      const planner = plannerHandoffId(agent.id), splitter = splitterHandoffId(agent.id), worker = ticketOfSession(agent.id)
      if (host.isHubGeneration(agent.id) || (planner && host.ownsPlanner(planner)) || (splitter && host.splitterWorkspace(splitter))
        || (worker && host.store.tickets.get(worker))) {
        this.bindings.set(agent, { disposers: [agent.ctx.tools.guard(() => WORKER_ANCESTRY_PENDING)] })
      } else await this.limitSubagent(agent)
      return
    }
    const master = host.isHubGeneration(agent.id)
    if (master && !this.isHubRoot(agent)) return
    const plannerId = master ? undefined : plannerHandoffId(agent.id)
    const splitterId = master ? undefined : splitterHandoffId(agent.id)
    const ticket = master || plannerId || splitterId ? undefined : this.ticketOf(agent)
    if (!ticket && agent.session.header.agentPreset === WORKER_PRESET) {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId) {
        this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId) })
        return
      }
    }
    if (!master && !plannerId && !splitterId && !ticket) return
    const handoffRole = plannerId ? 'planner' : splitterId ? 'splitter' : undefined
    const role: PromptRole = handoffRole ?? (master ? 'orchestrator' : 'worker')
    const binding: SessionBinding = { disposers: [], role }
    if (ticket) binding.ticketId = ticket.id
    this.bindings.set(agent, binding)
    if (master) {
      // The router preset omits the shell, jobs and every write tool; restrict the inherited surface too, so a profile that
      // still mounts one cannot hand it to the Hub. The Hub's own orchestrator_* tools are scoped registrations and stay.
      binding.disposers.push(agent.ctx.tools.restrict({ allow: HUB_TOOLS }))
      binding.disposers.push(agent.ctx.tools.guard(() => this.hubToolsAvailable(agent.id) ? undefined : 'Hub Session is inactive'))
    } else if (plannerId) {
      binding.disposers.push(...this.plannerOnly(agent, plannerId))
      if (!host.ownsPlanner(plannerId)) return
    } else if (splitterId) {
      binding.disposers.push(...this.splitterOnly(agent))
      if (!this.isSplitterSession(agent)) return
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, role, current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master || handoffRole ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, this.promptFor(agent, false))
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    binding.ready = Promise.resolve(skillScope).then(() => {
      // Bail out if the agent was disposed while awaiting the skill scope.
      if (this.bindings.get(agent) !== binding) return
      const register = this.registerTool(agent, binding)
      for (const tool of host.tools(agent, ticket, handoffRole)) {
        const shared = SHARED_HOST_TOOLS.includes(tool.name)
        const planner = PLANNER_HOST_TOOLS.includes(tool.name), splitter = SPLITTER_HOST_TOOLS.includes(tool.name)
        if (plannerId ? !shared && !planner : splitterId ? !shared && !splitter : planner || splitter) continue
        register(tool.name, tool.description, tool.schema, tool.execute)
      }
    })
    await binding.ready
  }
  /** Restrict every planner turn to read-only tools and its own handoff tools, including restored Sessions. */
  private plannerOnly(agent: Agent, handoffId: string): (() => void)[] {
    const allow = PLANNER_TOOLS.filter(name => agent.ctx.tools.get(name, scopeParentOf(agent)))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(({ name }) => {
      if (this.host.closing() || !this.host.plannerActive(handoffId)) return PLANNER_INACTIVE
      return PLANNER_TOOLS.includes(name) || SHARED_HOST_TOOLS.includes(name) || PLANNER_HOST_TOOLS.includes(name) ? undefined
        : PLANNER_DENIED
    })]
  }
  /** Deny inherited research, writes, delegation, and user communication even when the preset exposes them. */
  private splitterOnly(agent: Agent): (() => void)[] {
    const allow = SPLITTER_TOOLS.filter(name => agent.ctx.tools.get(name, scopeParentOf(agent)))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(({ name, arguments: args }) => {
      if (this.host.lifetime.aborted || !this.isSplitterSession(agent)) return SPLITTER_INACTIVE
      if (name === 'skill') {
        return (args as { name?: unknown } | null)?.name === splitterSkill.name ? undefined : SPLITTER_DENIED
      }
      return SHARED_HOST_TOOLS.includes(name) || SPLITTER_HOST_TOOLS.includes(name) ? undefined : SPLITTER_DENIED
    })]
  }
  /**
   * An Executor Session uses inherited work tools and the preset's Context7 documentation tools only while its ticket has
   * a verified live writer grant. Read inherited tools through the parent scope, which includes the preset's tools;
   * the global view misses preset tools and the agent's own view also includes local tools that `restrict` refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string, toolNames: readonly string[] = WORK_TOOLS): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = [...toolNames, ...DEV_MCP_TOOLS].filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(({ name, arguments: args }) => {
      const current = store.tickets.get(ticketId)
      if (!current || !liveTicket(current)) return WORKER_TICKET_ENDED
      if (name === 'orchestrator_credential_blocked' && agent.id === workerSessionId(ticketId)
        && agent.session.header.parentSession === undefined && this.host.credentialBlocked?.(ticketId)) return undefined
      if (!this.host.workerAuthorized(ticketId, workerSessionId(ticketId))) return WORKER_WRITER_REQUIRED
      if (name === 'skill') {
        const skill = (args as { name?: unknown } | null)?.name
        if (typeof skill === 'string' && (skill.startsWith(SKILL_PREFIX) || skill.startsWith('dsh-worker-'))
          && !this.bindings.get(agent)?.skills?.names.has(skill)) return WORKER_SKILL_NOT_BOUND
      }
      return undefined
    })]
  }
  /**
   * The ticket a Session belongs to, following `parentSession` from any depth. A loaded ancestor's session header answers;
   * an ancestor that is not loaded is inspected in persistence, so a reloaded or created child is protected even when an
   * intermediate Session is no longer live. A cycle or a chain proven not to reach a worker ends the search; an inspection
   * failure does not prove non-ownership and must leave the Session guarded.
   */
  private async owningTicket(agent: Agent): Promise<{ ticketId: string; nativeParents: boolean } | undefined> {
    const seen = new Set<string>([agent.id])
    let parent = agent.session.header.parentSession, nativeParents = true
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      const ticketId = ticketOfSession(parent), loaded = this.ctx.agents.get(parent)
      if (ticketId !== undefined) return { ticketId, nativeParents: nativeParents && loaded?.session.header.parentSession === undefined }
      if (loaded) {
        const session = loaded.session
        nativeParents &&= session.header.origin === 'subagent' && nativeDescriptor(session.snapshotEvents(), session.inheritedEventCount)
        parent = session.header.parentSession
      } else {
        const inspection = await this.ctx.sessionController.inspect(parent, this.host.lifetime)
        nativeParents &&= inspection.meta?.origin === 'subagent' && nativeDescriptor(inspection.events, inspection.inheritedEventCount)
        parent = inspection.meta?.parentSession
      }
    }
    return undefined
  }
  /** Review submissions also check the clean HEAD in the Executor. An old role binding never grants current writer authority. */
  async authorizeReviewSession(ticketId: string, sessionId: string, axis: ReviewAxis, candidate: string): Promise<boolean> {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    const review = agent && this.bindings.get(agent)?.review
    if (review?.ticketId !== ticketId || this.host.closing() || !this.host.workerAuthorized(ticketId, workerSessionId(ticketId))) return false
    const current = this.host.store.tickets.get(ticketId), { grant } = review
    return !!current && liveTicket(current) && grant.axis === axis && grant.candidate === candidate
      && grant.base === current.execution?.base?.sha && grant.generation === latestAssignment(current)?.writer?.generation
  }
  private async limitSubagent(agent: Agent): Promise<void> {
    const parent = agent.session.header.parentSession
    if (parent === undefined) return
    // A live Session reloaded on startup can invoke tools while persistence resolves an unloaded parent.
    const pending: SessionBinding = { disposers: [agent.ctx.tools.guard(() => WORKER_ANCESTRY_PENDING)], subagent: true }
    this.bindings.set(agent, pending)
    const lineage = await this.owningTicket(agent)
    if (this.bindings.get(agent) !== pending || this.host.closing()) return
    if (!lineage) { this.release(agent); return }
    const { ticketId, nativeParents } = lineage
    pending.ticketId = ticketId
    pending.role = 'worker'
    pending.disposers.push(...this.workOnly(agent, ticketId))
    if (agent.session.header.origin !== 'subagent') { pending.disposers.shift()!(); return }
    // Native children without a proven dispatch keep their guard, including a native child of an ordinary fork.
    if (nativeParents && this.host.projectMeter.owns(parent)) this.observeChild(agent, pending, ticketId, parent)
  }

  /** Child setup precedes its task; the Skill call comes later still. Never read either out of inherited history. */
  private observeChild(agent: Agent, binding: SessionBinding, ticketId: string, parent: string): void {
    const host = this.host, worker = workerSessionId(ticketId), session = agent.session
    const issued = host.store.tickets.get(ticketId)
    const cwd = session.header.cwd, worktree = issued?.execution?.worktree
    if (!cwd || !worktree || relative(worktree, cwd) !== '' || issued?.execution?.session !== worker) return
    const bound = host.store.get(KV.projectMeter.binding(agent.id))
    if (bound && (bound.ticket_id !== ticketId || bound.parent_session_id !== parent)) return
    let limited = false
    let admitted = false
    let initial: UserMessage | undefined
    const observe = (claimed?: UserMessage) => {
      if (host.closing()) return
      const events = session.snapshotEvents(), cut = session.inheritedEventCount
      if (!nativeDescriptor(events, cut)) return
      const task = events.find(event => event.seq >= cut && event.type === 'user/message')
      initial ??= claimed
      const message = task?.type === 'user/message' ? task.data : initial
      if (!message) return
      const grant = reviewTask(message)
      const ticket = host.store.tickets.get(ticketId)
      if (!ticket) return
      if (!admitted) {
        const version = host.prompts.forTicket(ticketId)
        const skillScope = agent.ctx.inject(['skills'], scope => {
          binding.scope = scope
          binding.skills = undefined
          this.bindSkills(binding, version)
        })
        binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => {
          this.ctx.logger.warn('dsh-superagent could not release a child skill scope: %s', String(error))
        }) })
      }
      if (grant && !limited) {
        // Restrict as soon as the delegated task is known, not after the first model call/Skill lookup.
        binding.disposers.push(...this.workOnly(agent, ticketId, REVIEW_TOOLS))
        limited = true
      }
      const writer = latestAssignment(ticket)?.writer
      const review = grant && grant.base === ticket.execution?.base?.sha && grant.generation === writer?.generation
      // Attribution recognizes a proven native dispatch even while its writer is being restored. Tools still require a live writer.
      if (!host.projectMeter.owns(agent.id)) {
        const historicalReview = grant && grant.base === ticket.execution?.base?.sha
          && ticket.assignments.some(item => item.writer?.generation === grant.generation)
        host.projectMeter.bind({ session_id: agent.id, parent_session_id: parent, ticket_id: ticketId, role: historicalReview ? 'review' : 'implementation' })
      }
      if (!admitted) { binding.disposers.shift()!(); admitted = true }
      if (review && grant) {
        if (!task || !loadedReviewSkill(events, task.seq)) return
        binding.review = { ticketId, grant }
        const register = this.registerTool(agent, binding)
        for (const tool of host.tools(agent, ticket, 'review')) {
          if (tool.name === 'orchestrator_review_submit' || tool.name === 'orchestrator_read') register(tool.name, tool.description, tool.schema, tool.execute)
        }
      }
      delete binding.observeDelegation
    }
    binding.observeDelegation = observe
    observe()
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    const names = new Set<string>()
    for (const [name, content] of this.host.prompts.skills(version.config, binding.role)) {
      const bundled = binding.role === 'splitter' ? splitterSkill : isBundledSkill(name) ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      const registeredName = bundled?.name ?? `${SKILL_PREFIX}${name}`
      names.add(registeredName)
      disposers.push(scope.skills.register({ name: registeredName, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, names, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return a ticket's pinned prompt or the effective current prompt, refreshing skills and recording non-ticket history. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const binding = this.bindings.get(agent)
    const ticketId = binding?.ticketId ?? ticketOfSession(agent.id)
    const version = ticketId ? this.host.prompts.forTicket(ticketId) : this.host.prompts.effective()
    if (!bind) return version
    if (binding) this.bindSkills(binding, version)
    if (ticketId) return version
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
