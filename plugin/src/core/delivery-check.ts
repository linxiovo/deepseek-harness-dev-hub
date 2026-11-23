/** Ticket delivery ledger: observations fenced by revision and writer generation, never authority to merge or deliver. */
import type { ReviewEvidence } from './model.ts'

export interface DeliveryRevision { base: string; candidate: string; generation: number }
type Criterion = { id: string; text: string }
type Category = 'correctness' | 'security' | 'standard' | 'optional'
type Finding = { id: string; category: Category; summary: string; evidence: readonly string[]; affects?: readonly string[] }
type Result = { id: string; status: 'passed' | 'failed' | 'not_run'; evidence: readonly string[] }
type Run = { directory: string; command: string; observed: string }
type Json = string | boolean | number | null | readonly Json[] | { readonly [key: string]: Json }

type Tests = {
  kind: 'tests'; result: 'reported_passed' | 'unverified' | 'failed'; reference: string
  evidence: {
    scope: 'focused' | 'consumers' | 'full'; reason: string
    checks: readonly (Run & { status: 'passed' | 'failed' | 'not_run' | 'pending' | 'cancelled' })[]
    red: readonly (Run & { revision: string })[] | null
  }
}
type Docs = { kind: 'docs'; structure: 'issues' | 'not-applicable' | 'checked'; evidence: { readonly [key: string]: Json }; reference: string }
export type DeliveryEvent = Tests | Docs
  | { kind: 'first-retro' | 'final-retro'; findings: readonly Finding[] }
  | { kind: 'acceptance'; expected: readonly Criterion[]; results: readonly Result[] }
  | { kind: 'repair'; fixes: readonly { id: string; evidence: readonly string[] }[] }
type Stamp = { revision: DeliveryRevision; at: string }
type Entry = DeliveryEvent & Stamp & { reviewsBeforeRepair?: readonly string[] }
export interface DeliveryLedger { events: readonly Entry[] }

/** Immutable addresses distinguish failed assertions even when they share a suite, command or candidate. */
export interface FailedCheck extends Run { id: string; read: string; revision: string; reference: string }
type Rerun = Pick<FailedCheck, 'id' | 'read' | 'observed' | 'reference'>
export interface FailedCheckObligation { failure: FailedCheck; rerun: Rerun | null }
const runKey = ({ directory, command }: Run) => JSON.stringify([directory, command])

type Issue = Stamp & (Finding | (Result & { category: 'acceptance' }))
type Observation = Stamp & Result & { text: string }
interface Cycle {
  revision?: DeliveryRevision
  first?: Stamp
  final?: Stamp
  expected: readonly Criterion[]
  results: Map<string, Observation>
  tests?: Tests & Stamp
  docs?: Docs & Stamp
  blockers: Issue[]
  /** Fixed in Git, but not yet examined in a retro/acceptance step after a fresh dual review. */
  repaired: Issue[]
}
const emptyCycle = (revision?: DeliveryRevision): Cycle => ({ revision, expected: [], results: new Map(), blockers: [], repaired: [] })
function forRevision(active: Cycle, revision?: DeliveryRevision): Cycle {
  if (matches(active.revision, revision)) return active
  const next = emptyCycle(revision)
  // Reclaiming a lease over the very same commit resets proofs, never open obligations.
  if (active.revision && revision?.candidate === active.revision.candidate) {
    next.blockers = active.blockers
    next.repaired = active.repaired
  }
  return next
}
const nonblank = (value: string) => typeof value === 'string' && value.trim().length > 0
const cited = (items: readonly string[]) => Array.isArray(items) && items.length > 0 && items.every(nonblank)
const sameLease = (a: DeliveryRevision, b: DeliveryRevision) => a.base === b.base && a.generation === b.generation
const matches = (a: DeliveryRevision | undefined, b: DeliveryRevision | undefined) => !!a && !!b && sameLease(a, b) && a.candidate === b.candidate
const keyOf = (id: string) => `acceptance:${id}`
const validImpactKey = (key: string) => key === 'tests' || key === 'docs' || key.startsWith('acceptance:') && nonblank(key.slice('acceptance:'.length))
const validCriteria = (criteria: readonly Criterion[]) => criteria.length > 0 && criteria.every(c => nonblank(c.id) && nonblank(c.text))
  && new Set(criteria.map(c => c.id)).size === criteria.length
