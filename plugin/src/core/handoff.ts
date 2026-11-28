import type { PLAN_FEATURE_KINDS } from './plan.ts'
import type { ActorRef } from './model.ts'

export interface ProjectRef { id: string; repository: string; workspace: string }
export interface ReleaseTarget { environment: string; target: string; scope: string }
export const sameReleaseTarget = (a: ReleaseTarget, b: ReleaseTarget): boolean =>
  a.environment === b.environment && a.target === b.target && a.scope === b.scope
export const releaseNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/
export const releaseScopePattern = /^[^\s\p{Cc}\p{Cf}](?:[^\p{Cc}\p{Cf}]{0,254}[^\s\p{Cc}\p{Cf}])?$/u
export interface HandoffInput {
  project: { repository: string; workspace: string }
  goal: string
  constraints: string[]
  acceptanceScope: string[]
  authorization: { scope: string; release: 'not-authorized' } | { scope: string; release: 'authorized'; releaseTarget?: ReleaseTarget }
  confirmedBy: { sessionId: string; messageId: string; text: string }
}
export interface HandoffQuestion {
  id: string
  text: string
  why: string
  affectedAcceptance: string[]
  status: 'awaiting' | 'answered'
  answer?: string
  /** Present for answers received from the bound Feishu topic; identity comes from the observed human event. */
  answeredBy?: { source: 'feishu'; actorId: string; triggerId: string }
}
export interface SpecAcceptance { statement: string; observable: string; delivery: typeof PLAN_FEATURE_KINDS[number] }
export interface SpecInput {
  body: string
  acceptance: SpecAcceptance[]
  testInterfaces: { seam: string; kind: 'existing' | 'proposed'; note: string }[]
  outOfScope: string[]
}
/** Pre-classification specifications remain readable but cannot authorize Plan registration. */
export interface Spec extends Omit<SpecInput, 'acceptance'> {
  id: string
  handoffId: string
  revision: 1
  acceptance: (Omit<SpecAcceptance, 'delivery'> & Partial<Pick<SpecAcceptance, 'delivery'>>)[]
}
export interface MaintenanceOrigin {
  eventId: string
  actor: ActorRef
  hubSessionId: string
  policyVersion: string
  rules: string[]
  intentEvidence: string
}

export interface InspectionObservation { sessionId: string; scope: string; commit: string; at: string }
export interface InspectionRepairOrigin {
  todoId: string
  observation: InspectionObservation
  baseRef: string
  supportingPaths: string[]
  hubSessionId: string
  approvedAt: string
}

export type StageTwoOrigin = { maintenance: MaintenanceOrigin; inspectionRepair?: never } |
  { inspectionRepair: InspectionRepairOrigin; maintenance?: never }

export type Handoff = {
  id: string
  project: ProjectRef
  goal: string
  constraints: string[]
  acceptanceScope: string[]
  authorization: { scope: string; release: 'not-authorized' } | { scope: string; release: 'authorized'; releaseTarget?: ReleaseTarget }
  status: 'confirmed' | 'planning' | 'awaiting' | 'specified'
  question?: HandoffQuestion
  spec?: Spec
} & ({ confirmedBy: HandoffInput['confirmedBy']; maintenance?: never; inspectionRepair?: never } | (StageTwoOrigin & {
  confirmedBy?: never
  authorization: { scope: string; release: 'not-authorized' }
}))

export const handoffHubSession = (handoff: Handoff): string =>
  handoff.confirmedBy ? handoff.confirmedBy.sessionId : (handoff.maintenance ?? handoff.inspectionRepair).hubSessionId
