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
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, latestAssignment, UserError, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { policyVersion, settingsPolicy, SettingsSchema } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { sameDirectory } from '../infra/environment.ts'
import { fill } from '../infra/text.ts'
import { promptFile } from './skill-files.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, workerSessionId } from '../executor/dsh.ts'
import { validateRepositoryIdentity } from '../executor/repository-identity.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects, Later, Park } from './effects.ts'
import { Handoffs } from './handoffs.ts'
import { TopicBinding } from './topic-binding.ts'
import { SettingsConfirmations } from './settings-confirmations.ts'
import { Installation, projectDatabase, projectHubId } from './installation.ts'
import { InstallationError } from './installation-api.ts'
import { Planning } from './planning.ts'
import { Plans, planDeliveryWriter } from './plans.ts'
import { PlanRequirements } from './plan-requirements.ts'
import { PlanControl } from './plan-control.ts'
import { hubResumeText } from './hub-resume.ts'
import { PlanStagnation } from './plan-stagnation.ts'
import { PlanIntegration } from './plan-integration.ts'
import { Maintenance } from './maintenance.ts'
import { releaseAdapter } from './release-adapter.ts'
import { ScopedAttention } from './scoped-attention.ts'
import { PlanDispatcher } from './plan-dispatch.ts'
import { MainlineQueue, mainlineIntent } from './mainline-queue.ts'
import { advanceMainline, precedes, prepareMainline, readMainline, readPlanIntegrationTarget, verifyDeliveryOnTarget } from '../executor/mainline-git.ts'
import { Prompts, promptByteLimit, PromptConflict } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { projectNavigationLink, ticketNavigationLink } from '../navigation.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice, promptsNotice } from './notices.ts'
import { dispatchPlanActions, isLatestPlanActions, observePlanActions } from '../sources/actions-evidence.ts'
import { cleanupPlanArtifactStaging, commitPlanArtifact, discardPlanArtifact, downloadPlanArtifact, openPlanArtifact, planArtifactExists } from './plan-artifacts.ts'
import { pullEndNotices, recoverPulls } from '../sources/github-pull.ts'
import { githubKind } from '../sources/github.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings, SOURCE as FEISHU } from '../sources/feishu.ts'
import { health, type FeishuTopic, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { SessionMeter, SessionMeterIdentityError } from './session-meter.ts'
import { matchesMeterHeader, ProjectMeter, type MeterLogAccess, type MeterSessionBinding } from './project-meter.ts'
import { RunLimits } from './run-limits.ts'
import { installModelAdmission } from './model-admission.ts'
import { restoreReviewBindings } from './meter-recovery.ts'
import { PLANNER_PRESET, ROUTER_PRESET, Sessions, splitterSessionId, WORKER_PRESET } from './sessions.ts'
import { HubAuthority } from './hub-authority.ts'
import { bindRequiredChecks, Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import { approveMainline, authorizeMainline, inspectFormalDelivery, type ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { plannerTools, type PlannerToolsHost } from './tools/planner.ts'
import { splitterTools, type SplitterToolsHost } from './tools/splitter.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { scopeProposalId } from './tools/requirement-scope.ts'

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
  readonly settingsConfirmations?: SettingsConfirmations
  readonly plans: Plans
  private readonly planIntegration: PlanIntegration
  private readonly maintenance?: Maintenance
  readonly planDispatcher: PlanDispatcher
  readonly attention: ScopedAttention
  readonly planning: Planning
  private readonly stagnation: PlanStagnation
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly meter: SessionMeter
  readonly projectMeter: ProjectMeter
  readonly runLimits: RunLimits
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
  masterId: string
  private feishuCardIdentity: string | undefined
  readonly hubId: string
  private readonly hubAuthority: HubAuthority
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private disposeHttp?: () => Promise<void>
  private disposeAdmission?: () => void
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
        recoverable: () => this.recoverable(), settings: () => this.store.settings(), legacyHubId: stateDir => this.legacyHubId(stateDir),
        legacyHandoffsMatch: ({ repository, workspace }) => this.handoffs.list().every(handoff =>
          handoff.project.repository.toLowerCase() === repository.toLowerCase() && sameDirectory(handoff.project.workspace, workspace)) })
      const project = installation.project
      const projectMachine = this.machine = { ...machine, stateDir: installation.stateDir }
      cleanupPlanArtifactStaging(projectMachine.stateDir)
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
      const legacyMasterId = store.get(KV.runtime.masterId) ?? projectHubId(installation.stateDir)
      const authority = this.hubAuthority = new HubAuthority(store, legacyMasterId, projectHubId(installation.stateDir))
      this.hubId = authority.hubId()
      const masterId = this.masterId = authority.visibleSessionId()
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const meter = this.meter = new SessionMeter({ context: ctx, store, lifetime: this.lifetime })
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const handoffs = this.handoffs = new Handoffs(store, effects, project, () => installation.assertNewWork(),
        handoff => this.topicBinding?.changed(handoff))
      const plans = this.plans = new Plans(store, handoffs, effects,
        (plan, node) => planControl.dispatchBlocked(plan, node), (id, node) => planControl.blocksNode(id, node))
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu, plans)
      const credentialChecks = new Map(projectMachine.credentialChecks?.filter(check => check.projectId === project?.id)
        .map(check => [check.id, check]))
      const attention = this.attention = new ScopedAttention({ store, plans, projectId: project?.id,
        available: () => this.configured() && !this.closing(), verifier: id => credentialChecks.get(id),
        check: async id => {
          const check = credentialChecks.get(id)
          if (!check) return false
          const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(30_000)])
          try {
            const handle = ctx.subprocess.spawn({ argv: [check.executable, ...check.args], cwd: machine.stateDir, signal,
              graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
            const outcome = await handle.done
            return !signal.aborted && outcome.exitCode === 0 && outcome.signal === null
          } catch { return false } // A verifier's output and errors are private, even on failure.
        },
        writerAuthorized: (ticketId, sessionId) => this.executor.writerAuthorized(ticketId, sessionId),
        relay: message => this.sessions.relay(message.id, message.text),
        suspend: ticketId => this.executor.suspendForCredential(ticketId),
        quotaBlocked: ticketId => this.runLimits.blocked(ticketId),
        drained: ticketId => this.executor.drainedForCredential(ticketId),
        resume: (ticketId, blockerId) => this.executor.resumeAfterCredential(ticketId, blockerId),
      })
      const projectMeter = this.projectMeter = new ProjectMeter({ store, meter, plans, masterId, canSample: binding => this.canSample(binding) })
      const runLimits = this.runLimits = new RunLimits({ store, relay: message => this.sessions.relay(message.id, message.text),
        changed: () => { if (!this.closing()) this.executor.reconcileQuotaPauses() } })
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        if (kind.policy?.sync || project) void this.ready?.then(async () => {
          if (this.closing() || this.sources.kind(kind.kind) !== kind) return
          if (kind.policy?.sync && this.settings.syncable().includes(kind.kind))
            await this.settings.sync(kind.kind).catch(() => { /* sync() records its failure in health. */ })
          if (!this.closing() && this.sources.kind(kind.kind) === kind) await this.maintenance?.resume(kind.kind)
        }).catch((error: unknown) => ctx.logger.warn('Could not resume Source %s: %s', kind.kind, String(error)))
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, get masterId() { return runtime.masterId }, context: ctx,
        meter: { read: (id, signal) => this.readScopedMeter(id, signal) }, plans,
        rulesManifestMaxBytes: () => promptByteLimit(machine.promptMaxChars.get()),
        reviewGeneration: ticketId => runtime.executor?.reviewGeneration(ticketId),
        credentialBlocked: ticketId => attention.blocked(ticketId),
        quotaBlocked: ticketId => runLimits.blocked(ticketId),
        promptVersion: id => this.sessions.promptVersion(id),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions: Sessions = this.sessions = new Sessions({ context: ctx, store, projectMeter, prompts, effects, health: board.claim('models'), masterId,
        currentHubId: () => authority.currentSessionId(), readyHubId: () => authority.readySessionId(), hubTargetId: () => authority.targetSessionId(),
        hubGenerations: () => authority.generations(), isHubGeneration: id => authority.isGeneration(id),
        hubCreation: id => authority.creation(id), hubRequiresProof: id => authority.generationEpoch(id) !== 0,
        hubRotation: () => authority.rotation(), beginHubRotation: (cwd, offset, turn) => authority.beginRotation(cwd, offset, turn),
        sealHubRotation: cwd => authority.sealRotation(cwd),
        activateHub: id => {
          authority.activate(id, epoch => hubResumeText({ store, handoffs, plans, effects, project: installation.project, hubId: runtime.hubId, epoch }))
          projectMeter.bind({ session_id: id, role: 'hub' })
        },
        hubResume: () => {
          const resume = authority.pendingResume()
          return resume && { ...resume, text: resume.text ?? hubResumeText({ store, handoffs, plans, effects,
            project: installation.project, hubId: runtime.hubId, epoch: resume.epoch }) }
        },
        hubResumeDelivered: requestId => { authority.resumeDelivered(requestId); runtime.masterId = authority.visibleSessionId() },
        ...(project ? { recordOperator: (input, transferred, historical) => this.maintenance?.receiveOperator(input, transferred, historical) } : {}),
        lifetime: this.lifetime, boundWorkspace: project?.workspace,
        relayAvailable: requestId => this.planIntegration.relayAvailable(requestId) && this.maintenance?.relayAvailable(requestId) !== false,
        closing: () => this.closing(), environment, ownsPlanner: id => handoffs.get(id) !== undefined,
        plannerActive: id => this.configured() && handoffs.isPlanning(id),
        scopeTask: id => {
          if (this.paused()) throw new Later('Requirement scope review is paused')
          const task = requirements.scopeTask(id)
          if (!task) return undefined
          installation.assertNewWork()
          const checkout = project?.workspace ?? store.settings().executor.repository
          const handoff = handoffs.get(task.planId)
          if (!checkout || !handoff || !sameDirectory(checkout, task.workspace) || !isAbsolute(task.workspace)
            || handoff.project.repository.toLowerCase() !== this.deployment.repository.toLowerCase()) {
            throw new Error('Requirement scope task does not belong to the active project checkout')
          }
          return task
        },
        verifyScopeWorkspace: async task => {
          const handoff = handoffs.get(task.planId)
          if (!handoff) throw new Error('Requirement scope handoff no longer exists')
          if (project) await installation.validateWorkspace(handoff.project)
          else await validateRepositoryIdentity(commands, task.workspace, handoff.project.repository)
        },
        recordScopeReview: (id, reviewer, verdict) => store.atomic(() => {
          const preview = requirements.recordScopeReview(id, reviewer, verdict)
          effects.cancel('requirementScopeReview', id)
          sessions.relay(key('requirement-scope-result', id), JSON.stringify({ kind: 'plan-requirement-scope-review',
            read: `plan-requirement/${id}`, classification: preview.scopeReview.status }))
        }),
        splitterWorkspace: id => {
          if (!this.configured()) return undefined
          const handoff = handoffs.get(id)
          return handoff?.id === id && handoff.status === 'specified' && handoff.spec?.handoffId === id ? project?.workspace ?? handoff.project.workspace : undefined
        },
        workerAuthorized: (ticketId, sessionId) => !this.closing() && this.configured() && runtime.executor?.writerAuthorized(ticketId, sessionId) === true,
        credentialBlocked: ticketId => attention.blocked(ticketId),
        tools: (agent, ticket, role) => role === 'planner' ? plannerTools(this.toolHost, agent)
          : role === 'splitter' ? splitterTools(this.toolHost, agent)
          : ticket ? executorTools(this.toolHost, ticket, agent.id, role === 'review') : mainTools(this.toolHost, agent) })
      const releaseConfig = projectMachine.planRelease?.find(check => check.projectId === project?.id)
      const planIntegration = this.planIntegration = new PlanIntegration({ store, effects, plans, handoffs, lifetime: this.lifetime,
        verification: project && machine.planVerification?.find(check => check.projectId === project.id),
        release: releaseConfig ? releaseAdapter(releaseConfig, projectMachine.stateDir, ctx.subprocess, this.lifetime) : undefined,
        releaseArtifact: async (planId, view) => (await openPlanArtifact(projectMachine.stateDir, planId, view))?.path,
        paused: () => this.paused(),
        controlBlocked: id => planControl.blocksRelease(id),
        target: () => {
          if (!project || !setup.configured()) return undefined
          const ref = store.settings().executor.baseRef?.trim()
          return ref?.startsWith('refs/heads/') ? { repository: project.workspace, slug: project.repository, ref } : undefined
        },
        readTarget: (target, integrations) => readPlanIntegrationTarget(commands, target, integrations),
        observe: request => observePlanActions(commands, request),
        isLatestRun: (request, run) => isLatestPlanActions(commands, request, run),
        downloadArtifact: (planId, request, run, artifact) => downloadPlanArtifact(commands, projectMachine.stateDir, planId, request, run, artifact),
        commitArtifact: commitPlanArtifact, discardArtifact: discardPlanArtifact,
        artifactAvailable: async (planId, view) => !!await openPlanArtifact(projectMachine.stateDir, planId, view),
        artifactExists: (planId, view) => planArtifactExists(projectMachine.stateDir, planId, view),
        dispatch: request => dispatchPlanActions(commands, request),
        deliveryLink: planId => {
          const ticketId = plans.get(planId)?.nodes.map(node => plans.state(planId, node.id)?.claim.ticketId).find(Boolean)
          const origin = `http://127.0.0.1:${ctx.webServer.port}`
          return project && ticketId ? ticketNavigationLink(origin, project.id, ticketId)
            : project ? projectNavigationLink(origin, project.id, 'project') : origin
        },
        relay: message => sessions.relay(message.id, message.text),
        cancelRelay: id => effects.cancel('relay', id),
      })
      const verifyProjectBinding = installation.validateWorkspace.bind(installation)
      this.planning = new Planning({ handoffs, plans, effects, sessions, verifyProjectBinding,
        paused: () => this.paused(), closing: () => this.closing() })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() },
        runLimitsChanged: () => runLimits.configurationChanged(),
        validate: (before, after) => {
          if (this.closing()) throw new InstallationError(409, 'switching')
          const oldGithub = before.sources.github?.config, newGithub = after.sources.github?.config
          if (project && ((oldGithub?.cli ?? '') !== (newGithub?.cli ?? '')
            || (oldGithub?.repository ?? '') !== (newGithub?.repository ?? '')
            || before.executor.repository !== after.executor.repository || before.executor.directory !== after.executor.directory)) {
            throw new InstallationError(409, 'projectBindingImmutable')
          }
          const overrides = after.executor.runLimits?.ticketOverrides
          if (overrides !== before.executor.runLimits?.ticketOverrides) for (const { planId, nodeId } of overrides ?? []) {
            if (!plans.get(planId)) throw new UserError('unknownPlan', { id: planId })
            if (!plans.at(planId, 1)?.plan.nodes.some(node => node.id === nodeId)) throw new UserError('unknownPlanNode', { id: planId, node: nodeId })
          }
        } })
      this.executor = new DshExecutor({ context: ctx, commands, get engine() { return runtime.engine }, store, effects,
        health: board.claim('worker'), machine: projectMachine, lifetime: this.lifetime, sessions, closing: () => this.closing(),
        credentialBlocked: ticketId => attention.blocked(ticketId),
        planControlBlocked: ticketId => planControl.blocksWorker(ticketId),
        controlDrained: (ticketId, assignmentId) => planControl.stopped(ticketId, assignmentId),
        controlResumeBlocked: ({ plan }) => !plan || !!this.planDispatcher.resumeBlock(plan.planId, plan.nodeId),
        diagnosisAllowed: (ticket, inputId) => runtime.stagnation.allowed(ticket, inputId),
        reassignmentAllowed: ticket => runtime.stagnation.allowed(ticket),
        quota: runLimits,
        paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(runtime.masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
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
            if (message.channel.address.settingsRequest) return this.settingsConfirmations!.deliver(message, deliveryCommands)
          }
          return sources.send(message, deliveryCommands)
        },
      } })
      const topicHealth = project ? board.claim('feishuBinding') : undefined
      const cardHealth = project ? board.claim('feishuCards') : undefined
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
        this.settingsConfirmations = new SettingsConfirmations({ store, settings: this.settings, sources, topic: this.topicBinding,
          projectId: project.id, repository: project.repository, cardIdentity: () => this.feishuCardIdentity })
      }
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, ...(project ? { projectId: project.id } : {}),
        credentialBlocked: ticketId => attention.blocked(ticketId),
        quotaBlocked: ticketId => runLimits.blocked(ticketId),
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          if (event.type === 'ticket.created') {
            const { ticketId } = event.data
            const binding = store.tickets.get(ticketId)?.plan
            const repair = binding && plans.repairSource(binding.planId, binding.nodeId)
            prompts.bindTicket(ticketId, repair ? prompts.forTicket(repair.ticketId).revision : undefined)
            if (binding) {
              const inherited = repair && store.get(KV.plans.requiredChecks(repair.ticketId))
              const required = inherited ?? githubKind.schema.parse(store.settings().sources.github?.config ?? {}).requiredChecks
              bindRequiredChecks(store, ticketId, required)
            }
          }
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
          if (ended && !ended.plan && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      if (project) this.maintenance = new Maintenance({ store, effects, project, handoffs, plans, sources,
        stage: () => planIntegration.stage(), observe: (trigger, mode) => engine.receive(trigger, mode),
        feishuIngress: trigger => feishu() && sources.instance(FEISHU)?.config.cli === this.setupFeishuCli
          ? this.topicBinding?.maintenanceIngress(trigger) : undefined,
        bindingEpoch: () => this.topicBinding?.view()?.epoch,
        relay: (id, text) => sessions.relay(id, text), relayConsumed: id => sessions.relayConsumed(id) })
      this.planDispatcher = new PlanDispatcher({ store, plans, engine, executor, attention, limits: runLimits,
        get control() { return planControl },
        paused: () => this.paused(),
        bindWorker: (ticket, id) => sessions.bindWorker(ticket, id) })
      const stagnation = this.stagnation = new PlanStagnation({ store, plans, limits: runLimits, engine,
        paused: () => this.paused(), eligible: ticket => {
          const binding = ticket.plan
          if (!binding || store.get(KV.plans.retired(binding.planId, binding.nodeId)) || attention.blocked(ticket.id)
            || planControl.blocksTicket(ticket.id)) return false
          const merge = mainlineIntent(store, ticket.id)
          return !merge || merge.status === 'waiting' || (merge.status === 'repair' && merge.repair_requested === true)
        }, replaceReview: (ticketId, previous, current) => {
          if (previous) effects.cancel('replanReview', key('plan-replan', ticketId, previous))
          if (current) effects.enqueue('replanReview', key('plan-replan', ticketId, current), { ticketId, failureId: current })
        } })
      effects.handle('replanReview', async ({ ticketId, failureId }, requestId) => {
        const plan = store.tickets.get(ticketId)?.plan
        if (!plan) return
        const withdrawn = new Error('The Plan recovery review no longer applies')
        const authorize = () => {
          const review = stagnation.review(ticketId, failureId)
          if (!review) throw withdrawn
          if (review === 'held') throw new Later()
        }
        try {
          const { planId, nodeId } = plan
          await sessions.prompt(this.masterId, requestId, JSON.stringify({ kind: 'plan-replan-review', plan: `plan/${planId}`,
            failure: `plan/${planId}/node/${nodeId}/recovery/${failureId}`, instructions: promptFile('plan-replan-relay') }), 'steer', authorize)
        } catch (error) { if (error !== withdrawn) throw error }
      }, { limit: () => this.configured() && !this.closing() ? 1 : 0 })
      const requirements = new PlanRequirements({ store, plans, handoffs, limits: runLimits,
        stop: (ticketId, reason) => { engine.stopTicket(ticketId, reason) }, authorize: () => installation.assertNewWork(),
        migrateHolds: (planId, replacements) => planControl.replaceNodes(planId, replacements),
        mainlineHeld: ticketId => planControl.blocksTicket(ticketId), cancelQueuedMerge: ticketId => mainline.cancelQueued(ticketId),
        requestScopeReview: id => effects.enqueue('requirementScopeReview', id, {}), isHubGeneration: id => authority.isGeneration(id), isCurrentHub: id => authority.isCurrent(id) })
      const scopeDispatchOpen = () => {
        if (this.paused()) return false
        const state = runLimits.view()?.budget.state
        return state === 'unlimited' || state === 'available'
      }
      effects.handle('requirementScopeReview', async (_, id) => {
        if (!requirements.scopeTask(id)) return
        await sessions.deliverScope(id, () => { if (!scopeDispatchOpen()) throw new Later('Requirement scope review dispatch is held') })
        if (requirements.scopeTask(id)) return Park
      }, { limit: () => scopeDispatchOpen() ? 1 : 0 })
      const planDelivery = planDeliveryWriter(plans, id => engine.closePlanTicket(id))
      const mainline = new MainlineQueue({ store, effects, lifetime: this.lifetime,
        available: () => this.configured() && !this.closing(), paused: () => this.paused(),
        controlBlocked: ticketId => planControl.blocksTicket(ticketId),
        approve: async (id, candidate, signal, replay) => {
          if (replay) await executor.settleMainlineWriter(id)
          return approveMainline(resources, id, candidate, signal, replay)
        },
        authorize: (id, approval) => {
          if (!this.configured() || this.closing()) throw new Error('The project is not available for mainline writes')
          authorizeMainline(resources, id, approval)
        },
        inspectDelivery: async (intent, verify) => {
          await executor.settleMainlineWriter(intent.ticket_id)
          return inspectFormalDelivery(resources, intent, verify, this.lifetime)
        },
        closeDelivery: (approval, receipt) => {
          if (!this.configured() || this.closing()) return 'delivery_target_changed'
          const { ticketId } = receipt, plan = store.tickets.get(ticketId)?.plan
          if (!plan) return 'plan_claim'
          try {
            authorizeMainline(resources, ticketId, approval)
            store.atomic(() => {
              if (approval.rulesRevision !== undefined) {
                prompts.publish(ticketId, approval.rulesRevision, receipt)
                const rules = prompts.current().config.admissionRules
                if (rules !== undefined) {
                  const previous = store.settings()
                  const next = { ...previous, policy: { ...previous.policy, rules } }
                  const from = policyVersion(previous), to = policyVersion(next)
                  if (from !== to) {
                    store.saveSettings(next, { source: 'panel', block: 'policy', policyVersion: to, policyChanged: true, notified: [] })
                    engine.policyChanged(from, to)
                  }
                }
                sessions.notify(...promptsNotice(approval.rulesRevision))
              }
              planDelivery.deliver(plan.planId, plan.nodeId, receipt)
              planIntegration.enqueue(plan.planId)
            })
          } catch (error) {
            if (error instanceof PromptConflict) return 'shared_rules_proposal_changed'
            if (error instanceof UserError) {
              if (error.code === 'mainlineRefused') return 'delivery_target_changed'
              if (error.code === 'invalidPlan' || error.code === 'unknownPlan' || error.code === 'unknownPlanNode') return 'plan_claim'
            }
            throw error
          }
          return undefined
        },
        read: target => readMainline(commands, target),
        precedes: (target, ancestor, descendant) => precedes(commands, target, ancestor, descendant),
        verifyDelivery: (target, base, integration, actual, scope) => verifyDeliveryOnTarget(commands, target, base, integration, actual, scope),
        prepare: (target, candidate, intent, queuedAt) => prepareMainline(commands, target, candidate, intent, queuedAt),
        advance: (target, base, candidate, authorize) => advanceMainline(commands, target, base, candidate, authorize),
        repair: (id, repair) => executor.requestMainlineRepair(id, repair),
        changed: (intent, delivered) => {
          const status = delivered ? 'delivered' : intent.delivery_missing ? 'delivery_blocked' : intent.status
          sessions.relay(key('mainline', intent.id, status), fill(promptFile('mainline-relay'), {
            status, resource: `ticket/${intent.ticket_id}/mainline`, delivery: `ticket/${intent.ticket_id}/delivery-check`,
          }))
        },
      })
      const planControl: PlanControl = new PlanControl({ store, plans, handoffs, isCurrentHub: id => authority.isCurrent(id),
        isHubGeneration: id => authority.isGeneration(id), authorize: () => {
          if (this.closing()) throw new InstallationError(409, 'switching')
        },
        suspend: ticketId => executor.pauseForControl(ticketId), waiting: (id, node) => this.planDispatcher.resumeBlock(id, node),
        rearm: (planId, ticketIds, retryOnly) => {
          for (const ticketId of ticketIds) {
            const ticket = store.tickets.get(ticketId)
            if (ticket && !ticket.ended && latestAssignment(ticket)?.state !== 'ended' && !planControl.blocksWorker(ticketId) &&
                (!retryOnly || effects.pending('planControlResume', ticketId))) effects.enqueue('planControlResume', ticketId, {})
            if (!retryOnly) mainline.resumeTicket(ticketId)
          }
          if (!retryOnly) planIntegration.resumePlan(planId)
        } })

      // Reconcile historical dispatch receipts before serving even paused/setup-pending reads. This grants no tools or writer lease.
      this.planDispatcher.restoreBindings()
      const { requiredChecks } = githubKind.schema.parse(store.settings().sources.github?.config ?? {})
      for (const ticket of store.tickets.list()) {
        if (ticket.plan && !ticket.ended) bindRequiredChecks(store, ticket.id, requiredChecks)
        if (!ticket.ended || ticket.execution?.session) {
          const prior = store.get(KV.sessions.prompts(workerSessionId(ticket.id)))?.at(-1)
          prompts.bindTicket(ticket.id, prior)
        }
        if (ticket.execution?.session) sessions.bindWorker(ticket.id, ticket.execution.session)
        for (const [index, assignment] of ticket.assignments.entries()) {
          const replacement = ticket.assignments[index - 1]?.endedReason
          if (assignment.writer?.session) sessions.bindWorker(ticket.id, assignment.writer.session,
            assignment.startedAt !== undefined && (replacement === 'retried' || replacement === 'reassigned'))
        }
      }
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); stagnation.scan(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => this.configured(), closing: () => this.closing() })
      const sourceInactive = () => this.closing() || !installation.github
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => this.configured(), closing: sourceInactive,
        get setupProblem() { return runtime.setupProblem }, get feishuProblem() { return setup.feishuProblem },
        ...(topicHealth ? { feishuTopic: { target: () => this.feishuTopic(),
          cardReady: (identity, ready, problem) => {
            const bot = setup.configured() ? setup.deployment.feishu : undefined
            if (this.closing() || !bot || identity !== `${bot.appId}:${bot.botId}`) return
            this.feishuCardIdentity = ready ? identity : undefined
            if (problem) cardHealth?.set(health('error', problem === 'unavailable' ? 'feishuCardsUnavailable'
              : problem === 'interrupted' ? 'feishuCardsInterrupted' : 'feishuCardsProcessing'))
            else if (ready) cardHealth?.set({ state: 'ready', detail: 'Listening for Feishu card actions', at: now() })
            else if (cardHealth?.get()?.state !== 'error') cardHealth?.set({ state: 'paused', detail: 'Not listening for Feishu card actions' })
          },
          cardAction: async event => {
            if (!this.topicBindingAvailable() || this.feishuCardIdentity !== event.botIdentity) return
            const revision = store.get(KV.settings.revision)
            await installation.validateWorkspace()
            if (this.topicBindingAvailable() && store.get(KV.settings.revision) === revision) this.settingsConfirmations?.cardAction(event)
          },
          claims: trigger => this.topicBinding?.claims(trigger) === true,
          maintenanceSince: topic => this.maintenance?.feishuSince(topic.epoch, topic.sourceRevision),
          resolvedMaintenance: (topic, messageId) => {
            const lookup = KV.feishu.maintenanceLookup(messageId)
            if (store.get(lookup)?.epoch === topic.epoch) store.delete(lookup)
          },
          receive: (trigger, epoch) => this.receiveBoundFeishu(trigger, epoch), report: value => topicHealth.set(value) } } : {}),
        receive: (trigger, kind) => {
          if (sourceInactive()) throw new InstallationError(409, installation.transitioning() ? 'switching' : 'githubSetupRequired')
          if (trigger.source !== kind) return 'filtered'
          if (kind === FEISHU && this.topicBinding?.claims(trigger)) return this.receiveBoundFeishu(trigger)
          return this.receive(trigger)
        } }
      this.toolHost = { context: ctx, engine, store, sessions, executor, mainline, planDispatcher: this.planDispatcher, settings: this.settings,
        planControl,
        assessor, resources, projectMeter, runLimits, attention, handoffs, plans, planIntegration, maintenance: this.maintenance,
        stagnation, requirements, lifetime: this.lifetime,
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
  receive(trigger: Trigger): ReceiveResult {
    if (this.closing()) throw new Error('Orchestrator is stopping')
    if (this.maintenance && this.planIntegration.stage().stage === 2) {
      const result = this.maintenance.receive(trigger)
      if (result === 'stored') this.passes.request()
      return result
    }
    return this.passes.receive(trigger)
  }
  /** Rotate the physical Hub Session while retaining the project identity and durable work state. */
  async rotateHub(): Promise<string> {
    this.installation.assertNewWork()
    const cwd = this.installation.project?.workspace ?? this.store.settings().executor.repository ?? this.machine.stateDir
    return this.sessions.rotateHub(cwd, 'dsh-superagent orchestrator')
  }
  /** Current physical Hub Session ID; the project identity is `hubId`. */
  get hubSessionId(): string { return this.masterId }
  /** The published successor for a physical conversation retired by the mounted project. */
  hubConversation(sessionId: string): string | undefined {
    const target = this.hubAuthority.continuation(sessionId)
    return target && this.sessions.isPublishedHub(target) ? target : undefined
  }

  async idle(): Promise<void> {
    await this.effects.idle('hubInbox')
    await this.sessions.idleHubTransfers()
    await this.passes.idle()
    await this.executor.idleHandoffs()
    await this.passes.idle()
    await this.effects.idle('hubInbox')
    await this.sessions.idleHubTransfers()
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
    if (this.closing() || !binding) return 'filtered'
    // Exact-topic polling never falls back to normal intake for an unclaimed protocol message.
    if (expectedEpoch !== undefined && !binding.claims(trigger)) {
      if (this.feishuTopic()?.epoch !== expectedEpoch || this.planIntegration.stage().stage !== 2) return 'filtered'
      return this.maintenance?.receive(trigger, expectedEpoch) ?? 'filtered'
    }
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
    if (this.planIntegration.stage().stage === 2 && (trigger.meta.parentId || trigger.meta.messageType !== 'text')) {
      if (trigger.meta.parentId || trigger.meta.messageType !== undefined) binding.discard(trigger)
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
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(KV.runtime.masterId) as { value: string } | undefined
      if (row) {
        const saved = JSON.parse(row.value) as unknown
        if (typeof saved === 'string' && saved.trim()) return saved
      }
      return projectHubId(stateDir)
    } finally { database.close() }
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposeHttp = registerHttp(this.ctx, this.httpHost())
    this.runLimits.recover()
    this.executor.recoverPauses()
    this.disposeAdmission = installModelAdmission(this.ctx, {
      owns: id => scopeProposalId(id) !== undefined || this.projectMeter.owns(id) || this.sessions.hasManagedAncestry(id),
      acquire: (id, maximum, signal) => {
        const binding = this.store.get(KV.projectMeter.binding(id))
        if (this.closing() || !binding) return { admitted: false, reason: 'Run limit Session is not authorized in this mount' }
        if (scopeProposalId(id) !== undefined && !this.sessions.scopeModelAllowed(id)) {
          return { admitted: false, reason: 'Requirement scope reviewer has no authorized native task in this mount' }
        }
        const { ticket_id: ticket } = binding
        if (ticket && !this.executor.writerAuthorized(ticket, workerSessionId(ticket))) {
          return { admitted: false, reason: 'Run limit Session has no active Ticket writer' }
        }
        return this.runLimits.acquire(binding, maximum, signal)
      },
    }, this.lifetime)
    await this.installation.initialize()
    if (this.closing()) return
    const project = this.installation.project
    try { await restoreReviewBindings(this.ctx, this.store, this.projectMeter, this.lifetime) }
    catch (error) { if (this.closing()) return; throw error }
    if (this.closing()) return
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
    const initialHubCwd = project?.initial ? project.workspace : this.machine.stateDir
    const hubCwd = this.hubAuthority.rotation() ? project?.workspace ?? settings.executor.repository ?? initialHubCwd : initialHubCwd
    await this.sessions.ensureHub(hubCwd, 'dsh-superagent orchestrator')
    if (this.closing()) return
    if (project && !await this.reconcilePulls()) return
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // Reconcile the package receipt before restarting other Plan work or background loops.
    if (this.closing()) return
    await this.planIntegration.resume()
    if (this.closing()) return
    await this.maintenance?.resume()
    if (this.closing()) return
    this.planDispatcher.resume()
    this.planning.resume()
    this.effects.wakeParked('requirementScopeReview')
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
        if (ticket.plan || this.attention.blocked(ticket.id)) continue // A Plan resumes from durable Git intent, not a closed PR.
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
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, sourceLinks, setup, passes, installation,
      projectMeter } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, get masterId() { return runtime.masterId }, sourceLinks, projectMeter, installation,
      attention: this.attention, runLimits: this.runLimits, planIntegration: this.planIntegration,
      planArtifact: async id => {
        const view = this.planIntegration.view(id)
        return view && 'artifact' in view && (!('artifactAvailable' in view) || view.artifactAvailable !== false)
          ? await openPlanArtifact(machine.stateDir, id, view) : undefined
      },
      meter: { read: (id, signal) => this.readScopedMeter(id, signal) },
      topicBinding: this.topicBinding, settingsConfirmations: this.settingsConfirmations, verifyTopicBinding: () => this.verifyTopicBinding(),
      get ready() { return runtime.ready }, assertNewWork: () => installation.assertNewWork(), rotateHub: () => runtime.rotateHub(),
      hubConversation: id => runtime.hubConversation(id),
      ownsSession: id => this.ownsSession(id),
      get deployment() { return setup.deployment },
      get setupProblem() { return runtime.setupProblem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => runtime.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { runtime.checkSetup() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  private ownsSession(id: string): boolean {
    return !this.installation.project || this.projectMeter.owns(id)
  }

  private async readScopedMeter(id: string, signal?: AbortSignal) {
    if (!this.installation.project) return this.meter.read(id, signal)
    const binding = this.store.get(KV.projectMeter.binding(id))
    if (!binding) return undefined
    const access = await this.canSample(binding)
    if (access === 'unavailable') throw new Error('Session log identity could not be read')
    if (typeof access === 'string') return access === 'read' ? this.meter.read(id, signal) : undefined
    try { return await this.meter.read(id, signal, header => matchesMeterHeader(access.header, header)) }
    catch (error) { if (error instanceof SessionMeterIdentityError) return undefined; throw error }
  }

  /** Check the host log independently of the business binding; a reservation alone does not prove log identity. */
  private async canSample(binding: MeterSessionBinding): Promise<MeterLogAccess> {
    const { session_id: id, ticket_id: ticketId, parent_session_id: parentId, roles } = binding
    const hub = roles.includes('hub'), planning = roles.includes('planner') || roles.includes('splitter')
    const scopeId = scopeProposalId(id)
    const parent = parentId ? this.store.get(KV.projectMeter.binding(parentId)) : undefined
    const worker = !!ticketId && parent?.roles.includes('hub') && roles.includes('implementation')
    const nativeChild = !!ticketId && !worker && (roles.includes('implementation') || roles.includes('review'))
    if (!hub && !planning && !worker && !nativeChild && scopeId === undefined) return 'read' // Explicit host registrations (retro and inspection).
    const ticket = ticketId ? this.store.tickets.get(ticketId) : undefined, execution = ticket?.execution
    if (worker && (!ticket || execution?.ownership?.ticket !== ticketId || !execution.ownership.verified || !execution.worktree)) return 'unverified'
    const issued = worker && (execution?.session === id || ticket?.assignments.some(item => item.writer?.session === id))
    if (worker && !issued) return 'unverified'
    const historyVerified = !worker || ticket?.assignments.some(item => item.writer?.session === id && item.startedAt !== undefined) === true
    let header = this.ctx.agents.get(id as SessionId)?.session.header
    if (!header) {
      try { header = (await this.ctx.sessionPersistence.stat(id as SessionId, { signal: this.lifetime }))?.header }
      catch (error) {
        this.lifetime.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        return historyVerified ? 'unavailable' : 'unverified'
      }
    }
    if (!header) return historyVerified ? 'not-found' : 'unverified'
    if (header.id !== id) return 'unverified'
    if (nativeChild) return header.origin === 'subagent' && header.parentSession === parentId ? { header } : 'unverified'
    if (header.origin !== undefined || header.parentSession !== undefined || header.isSeeded) return 'unverified'
    if (scopeId !== undefined) {
      const pin = this.store.get(KV.planRequirements.reviewer(scopeId))
      const preview = this.store.get(KV.planRequirements.preview(scopeId))
      const workspace = preview && this.handoffs.get(preview.handoffId)?.project.workspace
      return roles.includes('review') && !!parentId && this.hubAuthority.isGeneration(parentId) && preview?.planId === binding.plan_id && pin?.sessionId === id
        && pin.createdAt === header.createdAt && header.agentPreset === PLANNER_PRESET && workspace && header.cwd && isAbsolute(header.cwd)
        && sameDirectory(workspace, header.cwd) ? { header } : 'unverified'
    }
    const project = this.installation.project
    const handoff = planning ? this.handoffs.get(id.slice(id.indexOf('-') + 1)) : undefined
    // Rotation generations were provisioned in the mounted workspace; the legacy first generation keeps its old directory.
    const epoch = hub ? this.hubAuthority.generationEpoch(id) : undefined
    const cwd = worker ? execution?.worktree : planning ? handoff && (project?.workspace ?? handoff.project.workspace)
      : epoch !== undefined && epoch > 0 ? project?.workspace : project?.initial ? project.workspace : this.machine.stateDir
    const preset = worker ? WORKER_PRESET : planning ? PLANNER_PRESET : ROUTER_PRESET
    return header.agentPreset === preset && cwd && header.cwd && isAbsolute(header.cwd) && sameDirectory(cwd, header.cwd)
      ? { header } : 'unverified'
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
      const reviewSessions = () => this.ctx.agents.list().filter(agent => scopeProposalId(agent.id) !== undefined && this.projectMeter.owns(agent.id)).map(agent => agent.id)
      const agents = live([...this.hubAuthority.generations(), this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id)), ...handoffSessions(), ...reviewSessions()])
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([http, passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // An effect may have been creating a planner or splitter when shutdown took the first snapshot.
      const lateHandoffs = live([...handoffSessions(), ...reviewSessions()]).filter(agent => !agents.includes(agent))
      for (const agent of lateHandoffs) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(lateHandoffs.map(agent => agent.whenIdle()))
      await this.sessions.idleHubTransfers()
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      await this.ctx.sessionPersistence.flush()
      this.installation.stopped()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.runLimits.close()
      this.disposeAdmission?.()
      this.setup.restore()
      try { try { this.store.close() } finally { this.installation.close() } } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
