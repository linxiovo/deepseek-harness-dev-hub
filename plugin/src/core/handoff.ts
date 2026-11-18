import type { PLAN_FEATURE_KINDS } from './plan.ts'

export interface ProjectRef { id: string; repository: string; workspace: string }
export interface HandoffInput {
  project: { repository: string; workspace: string }
  goal: string
  constraints: string[]
  acceptanceScope: string[]
  authorization: { scope: string; release: 'authorized' | 'not-authorized' }
  confirmedBy: { sessionId: string; messageId: string; text: string }
}
export interface HandoffQuestion {
  id: string
  text: string
  why: string
  affectedAcceptance: string[]
  status: 'awaiting' | 'answered'
  answer?: string
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
export interface Handoff {
  id: string
  project: ProjectRef
  goal: string
  constraints: string[]
  acceptanceScope: string[]
  authorization: HandoffInput['authorization']
  confirmedBy: HandoffInput['confirmedBy']
  status: 'confirmed' | 'planning' | 'awaiting' | 'specified'
  question?: HandoffQuestion
  spec?: Spec
}
