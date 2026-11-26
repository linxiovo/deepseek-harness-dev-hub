import { z } from 'zod'
import { LIMITS } from './limits.ts'

const revision = z.number().int().nonnegative()
const change = z.discriminatedUnion('object', [
  z.strictObject({ object: z.enum(['projectTokens', 'ticketTokens']), value: z.number().int().nonnegative().nullable() }),
  z.strictObject({ object: z.literal('maxWorkers'), value: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max) }),
  z.strictObject({ object: z.literal('feishuChat'), chatId: z.string().max(128).regex(/^oc_[A-Za-z0-9]+$/), value: z.enum(['mentions', 'all']) }),
])
export const SettingsApprovalSchema = z.strictObject({ revision })
export const SettingsProposalSchema = SettingsApprovalSchema.extend({ change,
  approvers: z.array(z.string().max(128).regex(/^ou_[A-Za-z0-9]+$/)).max(100).optional() })
export type SettingsProposal = z.input<typeof SettingsProposalSchema>
export type ConfirmableChange = SettingsProposal['change']
export interface SettingsConfirmationView {
  id: string
  projectId: string
  repository: string
  object: ConfirmableChange['object']
  chatId?: string
  revision: number
  currentValue: number | string | null
  proposedValue: ConfirmableChange['value']
  effectiveValue: number | string | null
  effectiveRevision: number
  impact: string
  status: 'pending' | 'approved' | 'superseded' | 'expired'
  expiresAt: string
}
/** Only the dedicated bot callback stream supplies the operator, original message and event identity. */
export interface SettingsCardAction {
  action: 'approve' | 'status'
  projectId: string
  requestId: string
  revision: number
  chatId: string
  messageId: string
  actorId: string
  at: number
  botIdentity: string
  eventId: string
}
