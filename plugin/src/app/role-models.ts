/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

const initialSelections = new WeakMap<Agent, Promise<void>>()

/** Seed a Session's initial model, or reapply a native selection recorded before its first request. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null | (() => RoleModel | null),
  authorize?: () => void): Promise<void> {
  authorize?.()
  const { session } = agent
  if (session.requestHeader()) return
  const initialized = initialSelections.get(agent)
  if (initialized) return initialized
  let selected = session.snapshotEvents().findLast(event => event.type === 'model/selection')
  if (!selected) {
    const configured = typeof model === 'function' ? model() : model
    if (!configured) return
    const resolved = await resolveRoleModel(ctx, configured)
    authorize?.()
    if (session.requestHeader()) return
    const concurrent = initialSelections.get(agent)
    if (concurrent) return concurrent
    // Native selectModel also changes DSH's global default. Only write the Session-local event.
    selected = session.snapshotEvents().findLast(event => event.type === 'model/selection') ?? session.append('model/selection', resolved)
  }
  const { provider, model: name, reasoningEffort } = selected.data
  const initial: ModelSelection = { provider, model: name,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }
  const start = SessionLogOffset(selected.seq + 1)
  let assembled: ModelSelection | undefined
  const dispose = agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = session.requestHeader() || session.snapshotEvents(start).some(event => event.type === 'model/selection')
          ? undefined : initial
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  const ready = ctx.sessionPersistence.flush().catch(async (error: unknown) => {
    await dispose()
    initialSelections.delete(agent)
    throw error
  })
  initialSelections.set(agent, ready)
  await ready
}
