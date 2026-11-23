/** Bounded technical recovery of an already authorized Plan Ticket; never a grant or a delivery receipt. */
import type { DeliveryRevision } from '../core/delivery-check.ts'
import type { Engine } from '../core/engine.ts'
import { key } from '../core/ids.ts'
import { latestAssignment, type Assignment, type Ticket } from '../core/model.ts'
import { canRetry } from '../core/stage.ts'
import { KV } from '../kv.ts'
import type { Plans } from './plans.ts'
import type { DispatchLimits, RunLimits } from './run-limits.ts'
import { promptFile } from './skill-files.ts'
import type { Store } from './store.ts'

const diagnosis = promptFile('plan-stagnation')
export type PlanCheck = { directory: string; command: string }
type TestObservation = { candidate: string; result: 'failed' | 'reported_passed' | 'unverified';
  checks: readonly (PlanCheck & { status: string; observed: string })[]; read: string; reference?: string }

/** A passing summary is not a rerun. Every historically failing command needs a later observed pass on the exact approval revision. */
export function unrepairedChecks(ticket: Ticket, target: DeliveryRevision | undefined, inherited: readonly PlanCheck[] = []): PlanCheck[] {
  const required = new Map<string, PlanCheck>(), seen = new Set<string>()
  for (const check of inherited) required.set(JSON.stringify([check.directory, check.command]), check)
  for (const entry of ticket.deliveryCheck?.events ?? []) {
    if (entry.kind !== 'tests') continue
    const { revision } = entry
    const exact = target && revision.candidate === target.candidate && revision.generation === target.generation && revision.base === target.base
    for (const check of entry.evidence.checks) {
      const id = JSON.stringify([check.directory, check.command])
      if (check.status === 'failed') {
        required.set(id, { directory: check.directory, command: check.command })
      } else if (exact && entry.result === 'reported_passed' && check.status === 'passed') {
        // Replaying an old pass cannot clear a failure recorded since that pass.
        const run = key(id, check.observed, entry.reference)
        if (seen.has(run)) continue
        seen.add(run)
        required.delete(id)
      }
    }
  }
  return [...required.values()]
}

interface Failure { id: string; kind: 'tests' | 'report' | 'idle'; assignmentId: string; at: string; summary: string; read: string; candidate?: string }
type Stage = 'watching' | 'diagnose' | 'reassigned' | 'stalled'
export interface StagnationRecord {
  assignmentId: string
  stage: Stage
  /** Counters reset only on a new credible passing observation, not on steering, reassignment, or worker prose. */
  attempts: number
  roundAttempts: number
  roundAt: string
  failures: Failure[]
  openTests: boolean
  /** Only a Worker tool can attest to a technical report. A host/configuration failure or answered product question cannot. */
  technicalReportId?: string
  diagnosisDeliveredAt?: string
  /** Replaying an old pass cannot reset the idle clock or erase a subsequent failure report. */
  passes: string[]
  diagnosisInputId?: string
  reason?: string
}
export interface StagnationView {
  status: Stage | 'quota-paused' | 'waiting-for-budget' | 'paused' | 'held' | 'inactive'
  failureId?: string
  failure?: Failure
  attempts: number
  canReplan: boolean
  reason?: string
  assignmentId: string
  diagnosisInputId?: string
}
interface Host {
  store: Pick<Store, 'tickets' | 'atomic' | 'get' | 'set'>
  plans: Pick<Plans, 'state' | 'repairSource'>
  limits: Pick<RunLimits, 'forDispatch' | 'blocked'>
  engine: Pick<Engine, 'retryTicket' | 'note'>
  paused(): boolean
  /** Active graph, credential authority and exclusive mainline ownership; affects actions, not retained observations. */
  eligible(ticket: Ticket): boolean
  routeReplan?(ticket: Ticket, failureId: string): void
  now?: () => string
}
type Hold = Pick<StagnationView, 'status' | 'reason'>

