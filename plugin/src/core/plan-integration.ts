import type { ReleaseTarget } from './handoff.ts'
export type { ReleaseTarget }

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

export interface PlanArtifactReference { id: number; name: string; url: string }
/** Downloadable file metadata; the service retains and checks the bytes before reporting delivery. */
export interface PlanArtifact extends PlanArtifactReference { fileName: string; contentType: string; size: number; sha256: string }

/** An operator-managed adapter, separate from the repository's CI and Worker credentials. */
export interface PlanReleaseConfig extends ReleaseTarget {
  projectId: string
  executable: string
  args: string[]
  credentialId: string
  credentialProviderUrl: string
}

export interface PlanReleaseRequest {
  id: string
  planId: string
  projectId: string
  target: ReleaseTarget
  version: PlanIntegrationVersion
  run: Pick<PlanVerificationRun, 'id' | 'attempt'>
  artifact: Pick<PlanArtifact, 'id' | 'name' | 'fileName' | 'size' | 'sha256' | 'contentType'>
}

export interface PlanDeployment {
  id: string
  sha: string
  sha256: string
  at: string
}

export type PlanEnvironmentVerification = { status: 'pending' } | { status: 'failed'; at: string }
  | { status: 'passed'; at: string; deploymentId: string; sha: string; sha256: string }

export type PlanReleaseObservation = { requestId: string; target: ReleaseTarget } & (
  | { status: 'missing' | 'publishing' | 'not-published' }
  | { status: 'published'; deployment: PlanDeployment; verification: PlanEnvironmentVerification }
)

export interface PlanReleaseIntent { request: PlanReleaseRequest; adapter: string }

export type PlanActionsFailure = 'regression_failed' | 'full_regression_missing' | 'artifact_unavailable'
export type PlanActionsObservation =
  | { status: 'missing' }
  | { status: 'pending'; run: PlanVerificationRun }
  | { status: 'failed'; reason: PlanActionsFailure; run: PlanVerificationRun }
  | { status: 'passed'; run: PlanVerificationRun; artifact: PlanArtifactReference }
export interface PlanIntegrationVersion extends PlanIntegrationIdentity {
  workflowId: string
  configuration: string
  environment: string
}
type PlanIntegrationBlock = PlanActionsFailure | 'verification_unconfigured' | 'integration_unavailable' | 'integration_not_on_target'
  | 'target_changed' | 'actions_unavailable' | 'dispatch_unconfirmed'

export interface PlanIntegratedArtifact {
  version: PlanIntegrationVersion
  run: PlanVerificationRun
  artifact: PlanArtifact
  verifiedAt: string
}
type PlanReleaseProgress =
  | { status: 'release-blocked'; reason: 'release_unconfigured' | 'authorization_missing' | 'target_scope_mismatch' | 'release_unavailable' | 'release_busy'; release?: ReleaseTarget }
  | { status: 'awaiting-release-credentials'; release: ReleaseTarget; credential: { id: string; providerUrl: string } }
  | { status: 'releasing'; release: ReleaseTarget; releaseId: string; reason?: 'dispatch_unconfirmed' | 'release_unavailable' | 'release_configuration_changed' }
  | { status: 'release-failed'; release: ReleaseTarget; releaseId: string }
  | { status: 'released-unverified'; release: ReleaseTarget; releaseId: string; deployment: PlanDeployment;
      verification: PlanEnvironmentVerification; reason?: 'release_evidence_mismatch' | 'release_unavailable' | 'release_configuration_changed' }
  | { status: 'released'; release: ReleaseTarget; releaseId: string; deployment: PlanDeployment;
      verification: Extract<PlanEnvironmentVerification, { status: 'passed' }> }

/** Plan-level delivery, distinct from the status of an individual Ticket or the registered graph. */
export type PlanIntegrationView = { planId: string } & (
  | { status: 'awaiting-tickets'; waitingFor: string[] }
  | { status: 'blocked'; reason: PlanIntegrationBlock; version?: PlanIntegrationVersion; run?: PlanVerificationRun }
  | { status: 'verifying'; version: PlanIntegrationVersion; run?: PlanVerificationRun }
  | (PlanIntegratedArtifact & { status: 'delivered' })
  | (PlanIntegratedArtifact & { status: 'awaiting-release-verification'; release?: ReleaseTarget })
  | (PlanIntegratedArtifact & PlanReleaseProgress & { artifactAvailable?: false })
)
