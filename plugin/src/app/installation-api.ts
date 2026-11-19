import type { Settings } from '../policy.ts'
import type { SetupProblem } from '../setup.ts'

export interface GithubIdentity { id: number; login: string; noreply: string }
export type OnboardingView =
  | { status: 'unconfigured' }
  | { status: 'ready'; identity: GithubIdentity }
  | { status: 'blocked'; identity?: GithubIdentity; problem?: SetupProblem }

export interface VerifyGithubInput { cli: string }
export interface ProjectView { id: string; repository: string; workspace: string; hubSessionId: string }
export interface ProjectsView { activeProjectId: string | null; projects: ProjectView[] }
export interface CreateProjectInput { repository: string; workspace: string; baseRef: string; policy?: Settings['policy'] }
export interface SelectProjectResult { project: ProjectView; restarting: boolean }
export interface CreateProjectResult extends SelectProjectResult { reused: boolean }

export interface RuntimeView {
  mode: 'desktop' | 'headless'
  status: 'starting' | 'ready' | 'paused'
  reason: 'githubSetupRequired' | 'noProject' | 'operatorPaused' | 'projectSetupRequired' | 'switching' | 'recoveryPending' | null
  projectId: string | null
  resumedFrom: null | {
    reason: 'hostStopped' | 'projectSwitched' | 'interrupted'
    at: string
    recoverable: { assignments: number; handoffs: number; effects: number }
  }
}

export interface InstallationApi {
  onboarding(): OnboardingView
  verifyGithub(input: VerifyGithubInput): OnboardingView | Promise<OnboardingView>
  projects(): ProjectsView
  createProject(input: CreateProjectInput): CreateProjectResult | Promise<CreateProjectResult>
  selectProject(projectId: string): SelectProjectResult | Promise<SelectProjectResult>
  runtime(): RuntimeView
}

const ERROR_MESSAGES = {
  githubSetupRequired: 'Set up GitHub before starting work.',
  noProject: 'Select a project before starting work.',
  projectSetupRequired: 'Finish project setup before starting work.',
  operatorPaused: 'Resume processing before starting work.',
  switching: 'Wait for the project transition to finish.',
  projectScopeRequired: 'A project scope is required for this request.',
  staleProject: 'The request does not target the mounted project.',
  projectNotFound: 'Project not found.',
  invalidProject: 'Invalid project configuration.',
  invalidRequest: 'Invalid installation request.',
  installationUnavailable: 'Installation management is not available.',
  legacyProjectRequired: 'Migrate the legacy project before selecting another project.',
  legacyProjectMismatch: 'The project does not match the legacy project configuration.',
  projectConflict: 'The project conflicts with an existing project or operation.',
  projectBindingImmutable: 'The mounted project binding cannot be changed.',
} as const
export type InstallationErrorCode = keyof typeof ERROR_MESSAGES

/** A client-facing refusal with an HTTP status and a stable installation or project error code. */
export class InstallationError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: InstallationErrorCode, message: string = ERROR_MESSAGES[code]) {
    super(message)
  }
}
