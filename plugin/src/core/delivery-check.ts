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
  if (!reviews) return next
  const matching = currentReviews(reviews, revision)
  if (!dual(matching)) return next
  const affected = new Set<string>()
  let allCriteria = false
  for (const issue of next.repaired) {
    if (!('affects' in issue) || !issue.affects?.length) return next
    if (previous.expected.length && issue.affects.some(key => key.startsWith('acceptance:') && !previous.expected.some(c => keyOf(c.id) === key))) return next
    for (const key of issue.affects) affected.add(key)
    if (!issue.affects.some(key => key.startsWith('acceptance:'))) allCriteria = true
  }
  const keep = (key: string) => !affected.has(key) && matching.every(r => r.reuses?.includes(key))
  if (previous.tests && observationPassed(previous.tests) && keep('tests')) next.tests = previous.tests
  if (previous.docs && observationPassed(previous.docs) && keep('docs')) next.docs = previous.docs
  if (!allCriteria) for (const [id, result] of previous.results) {
    if (result.status === 'passed' && keep(keyOf(id))) next.results.set(id, result)
  }
  return next
}

function complete(state: Cycle, expected: readonly Criterion[]): boolean {
  return validCriteria(expected) && state.expected.length === expected.length && expected.every(({ id, text }) => {
    const result = state.results.get(id)
    return result?.status === 'passed' && result.text === text && state.expected.some(c => c.id === id && c.text === text)
  }) && expected.some(({ id }) => matches(state.results.get(id)?.revision, state.revision))
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
          if (result.status === 'passed' && (!cited(result.evidence) || referenceError(result.evidence, events, index, ticketId, revision, true))) {
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
  acceptance: readonly Criterion[], ticketId: string) {
  const events = ledger?.events ?? []
  const { active, followups } = project(events, reviews, ticketId)
  const state = forRevision(active, revision)
  const matching = currentReviews(reviews, revision)
  const missing: string[] = []
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
  return { revision: revision ?? null, events, reviews: matching, blockers: active.blockers, repaired: active.repaired,
    followups, acceptance: items, tests: state.tests ?? null, docs: state.docs ?? null, missing, ready: missing.length === 0 }
}
