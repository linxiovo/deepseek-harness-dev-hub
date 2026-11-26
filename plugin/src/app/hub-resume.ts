import type { Handoff, ProjectRef } from '../core/handoff.ts'
import type { Trigger } from '../core/model.ts'
import { KV } from '../kv.ts'
import { promptFile } from './skill-files.ts'
import type { Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import type { Plans } from './plans.ts'
import type { Store } from './store.ts'

const LIMIT = 16_384, MAX_TICKETS = 64, MAX_HANDOFFS = 32, MAX_PLANS = 64, MAX_EVENTS = 128, MAX_EFFECTS = 40

type ResumeStore = Pick<Store, 'get' | 'keys' | 'tickets' | 'threads' | 'triggers'>
type ResumeHandoffs = Pick<Handoffs, 'get' | 'list' | 'spec'>
type ResumeEffects = Pick<Effects, 'pendingSummary' | 'count'>

export interface HubResumeInput {
  store: ResumeStore
  handoffs: ResumeHandoffs
  plans: Pick<Plans, 'current'>
  effects: ResumeEffects
  project: ProjectRef | undefined
  hubId: string
  epoch: number
}

type EventRecord = { kind: 'trigger' | 'ticket-input'; id: string; at: string; read: string; state: 'pending' | 'evaluating' | 'undelivered';
  source?: string; preview?: string; thread?: string; ticket_id?: string; input_kind?: string; trigger_id?: string; trigger_read?: string }

function preview(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function belongsToProject(handoff: Handoff, project: ProjectRef | undefined): boolean {
  if (!project) return true
  return handoff.project.id === project.id && handoff.project.repository.toLowerCase() === project.repository.toLowerCase()
    && handoff.project.workspace.toLowerCase() === project.workspace.toLowerCase()
}

function eventRecord(trigger: Trigger, state: EventRecord['state'], thread: string,
  excerpt: (text: string, max: number) => string): EventRecord {
  return { kind: 'trigger', id: trigger.id, source: trigger.source, at: trigger.at, preview: excerpt(trigger.text, 220),
    read: `trigger/${trigger.id}`, thread, state }
}

/** Read-only, bounded prompt and durable-state projection used when a Hub Session resumes. */
export function hubResumeText({ store, handoffs, plans: planReader, effects, project, hubId, epoch }: HubResumeInput): string {
  const prompt = promptFile('hub-resume')
  let textTruncated = false, handoffListsTruncated = false
  const excerpt = (text: string, max: number): string => {
    if (text.length <= max) return text
    textTruncated = true
    return preview(text, max)
  }
  const shortList = (items: readonly string[]): string[] => {
    if (items.length > 16) handoffListsTruncated = true
    return items.slice(0, 16).map(item => excerpt(item, 220))
  }
  const threads = store.threads.list(), allTickets = store.tickets.list()
  const seenEvents = new Set<string>()
  let pendingEventCount = 0
  const pendingEvents: EventRecord[] = []
  for (const thread of threads) {
    for (const [ids, state] of [[thread.pending, 'pending'], [thread.evaluating?.triggerIds ?? [], 'evaluating']] as const) {
      for (const id of ids) {
        if (seenEvents.has(id)) continue
        const trigger = store.triggers.get(id)
        if (!trigger) throw new Error(`Hub resume found thread ${thread.key} with missing trigger ${id}`)
        pendingEventCount++
        if (pendingEvents.length < MAX_EVENTS) pendingEvents.push(eventRecord(trigger, state, thread.key, (text, max) => excerpt(text, max)))
        seenEvents.add(id)
      }
    }
  }
  for (const ticket of allTickets) for (const inputId of ticket.undelivered) {
    const input = ticket.inputs.find(item => item.id === inputId)
    if (!input) throw new Error(`Hub resume found ticket ${ticket.id} with missing input ${inputId}`)
    const trigger = input.kind === 'trigger' ? store.triggers.get(input.triggerId) : undefined
    if (input.kind === 'trigger' && !trigger) throw new Error(`Hub resume found ticket ${ticket.id} with missing trigger ${input.triggerId}`)
    pendingEventCount++
    if (pendingEvents.length < MAX_EVENTS) pendingEvents.push({ kind: 'ticket-input', id: input.id, ticket_id: ticket.id, input_kind: input.kind,
      at: input.at, read: `ticket/${ticket.id}/input/${input.id}`, state: 'undelivered',
      ...(trigger ? { trigger_id: trigger.id, trigger_read: `trigger/${trigger.id}`, source: trigger.source, preview: excerpt(trigger.text, 160) }
        : input.kind === 'text' || input.kind === 'note' ? { preview: excerpt(input.text, 160) } : {}) })
  }

  const handoffCandidates = handoffs.list().filter(item => belongsToProject(item, project))
    .filter(item => item.status !== 'specified' || !!item.spec).sort((a, b) => b.id.localeCompare(a.id))
  const activeHandoffs = handoffCandidates.slice(0, MAX_HANDOFFS).map(item => ({ id: item.id, status: item.status,
    project_id: item.project.id, goal: excerpt(item.goal, 300), constraints: shortList(item.constraints),
    acceptance_scope: shortList(item.acceptanceScope), authorization: { scope: excerpt(item.authorization.scope, 500), release: item.authorization.release },
    ...(item.question ? { question: { id: item.question.id, status: item.question.status, text: excerpt(item.question.text, 220),
      ...(item.question.answer ? { answer: excerpt(item.question.answer, 220) } : {}) } } : {}),
    ...(item.spec ? { spec: { id: item.spec.id, read: `spec/${item.id}` } } : {}), read: `handoff/${item.id}` }))

  // A registered Plan is keyed by its Handoff ID; a published Spec alone is not a Plan.
  const registeredPlanKeys = new Set(store.keys(KV.plans.record.prefix))
  const plannedHandoffs = handoffCandidates.filter(item => registeredPlanKeys.has(KV.plans.record(item.id)))
  const plans = plannedHandoffs.slice(0, MAX_PLANS).map(({ id }) => {
    const active = planReader.current(id)
    if (!active || active.plan.handoffId !== id) throw new Error(`Hub resume cannot resolve the active Plan revision for Handoff ${id}`)
    return { id, handoff_id: active.plan.handoffId, status: active.plan.status, goal: excerpt(active.goal, 300), revision: active.revision,
      read: `plan/${id}`, revision_read: `plan/${id}/revision/${active.revision}` }
  })

  const ticketCandidates = allTickets.filter(ticket => !ticket.ended || ticket.undelivered.length > 0)
  const ticketRows = ticketCandidates.slice(0, MAX_TICKETS).map(ticket => {
    const latest = ticket.assignments.at(-1), basis = ticket.mandate.basis
    const report = latest?.report
    return { id: ticket.id, title: excerpt(ticket.title, 180), state: ticket.ended ? `ended:${ticket.ended.outcome}` : latest?.state ?? 'open',
      mandate: { strength: ticket.mandate.strength, actor: { source: ticket.mandate.actor.source, id: excerpt(ticket.mandate.actor.id, 120) },
        scope: excerpt(ticket.mandate.scope, 500), basis: {
          via: basis.via, source: excerpt(basis.source ?? '', 120), sender: excerpt(basis.sender ?? '', 120),
          row: excerpt(basis.row ?? '', 120), addressed: 'addressed' in basis ? basis.addressed ?? null : null,
          rules: (basis.rules ?? []).slice(0, 8).map(rule => excerpt(rule, 80)), read: `ticket/${ticket.id}` } },
      undelivered_count: ticket.undelivered.length,
      ...(report ? { latest_action: { state: report.state, summary: excerpt(report.summary, 220), at: report.at, source: `ticket/${ticket.id}` } } : {}),
      read: `ticket/${ticket.id}`, ...(ticket.plan ? { plan: { id: ticket.plan.planId, read: `plan/${ticket.plan.planId}` } } : {}) }
  })

  const actionRows = ticketRows.flatMap(ticket => ticket.latest_action ? [{ ticket_id: ticket.id, ...ticket.latest_action }] : [])
  const actionCount = ticketCandidates.reduce((count, ticket) => count + (ticket.assignments.at(-1)?.report ? 1 : 0), 0)
  const summarizedEffects = effects.pendingSummary(MAX_EFFECTS + 1)
  const pendingEffects = summarizedEffects.slice(0, MAX_EFFECTS).map(({ kind, key, attempts, state }) => ({ kind, key, attempts, state }))
  const counts = { tickets: ticketCandidates.length, handoffs: handoffCandidates.length, plans: plannedHandoffs.length, pending_events: pendingEventCount,
    actions: actionCount, pending_effects: effects.count() }
  const projectView = project ? { id: project.id, repository: project.repository, workspace: project.workspace } : null
  const truncated = { tickets: ticketCandidates.length > ticketRows.length, handoffs: handoffCandidates.length > activeHandoffs.length,
    plans: plannedHandoffs.length > plans.length, pending_events: pendingEventCount > pendingEvents.length, actions: actionCount > actionRows.length,
    pending_effects: effects.count() > pendingEffects.length, text: textTruncated, handoff_lists: handoffListsTruncated }
  const result = { hub_id: hubId, epoch, project: projectView, tickets: ticketRows, handoffs: activeHandoffs, plans,
    pending_events: pendingEvents, actions: actionRows, pending_effects: pendingEffects,
    ...store.get(KV.plans.maintenanceStarted) ? { maintenance: 'maintenance' } : {}, counts, truncated }
  const maxJson = Math.max(0, LIMIT - prompt.length - 1)
  let json = JSON.stringify(result)
  while (json.length > maxJson) {
    if (result.pending_events.length) { result.pending_events.pop(); result.truncated.pending_events = true }
    else if (result.actions.length) { result.actions.pop(); result.truncated.actions = true }
    else if (result.tickets.length) { result.tickets.pop(); result.truncated.tickets = true }
    else if (result.handoffs.length) { result.handoffs.pop(); result.truncated.handoffs = true }
    else if (result.plans.length) { result.plans.pop(); result.truncated.plans = true }
    else if (result.pending_effects.length) { result.pending_effects.pop(); result.truncated.pending_effects = true }
    else break
    json = JSON.stringify(result)
  }
  if (json.length > maxJson) throw new Error('The fixed Hub resume prompt leaves no room for the required JSON summary')
  return `${prompt}\n${json}`
}