const currentReviews = (reviews: readonly ReviewEvidence[], revision?: DeliveryRevision) => reviews.filter(r => matches(r, revision))
function dual(reviews: readonly ReviewEvidence[]): boolean {
  const [a, b] = reviews
  return reviews.length === 2 && !!a && !!b && a.id !== b.id && a.reviewer_session !== b.reviewer_session
    && reviews.some(r => r.axis === 'standards') && reviews.some(r => r.axis === 'spec')
    && reviews.every(r => r.conclusion === 'passed' && r.blockers.length === 0 && nonblank(r.reviewer_session) && nonblank(r.id)
      && cited(r.basis) && nonblank(r.summary) && nonblank(r.at))
}

/** Only an explicit repair of open issues can carry anything. Reviewers reaffirm each key on EACH hop; the original stamp never changes. */
function afterRepair(previous: Cycle, revision: DeliveryRevision, reviews: readonly ReviewEvidence[] | undefined): Cycle {
  const next = emptyCycle(revision)
  next.repaired = previous.repaired.length && previous.blockers.length ? [...previous.repaired, ...previous.blockers]
    : previous.repaired.length ? previous.repaired : previous.blockers
  if (!previous.revision || !sameLease(previous.revision, revision)) return next
  next.first = previous.first
  next.expected = previous.expected
  if (!reviews) return next
  const matching = currentReviews(reviews, revision)
  if (!dual(matching)) return next
  const affected = new Set<string>()
  for (const issue of next.repaired) {
    if (!('affects' in issue) || !issue.affects?.length) return next
    if (previous.expected.length && issue.affects.some(key => key.startsWith('acceptance:') && !previous.expected.some(c => keyOf(c.id) === key))) return next
    for (const key of issue.affects) affected.add(key)
  }
  const keep = (key: string) => !affected.has(key) && matching.every(r => r.reuses?.includes(key))
  if (previous.tests && observationPassed(previous.tests) && keep('tests')) next.tests = previous.tests
  if (previous.docs && observationPassed(previous.docs) && keep('docs')) next.docs = previous.docs
  for (const [id, result] of previous.results) {
    if (result.status === 'passed' && keep(keyOf(id))) next.results.set(id, result)
  }
  return next
}

function complete(state: Cycle, expected: readonly Criterion[]): boolean {
  return validCriteria(expected) && state.expected.length === expected.length && expected.every(({ id, text }) => {
    const result = state.results.get(id)
    return result?.status === 'passed' && result.text === text && state.expected.some(c => c.id === id && c.text === text)
  })
}

/** Only ledger addresses can be resolved here. Other evidence remains openable under the existing reference convention. */
function referenceError(refs: readonly string[], events: readonly Entry[], before: number, ticketId: string,
  revision?: DeliveryRevision, requirePass = false): string | undefined {
  for (const ref of refs) {
    if (ref === `ticket/${ticketId}/delivery-check` || ref === `task/${ticketId}/delivery-check`)
      return 'Cite the original observation, not the delivery-check package itself'
    if (!(ref.startsWith('ticket/') || ref.startsWith('task/')) || !ref.includes('/delivery-observation/')) continue
    const match = /^(?:ticket|task)\/([^/]+)\/delivery-observation\/(0|[1-9]\d*)$/.exec(ref)
    const index = match?.[1] === ticketId ? Number(match[2]) : Infinity
    const observation = index < before ? events[index] : undefined
    if (!observation) return 'Delivery observation is missing or belongs to another ticket'
    if (revision && !matches(observation.revision, revision)) return 'Acceptance observation must match the current revision'
    if (requirePass && !observationPassed(observation)) return 'Passing acceptance must cite a successful test or Doc Tree observation'
  }
}

