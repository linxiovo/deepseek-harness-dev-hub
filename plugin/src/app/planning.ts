/** Durable delivery of confirmed handoffs and published specs to their dedicated Sessions. */
import type { Handoff } from '../core/handoff.ts'
import { PLAN_FEATURE_KINDS } from '../core/plan.ts'
import { Later, Park, type EffectPayloads, type Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import type { Plans } from './plans.ts'
import { splitterSessionId, type Sessions } from './sessions.ts'
import { promptFile } from './skill-files.ts'

interface PlanningHost {
  readonly handoffs: Pick<Handoffs, 'get' | 'list' | 'begin' | 'isPlanning'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'wakeParked'>
  readonly plans: Pick<Plans, 'get'>
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'holds'>
  paused(): boolean
  closing(): boolean
}

/** Pass the complete confirmed brief, not a summary that could lose the requester's constraints or authorization. */
function brief(handoff: Handoff) {
  const { id, project, goal, constraints, acceptanceScope, authorization, confirmedBy } = handoff
  return { handoff_id: id, project, goal, constraints, acceptanceScope, authorization, confirmedBy }
}

const sessionId = (id: string): string => `planner-${id}`
const taskPrompt = promptFile('planner-task')
const resumePrompt = promptFile('planner-resume')
const splitterTask = promptFile('splitter-task')
const splitterResume = promptFile('splitter-resume')

/** A Session can disappear between ensure and delivery; retry the persisted intent instead of losing it. */
function deferSessionUnavailable(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'session/not-found' || code === 'session/unavailable' || code === 'session/disposed'
    || /session (?:is )?(?:unavailable|disposed|not found)|delivery target was disposed/i.test(String(error))) throw new Later(String(error))
  throw error
}

/** Delivers planner and splitter turns from persisted state under stable Session and message IDs. */
export class Planning {
  /** A transient flush failure must retry the selected pass, not turn it into a new continuation. */
  private readonly selectedSplits = new Set<string>()

  constructor(private readonly host: PlanningHost) {
    host.effects.handle('planning', ({ handoffId }, key) => this.deliver(handoffId, key))
    host.effects.handle('splitting', (payload, key) => this.deliverSplit(payload, key))
  }

  /** Reconcile incomplete handoffs before the queue starts; awaiting and registered work does not wake a Session. */
  resume(): void {
    for (const handoff of this.host.handoffs.list()) {
      if (handoff.status === 'confirmed' || handoff.status === 'planning') {
        this.host.effects.enqueue('planning', handoff.id, { handoffId: handoff.id })
      }
    }
    this.host.effects.wakeParked('splitting')
  }

  private active(id: string): boolean {
    if (this.host.closing()) throw new Later('Planning is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    return this.host.handoffs.isPlanning(id)
  }

  private async deliver(id: string, key: string): Promise<void> {
    if (id !== key) throw new Error('Planning effect does not match its handoff')
    if (this.host.closing()) throw new Later('Planning is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    const current = this.host.handoffs.get(id)
    if (!current || current.status === 'awaiting' || current.status === 'specified') return
    if (current.status === 'confirmed') this.host.handoffs.begin(id)
    if (!this.active(id)) return
    const handoff = this.host.handoffs.get(id)
    if (!handoff) return
    const planner = sessionId(id)
    try {
      await this.host.sessions.ensure(planner, handoff.project.workspace, `Specification: ${handoff.goal.slice(0, 72)}`, 'planner')
      if (!this.active(id)) return
      await this.host.sessions.prompt(planner, `handoff:${id}:task`, JSON.stringify({ ...brief(handoff), task: taskPrompt }),
        'queue', () => { if (!this.active(id)) throw new Later('Planning state changed before delivery') })
      if (!this.active(id)) return
      const question = this.host.handoffs.get(id)?.question
      if (question?.status === 'answered') {
        if (typeof question.answer !== 'string') throw new Error('Answered planning question has no answer')
        await this.host.sessions.prompt(planner, `handoff:${id}:answer:${question.id}`, JSON.stringify({ ...brief(handoff),
          question: { id: question.id, text: question.text, why: question.why, affectedAcceptance: question.affectedAcceptance },
          answer: question.answer, task: resumePrompt }),
        'queue', () => { if (!this.active(id)) throw new Later('Planning state changed before answer delivery') })
      }
    } catch (error) {
      deferSessionUnavailable(error)
    }
  }

  private async deliverSplit({ handoffId: id, specId, pass = 0 }: EffectPayloads['splitting'], key: string): Promise<void | typeof Park> {
    if (id !== key || !Number.isSafeInteger(pass) || pass < 0) throw new Error('Invalid splitting intent')
    const pending = (): Handoff | undefined => {
      if (this.host.closing()) throw new Later('Splitting is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const handoff = this.host.handoffs.get(id)
      if (handoff?.id !== id || handoff.status !== 'specified' || handoff.spec?.id !== specId || handoff.spec.handoffId !== id) return
      if (handoff.spec.acceptance.some(({ delivery }) => delivery === undefined || !PLAN_FEATURE_KINDS.includes(delivery))) return
      return this.host.plans.get(id) ? undefined : handoff
    }
    const handoff = pending()
    if (!handoff) return
    const session = splitterSessionId(id)
    try {
      const agent = await this.host.sessions.ensure(session, handoff.project.workspace, `Plan: ${handoff.goal.slice(0, 72)}`, 'splitter')
      if (!pending()) return
      const base = `handoff:${id}:plan:${specId}`, request = pass === 0 ? base : `${base}:resume:${pass}`
      if (!this.selectedSplits.has(id)) {
        const held = await this.host.sessions.holds(session, request)
        if (!pending()) return
        if (held) {
          // A live turn already owns the pass. Otherwise wake the idle splitter from history or its parked inbox.
          if (agent.status !== 'idle') return Park
          // Persist the next ID before sending it. Effects will not delete the new generation when this handler returns.
          this.host.effects.enqueue('splitting', id, { handoffId: id, specId, pass: pass + 1 })
          this.selectedSplits.add(id)
          return
        }
        this.selectedSplits.add(id)
      }
      await this.host.sessions.prompt(session, request, JSON.stringify({
        handoff_id: id, spec_id: specId, handoff: `handoff/${id}`, spec: `spec/${id}`, task: pass === 0 ? splitterTask : splitterResume,
      }), pass === 0 ? 'queue' : 'steer', () => { if (!pending()) throw new Later('Splitting state changed before delivery') })
      return Park
    } catch (error) {
      deferSessionUnavailable(error)
    }
  }
}
