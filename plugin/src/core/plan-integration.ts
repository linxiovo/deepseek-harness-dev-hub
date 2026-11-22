/** Machine-owned contract of one trusted full regression workflow for a registered project. */
export interface PlanVerificationConfig {
  projectId: string
  workflowId: string
  identityJob: string
  jobs: readonly string[]
  artifactName: string
  configuration: string
  environment: string
}

export interface PlanIntegrationIdentity {
  repository: string
  ref: string
  sha: string
  context: string
}

export interface PlanVerificationRequest extends PlanIntegrationIdentity {
  verification: PlanVerificationConfig
}

export interface PlanVerificationRun {
  id: number
  attempt: number
  url: string
  checks: { name: string; status: string; conclusion: string | null; url?: string }[]
}

/** Browser-download reference; GitHub still checks repo access when it is opened. */
export interface PlanArtifact { id: number; name: string; url: string }

export type PlanActionsFailure = 'regression_failed' | 'full_regression_missing' | 'artifact_unavailable'
export type PlanActionsObservation =
  | { status: 'missing' }
  | { status: 'pending'; run: PlanVerificationRun }
  | { status: 'failed'; reason: PlanActionsFailure; run: PlanVerificationRun }
  | { status: 'passed'; run: PlanVerificationRun; artifact: PlanArtifact }

export interface PlanIntegrationVersion extends PlanIntegrationIdentity {
  workflowId: string
  configuration: string
  environment: string
}
type PlanIntegrationBlock = PlanActionsFailure | 'verification_unconfigured' | 'integration_unavailable' | 'integration_not_on_target'
  | 'target_changed' | 'actions_unavailable' | 'dispatch_unconfirmed'

/** Plan-level delivery, distinct from the status of an individual Ticket or the registered graph. */
export type PlanIntegrationView = { planId: string } & (
  | { status: 'awaiting-tickets'; waitingFor: string[] }
  | { status: 'blocked'; reason: PlanIntegrationBlock; version?: PlanIntegrationVersion; run?: PlanVerificationRun }
  | { status: 'verifying'; version: PlanIntegrationVersion; run?: PlanVerificationRun }
  | { status: 'delivered' | 'awaiting-release-verification'; version: PlanIntegrationVersion;
      run: PlanVerificationRun; artifact: PlanArtifact; verifiedAt: string }
)
