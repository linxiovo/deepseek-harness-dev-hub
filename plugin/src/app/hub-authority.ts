/** Durable Hub identity and physical-session authority across safe Session rotations. */
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

const GenerationSchema = z.strictObject({ sessionId: z.string().min(1), epoch: z.number().int().nonnegative(), status: z.enum(['active', 'retired']) })
const RotationSchema = z.strictObject({ fromSessionId: z.string().min(1), fromEpoch: z.number().int().nonnegative(), targetSessionId: z.string().min(1), targetEpoch: z.number().int().positive(), startedAt: z.string().min(1) })
const AuthoritySchema = z.strictObject({
  hubId: z.string().min(1), sessionId: z.string().min(1), epoch: z.number().int().nonnegative(), phase: z.enum(['active', 'rotating']),
  generations: z.array(GenerationSchema).min(1), rotation: RotationSchema.optional(), resume: z.strictObject({ epoch: z.number().int().positive(), requestId: z.string().min(1) }).optional(),
})

export type HubGeneration = z.infer<typeof GenerationSchema>
export type HubRotation = z.infer<typeof RotationSchema>
export type HubAuthorityState = z.infer<typeof AuthoritySchema>

/**
 * Keeps the stable project Hub identity separate from the physical DSH Session that currently owns Hub tools.
 * `beginRotation` is the durable quiescence fence; callers must provision its deterministic target and call `activate` only
 * after that Session is verified. A process crash between either step is recovered by replaying the same target ID.
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
  currentSessionId(): string | undefined { return this.stateValue.phase === 'active' ? this.stateValue.sessionId : undefined }
  targetSessionId(): string | undefined { return this.stateValue.rotation?.targetSessionId }
  visibleSessionId(): string { return this.currentSessionId() ?? this.targetSessionId() ?? this.stateValue.sessionId }
  isCurrent(sessionId: string): boolean { return this.stateValue.phase === 'active' && this.stateValue.sessionId === sessionId }
  isGeneration(sessionId: string): boolean {
    return this.stateValue.sessionId === sessionId || this.stateValue.rotation?.fromSessionId === sessionId
      || this.stateValue.rotation?.targetSessionId === sessionId || this.stateValue.generations.some(generation => generation.sessionId === sessionId)
  }
  generations(): string[] {
    return [...new Set([this.stateValue.sessionId, ...this.stateValue.generations.map(generation => generation.sessionId),
      ...(this.stateValue.rotation ? [this.stateValue.rotation.targetSessionId, this.stateValue.rotation.fromSessionId] : [])])]
  }
  pendingResume(): { epoch: number; requestId: string } | undefined { return this.stateValue.resume }

  /** Persist the fence before any physical Session creation; repeated calls return the same target. */
  beginRotation(now = new Date().toISOString()): HubRotation {
    return this.store.atomic(() => {
      this.reload()
      const existing = this.stateValue.rotation
      if (this.stateValue.phase === 'rotating' && existing) return existing
      if (this.stateValue.phase !== 'active') throw new Error('Hub authority is already rotating without a valid target')
      const targetEpoch = this.stateValue.epoch + 1
      const rotation: HubRotation = { fromSessionId: this.stateValue.sessionId, fromEpoch: this.stateValue.epoch,
        targetSessionId: `orchestrator-${key('hub-rotation', this.stateValue.hubId, String(targetEpoch))}`, targetEpoch, startedAt: now }
      this.stateValue = { ...this.stateValue, phase: 'rotating', rotation }
      this.save()
      return rotation
    })
  }

  /** Atomically grants the new physical Session the current Hub role and records a resume delivery still to be made. */
  activate(sessionId: string): HubAuthorityState {
    return this.store.atomic(() => {
      this.reload()
      const rotation = this.stateValue.rotation
      if (!rotation || rotation.targetSessionId !== sessionId) throw new Error('The Hub rotation target does not match the persisted intent')
      const generations = this.stateValue.generations.map(generation => generation.sessionId === rotation.fromSessionId
        ? { ...generation, status: 'retired' as const } : generation)
      if (!generations.some(generation => generation.sessionId === rotation.fromSessionId)) {
        generations.push({ sessionId: rotation.fromSessionId, epoch: rotation.fromEpoch, status: 'retired' })
      }
      const requestId = `hub-resume:${rotation.targetEpoch}`
      this.stateValue = { hubId: this.stateValue.hubId, sessionId, epoch: rotation.targetEpoch, phase: 'active', generations,
        resume: { epoch: rotation.targetEpoch, requestId } }
      this.save()
      return this.state()
    })
  }

  /** Clear the durable resume marker only after the target Session has flushed the factual continuation. */
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
