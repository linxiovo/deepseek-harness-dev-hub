import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { key } from '../core/ids.ts'
import type { ProjectRef } from '../core/handoff.ts'
import { verifyGithubAccount, verifyGithubRepository, type Machine, type Probe, type VerifiedGithub } from '../deployment.ts'
import { validateRepositoryIdentity } from '../executor/repository-identity.ts'
import { agentVariables, sameDirectory } from '../infra/environment.ts'
import { ExecutorConfigSchema, PolicyConfigSchema, type Settings } from '../policy.ts'
import { SetupError } from '../setup.ts'
import { InstallationError, type InstallationApi, type OnboardingView, type ProjectView, type RuntimeView } from './installation-api.ts'
import { containsWorkspace, isAbsoluteWorkspace, ProjectCatalog, ProjectConflict, type Project, type ProjectSuspension } from './projects.ts'

const execute = promisify(execFile)
const timestamp = () => new Date().toISOString()
const hubId = (stateDir: string) => `orchestrator-${key(stateDir)}`

interface InstallationHost {
  readonly machine: Machine
  readonly signal: AbortSignal
  readonly probe: Probe
  restart(): void
  configured(): boolean
  paused(): boolean
  recoveryPending(): boolean
  recoverable(): ProjectSuspension['recoverable']
  settings(): Settings
  legacyHubId(): string
  legacyHandoffsMatch(project: { repository: string; workspace: string }): boolean
}

/** Owns the verified account, project registration and remount decisions for one DSH installation. */
export class Installation implements InstallationApi {
  readonly project: Project | undefined
  private readonly catalog: ProjectCatalog
  private onboardingState: OnboardingView = { status: 'unconfigured' }
  private verifiedAccount?: VerifiedGithub
  private legacyAccount?: VerifiedGithub
  private resumed: ProjectSuspension | null = null
  private changing = false
  private switching = false
  private started = false

  constructor(private readonly host: InstallationHost) {
    this.catalog = new ProjectCatalog(host.machine.stateDir)
    try { this.project = this.catalog.selected() }
    catch (error) { this.catalog.close(); throw error }
  }

  get stateDir(): string { return this.project?.stateDir ?? this.host.machine.stateDir }
  get github(): VerifiedGithub | undefined { return this.onboardingState.status === 'ready' ? this.verifiedAccount : undefined }
  get legacyGithub(): VerifiedGithub | undefined {
    return this.onboardingState.status === 'ready' ? this.legacyAccount : undefined
  }
  transitioning(): boolean { return this.switching || this.host.signal.aborted }
  onboarding(): OnboardingView { return this.onboardingState }

  async initialize(): Promise<void> {
    const saved = this.catalog.account()
    const sourceCli = this.project ? undefined : this.legacyCli()
    const cli = saved?.cli ?? sourceCli
    if (cli) {
      try {
        const verified = await this.verify(cli)
        if (sourceCli) this.legacyAccount = sourceCli === cli ? verified : await this.verifyLegacyGithub(sourceCli, verified)
        this.host.signal.throwIfAborted()
        this.publish(verified)
      }
      catch (error) {
        if (!(error instanceof SetupError)) throw error
        this.onboardingState = { status: 'blocked', problem: error.problem }
      }
    }
    if (this.project) {
      const prior = this.project.suspension
      const recoverable = this.host.recoverable()
      this.resumed = prior ? { ...prior, recoverable } : null
      if (this.github) this.mark('interrupted')
    }
  }

  finishStartup(): void { this.started = true }

  async validateWorkspace(expected?: ProjectRef): Promise<string | undefined> {
    if (!this.project) return
    const { repository, workspace } = this.project
    const baseRef = this.host.settings().executor.baseRef
    if (!baseRef || relative(workspace, await this.workspace(workspace, repository, baseRef)) !== '') {
      throw new InstallationError(400, 'invalidProject', 'The registered checkout path or base reference changed.')
    }
    if (expected && (expected.repository.toLowerCase() !== repository.toLowerCase() || !sameDirectory(workspace, expected.workspace))) {
      throw new InstallationError(400, 'invalidProject', 'The saved handoff no longer matches the registered checkout.')
    }
    return workspace
  }

  private mark(reason: ProjectSuspension['reason']): void {
    if (this.project) this.catalog.setSuspension(this.project.id, { reason, at: timestamp(), recoverable: this.host.recoverable() })
  }

  close(): void { this.catalog.close() }

  stopped(): void {
    if (this.started && this.project) this.mark(this.catalog.selected()?.id === this.project.id ? 'hostStopped' : 'projectSwitched')
  }