const needsRepair = (active: Cycle, revision?: DeliveryRevision) => active.revision?.candidate !== revision?.candidate
  && (active.blockers.length > 0 || active.repaired.length > 0)

function repairError(active: Cycle, revision: DeliveryRevision, fixes: readonly { id: string; evidence: readonly string[] }[],
  events: readonly Entry[], before: number, ticketId: string): string | undefined {
  const invalid = 'Repair requires a changed candidate and evidence for exactly all outstanding mandatory IDs'
  if (!active.revision || active.revision.candidate === revision.candidate || !fixes.length) return invalid
  const pending = new Set<string>()
  for (const issue of active.blockers) pending.add(issue.id)
  for (const issue of active.repaired) pending.add(issue.id)
  if (fixes.length !== pending.size) return invalid
  for (const fix of fixes) {
    if (!pending.delete(fix.id) || !cited(fix.evidence)) return invalid
    const error = referenceError(fix.evidence, events, before, ticketId)
    if (error) return error
  }
}

/** Rebuild, in append order, from the same persisted facts on writes, reads, and recovery. No mutable readiness bit. */
function project(events: readonly Entry[], reviews: readonly ReviewEvidence[], ticketId: string) {
  let active = emptyCycle()
  const followups: (Finding & Stamp)[] = []
  const mandatoryIds = new Set<string>()
  for (let index = 0; index < events.length; index++) {
    const entry = events[index]!
    const { revision, at } = entry
    if (entry.kind === 'repair') {
      if (!repairError(active, revision, entry.fixes, events, index, ticketId)) {
        // Reviews written before the repair was recorded cannot reaffirm the frozen set of original reports.
        active = afterRepair(active, revision, entry.reviewsBeforeRepair?.length ? undefined : reviews)
      }
      continue
    }
    // A missing or invalid repair must not let later reports erase the outstanding obligations.
    if (needsRepair(active, revision)) continue
    active = forRevision(active, revision)
    switch (entry.kind) {
      case 'first-retro': case 'final-retro': {
        if (entry.kind === 'first-retro') active.first = { revision, at }
        else if (!active.blockers.length && active.first && complete(active, active.expected)) {
          active.final = { revision, at }
          active.repaired = []
        }
        for (const finding of entry.findings) {
          const item = { ...finding, revision, at }
          if (finding.category === 'optional') followups.push(item)
          else { active.blockers.push(item); mandatoryIds.add(item.id) }
        }
        break
      }
      case 'acceptance':
        active.expected = entry.expected
        for (const result of entry.results) {
          const passed = result.status === 'passed'
          if ((passed && !cited(result.evidence)) || referenceError(result.evidence, events, index, ticketId, revision, passed)) {
            active.results.delete(result.id)
            continue
          }
          const criterion = entry.expected.find(c => c.id === result.id)!
          active.results.set(result.id, { ...result, text: criterion.text, revision, at })
          if (result.status === 'failed') {
            active.blockers.push({ ...result, category: 'acceptance', revision, at }); mandatoryIds.add(result.id)
          }
        }
        break
      case 'tests': active.tests = entry; break
      case 'docs': active.docs = entry; break
    }
  }
  return { active, followups, mandatoryIds }
}

function distinct(items: readonly { id: string }[]) {
  if (items.some(i => !nonblank(i.id) || i.id.trim() !== i.id) || new Set(items.map(i => i.id)).size !== items.length)
    throw new Error('Evidence IDs must be nonblank, unique and unambiguous')
}

function passingRuns(report: Tests): boolean {
  const { checks, red } = report.evidence
  const observed = (run: Run) => nonblank(run.command) && nonblank(run.directory) && nonblank(run.observed)
  return checks.length > 0 && checks.every(c => c.status === 'passed' && observed(c))
    && (red === null || red.length > 0 && red.every(r => nonblank(r.revision) && observed(r)
      && checks.some(c => c.directory === r.directory && c.command === r.command)))
}

