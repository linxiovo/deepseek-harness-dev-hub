import { randomUUID } from 'node:crypto'
import { SettingsProposalSchema, type ConfirmableChange, type SettingsCardAction, type SettingsConfirmationView,
  type SettingsProposal } from '../confirmed-settings.ts'
import { key, type OutboundMessage } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { effectiveRunLimits } from '../policy.ts'
import { sendSettingsCard } from '../sources/feishu-card.ts'
import type { FeishuConfig } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Settings } from './settings.ts'
import type { Store } from './store.ts'
import type { TopicBinding } from './topic-binding.ts'

const LIFETIME_MS = 15 * 60_000
const { latest, request } = KV.settingsConfirmations
const objectKey = (change: ConfirmableChange) => change.object === 'feishuChat' ? `feishuChat:${change.chatId}` : change.object
const impacts = {
  projectTokens: 'Changes the project-wide ceiling for managed model calls, not release authorization.',
  ticketTokens: 'Changes the default ceiling for each Ticket without an override; the project ceiling still applies.',
  maxWorkers: 'Changes how many Workers can run concurrently; it grants no new work or release permissions.',
  feishuChat: 'Changes which group messages the Source receives. Actor, bound topic and work admission rules still apply.',
} as const
type Decision = { via: 'panel' } | { via: 'feishu'; actorId: string; eventId: string }
export interface SettingsConfirmationRecord {
  projectId: string
  change: ConfirmableChange
  revision: number
  currentValue: SettingsConfirmationView['currentValue']
  createdAt: number
  expiresAt: number
  grant?: { epoch: string; actors: string[] }
  delivery?: { kind: 'text' } | { kind: 'card'; botIdentity: string; messageId?: string }
  decision?: Decision
}

/** Public refusals contain no operator-supplied text or deployment credentials. */
export class SettingsConfirmationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}

interface Host {
  store: Pick<Store, 'atomic' | 'get' | 'set' | 'settings' | 'blockRevision'>
  settings: Pick<Settings, 'applyConfirmed'>
  sources: Pick<SourceRegistry, 'instance' | 'send'>
  topic: Pick<TopicBinding, 'view' | 'pollTarget' | 'settingsNotice'>
  projectId: string
  repository: string
  cardIdentity(): string | undefined
}

/** Owns one mounted project's proposals, original-card receipts and the atomic human decision shared by both entrances. */
export class SettingsConfirmations {
  constructor(private readonly host: Host) {}

  propose(input: SettingsProposal): SettingsConfirmationView {
    const { revision, change, approvers } = SettingsProposalSchema.parse(input)
    const { store, projectId, topic } = this.host
    return store.atomic(() => {
      const { effectiveValue, effectiveRevision, available } = this.snapshot(change)
      if (effectiveRevision !== revision || !available) throw new SettingsConfirmationError(409, 'The settings block changed or is unavailable.')
      const higher = typeof effectiveValue === 'number' ? change.value === null || (typeof change.value === 'number' && change.value > effectiveValue)
        : effectiveValue === 'none' || (effectiveValue === 'mentions' && change.value === 'all')
      if (!higher) throw new SettingsConfirmationError(400, 'The proposal must increase the effective quota or expand the listening scope.')
      let grant: SettingsConfirmationRecord['grant']
      if (approvers?.length) {
        const binding = topic.pollTarget()
        if (!binding || binding.projectId !== projectId || approvers.some(actor => !binding.allowedActors.includes(actor))) {
          throw new SettingsConfirmationError(403, 'Choose explicitly authorized participants in the active project binding.')
        }
        grant = { epoch: binding.epoch, actors: [...new Set(approvers)] }
      }
      const id = randomUUID(), createdAt = Date.now()
      const record: SettingsConfirmationRecord = { projectId, revision, change, currentValue: effectiveValue, createdAt,
        expiresAt: createdAt + LIFETIME_MS, ...(grant && { grant }) }
      store.set(request(id), record)
      store.set(latest(objectKey(change)), id)
      const view = this.view(id, record)
      if (grant) topic.settingsNotice(grant.epoch, `settings-request:${id}`,
        `Project ${view.repository} (${projectId}) · ${objectKey(change)}: ${effectiveValue} → ${change.value}. ${view.impact} Request ${id}, expires ${view.expiresAt}.`, id)
      return view
    })
  }

  read(id: string): SettingsConfirmationView {
    return this.view(id, this.record(id))
  }

  approve(id: string, revision: number): SettingsConfirmationView {
    return this.host.store.atomic(() => {
      const record = this.record(id), view = this.view(id, record)
      if (view.status !== 'pending' || revision !== view.revision) throw new SettingsConfirmationError(409, 'The proposal is no longer pending at this revision.')
      return this.apply(id, record, { via: 'panel' })
    })
  }

