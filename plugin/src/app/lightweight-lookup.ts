/** A one-turn, tool-free DSH lookup over a bounded snapshot from the mounted project. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type GenerateOptions, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { ticketStage } from '../core/stage.ts'
import { inspectionCommit, readInspectionPath, validInspectionPath } from '../executor/inspection-git.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { RoleModel } from '../policy.ts'
import { messageId } from './delivery.ts'
import { matchesNativeRoot, openNativeRoot } from './hub-session-root.ts'
import type { ModelAdmission } from './model-admission.ts'
import type { MeterSessionBinding, ProjectMeter } from './project-meter.ts'
import type { Project } from './projects.ts'
import { initializeRoleModel } from './role-models.ts'
import type { RunLimits } from './run-limits.ts'
import { promptFile } from './skill-files.ts'
import type { Store } from './store.ts'
import { matchesTaskMessage, sealedHistory } from './tools/requirement-scope.ts'

export const LOOKUP_PRESET = 'dsh-superagent-lookup'
export const isLookupId = (id: string) => id.startsWith('lookup-')
const systemPrompt = promptFile('lightweight-lookup'), denied = promptFile('lightweight-lookup-denied')
const path = z.string().min(1).max(1024).refine(validInspectionPath, 'Expected an exact repository-relative path')
const query = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const offset = z.number().int().nonnegative().default(0)
export const LookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('code'), path, query, offset }),
  z.strictObject({ kind: z.literal('doc-route'), path: path.refine(p => /\.md$/i.test(p), 'Expected a Markdown route').default('DOCS.md'), query, offset }),
  z.strictObject({ kind: z.literal('status') }),
])
type Lookup = z.infer<typeof LookupSchema>
interface Host {
  ctx: Context; project: Project; store: Pick<Store, 'settings' | 'tickets' | 'get' | 'set' | 'atomic'>; commands: Commands
  meter: Pick<ProjectMeter, 'bind'>; limits: Pick<RunLimits, 'acquire'>; lifetime: AbortSignal
  currentHub(id: string): boolean
  assertCurrent(): void
}
interface Active {
  hubId: string; agent: Agent; request: Parameters<typeof sealedHistory>[1]; model: RoleModel | null; check(): void
  route?: { provider: string; model: string }
}

/** Check the actual outgoing context as well as the log: another host extension can contribute at request assembly. */
function sealedInput(options: GenerateOptions, text: string): boolean {
  const { messages, toolHistory } = options, first = messages[0], last = messages.at(-1)
  const plain = (message: typeof first, expected: string) => message?.content.length === 1 &&
    message.content[0]?.type === 'text' && message.content[0].text === expected
  return !options.purpose && !options.system && !options.tools?.length && !toolHistory?.tools.length && !toolHistory?.updates.length &&
    (messages.length === 1 || messages.length === 2 && first?.role === 'system' && plain(first, systemPrompt)) &&
    last?.role === 'user' && plain(last, text)
}

/** The meter binding survives a restart; only a live Hub invocation can wake its own fresh, sealed native root. */
export class LightweightLookup {
  private readonly active = new Map<string, Active>()

