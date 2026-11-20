/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, latestAssignment, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { settingsPolicy, SettingsSchema } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { sameDirectory } from '../infra/environment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Handoffs } from './handoffs.ts'
import { TopicBinding } from './topic-binding.ts'
import { Installation, projectDatabase, projectHubId } from './installation.ts'
import { InstallationError } from './installation-api.ts'
import { Planning } from './planning.ts'
import { Plans, planDeliveryWriter } from './plans.ts'
import { PlanDispatcher } from './plan-dispatch.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { projectNavigationLink } from '../navigation.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices, recoverPulls } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings, SOURCE as FEISHU } from '../sources/feishu.ts'
import { health, type FeishuTopic, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { SessionMeter } from './session-meter.ts'
import { Sessions, splitterSessionId } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { plannerTools, type PlannerToolsHost } from './tools/planner.ts'
import { splitterTools, type SplitterToolsHost } from './tools/splitter.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects persistent `Handoffs` and `Planning` with `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `SessionMeter`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly handoffs: Handoffs
  readonly topicBinding?: TopicBinding
  readonly plans: Plans
  readonly planDispatcher: PlanDispatcher
  readonly planning: Planning
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly meter: SessionMeter
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  readonly installation: Installation
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private disposeHttp?: () => Promise<void>
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private recoveryPending = false
  private setupFeishuCli?: string
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost & PlannerToolsHost & SplitterToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  readonly machine: Machine
  constructor(ctx: Context, machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    machine = { ...machine, stateDir: realpathSync.native(machine.stateDir) }
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    let catalog: Installation | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const installation = catalog = this.installation = new Installation({ machine, signal: this.lifetime,
        probe: workerProbe(ctx.subprocess, machine.stateDir, machine.stateDir, this.lifetime),
        restart: () => { setTimeout(restart, 0) }, configured: () => this.configured(), paused: () => this.store.settings().paused,
        recoveryPending: () => this.recoveryPending,
        recoverable: () => this.recoverable(), settings: () => this.store.settings(), legacyHubId: () => this.legacyHubId(machine.stateDir),
        legacyHandoffsMatch: ({ repository, workspace }) => this.handoffs.list().every(handoff =>
          handoff.project.repository.toLowerCase() === repository.toLowerCase() && sameDirectory(handoff.project.workspace, workspace)) })
      const project = installation.project
      const projectMachine = this.machine = { ...machine, stateDir: installation.stateDir }
      const store = opened = this.store = new Store(projectDatabase(installation), report)
      if (project?.initial && store.get(KV.settings.revision) === undefined) {
        const { baseRef, policy } = project.initial
        store.saveSettings(SettingsSchema.parse({ policy, sources: { github: { config: { repository: project.repository } } },
          executor: { repository: project.workspace, baseRef } }))
      }
      if (project && store.settings().executor.repository !== project.workspace) {
        const saved = store.settings()
        store.saveSettings({ ...saved, executor: { ...saved.executor, repository: project.workspace } })
      }
      const setup = this.setup = new Setup({ context: ctx, machine: projectMachine, lifetime: this.lifetime, restart }, project ? {
        managed: () => installation.github && { repository: project.repository, github: installation.github },
      } : { legacy: () => installation.legacyGithub, verifyLegacy: cli => installation.verifyLegacyGithub(cli) })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? projectHubId(installation.stateDir)
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const meter = this.meter = new SessionMeter({ context: ctx, store, lifetime: this.lifetime })
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const handoffs = this.handoffs = new Handoffs(store, effects, project, () => installation.assertNewWork(),
        handoff => this.topicBinding?.changed(handoff))
      const plans = this.plans = new Plans(store, handoffs, effects)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx, meter,
        ownsSession: id => this.ownsSession(id),
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, boundWorkspace: project?.workspace,
        closing: () => this.closing(), environment, ownsPlanner: id => handoffs.get(id) !== undefined,
        plannerActive: id => this.configured() && handoffs.isPlanning(id),
        splitterWorkspace: id => {
          if (!this.configured()) return undefined
          const handoff = handoffs.get(id)
          return handoff?.id === id && handoff.status === 'specified' && handoff.spec?.handoffId === id ? project?.workspace ?? handoff.project.workspace : undefined
        },
        workerAuthorized: (ticketId, sessionId) => !this.closing() && this.configured() && runtime.executor?.writerAuthorized(ticketId, sessionId) === true,
        tools: (agent, ticket, role) => role === 'planner' ? plannerTools(this.toolHost, agent)
          : role === 'splitter' ? splitterTools(this.toolHost, agent)
          : ticket ? executorTools(this.toolHost, ticket, agent.id) : mainTools(this.toolHost, agent) })
      const verifyProjectBinding = installation.validateWorkspace.bind(installation)
      this.planning = new Planning({ handoffs, plans, effects, sessions, verifyProjectBinding,
        paused: () => this.paused(), closing: () => this.closing() })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() },
        validate: (before, after) => {
          if (this.closing()) throw new InstallationError(409, 'switching')
          if (project && (before.sources.github?.config.cli !== after.sources.github?.config.cli
            || before.sources.github?.config.repository !== after.sources.github?.config.repository
            || before.executor.repository !== after.executor.repository || before.executor.directory !== after.executor.directory)) {
            throw new InstallationError(409, 'projectBindingImmutable')
          }
        } })
      this.executor = new DshExecutor({ context: ctx, commands, get engine() { return runtime.engine }, store, effects,
        health: board.claim('worker'), machine: projectMachine, lifetime: this.lifetime, sessions, closing: () => this.closing(),
        paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, commands, paused: () => this.paused(), sources: {
        instance: sources.instance.bind(sources), channelAllowed: channel => channel.address.bindingEpoch !== undefined
          ? channel.source === FEISHU : sources.channelAllowed(channel),
        send: async (message, deliveryCommands) => {
          if (message.channel.address.bindingEpoch !== undefined) {
            if (!this.topicBinding?.allows(message.channel)) return 'waiting'
            const revision = store.get(KV.settings.revision)
            await installation.validateWorkspace()
            // Answering in Harness can withdraw the question while the checkout is being verified.
            if (store.receipts.get(message.id)?.status !== 'pending') return 'waiting'
            if (!this.topicBinding.allows(message.channel) || revision !== store.get(KV.settings.revision)) return 'waiting'
          }
          return sources.send(message, deliveryCommands)
        },
      } })
      const topicHealth = project ? board.claim('feishuBinding') : undefined
      if (project) {
        const link = (view: 'project' | 'settings') => projectNavigationLink(`http://127.0.0.1:${ctx.webServer.port}`, project.id, view)
        this.topicBinding = new TopicBinding({ store, handoffs, outbox, sources, projectId: project.id,
          get projectLink() { return link('project') }, get settingsLink() { return link('settings') },
          available: () => this.topicBindingAvailable(), botIdentity: () => {
            const bot = setup.configured() ? setup.deployment.feishu : undefined
            return bot && `${bot.appId}:${bot.botId}`
          },
          unbound: () => {
            if (!this.closing() && this.topicBinding?.view() === null)
              topicHealth?.set({ state: 'ready', detail: 'No Feishu topic is bound', at: now() })
          },
        })
      }
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, ...(project ? { projectId: project.id } : {}),
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          if (event.type === 'assignment.started') {
            const ticket = store.tickets.get(event.data.ticketId)
            plans.assignmentStarted(event.data.ticketId, event.data.assignmentId, ticket?.execution?.session ?? workerSessionId(event.data.ticketId))
          }
          if (event.type === 'ticket.ended') plans.assignmentEnded(event.data.ticketId)
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      this.planDispatcher = new PlanDispatcher({ store, plans, engine, executor })
      const planDelivery = planDeliveryWriter(plans)
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => this.configured(), closing: () => this.closing() })
      const sourceInactive = () => this.closing() || !installation.github
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => this.configured(), closing: sourceInactive,
        get setupProblem() { return runtime.setupProblem }, get feishuProblem() { return setup.feishuProblem },
        ...(topicHealth ? { feishuTopic: { target: () => this.feishuTopic(),
          claims: trigger => this.topicBinding?.claims(trigger) === true,
          receive: (trigger, epoch) => this.receiveBoundFeishu(trigger, epoch), report: value => topicHealth.set(value) } } : {}),
        receive: (trigger, kind) => {
          if (sourceInactive()) throw new InstallationError(409, installation.transitioning() ? 'switching' : 'githubSetupRequired')
          if (kind === FEISHU && this.topicBinding?.claims(trigger)) return this.receiveBoundFeishu(trigger)
          return passes.receive(trigger)
        } }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, executor, planDispatcher: this.planDispatcher, planDelivery, settings: this.settings, assessor, resources, handoffs, plans, lifetime: this.lifetime,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(), assertNewWork: () => installation.assertNewWork(), verifyProjectBinding,
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize().then(() => { installation.finishStartup() })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { try { catalog?.close() } finally { release() } }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() && !this.recoveryPending && !!this.installation.github }
  get setupProblem(): SetupProblem | undefined {
    const onboarding = this.installation.onboarding()
    return onboarding.status === 'blocked' ? onboarding.problem ?? this.setup.problem : this.setup.problem
  }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { if (this.recoveryPending) this.setup.restart(); else this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  async idle(): Promise<void> {
    await this.passes.idle()
    await this.executor.idleHandoffs()
    await this.passes.idle()
  }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag || this.lifetime.aborted || this.installation.transitioning() }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return this.closing() || !this.configured() || this.store.settings().paused }
  private topicBindingAvailable(): boolean {
    if (this.paused() || !this.installation.project || !this.deployment.feishu) return false
    const instance = this.sources.instance(FEISHU)
    return instance?.enabled === true && instance.config.cli === this.setupFeishuCli
  }
  private feishuTopic(): FeishuTopic | undefined {
    if (this.closing()) return undefined
    const target = this.topicBinding?.pollTarget()
    if (target && target.projectId === this.installation.project?.id)
      return { epoch: target.epoch, since: target.boundAt, chatId: target.chatId, direct: target.direct,
        sourceRevision: this.store.blockRevision(`source:${FEISHU}`),
        ...(target.rootId ? { rootId: target.rootId } : {}) }
    return undefined
  }
  /** Verify the mounted checkout as well as the Feishu setup before accepting a bound ingress or creating a binding. */
  private async verifyTopicBinding(): Promise<void> {
    this.installation.assertNewWork()
    if (!this.topicBindingAvailable()) throw new InstallationError(409, 'projectSetupRequired', 'Enable the verified Feishu Source first.')
    const revision = this.store.get(KV.settings.revision)
    await this.installation.validateWorkspace()
    this.installation.assertNewWork()
    if (!this.topicBindingAvailable() || revision !== this.store.get(KV.settings.revision)) throw new InstallationError(409, 'staleProject')
  }
  private async receiveBoundFeishu(trigger: Trigger, expectedEpoch?: string): Promise<ReceiveResult> {
    const binding = this.topicBinding
    // Normal ingress has already classified protocol traffic. Exact polling gets no generic fallback.
    if (this.closing() || !binding || (expectedEpoch !== undefined && !binding.claims(trigger))) return 'filtered'
    const target = this.feishuTopic()
    if ((expectedEpoch !== undefined && target?.epoch !== expectedEpoch) || !binding.matches(trigger)) return 'filtered'
    if (!binding.eligible(trigger)) {
      binding.discard(trigger)
      return 'filtered'
    }
    // Pause or setup can recover on the same binding: don't mark the authorized message as consumed while unavailable.
    if (!target) return 'filtered'
    await this.verifyTopicBinding()
    const current = this.feishuTopic()
    if (current?.epoch !== target.epoch || current.sourceRevision !== target.sourceRevision) {
      if (!this.closing() && binding.view()?.epoch !== target.epoch) binding.discard(trigger)
      return 'filtered'
    }
    return binding.receive(trigger) ? 'stored' : 'filtered'
  }
  private recoverable() {
    return {
      assignments: this.store.tickets.open().filter(ticket => latestAssignment(ticket)?.state !== 'ended').length,
      handoffs: this.handoffs.list().filter(handoff => handoff.status === 'confirmed' || handoff.status === 'planning'
        || (handoff.status === 'specified' && this.plans.get(handoff.id) === undefined)).length,
      effects: this.effects.count(),
    }
  }
  private legacyHubId(stateDir: string): string {
    if (sameDirectory(stateDir, this.machine.stateDir)) return this.masterId
    const path = join(stateDir, 'orchestrator.sqlite')
    if (!existsSync(path)) return projectHubId(stateDir)
    const store = new Store(path)
    try { return store.get(KV.runtime.masterId) ?? projectHubId(stateDir) }
    finally { store.close() }
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposeHttp = registerHttp(this.ctx, this.httpHost())
    await this.installation.initialize()
    if (this.closing()) return
    const project = this.installation.project
    if (project) this.sessions.install()
    if (this.installation.project && this.installation.github) {
      try { await this.installation.validateWorkspace() }
      catch (error) {
        if (this.closing()) return
        if (!(error instanceof InstallationError)) throw error
        this.runtimeHealth.set({ state: 'error', detail: error.message, at: now() })
        return
      }
    }
    const settings = this.store.settings()
    this.setupFeishuCli = String(settings.sources[FEISHU]?.config.cli ?? '').trim()
    if ((this.installation.project && !this.installation.github) || !await this.setup.run(settings)) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    if (!project) this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, project?.initial ? project.workspace : this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    if (this.closing()) return
    if (project && !await this.reconcilePulls()) return
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.planDispatcher.resume()
    this.planning.resume()
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private async reconcilePulls(): Promise<boolean> {
    const source = this.context({ kind: 'github', health: ['github'] })
    try {
      await recoverPulls(source, this.lifetime)
      for (const ticket of this.store.tickets.open()) {
        const assignment = latestAssignment(ticket)
        if (assignment?.state !== 'running' && assignment?.state !== 'pending') continue
        // An observed merge is durable. Another restart must not resume the same Assignment if the PR's head can no longer be found.
        const merged = ticket.follows?.find(({ thread, closed }) => thread.startsWith('github:')
          && closed?.outcome === 'merged' && Date.parse(closed.at) >= Date.parse(assignment.createdAt))
        if (merged) {
          this.recoveryPending = true
          this.runtimeHealth.set({ state: 'error', detail: `GitHub PR #${merged.thread.slice('github:'.length)} has merged but its Ticket is still open. Resolve the Ticket before retrying recovery.`, at: now() })
          return false
        }
      }
      return !this.closing()
    } catch {
      if (this.closing()) return false
      this.recoveryPending = true
      this.runtimeHealth.set({ state: 'error', detail: 'Could not reconcile tracked GitHub pull requests. Run the setup check to retry recovery.', at: now() })
      return false
    }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, sourceLinks, setup, passes, installation,
      meter } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, sourceLinks, meter, installation,
      topicBinding: this.topicBinding, verifyTopicBinding: () => this.verifyTopicBinding(),
      get ready() { return runtime.ready }, assertNewWork: () => installation.assertNewWork(),
      ownsSession: id => this.ownsSession(id),
      get deployment() { return setup.deployment },
      get setupProblem() { return runtime.setupProblem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => runtime.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { runtime.checkSetup() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  private ownsSession(id: string): boolean {
    if (!this.installation.project || id === this.masterId) return true
    const ticketId = ticketOfSession(id)
    if (ticketId) return this.store.tickets.get(ticketId) !== undefined
    return this.handoffs.list().some(handoff => `planner-${handoff.id}` === id || splitterSessionId(handoff.id) === id)
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      const http = this.disposeHttp?.()
      this.assessor.stop()
      await this.ready.catch(() => {})
      const handoffSessions = () => this.handoffs.list().flatMap(({ id }) => {
        const splitter = this.ctx.agents.get(splitterSessionId(id) as SessionId)
        return splitter && this.sessions.isSplitterSession(splitter) ? [`planner-${id}`, splitter.id] : [`planner-${id}`]
      })
      const live = (ids: string[]) => ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      const agents = live([this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id)), ...handoffSessions()])
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([http, passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // An effect may have been creating a planner or splitter when shutdown took the first snapshot.
      const lateHandoffs = live(handoffSessions()).filter(agent => !agents.includes(agent))
      for (const agent of lateHandoffs) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(lateHandoffs.map(agent => agent.whenIdle()))
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      await this.ctx.sessionPersistence.flush()
      this.installation.stopped()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { try { this.store.close() } finally { this.installation.close() } } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