type TestProgress = { status: 'failed'; check: FailedCheck } | { status: 'passed' }

function projectTestEvidence(ticketId: string, ledger: DeliveryLedger | undefined, target: DeliveryRevision | undefined,
  inherited: readonly FailedCheck[]) {
  const failures = [...inherited], reruns = new Map<string, Rerun>(), seenRuns = new Set<string>(), seenRed = new Set<string>()
  const lastFailure = new Map<string, string>(), lastPass = new Map<string, string>()
  const events = ledger?.events ?? [], defaultReference = `ticket/${ticketId}/delivery-check`
  let latest: TestProgress | undefined
  for (const [index, entry] of events.entries()) {
    if (entry.kind !== 'tests') continue
    const { revision, reference } = entry, read = `ticket/${ticketId}/delivery-observation/${index}`
    const exact = matches(revision, target), current = exact && index === events.length - 1
    const local = reference === defaultReference
    const fail = (command: string, run: Run, id: string, candidate: string): FailedCheck => {
      const failure = { directory: run.directory, command: run.command, observed: run.observed, id, read, revision: candidate, reference }
      failures.push(failure)
      lastFailure.set(command, id)
      reruns.delete(command)
      return failure
    }
    // The ancestral red in a TDD report is distinct from a failed check on that report's candidate.
    for (const [i, run] of entry.evidence.red?.entries() ?? []) {
      const command = runKey(run), key = JSON.stringify([run.revision, command, run.observed])
      if (seenRed.has(key)) continue
      seenRed.add(key)
      fail(command, run, `${read}#red/${i}`, run.revision)
    }
    const passing = entry.result === 'reported_passed' && passingRuns(entry)
    for (const [i, run] of entry.evidence.checks.entries()) {
      const command = runKey(run)
      if (run.status !== 'passed' && run.status !== 'failed') {
        if (exact) reruns.delete(command)
        continue
      }
      if (run.status === 'passed' && !passing) continue
      const onRevision = JSON.stringify([command, revision.base, revision.candidate, revision.generation])
      // An exact cited run cannot become new evidence when red recurs. A local report has no run receipt;
      // a new opposite result for the same check is the durable boundary between its identical reports.
      const identity = local
        ? JSON.stringify([run.status, onRevision, run.observed, run.status === 'failed' ? lastPass.get(onRevision) : lastFailure.get(command)])
        : JSON.stringify([run.status, command, reference])
      if (seenRuns.has(identity) || (!local && run.status === 'passed' && seenRuns.has(JSON.stringify(['failed', command, reference])))) continue
      seenRuns.add(identity)
      const id = `${read}#checks/${i}`
      if (run.status === 'failed') {
        const failure = fail(command, run, id, revision.candidate)
        if (current) latest ??= { status: 'failed', check: failure }
      } else {
        lastPass.set(onRevision, id)
        if (exact) reruns.set(command, { id, read, observed: run.observed, reference })
        if (current) latest ??= { status: 'passed' }
      }
    }
  }
  return { failures, reruns, latest }
}

/** A matching Worker rerun is evidence of progress, not proof that the assertions survived. */
export function failedCheckObligations(ticketId: string, ledger: DeliveryLedger | undefined, target: DeliveryRevision | undefined,
  inherited: readonly FailedCheck[] = []): FailedCheckObligation[] {
  const { failures, reruns } = projectTestEvidence(ticketId, ledger, target, inherited)
  return failures.map(failure => ({ failure, rerun: reruns.get(runKey(failure)) ?? null }))
}

/** Only the latest distinct observation can affect recovery. A pass must cover every outstanding failed check. */
export function latestTestProgress(ticketId: string, ledger: DeliveryLedger | undefined, target: DeliveryRevision,
  inherited: readonly FailedCheck[]): TestProgress | undefined {
  const { failures, reruns, latest } = projectTestEvidence(ticketId, ledger, target, inherited)
  if (latest?.status === 'passed' && failures.some(failure => !reruns.has(runKey(failure)))) return undefined
  return latest
}

