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
export interface SpecInput {
  body: string
  acceptance: { statement: string; observable: string }[]
  testInterfaces: { seam: string; kind: 'existing' | 'proposed'; note: string }[]
  outOfScope: string[]
}
export interface Spec extends SpecInput { id: string; handoffId: string; revision: 1 }
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