  constructor(private readonly host: Host) {
    const protect = (agent: Agent) => {
      if (!isLookupId(agent.id)) return
      agent.ctx.tools.restrict({ allow: [] }); agent.ctx.tools.guard(() => denied); agent.ctx.tools.presentAs('native')
    }
    for (const agent of host.ctx.agents.list()) protect(agent)
    host.ctx.on('agent/created', ({ agent }) => { protect(agent) })
    host.ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (!isLookupId(agent.id)) return next()
      const allowed = (offered: readonly UserMessage[]) => {
        const task = this.active.get(agent.id)
        try {
          if (!task || task.agent !== agent || task.route || offered.length !== 1 || !matchesTaskMessage(offered[0]!, task.request)) return false
          task.check()
          return sealedHistory(agent, task.request).taskSeq === undefined
        } catch { return false }
      }
      if (!allowed(messages)) return { kind: 'reject' }
      const decision = await next()
      return decision.kind === 'enter' && !allowed(decision.messages) ? { kind: 'reject' } : decision
    })
  }

  /** Called only for a verified agent-loop stream. A wait is not consumption; an admitted provider attempt is. */
  acquire(binding: MeterSessionBinding, maximum: number | null, signal: AbortSignal | undefined, options: GenerateOptions): ModelAdmission {
    const task = this.active.get(binding.session_id), refusal = { admitted: false as const, reason: 'Lookup has no authorized model request' }
    if (!task || task.route || task.agent.status !== 'running' || task.hubId !== binding.parent_session_id || binding.roles.length !== 1 ||
      binding.roles[0] !== 'lookup' || binding.ticket_id !== null || binding.plan_id !== null ||
      this.host.store.get(KV.lookup.native(binding.session_id)) !== task.agent.session.header.createdAt) return refusal
    const route = task.agent.session.requestContext()
    if (!route || route.provider !== options.provider || route.model !== options.model || !sealedInput(options, task.request.text)) return refusal
    try {
      task.check()
      const { taskSeq, ended, events } = sealedHistory(task.agent, task.request)
      const selections = events.filter(e => e.type === 'model/selection'), selected = selections[0]?.data
      if (taskSeq === undefined || ended !== undefined || events.some(e => e.type === 'assistant/message' || e.type === 'assistant/attempt') ||
        (task.model ? selections.length !== 1 || selected?.provider !== route.provider || selected.model !== route.model ||
          (selected.reasoningEffort !== undefined && selected.reasoningEffort !== options.reasoningEffort) : selections.length !== 0)) return refusal
    } catch { return refusal }
    const reservation = this.host.limits.acquire(binding, maximum, signal)
    if (reservation.admitted) task.route = { provider: route.provider, model: route.model }
    return reservation
  }

  /** Scope comes exclusively from this mount, never a workspace, commit, project or resource supplied by a caller. */
  private async snapshot(input: Lookup, check: () => void) {
    const { project, commands, store } = this.host, projectId = project.id
    if (input.kind === 'status') {
      const stages = { working: 0, idle: 0, person: 0, ended: 0 }, tickets = store.tickets.open()
      for (const ticket of tickets) stages[ticketStage(ticket).stage]++
      return { source: { projectId, sampledAt: new Date().toISOString() }, facts: { openTickets: tickets.length, stages } }
    }
    const base = store.settings().executor.baseRef
    if (!base) throw new Error('Lookup requires a configured project base reference')
    const commit = await inspectionCommit(commands, project, base, input.path)
    check()
    const page = await readInspectionPath(commands, project, commit, input.path, input.path, input.offset)
    check()
    if (input.kind === 'doc-route' && page.kind !== 'file') throw new Error('Doc Tree routes must be Markdown files')
    return { source: { projectId, commit, path: page.path, offset: input.offset, nextOffset: page.nextOffset }, facts: page }
  }

  async run(hub: Agent, input: Lookup, caller: AbortSignal, callId?: string) {
    const { ctx, lifetime, store, project } = this.host, signal = AbortSignal.any([lifetime, caller])
    const checkHub = () => {
      signal.throwIfAborted()
      const { header, inheritedEventCount } = hub.session
      if (ctx.agents.get(hub.id) !== hub || !this.host.currentHub(hub.id) || header.id !== hub.id ||
        inheritedEventCount !== 0 || header.isSeeded || header.parentSession !== undefined || header.origin !== undefined) {
        throw new Error('Lookup requires the current project Hub root')
      }
      this.host.assertCurrent()
    }
    checkHub()
    const call = callId && hub.session.snapshotEvents(hub.session.inheritedEventCount).findLast(e => e.type === 'tool/call' && e.data.callId === callId)
    if (!call || call.type !== 'tool/call' || call.data.name !== 'orchestrator_lookup' ||
      !isDeepStrictEqual(LookupSchema.parse(JSON.parse(call.data.arguments)), input)) throw new Error('Lookup requires its native Hub tool call')
    const current = () => {
      checkHub()
      if (hub.session.snapshotEvents(SessionLogOffset(call.seq + 1)).some(e => e.type === 'turn/end' || e.type === 'step/end' ||
        e.type === 'tool/result' && e.data.message.toolCallId === call.data.callId)) throw new Error('The Hub lookup call has ended')
    }
    // A re-entry of the same physical call addresses the same root, but can never adopt its creation token.
    const id = SessionId(`lookup-${key(project.id, hub.id, String(hub.session.header.createdAt), String(call.data.turn), String(call.data.step), call.data.callId)}`)
    if (store.get(KV.lookup.native(id)) !== undefined) throw new Error('This Hub lookup call was already consumed')
    current()
    const { source, facts } = await this.snapshot(input, current)
    current()
    const text = JSON.stringify({ kind: input.kind, ...input.kind !== 'status' && { query: input.query }, source, facts })
    if (text.length > 32_000) throw new Error('Lookup page exceeds the bounded model input')
    const cwd = join(project.stateDir, 'lookup-sessions')
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    if (relative(cwd, realpathSync.native(cwd)) !== '') throw new Error('Lookup requires a physical private Session directory')
    const creation = { token: randomUUID(), cwd, marker: 'dsh-superagent/lookup-root' as const }
    const request = { id: `lookup:${id}:task`, text, tools: [], systemPrompt }
    const agent = await openNativeRoot(ctx, id, creation, LOOKUP_PRESET, true, current)
    current()
    const model = store.settings().executor.lightweightModel ?? null
    const check = () => {
      current()
      if (!matchesNativeRoot(ctx, agent, creation, LOOKUP_PRESET) || !isDeepStrictEqual(model, store.settings().executor.lightweightModel ?? null)) {
        throw new Error('Lookup Session or authorized model changed')
      }
    }
    const fresh = sealedHistory(agent, request)
    if (fresh.taskSeq !== undefined || fresh.inserted || fresh.pending || agent.status !== 'idle' || agent.session.requestHeader() ||
      fresh.events.some(e => e.type === 'model/selection')) throw new Error('Lookup requires a fresh native Session')
    const prompt = agent.ctx.systemPrompt
    prompt.section({ name: 'dsh-superagent-lookup', order: 9999, complete: true, interpolate: false, text: systemPrompt })
    prompt.context({ name: 'working-directory:current', order: 0, text: '' }); prompt.suppressRuntimeContext()
    await initializeRoleModel(ctx, agent, model)
    check()
    store.atomic(() => {
      this.host.meter.bind({ session_id: id, parent_session_id: hub.id, role: 'lookup' })
      store.set(KV.lookup.native(id), agent.session.header.createdAt)
    })
    const task: Active = { hubId: hub.id, agent, request, model, check }
    this.active.set(id, task)
    const stop = addAbortListener(signal, () => agent.cancel({ kind: 'user' }))
    try {
      agent.followup(freezeMessage({ role: 'user', id: messageId(key(request.id)), source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      check()
      const { events, ended } = sealedHistory(agent, request)
      const answers = events.filter(e => e.type === 'assistant/message'), answer = answers[0]?.data
      if (!task.route || ended !== 'completed' || answers.length !== 1 || !answer || answer.interrupted || answer.message.source.kind !== 'model' ||
        task.route.provider !== answer.message.source.provider || task.route.model !== answer.message.source.model) throw new Error(`Lookup did not complete (${ended ?? 'interrupted'})`)
      const summary = answer.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
      if (!summary || summary.length > 2_000) throw new Error('Lookup returned no bounded text summary')
      return { advisory: true, sessionId: id, model: task.route, source, summary }
    } finally {
      this.active.delete(id); stop[Symbol.dispose]()
    }
  }
}
