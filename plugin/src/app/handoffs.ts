import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { key } from '../core/ids.ts'
import type { Handoff, HandoffInput, HandoffQuestion, ProjectRef, Spec, SpecInput } from '../core/handoff.ts'
import { PLAN_FEATURE_KINDS } from '../core/plan.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import { promptFile } from './skill-files.ts'

const relayTemplate = promptFile('handoff-relay')

function matchesBinding(approved: HandoffInput['project'], recorded: ProjectRef): boolean {
  if (approved.repository.trim().toLowerCase() !== recorded.repository.toLowerCase()) return false
  try {
    const workspace = realpathSync.native(approved.workspace.trim())
    const matches = process.platform === 'win32' ? workspace.toLowerCase() === recorded.workspace.toLowerCase() : workspace === recorded.workspace
    return matches && statSync(workspace).isDirectory()
  } catch {
    return false
  }
}

/** Durable lifecycle for confirmed product briefs and their immutable published specifications. */
export class Handoffs {
  constructor(private readonly store: Store, private readonly effects: Effects, private readonly binding?: ProjectRef,
    private readonly assertNewWork?: () => void, private readonly changed?: (handoff: Handoff) => void) {}

  /** Confirm and persist the original brief once; identical confirmations reuse it without re-enqueuing planning. */
  confirm(input: HandoffInput): { handoff: Handoff; reused: boolean } {
    const authorization = input.authorization.release === 'authorized'
      ? { scope: input.authorization.scope.trim(), release: input.authorization.release,
        ...(input.authorization.releaseTarget ? { releaseTarget: { environment: input.authorization.releaseTarget.environment,
          target: input.authorization.releaseTarget.target, scope: input.authorization.releaseTarget.scope } } : {}) }
      : { scope: input.authorization.scope.trim(), release: input.authorization.release }
    const brief = { goal: input.goal.trim(),
      constraints: input.constraints.map(item => item.trim()), acceptanceScope: input.acceptanceScope.map(item => item.trim()), authorization }
    const idFor = ({ id, repository, workspace }: ProjectRef) => key('handoff', id, JSON.stringify({ project: { repository, workspace }, ...brief }))
    const repository = input.project.repository.trim()
    const workspace = resolve(input.project.workspace.trim())
    const { sessionId, messageId, text } = input.confirmedBy
    if (!sessionId?.trim() || !messageId?.trim() || !text?.trim()) throw new Error('A direct user confirmation requires a session, message, and text')
    const receiptKey = KV.handoffs.confirmationReceipt(sessionId, messageId)
    return this.store.atomic(() => {
      const receipt = this.store.get(receiptKey)
      if (receipt) {
        const prior = this.get(receipt.handoffId)
        if (!prior) throw new Error(`Confirmation receipt references unavailable handoff ${receipt.handoffId}`)
        const exact = repository === prior.project.repository && workspace === prior.project.workspace
        if (idFor(prior.project) !== prior.id || (!exact && !matchesBinding(input.project, prior.project))) {
          throw new Error('This user message already confirmed a different product brief')
        }
        return { handoff: prior, reused: true }
      }
      this.assertNewWork?.()
      let project: ProjectRef
      if (this.binding) {
        if (!matchesBinding(input.project, this.binding)) throw new Error('Approved repository or workspace does not match the bound project')
        const { id, repository, workspace } = this.binding
        project = { id, repository, workspace }
      } else {
        project = { id: key('handoff-project', repository, workspace), repository, workspace }
      }
      const projectId = project.id
      const handoffId = idFor(project)
      const prior = this.store.get(KV.handoffs.record(handoffId))
      if (prior) {
        this.store.set(receiptKey, { handoffId })
        return { handoff: prior, reused: true }
      }
      const currentId = this.store.get(KV.handoffs.current(projectId))
      const current = currentId ? this.store.get(KV.handoffs.record(currentId)) : undefined
      if (current && current.status !== 'specified') throw new Error(`Project already has active handoff ${current.id}`)
      const handoff: Handoff = { id: handoffId, project, goal: brief.goal, constraints: brief.constraints,
        acceptanceScope: brief.acceptanceScope, authorization: brief.authorization, confirmedBy: { sessionId, messageId, text }, status: 'confirmed' }
      this.store.set(receiptKey, { handoffId })
      this.store.set(KV.handoffs.project(projectId), project)
      this.store.set(KV.handoffs.record(handoffId), handoff)
      this.store.set(KV.handoffs.current(projectId), handoffId)
      this.effects.enqueue('planning', handoffId, { handoffId })
      this.changed?.(handoff)
      return { handoff, reused: false }
    })
  }

  get(id: string): Handoff | undefined { return this.store.get(KV.handoffs.record(id)) }

  /** The project's canonical head, not a guessed latest record from history. */
  current(projectId: string): Handoff | undefined {
    const id = this.store.get(KV.handoffs.current(projectId))
    const handoff = id && this.get(id)
    return handoff && handoff.project.id === projectId ? handoff : undefined
  }

  /** Only a persisted planning record authorizes planner operations; malformed/missing state fails closed. */
  isPlanning(id: string): boolean {
    try { return this.get(id)?.status === 'planning' } catch { return false }
  }

