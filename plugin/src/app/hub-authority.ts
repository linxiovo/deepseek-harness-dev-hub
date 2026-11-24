/** Durable Hub identity and physical-session authority across safe Session rotations. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

const CreationSchema = z.strictObject({ token: z.string().min(1), cwd: z.string().min(1) })
const GenerationSchema = z.strictObject({ sessionId: z.string().min(1), epoch: z.number().int().nonnegative(),
  status: z.enum(['active', 'retired']), creation: CreationSchema.optional() })
const RotationSchema = z.strictObject({ fromSessionId: z.string().min(1), fromEpoch: z.number().int().nonnegative(),
  targetSessionId: z.string().min(1), targetEpoch: z.number().int().positive(), startedAt: z.string().min(1),
  creation: CreationSchema.optional(), drainingTurn: z.number().int().nonnegative().optional(), inboxOffset: z.number().int().nonnegative().optional() })
const AuthoritySchema = z.strictObject({
  hubId: z.string().min(1), sessionId: z.string().min(1), epoch: z.number().int().nonnegative(), phase: z.enum(['active', 'draining', 'rotating']),
  generations: z.array(GenerationSchema).min(1), rotation: RotationSchema.optional(),
  resume: z.strictObject({ epoch: z.number().int().positive(), requestId: z.string().min(1), text: z.string().optional() }).optional(),
})

export type HubCreation = z.infer<typeof CreationSchema>
export type HubGeneration = z.infer<typeof GenerationSchema>
export type HubRotation = z.infer<typeof RotationSchema>
export type HubAuthorityState = z.infer<typeof AuthoritySchema>

/**
 * Keeps the stable project Hub identity separate from the physical DSH Session that currently owns Hub tools.
 * Persists the intake fence before draining the admitted turn, then revokes the old generation before provisioning.
 * The target and its creation proof stay fixed across restart; activation is not publication until the resume is durable.
 */