  private view(project: Project): ProjectView {
    const { id, repository, workspace, stateDir } = project
    const hubSessionId = sameDirectory(stateDir, this.host.machine.stateDir) ? this.host.legacyHubId() : hubId(stateDir)
    return { id, repository, workspace, hubSessionId }
  }

  projects(): ReturnType<InstallationApi['projects']> {
    return { activeProjectId: this.project?.id ?? null, projects: this.catalog.list().map(project => this.view(project)) }
  }

  runtime(): RuntimeView {
    const mode = this.host.machine.runtimeMode ?? 'desktop'
    const projectId = this.project?.id ?? null
    const state = { mode, projectId, resumedFrom: this.resumed }
    if (!this.started) return { ...state, status: 'starting', reason: null }
    const reason = this.transitioning() ? 'switching' : !this.github ? 'githubSetupRequired' : !this.project && !this.legacyRepository() ? 'noProject'
      : this.host.recoveryPending() ? 'recoveryPending'
      : !this.host.configured() ? 'projectSetupRequired' : this.host.paused() ? 'operatorPaused' : null
    return { ...state, status: reason ? 'paused' : 'ready', reason }
  }

  assertNewWork(): void {
    if (this.host.signal.aborted || this.switching) throw new InstallationError(409, 'switching')
    this.requireGithub()
    if (!this.project && !this.legacyRepository()) throw new InstallationError(409, 'noProject')
    if (!this.host.configured()) throw new InstallationError(409, 'projectSetupRequired', 'Project setup is not ready.')
    if (this.project && this.host.paused()) throw new InstallationError(409, 'operatorPaused')
  }

  private requireGithub(): VerifiedGithub {
    const account = this.github
    if (!account) throw new InstallationError(409, 'githubSetupRequired', 'Connect and verify GitHub before starting work or creating a project.')
    return account
  }

  private legacyCli(): string | undefined {
    const cli = this.host.settings().sources.github?.config.cli
    return typeof cli === 'string' ? cli.trim() || undefined : undefined
  }

  private legacyRepository(): string | undefined {
    const repository = this.host.settings().sources.github?.config.repository
    return typeof repository === 'string' ? repository.trim() || undefined : undefined
  }

  /** Validate the Source CLI even when its repository cannot run, without changing the installation binding. */
  async verifyLegacyGithub(cli: string, expected?: VerifiedGithub): Promise<VerifiedGithub> {
    const verified = await this.verify(cli)
    if (expected && verified.id !== expected.id) throw new SetupError('agentAccountChanged')
    return verified
  }

  private async verify(cli: string): Promise<VerifiedGithub> {
    const account = await verifyGithubAccount(this.host.machine, cli, this.host.probe)
    this.host.signal.throwIfAborted()
    const prior = this.catalog.account()
    if (prior && prior.id !== account.id) {
      throw new SetupError('agentAccountChanged')
    }
    return account
  }