  /** Begin planning before the planner Session is ensured; repeated calls do not overwrite waiting or specified records. */
  begin(id: string): Handoff {
    return this.store.atomic(() => {
      const handoff = this.require(id)
      if (handoff.status === 'confirmed') {
        const planning: Handoff = { ...handoff, status: 'planning' }
        this.store.set(KV.handoffs.record(id), planning)
        return planning
      }
      return handoff
    })
  }

  /** Save the sole product-intent question and stop planning until its answer arrives. */
  question(id: string, input: { text: string; why: string; affectedAcceptance: string[] }): Handoff {
    return this.store.atomic(() => {
      const handoff = this.require(id)
      if (handoff.status !== 'planning') throw new Error(`Handoff ${id} is not planning`)
      if (handoff.question) throw new Error(`Handoff ${id} already has its product-intent question`)
      if (!input.text.trim() || !input.why.trim() || input.affectedAcceptance.length === 0 ||
          input.affectedAcceptance.some(item => !handoff.acceptanceScope.includes(item))) {
        throw new Error('A product-intent question must be explicit and identify affected acceptance scope')
      }
      const question: HandoffQuestion = { id: key(id, 'question'), text: input.text.trim(), why: input.why.trim(),
        affectedAcceptance: [...input.affectedAcceptance], status: 'awaiting' }
      const awaiting: Handoff = { ...handoff, question, status: 'awaiting' }
      this.store.set(KV.handoffs.record(id), awaiting)
      this.effects.enqueue('relay', `handoff:${id}:question:${question.id}`, {
        text: this.relay(handoff, 'product clarification',
          `${question.text}\nWhy: ${question.why}\nAffected acceptance: ${question.affectedAcceptance.join('; ')}`,
          'orchestrator_handoff_answer'),
      })
      this.changed?.(awaiting)
      return awaiting
    })
  }

  /** Record a single user answer; an identical retry is idempotent and a conflicting answer is rejected. */
  answer(id: string, questionId: string, answer: string, answeredBy?: HandoffQuestion['answeredBy']): Handoff {
    return this.store.atomic(() => {
      const handoff = this.require(id), question = handoff.question
      if (!question || question.id !== questionId) throw new Error(`Unknown question ${questionId} for handoff ${id}`)
      if (question.status === 'answered') {
        if (question.answer !== answer) throw new Error(`Question ${questionId} already has a different answer`)
        return handoff
      }
      if (handoff.status !== 'awaiting') throw new Error(`Handoff ${id} is not awaiting an answer`)
      const resumed: Handoff = { ...handoff, status: 'planning', question: { ...question, status: 'answered', answer,
        ...(answeredBy ? { answeredBy } : {}) } }
      this.store.set(KV.handoffs.record(id), resumed)
      this.effects.enqueue('planning', id, { handoffId: id })
      this.changed?.(resumed)
      return resumed
    })
  }

  /** Publish a complete immutable three-block specification exactly once. */
  publish(id: string, input: SpecInput): Handoff {
    return this.store.atomic(() => {
      const handoff = this.require(id)
      if (handoff.status !== 'planning') throw new Error(`Handoff ${id} is not planning`)
      if (!input.body.trim() || input.acceptance.length === 0 || input.acceptance.some(item => !item.statement.trim() || !item.observable.trim() ||
          !PLAN_FEATURE_KINDS.includes(item.delivery)) ||
          input.testInterfaces.length === 0 || input.testInterfaces.some(item => !item.seam.trim() || !item.note.trim() ||
            (item.kind !== 'existing' && item.kind !== 'proposed')) ||
          input.outOfScope.some(item => !item.trim())) {
        throw new Error('A specification requires complete body, acceptance, and test-interface blocks')
      }
      const spec: Spec = { id: key(id, 'spec', '1'), handoffId: id, revision: 1, body: input.body, acceptance: input.acceptance.map(item => ({ ...item })),
        testInterfaces: input.testInterfaces.map(item => ({ ...item })), outOfScope: [...input.outOfScope] }
      const specified: Handoff = { ...handoff, status: 'specified', spec }
      this.store.set(KV.handoffs.spec(id), spec)
      this.store.set(KV.handoffs.record(id), specified)
      this.effects.enqueue('relay', `handoff:${id}:spec`, {
        text: this.relay(handoff, 'published specification', `Goal: ${handoff.goal}`, `spec/${id} (revision ${spec.revision})`),
      })
      this.effects.enqueue('splitting', id, { handoffId: id, specId: spec.id })
      this.changed?.(specified)
      return specified
    })
  }

  spec(id: string): Spec | undefined { return this.store.get(KV.handoffs.spec(id)) }

  /** Full records remain queryable after a later handoff becomes current for the same project. */
  list(): Handoff[] {
    return this.store.keys(KV.handoffs.record.prefix).map(name => this.store.get(KV.handoffs.record(name.slice(KV.handoffs.record.prefix.length))))
      .filter((handoff): handoff is Handoff => handoff !== undefined)
  }

  private relay(handoff: Handoff, kind: 'product clarification' | 'published specification', content: string, resource: string): string {
    const values = { project: `${handoff.project.repository} (${handoff.project.workspace})`, kind, content, resource, handoffId: handoff.id }
    return relayTemplate.replace(/\{(project|kind|content|resource|handoffId)\}/g, (_, name: keyof typeof values) => values[name])
  }

  private require(id: string): Handoff {
    const handoff = this.get(id)
    if (!handoff) throw new Error(`Unknown handoff ${id}`)
    return handoff
  }
}