/** Observes committed Worker facts and advances at most one recovery step per policy window. */
export class PlanStagnation {
  constructor(private readonly host: Host) {}

  /** The original claim stays immutable even when a newer Assignment is running this same Ticket. */
  private claimed(ticket: Ticket): boolean {
    const plan = ticket.plan
    if (!plan || ticket.ended || ticket.id !== key('plan-ticket', plan.planId, plan.nodeId)) return false
    const state = this.host.plans.state(plan.planId, plan.nodeId), claim = state?.claim
    return !!state && !['delivered', 'failed', 'stopped'].includes(state.status) && !!claim && claim.ticketId === ticket.id
      && claim.role === plan.role && claim.assignmentId === ticket.assignments[0]?.id && claim.session === `worker-${ticket.id}`
  }

  private record(ticket: Ticket, assignment: Assignment): StagnationRecord {
    const saved = this.host.store.get(KV.planStagnation.ticket(ticket.id))
    if (saved?.assignmentId === assignment.id) return saved
    return { assignmentId: assignment.id, stage: 'watching', roundAt: assignment.startedAt ?? assignment.createdAt,
      attempts: saved?.attempts ?? 0, roundAttempts: saved?.attempts ?? 0, failures: saved?.failures ?? [],
      openTests: saved?.openTests ?? false, passes: saved?.passes ?? [] }
  }

  private save(ticket: Ticket, record: StagnationRecord) { this.host.store.set(KV.planStagnation.ticket(ticket.id), record) }

  private admission(ticket: Ticket, plan: NonNullable<Ticket['plan']>, record?: StagnationRecord): { limits: DispatchLimits; hold?: Hold } {
    const { limits, block } = this.host.limits.forDispatch(ticket.id, plan)
    if (this.host.paused()) return { limits, hold: { status: 'paused', reason: 'Processing is paused' } }
    if (block || this.host.limits.blocked(ticket.id)) return { limits, hold: {
      status: block?.state === 'reserved' ? 'waiting-for-budget' : 'quota-paused',
      reason: block ? `${block.scope} budget: ${block.state}` : 'Run limit is paused',
    } }
    if (ticket.attention || !this.host.eligible(ticket)) return { limits, hold: { status: 'held', reason: ticket.attention
      ? 'Waiting for an explicit human action' : 'The active Plan, credential or mainline guard does not permit recovery' } }
    const assignment = latestAssignment(ticket), report = assignment?.report
    if (assignment && report && (report.state === 'failed' || report.state === 'blocked')
      && record?.technicalReportId !== key('report', assignment.id, report.state, report.at, report.summary)) {
      return { limits, hold: { status: 'held', reason: `No current Worker technical report: ${report.summary}` } }
    }
    return { limits }
  }

  /** Rechecked by the Executor at the actual delivery boundary, not merely when intent was written. */
  allowed(ticket: Ticket, inputId?: string): boolean {
    if (!ticket.plan || !this.claimed(ticket)) return false
    const record = this.host.store.get(KV.planStagnation.ticket(ticket.id))
    if (!record || latestAssignment(ticket)?.id !== record.assignmentId || this.admission(ticket, ticket.plan, record).hold) return false
    return inputId === undefined ? record.stage === 'reassigned' : record.stage === 'diagnose' && record.diagnosisInputId === inputId
  }

  private addFailure(ticket: Ticket, record: StagnationRecord, failure: Failure): void {
    if (record.failures.some(previous => previous.id === failure.id)) return
    record.failures.push(failure)
    if (failure.kind !== 'idle') record.attempts++
    this.save(ticket, record)
  }

  observeReport(ticket: Ticket): void {
    const assignment = latestAssignment(ticket), report = assignment?.report
    if (!assignment || !report || (report.state !== 'failed' && report.state !== 'blocked') || ticket.attention || !this.claimed(ticket)) return
    const record = this.record(ticket, assignment)
    const id = key('report', assignment.id, report.state, report.at, report.summary)
    if (record.technicalReportId === id) return
    record.technicalReportId = id
    // Once a check is red, reports describe it; only distinct run evidence counts another attempt for it.
    if (record.openTests) this.save(ticket, record)
    else this.addFailure(ticket, record, { id, kind: 'report', assignmentId: assignment.id, at: report.at,
      summary: report.summary, read: `ticket/${ticket.id}/report/${assignment.id}` })
  }