function reviewedChecks(obligations: readonly FailedCheckObligation[], reviews: readonly ReviewEvidence[]) {
  if (!obligations.length) return []
  const axes = ['standards', 'spec'] as const
  const lanes = axes.map(axis => reviews.filter(r => r.axis === axis))
  const signers = lanes.map(lane => new Set(lane.flatMap(r => [r.reviewer_session, ...(r.retainedChecks ?? []).map(c => c.reviewer_session)])))
  const blob = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
  const confirmations = lanes.map((lane, i) => {
    const review = lane[0], valid = new Set<string>()
    if (lane.length === 1 && review?.conclusion === 'passed' && !review.blockers.length) {
      for (const c of review.retainedChecks ?? []) {
        if (nonblank(c.reviewer_session) && !signers[1 - i]!.has(c.reviewer_session) && nonblank(c.at) && nonblank(c.rationale)
          && nonblank(c.originalPath) && nonblank(c.currentPath) && blob.test(c.originalBlob) && blob.test(c.currentBlob))
          valid.add(JSON.stringify([c.failure, c.rerun]))
      }
    }
    return valid
  })
  return obligations.map(({ failure, rerun }) => {
    const pair = JSON.stringify([failure.id, rerun?.id])
    return { failure, rerun, confirmed_by: axes.filter((_, i) => !!rerun && confirmations[i]!.has(pair)) }
  })
}

function observationPassed(event: DeliveryEvent): boolean {
  return event.kind === 'tests' ? event.result === 'reported_passed' && passingRuns(event)
    : event.kind === 'docs' && (event.structure === 'checked' || event.structure === 'not-applicable')
}

function validateReport(report: Tests | Docs) {
  if (!nonblank(report.reference)) throw new Error('A report must cite its original evidence')
  if (report.kind === 'docs') {
    if (!['checked', 'not-applicable', 'issues'].includes(report.structure) || !report.evidence || Array.isArray(report.evidence)
      || !Object.keys(report.evidence).length) throw new Error('Document report requires observed evidence')
    return
  }
  if (!nonblank(report.evidence.reason)) throw new Error('Test evidence requires a selection reason')
  if (report.result === 'reported_passed' && !passingRuns(report))
    throw new Error('Passed tests require observed passing checks and matching red runs when declared')
}

