import { randomUUID } from 'node:crypto'
import { key, reasonText, type ActorRef, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { ProjectRef, SpecInput } from '../core/handoff.ts'
import type { PlanDraft } from '../core/plan.ts'
import { KV } from '../kv.ts'
import { allowedSender, assessmentOutcome, matchedRules, policyVersion, type AdmissionDirection, type RuleAssessment, type Settings } from '../policy.ts'
import { githubAddress, type GithubAddress } from '../sources/github-trigger.ts'
import { POLL_HORIZON_MS } from '../sources/poll.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import type { PlanIntegration } from './plan-integration.ts'
import type { FeishuMaintenanceIngress, TopicBinding } from './topic-binding.ts'
import type { Plans } from './plans.ts'
import type { Store } from './store.ts'

export type MaintenanceTarget = { planId: string } | { ticketId: string }
type Result = { status: 'ignored' | 'checked'; reason: string } | { status: 'registered' | 'associated'; target: MaintenanceTarget }
export type MaintenanceEvent = { actor: ActorRef; at: string; policyVersion: string; result?: Result } &
  ({ operatorText: string } | { sourceRevision: number; bindingEpoch?: string })
type RuleEvidence = { intentEvidence: string; ruleAssessments: RuleAssessment[] }
export type MaintenanceVerdict = { kind: 'ignore'; reason: string } | (RuleEvidence & (
  { kind: 'checked'; reason: string } | { kind: 'existing'; ticketId: string } | {
    kind: 'plan'; scope: string; direction: AdmissionDirection; spec: SpecInput; draft: PlanDraft
  }))
export type OperatorMessage = { sessionId: string; messageId: string; at: number; text: string }
interface Host {
  store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'blockRevision' | 'settings' | 'triggers' | 'tickets'>
  effects: Pick<Effects, 'cancel' | 'pending'>
  project: ProjectRef
  plans: Pick<Plans, 'get' | 'register' | 'state'>
  handoffs: Pick<Handoffs, 'get' | 'recordMaintenance'>
  sources: Pick<SourceRegistry, 'scope'>
  stage: PlanIntegration['stage']
  feishuIngress: TopicBinding['maintenanceIngress']
  bindingEpoch(): string | undefined
  observe(trigger: Trigger, mode: 'observe' | 'context'): ReceiveResult
  relay(id: string, text: string): void
  relayConsumed(id: string): Promise<boolean>
}

const relayPrefix = 'maintenance-candidate:'
const recoveryPrefix = 'maintenance-pending:'
const usableText = (text: string): boolean => !!text.trim() && text.length <= 8000 &&
  !/(?:^|\n)[\t ]*>|<(?:blockquote|forwarded_messages|quoted_message)\b|^\s*\{\s*"confirmed"\s*:/iu.test(text)

/** Keeps unsolicited maintenance on the authorized project, independent of legacy Ticket routing and idle inspections. */
export class Maintenance {
  constructor(private readonly host: Host) {}

  receive(trigger: Trigger, expectedEpoch?: string): ReceiveResult {
    const { host } = this, { store } = host
    const settings = store.settings()
    const feishu = trigger.source === 'feishu' ? host.feishuIngress(trigger) : undefined
    const github = trigger.source === 'github' ? this.githubEvent(trigger) : undefined
    const messageId = trigger.source === 'feishu' && typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined
    const grant = this.sourceGrant(trigger, settings, feishu, github)
    if (expectedEpoch !== undefined && grant?.bindingEpoch !== expectedEpoch) return 'filtered'
    if (feishu?.needsHistory && grant?.bindingEpoch) {
      if (messageId && !store.triggers.get(trigger.id)) {
        const lookup = KV.feishu.maintenanceLookup(messageId)
        if (!store.get(lookup)) store.set(lookup, { epoch: grant.bindingEpoch, at: trigger.at, actorId: trigger.actor.id,
          sourceRevision: store.blockRevision('source:feishu'), policyVersion: policyVersion(settings) })
      }
      return 'filtered'
    }
    const context = github?.pr && (trigger.meta.kind === 'inline' || trigger.meta.kind === 'review' ||
      (!trigger.human && trigger.meta.ci === true))
    return store.atomic(() => {
      const stored = host.observe(trigger, context ? 'context' : 'observe')
      if (stored !== 'stored' || !grant) return stored
      const lookup = messageId ? store.get(KV.feishu.maintenanceLookup(messageId)) : undefined
      if (lookup && (lookup.epoch !== feishu?.epoch || lookup.actorId !== trigger.actor.id || Date.parse(lookup.at) !== Date.parse(trigger.at) ||
        lookup.sourceRevision !== store.blockRevision('source:feishu') || lookup.policyVersion !== policyVersion(settings))) return stored
      if (lookup && messageId) store.delete(KV.feishu.maintenanceLookup(messageId))
      const event: MaintenanceEvent = { actor: trigger.actor, at: trigger.at, policyVersion: policyVersion(settings),
        sourceRevision: store.blockRevision(`source:${trigger.source}`), ...grant }
      this.offer(trigger.id, event, trigger.text, trigger)
      return stored
    })
  }

  feishuSince(epoch: string, sourceRevision: number): string | undefined {
    const { store } = this.host, version = policyVersion(store.settings()), earliest = Date.now() - POLL_HORIZON_MS
    let since: string | undefined
    for (const name of store.keys(KV.feishu.maintenanceLookup)) {
      const lookup = store.get(KV.feishu.maintenanceLookup(name.slice(KV.feishu.maintenanceLookup.prefix.length)))
      if (!lookup || lookup.epoch !== epoch || Date.parse(lookup.at) < earliest) store.delete(name)
      else if (lookup.sourceRevision === sourceRevision && lookup.policyVersion === version && (since === undefined || lookup.at < since)) since = lookup.at
    }
    return since
  }

  /** Retain native operator evidence; an input already in the Hub turn doesn't need a second notification. */
  receiveOperator(input: OperatorMessage, transferred: boolean, historical: boolean): void {
    const { store } = this.host, id = this.operatorId(input)
    if (store.get(KV.maintenance.event(id))) return
    const event = this.operatorEvent(input, store.settings())
    if (!event || (historical && !this.operatorPolicyUnchanged(input.at, event.policyVersion))) return
    store.atomic(() => this.offer(id, event, input.text, undefined, transferred))
  }

  private offer(id: string, event: MaintenanceEvent, text: string, trigger?: Trigger, notify = true): void {
    const { host: { store, relay } } = this
    const target = this.known(text, trigger)
    if (target) {
      this.finish(id, event, { status: 'associated', target }, text, trigger)
      return
    }
    store.set(KV.maintenance.event(id), event)
    store.set(KV.maintenance.pending(id), true)
    if (notify) relay(relayPrefix + id, JSON.stringify({ kind: 'maintenance-candidate', event_id: id, read: `maintenance/${id}` }))
  }

  /** A restart may interrupt assessment after the durable relay is consumed but before a verdict is written. */
  async resume(source?: string): Promise<void> {
    const { host } = this, { store } = host
    if (source && !this.pendingIds(false, source).length) return
    const previous = store.get(KV.maintenance.recovery)
    const consumed = previous !== undefined && await host.relayConsumed(previous)
    store.atomic(() => {
      if (store.get(KV.maintenance.recovery) !== previous) return
      if (!this.pendingIds(true).length) {
        // A registered Source can arrive after runtime startup. Keep the ID of any outstanding wake-up.
        if (store.keys(KV.maintenance.pending).length) return
        if (previous) host.effects.cancel('relay', previous)
        store.delete(KV.maintenance.recovery)
        return
      }
      // An effect may settle when the notice is still only in the native inbox.
      const id = previous && !consumed ? previous : recoveryPrefix + randomUUID()
      if (id !== previous) {
        if (previous) host.effects.cancel('relay', previous)
        store.set(KV.maintenance.recovery, id)
      }
      if (!host.effects.pending('relay', id)) host.relay(id, JSON.stringify({ kind: 'maintenance-pending', read: 'maintenance' }))
    })
  }

  relayAvailable(id: string): boolean {
    const { store } = this.host
    if (id.startsWith(recoveryPrefix)) return store.get(KV.maintenance.recovery) === id && this.pendingIds().length > 0
    if (!id.startsWith(relayPrefix)) return true
    const eventId = id.slice(relayPrefix.length)
    return store.get(KV.maintenance.pending(eventId)) === true && this.canRead(eventId, store.settings())
  }

  pending(offset: number, limit: number) {
    const ids = this.pendingIds()
    const items = ids.slice(offset, offset + limit).map(id => ({ event_id: id, read: `maintenance/${id}` }))
    return { items, next_offset: offset + limit < ids.length ? offset + limit : null }
  }

  read(id: string) {
    const { store } = this.host
    const event = store.get(KV.maintenance.event(id))
    if (!event) throw new Error('Unknown maintenance event')
    if (event.result) return { event_id: id, ...this.result(event.result) }
    if (!store.get(KV.maintenance.pending(id)) || !this.canRead(id, store.settings())) return { event_id: id, status: 'withdrawn' }
    const trigger = 'operatorText' in event ? undefined : store.triggers.get(id)
    const text = 'operatorText' in event ? event.operatorText : trigger?.text
    if (text === undefined) throw new Error('Missing source message for maintenance')
    return { event_id: id, status: 'pending', actor: event.actor, at: event.at, text, url: trigger?.url }
  }

  decide(input: string | OperatorMessage, hubSessionId: string, verdict: MaintenanceVerdict) {
    const { host } = this, { store } = host
    return store.atomic(() => {
      if (host.stage().stage !== 2) throw new Error('Maintenance requires a fully delivered Plan')
      const settings = store.settings(), version = policyVersion(settings)
      const id = typeof input === 'string' ? input : this.operatorId(input)
      const event = store.get(KV.maintenance.event(id))
      if (event?.result) return this.result(event.result)
      if (!event || !store.get(KV.maintenance.pending(id)) || !this.current(event, version)) {
        throw new Error('Maintenance event lacks current source authorization')
      }
      let trigger: Trigger | undefined, text: string
      if ('operatorText' in event) text = event.operatorText
      else {
        trigger = store.triggers.get(id)
        if (!trigger || !this.sourceAuthorized(trigger, settings)) throw new Error('Maintenance event lacks current source authorization')
        text = trigger.text
      }
      const known = this.known(text, trigger)
      if (known) return this.finish(id, event, { status: 'associated', target: known }, text, trigger)
      if (verdict.kind === 'ignore') return this.finish(id, event, { status: 'ignored', reason: verdict.reason }, text, trigger)
      if (!text.includes(verdict.intentEvidence)) throw new Error('Maintenance intent evidence must quote the original author’s new message')
      if (verdict.kind !== 'plan' && !matchedRules(verdict.ruleAssessments, settings.policy.rules).length) {
        throw new Error('Maintenance requires a matched rule')
      }
      if (verdict.kind === 'checked') return this.finish(id, event, { status: 'checked', reason: verdict.reason }, text, trigger)
      if (verdict.kind === 'existing') {
        const ticket = store.tickets.get(verdict.ticketId)
        if (!ticket || (ticket.plan && host.handoffs.get(ticket.plan.planId)?.project.id !== host.project.id)) {
          throw new Error('Maintenance can only associate a Ticket in this project')
        }
        return this.finish(id, event, { status: 'associated', target: { ticketId: ticket.id } }, text, trigger)
      }
      if (verdict.draft.features.length !== 1) throw new Error('A maintenance Plan must cover one feature')
      const outcome = assessmentOutcome({ decision: 'accept', rule_assessments: verdict.ruleAssessments, direction: verdict.direction,
        intent_evidence: verdict.intentEvidence, title: verdict.draft.nodes[0]!.title, scope: verdict.scope, reason: verdict.direction.evidence }, settings, 'inferred')
      if (outcome.kind !== 'accept') throw new Error(`Maintenance is not authorized: ${typeof outcome.reason === 'string' ? outcome.reason : reasonText(outcome.reason)}`)
      const rules = outcome.rules ?? []
      const constraints = settings.policy.rules.filter(rule => rules.includes(rule.id)).map(rule => rule.instruction)
      const spec = host.handoffs.recordMaintenance({ eventId: id, actor: event.actor, policyVersion: version, rules, hubSessionId,
        intentEvidence: verdict.intentEvidence }, verdict.scope, constraints, verdict.spec)
      const plan = host.plans.register(spec.handoffId, spec.id, verdict.draft)
      return this.finish(id, event, { status: 'registered', target: { planId: plan.id } }, text, trigger)
    })
  }

  private pendingIds(prune = false, source?: string): string[] {
    const { store } = this.host, settings = store.settings(), version = policyVersion(settings), ids: string[] = []
    for (const name of store.keys(KV.maintenance.pending)) {
      const id = name.slice(KV.maintenance.pending.prefix.length), event = store.get(KV.maintenance.event(id))
      if (event && !event.result && this.current(event, version)) {
        if ((!source || event.actor.source === source) && this.canRead(id, settings)) ids.push(id)
        continue
      } else if (prune) store.delete(KV.maintenance.pending(id))
    }
    return ids
  }

  private canRead(id: string, settings: Settings): boolean {
    const { store } = this.host, event = store.get(KV.maintenance.event(id))
    if (!event || event.result || !this.current(event, policyVersion(settings))) return false
    if ('operatorText' in event) return true
    const trigger = store.triggers.get(id)
    return !!trigger && this.sourceAuthorized(trigger, settings)
  }

  private sourceAuthorized(trigger: Trigger, settings: Settings): boolean {
    const feishu = trigger.source === 'feishu' ? this.host.feishuIngress(trigger) : undefined
    return !feishu?.needsHistory && !!this.sourceGrant(trigger, settings, feishu, trigger.source === 'github' ? this.githubEvent(trigger) : undefined)
  }

  private operatorId({ sessionId, messageId }: OperatorMessage): string {
    return key('maintenance-harness', this.host.project.id, sessionId, messageId)
  }

  private operatorEvent(input: OperatorMessage, settings: Settings): MaintenanceEvent | undefined {
    const stage = this.host.stage()
    if (stage.stage !== 2 || !(input.at >= Date.parse(stage.startedAt)) || !usableText(input.text) || settings.eval.mode === 'off' ||
        !settings.policy.rules.some(rule => rule.enabled)) return undefined
    return { actor: { source: 'harness', id: input.sessionId }, at: new Date(input.at).toISOString(),
      policyVersion: policyVersion(settings), operatorText: input.text }
  }

  /** A cold input has no local receipt: require the same authorization from its arrival through now. */
  private operatorPolicyUnchanged(at: number, version: string): boolean {
    const { store } = this.host
    for (let revision = store.get(KV.settings.revision) ?? 0; revision > 0; revision--) {
      const snapshot = store.get(KV.settings.version(revision))
      if (!snapshot || policyVersion(snapshot.settings) !== version) return false
      if (Date.parse(snapshot.savedAt) < at) return true
    }
    return false
  }

  private githubEvent(trigger: Trigger): GithubAddress | undefined {
    const address = trigger.url && githubAddress(trigger.url, this.host.project.repository)
    if (address && address.number === trigger.meta.number && address.pr === trigger.meta.isPr &&
        trigger.threads[0]?.source === 'github' && trigger.threads[0].id === String(address.number)) return address
    return undefined
  }

  private sourceGrant(trigger: Trigger, settings: Settings, feishu: FeishuMaintenanceIngress | undefined, github: GithubAddress | undefined):
    { bindingEpoch?: string } | undefined {
    const { host } = this, stage = host.stage()
    if (stage.stage !== 2 || !(Date.parse(trigger.at) >= Date.parse(stage.startedAt)) || trigger.human !== true ||
        trigger.actor.source !== trigger.source || !allowedSender(settings, trigger.actor) || !usableText(trigger.text) ||
        settings.eval.mode === 'off' || !settings.policy.rules.some(rule => rule.enabled)) return undefined
    const scope = host.sources.scope(trigger)
    if (!scope.listened || (scope.row !== undefined && settings.policy.sources[trigger.source]?.admission[scope.row]?.listedUnaddressed === 'ignore')) return undefined
    if (github && scope.observed && (trigger.meta.kind === 'issue' || (trigger.meta.kind === 'conversation' &&
      typeof trigger.meta.createdAt === 'string' && Date.parse(trigger.meta.createdAt) >= Date.parse(stage.startedAt)))) return {}
    if (feishu && (scope.observed || scope.row === 'direct')) return { bindingEpoch: feishu.epoch }
    return undefined
  }

  private current(event: MaintenanceEvent, version: string): boolean {
    return event.policyVersion === version && ('operatorText' in event || (
      this.host.store.blockRevision(`source:${event.actor.source}`) === event.sourceRevision &&
      (event.bindingEpoch === undefined || event.bindingEpoch === this.host.bindingEpoch())))
  }

  private feedbackKeys(text: string, trigger?: Trigger): string[] {
    const scope = trigger?.source === 'feishu' && trigger.meta.direct === true ? trigger.channel?.thread : trigger?.threads[0]?.id
    const content = key('feedback-text', trigger?.source ?? 'harness', scope ?? '', text.replaceAll('\r\n', '\n').trim())
    return trigger?.source === 'github' && typeof trigger.meta.commentId === 'number'
      ? [key('feedback-comment', scope ?? '', String(trigger.meta.kind), String(trigger.meta.commentId)), content] : [content]
  }

  private known(text: string, trigger?: Trigger): MaintenanceTarget | undefined {
    for (const key of this.feedbackKeys(text, trigger)) {
      const target = this.host.store.get(KV.maintenance.feedback(key))
      if (target) return target
    }
    return undefined
  }

  private finish(id: string, event: MaintenanceEvent, result: Result, text: string, trigger?: Trigger) {
    const { store } = this.host
    store.set(KV.maintenance.event(id), { ...event, result })
    store.delete(KV.maintenance.pending(id))
    if ('target' in result) for (const key of this.feedbackKeys(text, trigger)) {
      if (!store.get(KV.maintenance.feedback(key))) store.set(KV.maintenance.feedback(key), result.target)
    }
    return this.result(result)
  }

  private result(result: Result) {
    if (!('target' in result)) return result
    const { status, target } = result
    if ('ticketId' in target) return { status, ticketIds: [target.ticketId], read: `ticket/${target.ticketId}` }
    const { plans } = this.host, { planId } = target
    const ticketIds = plans.get(planId)?.nodes.flatMap(node => {
      const claim = plans.state(planId, node.id)?.claim
      return claim ? [claim.ticketId] : []
    }) ?? []
    return { status, planId, ticketIds, read: `plan/${planId}` }
  }
}
