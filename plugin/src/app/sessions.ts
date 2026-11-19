/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for managed DSH Sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { physicalPath } from '../infra/paths.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills, isBundledSkill, promptFile, splitterSkill } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts, type Role as PromptRole } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  readonly boundWorkspace?: string | undefined
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Whether the persisted handoff is in its active planning state; all other statuses deny planner tools. */
  plannerActive(handoffId: string): boolean
  /** Workspace authorized by a persisted published specification, including after registration for idempotent replay. */
  splitterWorkspace(handoffId: string): string | undefined
  /** In-process writer grant; a stored lease cannot authorize worker turns after a restart. */
  workerAuthorized?(ticketId: string, sessionId: string): boolean
  /** Handoff roles receive only their own tools, rather than the Hub's or a worker ticket's. */
  tools(agent: Agent, ticket?: Ticket, role?: 'planner' | 'splitter'): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void };
  role?: PromptRole; subagent?: true; ready?: Promise<void> }

/** The agent presets Executor, planner and main Sessions are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router', PLANNER_PRESET = 'dsh-superagent-planner'
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
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other DSH tool the profile has, whenever it was registered: none that asks or shows a person
 * something, changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold,
 * starts or messages other Sessions, or edits documents. Its only MCP tools are the Context7 documentation lookups below.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'apply_patch', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list',
  'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents',
  'interrupt_agent']
/**
 * The MCP tools an Executor Session may use, by the exact `mcp__<server>__<tool>` names Context7 registers: its read-only
 * documentation lookups. Messaging and other MCP servers stay out, so a Worker cannot send a person a message directly and
 * bypass the Hub. DSH's tool schema has no server or policy metadata, so the development server is named explicitly.
 */
const DEV_MCP_TOOLS = ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs']

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
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
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET
          : plannerHandoffId(sessionId) || (agent && this.isSplitterSession(agent)) ? PLANNER_PRESET
          : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
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
    if (role === 'worker' && (!ticketId || this.host.workerAuthorized?.(ticketId, id) === false)) {
      throw new Error(`Worker ${id} has no verified writer grant; refusing to create its Session`)
    }
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'planner' || role === 'splitter' ? PLANNER_PRESET : role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
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
      const createdIn = result.agent.session.header.cwd
      if (!createdIn) throw new Error(`Worker ${id} has no recorded workspace directory`)
      const [sessionPath, expectedPath] = await Promise.all([physicalPath(createdIn), physicalPath(cwd)])
      const same = process.platform === 'win32' ? sessionPath.toLowerCase() === expectedPath.toLowerCase() : sessionPath === expectedPath
      if (!same) throw new Error(`Worker ${id} belongs to ${createdIn}, not the verified ticket worktree ${cwd}`)
      if (this.host.workerAuthorized?.(ticketId!, id) === false) throw new Error(`Worker ${id} lost its writer grant before Session setup`)
    }
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const ticketId = ticketOfSession(sessionId)
    const granted = () => {
      if (ticketId && this.host.workerAuthorized?.(ticketId, sessionId) === false) {
        throw new Error(`Worker ${sessionId} has no verified writer grant; refusing its turn`)
      }
      authorize?.()
    }
    granted()
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, granted, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
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
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
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
  private async decorate(agent: Agent): Promise<void> {
    const prior = this.bindings.get(agent)
    if (prior) {
      if (prior.role !== 'splitter' || prior.ready || !this.isSplitterSession(agent)) { await prior.ready; return }
      // A reserved Session seen before publication had only a denying guard, not the splitter registrations.
      this.release(agent)
    }
    const host = this.host
    const master = agent.id === host.masterId
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
    if (!master && !plannerId && !splitterId && !ticket) { await this.limitSubagent(agent); return }
    const handoffRole = plannerId ? 'planner' : splitterId ? 'splitter' : undefined
    const role: PromptRole = handoffRole ?? (master ? 'orchestrator' : 'worker')
    const binding: SessionBinding = { disposers: [], role }
    this.bindings.set(agent, binding)
    if (master) {
      // The router preset omits the shell, jobs and every write tool; restrict the inherited surface too, so a profile that
      // still mounts one cannot hand it to the Hub. The Hub's own orchestrator_* tools are scoped registrations and stay.
      binding.disposers.push(agent.ctx.tools.restrict({ allow: HUB_TOOLS }))
    } else if (plannerId) {
      binding.disposers.push(...this.plannerOnly(agent, plannerId))
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
      this.bindSkills(binding, host.prompts.current())
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
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = [...WORK_TOOLS, ...DEV_MCP_TOOLS].filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      if (!current || !liveTicket(current)) return WORKER_TICKET_ENDED
      if (this.host.workerAuthorized?.(ticketId, workerSessionId(ticketId)) === false) return WORKER_WRITER_REQUIRED
      return undefined
    })]
  }
  /**
   * The ticket a Session belongs to, following `parentSession` from any depth. A loaded ancestor's session header answers;
   * an ancestor that is not loaded is inspected in persistence, so a reloaded or created child is protected even when an
   * intermediate Session is no longer live. A cycle or a chain proven not to reach a worker ends the search; an inspection
   * failure does not prove non-ownership and must leave the Session guarded.
   */
  private async owningTicket(agent: Agent): Promise<string | undefined> {
    const seen = new Set<string>()
    let parent = agent.session.header.parentSession
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      const ticketId = ticketOfSession(parent)
      if (ticketId !== undefined) return ticketId
      const loaded = this.ctx.agents.get(parent)
      if (loaded) { parent = loaded.session.header.parentSession; continue }
      parent = (await this.ctx.sessionController.inspect(parent)).meta?.parentSession
    }
    return undefined
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private async limitSubagent(agent: Agent): Promise<void> {
    if (agent.session.header.parentSession === undefined) return
    // A live Session reloaded on startup can invoke tools while persistence resolves an unloaded parent.
    const pending: SessionBinding = { disposers: [agent.ctx.tools.guard(() => WORKER_ANCESTRY_PENDING)], subagent: true }
    this.bindings.set(agent, pending)
    const ticketId = await this.owningTicket(agent)
    if (this.bindings.get(agent) !== pending || this.host.closing()) return
    if (ticketId === undefined) { this.release(agent); return }
    // Install the ticket guard before lifting the temporary one; an inspection error leaves the latter in place.
    pending.disposers.push(...this.workOnly(agent, ticketId))
    pending.disposers.shift()!()
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config, binding.role)) {
      const bundled = binding.role === 'splitter' ? splitterSkill : isBundledSkill(name) ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: bundled?.name ?? `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
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