  /** The Outbox retries the same remote UUID, never a new card or a different delivery mode after an uncertain send. */
  async deliver(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const id = message.channel.address.settingsRequest!, record = this.record(id)
    const { topic, store } = this.host, target = topic.pollTarget()
    if (!target || target.epoch !== record.grant?.epoch || message.id !== key('topic-binding', target.epoch, `settings-request:${id}`)) return 'gone'
    if (record.delivery?.kind === 'card' && record.delivery.messageId) return 'sent'
    const view = this.view(id, record)
    if (view.status !== 'pending') return 'gone'
    const identity = this.host.cardIdentity()
    const delivery = record.delivery ?? (identity ? { kind: 'card' as const, botIdentity: identity } : { kind: 'text' as const })
    if (!record.delivery) store.set(request(id), { ...record, delivery })
    if (delivery.kind === 'text') return this.host.sources.send(message, commands)
    if (delivery.botIdentity !== identity) return 'waiting'
    const messageId = await sendSettingsCard(commands, target, view)
    // Approval may have committed while the send was in flight. Attach the receipt to the latest record without undoing it.
    store.set(request(id), { ...this.record(id), delivery: { ...delivery, messageId } })
    return 'sent'
  }

  /** Called only by the verified bot event consumer, after the Runtime rechecks the mounted workspace. */
  cardAction(event: SettingsCardAction): void {
    const { store, projectId, topic } = this.host
    if (event.projectId !== projectId || event.botIdentity !== this.host.cardIdentity()) return
    store.atomic(() => {
      const record = store.get(request(event.requestId)), binding = topic.pollTarget()
      if (!record || record.projectId !== projectId || !binding || !record.grant || binding.epoch !== record.grant.epoch ||
        binding.chatId !== event.chatId || !binding.allowedActors.includes(event.actorId) || !record.grant.actors.includes(event.actorId) ||
        record.delivery?.kind !== 'card' || record.delivery.botIdentity !== event.botIdentity || record.delivery.messageId !== event.messageId ||
        !record.delivery.messageId || event.revision !== record.revision || !Number.isSafeInteger(event.at) || event.at < record.createdAt) return
      const view = this.view(event.requestId, record)
      if (event.action === 'status') {
        topic.settingsNotice(binding.epoch, `settings-status:${event.requestId}:${event.eventId}`, this.summary(record, view))
      } else if (event.action === 'approve' && view.status === 'pending' && event.at < record.expiresAt) {
        this.apply(event.requestId, record, { via: 'feishu', actorId: event.actorId, eventId: event.eventId })
      }
    })
  }

  private record(id: string): SettingsConfirmationRecord {
    const record = this.host.store.get(request(id))
    if (!record || record.projectId !== this.host.projectId) throw new SettingsConfirmationError(404, 'Settings confirmation not found.')
    return record
  }

  private snapshot(change: ConfirmableChange) {
    const { store, sources } = this.host
    if (change.object === 'feishuChat') {
      const instance = sources.instance<FeishuConfig>('feishu'), available = instance?.enabled === true
      const effectiveValue = available ? instance.config.chats.find(chat => chat.chatId === change.chatId)?.listen ?? instance.config.otherChats : 'none'
      return { available, effectiveValue, effectiveRevision: store.blockRevision('source:feishu') }
    }
    return { available: true, effectiveValue: effectiveRunLimits(store.settings().executor).effective[change.object],
      effectiveRevision: store.blockRevision('executor') }
  }

  private view(id: string, record: SettingsConfirmationRecord): SettingsConfirmationView {
    const { change, revision, currentValue, grant, expiresAt } = record
    const { effectiveValue, effectiveRevision, available } = this.snapshot(change)
    const status = record.decision ? 'approved'
      : this.host.store.get(latest(objectKey(change))) !== id || effectiveRevision !== revision || effectiveValue !== currentValue || !available ||
        (grant && this.host.topic.view()?.epoch !== grant.epoch) ? 'superseded' : Date.now() >= expiresAt ? 'expired' : 'pending'
    return { id, projectId: record.projectId, repository: this.host.repository, object: change.object, ...(change.object === 'feishuChat' && { chatId: change.chatId }),
      revision, currentValue, proposedValue: change.value, effectiveValue, effectiveRevision, impact: impacts[change.object],
      status, expiresAt: new Date(expiresAt).toISOString() }
  }

  private summary(record: SettingsConfirmationRecord, view: SettingsConfirmationView): string {
    return `Project ${view.repository} (${view.projectId}) · ${objectKey(record.change)}: ${view.status}. Effective value: ${view.effectiveValue} (revision ${view.effectiveRevision}).`
  }

  private apply(id: string, record: SettingsConfirmationRecord, decision: Decision): SettingsConfirmationView {
    this.host.settings.applyConfirmed(record.change, decision.via)
    const approved = { ...record, decision }
    this.host.store.set(request(id), approved)
    const view = this.view(id, approved)
    if (record.grant) this.host.topic.settingsNotice(record.grant.epoch, `settings-approved:${id}`, this.summary(record, view))
    return view
  }
}