  observeTests(ticketId: string, observation: TestObservation): void {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || !assignment || !this.claimed(ticket)) return
    const events = ticket.deliveryCheck?.events, index = (events?.length ?? 0) - 1, entry = events?.[index]
    // Trust the appended, inspected observation, not a caller-supplied summary or replacement pointer.
    if (entry?.kind !== 'tests' || entry.revision.candidate !== observation.candidate || entry.result !== observation.result
      || observation.read !== `ticket/${ticketId}/delivery-observation/${index}` || entry.revision.generation !== assignment.writer?.generation) return
    const record = this.record(ticket, assignment)
    if (entry.result === 'unverified') return
    const failed = entry.result === 'failed'
    const checks = entry.evidence.checks.filter(check => check.status === (failed ? 'failed' : 'passed'))
    if (!checks.length) return
    // Resource indices vary on replay. A new candidate, actual output, or original run reference distinguishes attempts.
    const id = key('check-run', entry.result, entry.revision.candidate, entry.revision.base, String(entry.revision.generation), entry.reference,
      ...(failed && record.passes.length ? [record.passes.at(-1)!] : []),
      ...checks.map(c => JSON.stringify([c.directory, c.command, c.observed])).sort())
    if (failed) {
      record.openTests = true
      this.addFailure(ticket, record, { id, kind: 'tests', at: entry.at, assignmentId: assignment.id, candidate: entry.revision.candidate,
        summary: `${checks[0]!.directory}: ${checks[0]!.command}: ${checks[0]!.observed}`, read: observation.read })
      return
    }
    if (record.passes.includes(id)) return
    record.passes.push(id)
    const plan = ticket.plan
    const inherited = plan && this.host.plans.repairSource(plan.planId, plan.nodeId)?.checks
    if (!unrepairedChecks(ticket, entry.revision, inherited).length) {
      this.withdraw(ticket, record)
      record.attempts = 0; record.roundAttempts = 0; record.roundAt = entry.at; record.stage = 'watching'; record.openTests = false
      delete record.reason
    }
    this.save(ticket, record)
  }

  /** Withdraw only our obsolete pending intent. Its original Input, identity and evidence stay in Ticket history. */
  private withdraw(ticket: Ticket, record: StagnationRecord): void {
    const id = record.diagnosisInputId
    if (id && ticket.undelivered.includes(id)) {
      ticket.undelivered = ticket.undelivered.filter(pending => pending !== id)
      this.host.store.tickets.save(ticket)
    }
    delete record.diagnosisInputId
    delete record.diagnosisDeliveredAt
  }

  scan(): void {
    for (const ticket of this.host.store.tickets.open()) {
      if (ticket.plan) this.host.store.atomic(() => this.advance(ticket))
    }
  }

  private advance(ticket: Ticket): void {
    const assignment = latestAssignment(ticket)
    if (!ticket.plan || !assignment || !this.claimed(ticket)) return
    const record = this.record(ticket, assignment)
    if (record.stage === 'stalled') return
    const { limits, hold } = this.admission(ticket, ticket.plan, record)
    if (hold) return
    // Waiting for initial launch capacity is not a failed Worker attempt; ready is never a formal delivery receipt.
    if (assignment.report?.state === 'ready' && !record.attempts || assignment.state !== 'running' && !assignment.report) return
    const now = this.host.now?.() ?? new Date().toISOString(), { maxAttemptsWithoutProgress, idleSeconds } = limits.stagnation
    // A restart before delivery (or before its receipt) must first reconcile the same Input, not skip straight to a retry.
    if (record.stage === 'diagnose' && record.diagnosisInputId && !record.diagnosisDeliveredAt) {
      if (ticket.undelivered.includes(record.diagnosisInputId)) {
        if (!ticket.delivery) return
      } else if (assignment.deliveredAt) {
        record.diagnosisDeliveredAt = assignment.deliveredAt
        this.save(ticket, record)
      }
    }
    const start = Math.max(Date.parse(record.roundAt), Date.parse(record.diagnosisDeliveredAt ?? record.roundAt),
      Date.parse(assignment.startedAt ?? record.roundAt))
    if (record.attempts - record.roundAttempts < maxAttemptsWithoutProgress && Date.parse(now) - start < idleSeconds * 1000) return
    if (record.attempts === 0 && record.stage === 'watching') this.addFailure(ticket, record, {
      id: key('no-progress', assignment.id, record.roundAt), kind: 'idle', assignmentId: assignment.id, at: now,
      summary: `No new passing check since ${record.roundAt}`, read: `ticket/${ticket.id}/delivery-check`,
    })
    const failure = record.failures.at(-1)!
    const { execution } = ticket, writer = assignment.writer, active = execution?.active_writer
    const safeWriter = assignment.state === 'running' && execution?.ownership?.verified && execution.ownership.ticket === ticket.id
      && execution.preparation?.state === 'verified' && writer?.generation === execution.ownership.generation && writer.session === `worker-${ticket.id}`
      && (writer.state === 'idle' && !active || writer.state === 'active' && active?.assignment === assignment.id && active.session === writer.session)
    if (!safeWriter) record.reason = 'No safely reusable, verified current Worker Assignment'
    else if (record.stage === 'watching') {
      const text = `${diagnosis}\n${JSON.stringify({ failure_id: failure.id, summary: failure.summary.slice(0, 500), read: failure.read, attempts: record.attempts })}`
      const updated = this.host.engine.note(ticket.id, text, assignment.id)
      const input = updated.inputs.findLast(input => input.kind === 'note' && input.diagnosisFor === assignment.id && input.text === text)
      if (!input) throw new Error('The diagnostic Input did not commit on the current Assignment')
      record.diagnosisInputId = input.id; record.stage = 'diagnose'
    } else if (record.stage === 'diagnose' && canRetry(ticket)) {
      const updated = this.host.engine.retryTicket(ticket.id, assignment.id)
      record.assignmentId = latestAssignment(updated)!.id; record.stage = 'reassigned'
      delete record.diagnosisDeliveredAt
    } else record.reason = record.stage === 'reassigned' ? 'The replacement Assignment has not made credible progress'
      : 'The diagnostic did not restore progress; the current Assignment is not safely retryable'
    if (record.reason) { record.stage = 'stalled'; this.withdraw(ticket, record) }
    record.roundAttempts = record.attempts; record.roundAt = now
    this.save(ticket, record)
    if (record.stage === 'stalled') this.host.routeReplan?.(ticket, failure.id)
  }

  /** Resolve an earlier Plan revision's failure even after another report, progress, replacement, or formal delivery. */
  failure(ticketId: string, id: string): Failure | undefined {
    return this.host.store.get(KV.planStagnation.ticket(ticketId))?.failures.find(failure => failure.id === id)
  }

  view(ticketId: string): StagnationView | undefined {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket?.plan || !assignment) return undefined
    const record = this.record(ticket, assignment), failure = record.failures.at(-1)
    const hold = this.claimed(ticket) ? this.admission(ticket, ticket.plan, record).hold
      : { status: 'inactive' as const, reason: 'Ticket is no longer an active Plan claim' }
    return { status: hold?.status ?? record.stage, reason: hold?.reason ?? record.reason, assignmentId: record.assignmentId,
      attempts: record.attempts, failureId: failure?.id, failure, diagnosisInputId: record.diagnosisInputId,
      canReplan: !hold && !!failure && record.stage !== 'watching' && (assignment.report?.state !== 'ready' || record.attempts > 0) }
  }
}