export class HubAuthority {
  private stateValue: HubAuthorityState

  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic'>, legacySessionId: string, stableHubId: string) {
    const saved = store.get(KV.runtime.authority)
    if (saved !== undefined) {
      const parsed = AuthoritySchema.safeParse(saved)
      if (!parsed.success) throw new Error('The persisted Hub authority is invalid; refusing to start')
      this.stateValue = parsed.data
      if (store.get(KV.runtime.masterId) !== parsed.data.sessionId) {
        store.atomic(() => store.set(KV.runtime.masterId, parsed.data.sessionId))
      }
      return
    }
    const sessionId = legacySessionId.trim() || stableHubId
    this.stateValue = { hubId: stableHubId, sessionId, epoch: 0, phase: 'active', generations: [{ sessionId, epoch: 0, status: 'active' }] }
    store.atomic(() => {
      if (store.get(KV.runtime.authority) === undefined) store.set(KV.runtime.authority, this.stateValue)
      if (store.get(KV.runtime.masterId) === undefined) store.set(KV.runtime.masterId, sessionId)
    })
  }

  state(): HubAuthorityState { return structuredClone(this.stateValue) }
  hubId(): string { return this.stateValue.hubId }
  currentSessionId(): string | undefined { return this.stateValue.phase !== 'rotating' ? this.stateValue.sessionId : undefined }
  targetSessionId(): string | undefined { return this.stateValue.rotation?.targetSessionId }
  visibleSessionId(): string {
    const { resume, generations, sessionId } = this.stateValue
    return resume ? generations.find(generation => generation.epoch === resume.epoch - 1)?.sessionId ?? sessionId : sessionId
  }
  readySessionId(): string | undefined {
    return this.stateValue.phase === 'active' && !this.stateValue.resume ? this.stateValue.sessionId : undefined
  }
  isCurrent(sessionId: string): boolean { return !this.stateValue.resume && this.currentSessionId() === sessionId }
  isGeneration(sessionId: string): boolean {
    return this.stateValue.sessionId === sessionId || this.stateValue.rotation?.fromSessionId === sessionId
      || this.stateValue.rotation?.targetSessionId === sessionId || this.stateValue.generations.some(generation => generation.sessionId === sessionId)
  }
  generations(): string[] {
    return [...new Set([this.stateValue.sessionId, ...this.stateValue.generations.map(generation => generation.sessionId),
      ...(this.stateValue.rotation ? [this.stateValue.rotation.targetSessionId, this.stateValue.rotation.fromSessionId] : [])])]
  }
  generationEpoch(sessionId: string): number | undefined {
    if (this.stateValue.sessionId === sessionId) return this.stateValue.epoch
    return this.stateValue.generations.find(generation => generation.sessionId === sessionId)?.epoch
  }
  creation(sessionId: string): HubCreation | undefined {
    const pending = this.stateValue.rotation
    if (pending?.targetSessionId === sessionId) return pending.creation
    return this.stateValue.generations.find(generation => generation.sessionId === sessionId)?.creation
  }
  rotation(): HubRotation | undefined { return this.stateValue.rotation }
  continuation(sessionId: string): string | undefined {
    if (!this.stateValue.generations.some(generation => generation.sessionId === sessionId && generation.status === 'retired')) return
    return this.readySessionId()
  }
  pendingResume(): HubAuthorityState['resume'] { return this.stateValue.resume }

  /** Fence inbound work while keeping the already admitted turn authorized. */
  beginRotation(cwd: string, inboxOffset: number, drainingTurn?: number): HubRotation {
    return this.store.atomic(() => {
      this.reload()
      if (this.stateValue.rotation) return this.stateValue.rotation
      if (this.stateValue.phase !== 'active' || this.stateValue.resume) throw new Error('The previous Hub rotation has not finished')
      const targetEpoch = this.stateValue.epoch + 1
      const creation = { token: randomUUID(), cwd }
      const rotation: HubRotation = { fromSessionId: this.stateValue.sessionId, fromEpoch: this.stateValue.epoch,
        targetSessionId: `orchestrator-${key('hub-rotation', this.stateValue.hubId, String(targetEpoch), creation.token)}`,
        targetEpoch, startedAt: new Date().toISOString(), creation, drainingTurn, inboxOffset }
      this.stateValue = { ...this.stateValue, phase: 'draining', rotation }
      this.save()
      return rotation
    })
  }

  /** Revoke the old turn before any attempt to provision its successor. */
  sealRotation(cwd: string): HubRotation {
    return this.store.atomic(() => {
      this.reload()
      const pending = this.stateValue.rotation
      if (!pending) throw new Error('No Hub rotation is pending')
      const rotation = pending.creation ? pending : { ...pending, creation: { token: randomUUID(), cwd } }
      this.stateValue = { ...this.stateValue, phase: 'rotating', rotation }
      this.save()
      return rotation
    })
  }

  /** Atomically grants the new physical Session the current Hub role and records a resume delivery still to be made. */
  activate(sessionId: string, resumeText: (epoch: number) => string): HubAuthorityState {
    return this.store.atomic(() => {
      this.reload()
      const rotation = this.stateValue.rotation
      if (this.stateValue.phase !== 'rotating' || !rotation?.creation || rotation.targetSessionId !== sessionId) {
        throw new Error('The Hub rotation target does not match the fenced intent')
      }
      const generations = this.stateValue.generations.map(generation => generation.sessionId === rotation.fromSessionId
        ? { ...generation, status: 'retired' as const } : generation)
      if (!generations.some(generation => generation.sessionId === rotation.fromSessionId)) {
        generations.push({ sessionId: rotation.fromSessionId, epoch: rotation.fromEpoch, status: 'retired' })
      }
      generations.push({ sessionId, epoch: rotation.targetEpoch, status: 'active', creation: rotation.creation })
      const requestId = `hub-resume:${rotation.targetEpoch}`
      this.stateValue = { hubId: this.stateValue.hubId, sessionId, epoch: rotation.targetEpoch, phase: 'active', generations,
        resume: { epoch: rotation.targetEpoch, requestId, text: resumeText(rotation.targetEpoch) } }
      this.save()
      return this.state()
    })
  }

  /** Publish the successor only after the target Session has durably recorded its factual continuation. */
  resumeDelivered(requestId: string): void {
    this.store.atomic(() => {
      this.reload()
      if (this.stateValue.resume?.requestId !== requestId) return
      const { resume: _resume, ...active } = this.stateValue
      this.stateValue = active
      this.save()
    })
  }

  private reload(): void {
    const saved = this.store.get(KV.runtime.authority)
    const parsed = AuthoritySchema.safeParse(saved)
    if (!parsed.success) throw new Error('The persisted Hub authority is invalid; refusing to change it')
    this.stateValue = parsed.data
  }
  private save(): void {
    this.store.set(KV.runtime.authority, this.stateValue)
    this.store.set(KV.runtime.masterId, this.stateValue.sessionId)
  }
}
