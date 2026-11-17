/** Durable delivery of a confirmed handoff to its project-scoped planner Session. */
import type { Handoff } from '../core/handoff.ts'
import { Later, type Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import type { Sessions } from './sessions.ts'
import { promptFile } from './skill-files.ts'

interface PlanningHost {
  readonly handoffs: Pick<Handoffs, 'get' | 'list' | 'begin' | 'isPlanning'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt'>
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

/** Starts and resumes planner turns from the same persisted handoff and session; all deliveries have stable history IDs. */
export class Planning {
  constructor(private readonly host: PlanningHost) {
    host.effects.handle('planning', ({ handoffId }, key) => this.deliver(handoffId, key))
  }

  /** Reconcile state before the effect loop starts: crash recovery never wakes awaiting or specified handoffs. */
  resume(): void {
    for (const handoff of this.host.handoffs.list()) {
      if (handoff.status === 'confirmed' || handoff.status === 'planning') {
        this.host.effects.enqueue('planning', handoff.id, { handoffId: handoff.id })
      }
    }
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
      // A session can be deleted, disposed or temporarily unavailable between ensure and delivery; let Effects retry without treating it as a failed handoff.
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string' && (code === 'session/not-found' || code === 'session/unavailable' || code === 'session/disposed')
        || /session (?:is )?(?:unavailable|disposed|not found)/i.test(String(error))) throw new Later(String(error))
      throw error
    }
  }
}