/** Append one observed event. Revision, clock, previous ledger, review authority and canonical criteria come from trusted adapters. */
export function advanceDelivery(ledger: DeliveryLedger | undefined, revision: DeliveryRevision, reviews: readonly ReviewEvidence[],
  event: DeliveryEvent, at: string, ticketId: string): DeliveryLedger {
  if (!nonblank(revision.base) || !nonblank(revision.candidate) || !Number.isSafeInteger(revision.generation) || revision.generation < 0 || !nonblank(at))
    throw new Error('Delivery evidence requires a verified revision, generation and timestamp')
  const events = ledger?.events ?? []
  const { active, mandatoryIds } = project(events, reviews, ticketId)
  if (event.kind === 'repair') {
    const error = repairError(active, revision, event.fixes, events, events.length, ticketId)
    if (error) throw new Error(error)
  } else {
    if (needsRepair(active, revision))
      throw new Error('Repair outstanding mandatory issues before changing candidate')
    const state = forRevision(active, revision)
    if (event.kind === 'tests' || event.kind === 'docs') {
      validateReport(event)
    } else {
      if (!dual(currentReviews(reviews, revision))) throw new Error('Delivery sequence requires two independent passing reviews of this revision')
      if (state.blockers.length) throw new Error('Repair mandatory findings before continuing the delivery sequence')
      if (event.kind === 'acceptance') {
        if (!state.first || state.final) throw new Error('Acceptance must follow the first retro and precede the final retro')
        distinct(event.results)
        if (!validCriteria(event.expected) || !event.results.length || event.results.some(r => !event.expected.some(c => c.id === r.id)
          || !['passed', 'failed', 'not_run'].includes(r.status) || !(r.status === 'not_run' ? r.evidence.every(nonblank) : cited(r.evidence))))
          throw new Error('Acceptance results require canonical criteria and concrete evidence')
        if (state.expected.length && (state.expected.length !== event.expected.length || state.expected.some(c => !event.expected.some(e => c.id === e.id && c.text === e.text))))
          throw new Error('Acceptance criteria changed within a delivery cycle')
        for (const result of event.results) {
          const error = referenceError(result.evidence, events, events.length, ticketId, revision, result.status === 'passed')
          if (error) throw new Error(error)
        }
      } else {
        if (event.kind === 'first-retro' && state.first) throw new Error('First retro was already recorded in this cycle')
        if (event.kind === 'first-retro' && !state.tests?.evidence.checks.some(check => check.status === 'passed' || check.status === 'failed'))
          throw new Error('First retro requires observed execution evidence for this revision')
        if (event.kind === 'final-retro' && (!state.first || state.final || !complete(state, state.expected))) throw new Error('Final retro requires complete passing acceptance in this cycle')
        distinct(event.findings)
        for (const f of event.findings) {
          if (!['correctness', 'security', 'standard', 'optional'].includes(f.category) || !nonblank(f.summary) || !cited(f.evidence)
            || f.affects?.some(key => !validImpactKey(key)) || f.category === 'optional' && (mandatoryIds.has(f.id) || f.affects?.length))
            throw new Error('Invalid finding category, evidence, impact key, or attempted downgrade of a mandatory issue')
          const error = referenceError(f.evidence, events, events.length, ticketId)
          if (error) throw new Error(error)
        }
      }
    }
  }
  const entry: Entry = { ...event, revision, at }
  if (event.kind === 'repair') entry.reviewsBeforeRepair = currentReviews(reviews, revision).map(r => r.id)
  return { events: [...events, structuredClone(entry)] }
}

/** A local evidence view, not CI, a merge receipt, or formal delivery. Missing/dirty worktrees have no active evidence. */
export function viewDelivery(ledger: DeliveryLedger | undefined, revision: DeliveryRevision | undefined, reviews: readonly ReviewEvidence[],
  acceptance: readonly Criterion[], ticketId: string, inherited?: readonly FailedCheck[]) {
  const events = ledger?.events ?? []
  const { active, followups } = project(events, reviews, ticketId)
  const state = forRevision(active, revision)
  const matching = currentReviews(reviews, revision)
  const missing: string[] = []
  // Plan callers opt in with their canonical inherited checks, even when that list is empty.
  const failed_checks = inherited === undefined ? [] : reviewedChecks(failedCheckObligations(ticketId, ledger, revision, inherited), matching)
  if (failed_checks.some(check => check.confirmed_by.length !== 2)) missing.push('failed_checks_require_recheck')
  if (!revision) missing.push('revision')
  if (!dual(matching)) missing.push('dual-review')
  if (!state.first) missing.push('first-retro')
  if (!complete(state, acceptance)) missing.push('acceptance')
  const items = acceptance.map(c => {
    const observed = state.results.get(c.id)
    const result = observed?.text === c.text ? observed : undefined
    if (result?.status !== 'passed') missing.push(keyOf(c.id))
    return { ...c, result: result ?? null }
  })
  if (!state.final) missing.push('final-retro')
  for (const issue of active.blockers) missing.push(`repair:${issue.id}`)
  if (needsRepair(active, revision)) for (const issue of active.repaired) missing.push(`repair:${issue.id}`)
  if (!state.tests || !observationPassed(state.tests)) missing.push('tests')
  if (!state.docs || !observationPassed(state.docs)) missing.push('docs')
  return { revision: revision ?? null, events, reviews: matching, failed_checks, blockers: active.blockers, repaired: active.repaired,
    followups, acceptance: items, tests: state.tests ?? null, docs: state.docs ?? null, missing, ready: missing.length === 0 }
}