  private async revalidate(): Promise<VerifiedGithub> {
    const current = this.requireGithub()
    try { return await this.verify(current.cli) }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.onboardingState = { status: 'blocked', problem: error.problem }
      throw new InstallationError(409, 'githubSetupRequired')
    }
  }

  private publish(account: VerifiedGithub): OnboardingView {
    this.catalog.setAccount(account)
    this.verifiedAccount = account
    this.onboardingState = { status: 'ready', identity: { id: account.id, login: account.login, noreply: account.noreply } }
    return this.onboardingState
  }

  private async change<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.host.signal.aborted || this.changing || this.switching || !this.started) {
      throw new InstallationError(409, 'switching')
    }
    this.changing = true
    try { return await operation() }
    finally { this.changing = false }
  }

  private restart(): void {
    this.switching = true
    this.host.restart()
  }

  verifyGithub({ cli }: { cli: string }): Promise<OnboardingView> {
    return this.change(async () => {
      const previous = this.github
      try {
        const verified = await this.verify(cli)
        const sourceCli = this.project ? undefined : this.legacyCli()
        const legacy = sourceCli ? sourceCli === cli.trim() ? verified : await this.verifyLegacyGithub(sourceCli, verified) : undefined
        this.host.signal.throwIfAborted()
        const view = this.publish(verified)
        if (this.project && (!this.host.configured() || previous?.cli !== verified.cli || previous.login !== verified.login)) this.restart()
        else if (legacy && this.legacyRepository() && (!previous || this.legacyAccount?.cli !== legacy.cli || this.legacyAccount.login !== legacy.login)) this.restart()
        return view
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        const rejected: OnboardingView = { status: 'blocked', problem: error.problem }
        if (!previous) this.onboardingState = rejected
        return rejected
      }
    })
  }

  createProject(input: Parameters<InstallationApi['createProject']>[0]): Promise<Awaited<ReturnType<InstallationApi['createProject']>>> {
    return this.change(async () => {
      const account = await this.revalidate()
      const repository = await verifyGithubRepository(account, input.repository, this.host.probe)
      const baseRef = ExecutorConfigSchema.parse({ baseRef: input.baseRef }).baseRef
      if (!baseRef) throw new InstallationError(400, 'invalidProject', 'An explicit Git base reference is required.')
      const workspace = await this.workspace(input.workspace, repository, baseRef)
      this.host.signal.throwIfAborted()
      const policy = PolicyConfigSchema.parse(input.policy ?? {})
      const records = this.catalog.list()
      const existing = records.find(project => project.repository.toLowerCase() === repository.toLowerCase() && sameDirectory(project.workspace, workspace))
      const settings = this.host.settings()
      const legacyRepo = this.legacyRepository()
      const legacyWorkspace = settings.executor.repository
      const legacyStorage = records.length === 0 && legacyRepo?.toLowerCase() === repository.toLowerCase()
        && !!legacyWorkspace && sameDirectory(legacyWorkspace, workspace)
      if (!records.length && legacyRepo && !legacyStorage) {
        throw new InstallationError(409, 'legacyProjectRequired', 'Register the existing installation repository and workspace before adding another project.')
      }
      if (legacyStorage && (!this.host.legacyHandoffsMatch({ repository, workspace }) || input.policy !== undefined || baseRef !== settings.executor.baseRef)) {
        throw new InstallationError(409, 'legacyProjectMismatch', 'Existing handoffs, authorization or base reference do not match the legacy project binding.')
      }
      if (legacyStorage) {
        try { await this.verifyLegacyGithub(this.legacyCli() ?? '', account) }
        catch (error) {
          if (!(error instanceof SetupError)) throw error
          this.host.signal.throwIfAborted()
          this.onboardingState = { status: 'blocked', problem: error.problem }
          throw new InstallationError(409, 'legacyProjectMismatch', 'Cannot verify that the legacy GitHub CLI uses the installation account.')
        }
        this.host.signal.throwIfAborted()
      }
      let project: Project
      try {
        project = existing?.initial === undefined && existing ? existing : this.catalog.register({ repository, workspace,
          ...(legacyStorage ? { legacyStorage } : { initial: { baseRef, policy } }) })
      } catch (error) {
        if (error instanceof ProjectConflict) throw new InstallationError(409, 'projectConflict')
        throw error
      }
      const restarting = this.catalog.selected()?.id === project.id && this.project?.id !== project.id
      if (restarting) this.restart()
      return { project: this.view(project), reused: !!existing, restarting }
    })
  }

  selectProject(id: string): Promise<Awaited<ReturnType<InstallationApi['selectProject']>>> {
    return this.change(async () => {
      await this.revalidate()
      const project = this.catalog.get(id)
      if (!project) throw new InstallationError(404, 'projectNotFound')
      const restarting = this.project?.id !== id
      if (restarting) { this.catalog.select(id); this.restart() }
      return { project: this.view(project), restarting }
    })
  }

  private async workspace(path: string, repository: string, baseRef: string): Promise<string> {
    if (!isAbsoluteWorkspace(path)) throw new InstallationError(400, 'invalidProject', 'Use an absolute local Git checkout path.')
    const env = { ...process.env }
    for (const [name, value] of Object.entries(agentVariables(this.host.machine.stateDir))) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    const git = async (argv: string[], cwd: string) => (await execute('git', argv, { cwd, env, encoding: 'utf8', windowsHide: true,
      signal: AbortSignal.any([this.host.signal, AbortSignal.timeout(15_000)]) })).stdout
    try {
      const root = await realpath(path)
      const top = (await git(['rev-parse', '--show-toplevel'], root)).trim()
      const common = await realpath((await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim())
      const stateDir = await realpath(this.host.machine.stateDir)
      if (!sameDirectory(root, top) || !sameDirectory(dirname(common), root) || containsWorkspace(root, stateDir) || containsWorkspace(stateDir, root)) {
        throw new Error('Workspaces must be independent primary checkouts outside the installation state directory.')
      }
      await validateRepositoryIdentity({ git }, root, repository)
      await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], root)
      return root
    } catch {
      throw new InstallationError(400, 'invalidProject', 'Workspace must be an independent primary Git checkout with the matching GitHub origin and a resolvable base reference.')
    }
  }
}

export const projectHubId = hubId
export const projectDatabase = (installation: Installation): string => join(installation.stateDir, 'orchestrator.sqlite')
