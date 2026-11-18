/** Splitter Session tools, scoped to one published specification and its handoff. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Handoffs } from '../handoffs.ts'
import { PlanDraftSchema, type Plans } from '../plans.ts'
import { splitterHandoffId, type Sessions } from '../sessions.ts'
import { tool, type Tool } from './tool.ts'

export interface SplitterToolsHost {
  readonly handoffs: Pick<Handoffs, 'get'>
  readonly plans: Pick<Plans, 'register'>
  readonly sessions: Pick<Sessions, 'isSplitterSession'>
  readonly lifetime: AbortSignal
}

export function splitterTools(host: SplitterToolsHost, agent: Agent): Tool[] {
  const handoffId = splitterHandoffId(agent.id)
  if (!handoffId) throw new Error('Splitter tools require a splitter-<handoffId> Session')
  const scope = () => {
    host.lifetime.throwIfAborted()
    if (!host.sessions.isSplitterSession(agent)) throw new Error('Only the scoped splitter Session may use this tool')
    const handoff = host.handoffs.get(handoffId), spec = handoff?.spec
    if (handoff?.status !== 'specified' || !spec || spec.handoffId !== handoffId) {
      throw new Error('Splitter Session requires its persisted published specification')
    }
    return { handoff, spec }
  }
  const handoffPath = `handoff/${handoffId}`, specPath = `spec/${handoffId}`
  return [
    tool({
      name: 'orchestrator_read',
      description: 'Read only this splitter Session’s persisted handoff or immutable specification, with numbered acceptance criteria.',
      schema: z.strictObject({ resource: z.enum([handoffPath, specPath]) }),
      execute: async ({ resource }, signal) => {
        signal.throwIfAborted()
        const { handoff, spec } = scope()
        if (resource === handoffPath) return handoff
        if (resource === specPath) return { ...spec, acceptance: spec.acceptance.map((item, index) => ({ ...item, number: index + 1 })) }
        throw new Error('Resource is outside this splitter Session’s handoff scope')
      },
    }),
    tool({
      name: 'orchestrator_plan_register',
      description: 'Register an immutable Plan DAG for this handoff’s published specification. Acceptance references are one-based numbers from the spec. Registration does not start workers.',
      schema: z.strictObject({ handoffId: z.literal(handoffId), specId: z.string().min(1), ...PlanDraftSchema.shape }),
      execute: async ({ handoffId: id, specId, ...draft }, signal) => {
        signal.throwIfAborted()
        const { spec } = scope()
        if (id !== handoffId) throw new Error('Handoff is outside this splitter Session’s scope')
        if (specId !== spec.id) throw new Error('Spec ID does not match this splitter Session’s published specification')
        const plan = host.plans.register(id, specId, draft)
        return { handoffId: id, specId, plan: `plan/${plan.id}`, status: 'registered' }
      },
    }),
  ]
}
