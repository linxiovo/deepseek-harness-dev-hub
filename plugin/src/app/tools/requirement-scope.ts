/** Sealed host tasks, native model-call evidence and the requirement scope review tool. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key } from '../../core/ids.ts'
import { messageId } from '../delivery.ts'
import { RequirementScopeVerdictSchema, type RequirementScopeTask, type ScopeVerdict } from '../plan-requirements.ts'
import { promptFile } from '../skill-files.ts'

const prefix = 'requirement-scope-'
export const scopeSessionId = (proposal: string) => `${prefix}${proposal}`
export const scopeProposalId = (session: string) => session.startsWith(prefix) ? session.slice(prefix.length) : undefined
export const scopeToolName = 'orchestrator_plan_scope_review'
const description = promptFile('plan-requirement-scope-tool')

type Request = { id: string; text: string; tools: readonly string[]; resume?: true; systemPrompt?: string }
export function scopeRequest(task: RequirementScopeTask): Request {
  return { id: `requirement-scope:${task.input.proposalId}:task`, text: JSON.stringify(task.input), tools: [scopeToolName], resume: true }
}
export function matchesTaskMessage(message: UserMessage, request: Pick<Request, 'id' | 'text'>): boolean {
  return message.id === messageId(key(request.id)) && message.role === 'user'
    && message.source.kind === 'dsh-superagent' && message.source.form === 'relay'
    && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === request.text
}

/** Only the sealed task (and, for resumable reviewers, a host wake for its interrupted turn) may enter the Session. */
export function sealedHistory(agent: Agent, request: Request) {
  let taskSeq: number | undefined, wake: Pick<Request, 'id' | 'text'> | undefined, ended: string | undefined
  let inserted = false
  const results = request.systemPrompt ? new Map<string, { turn: number; step: number }>() : undefined
  const events = agent.session.snapshotEvents()
  const reject = (): never => { throw new Error('The Session has conflicting native task history') }
  for (const event of events) {
    if (typeof event.surfaceOp === 'object' || event.type === 'developer/message') reject()
    if (results) {
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) {
          if (inserted || !matchesTaskMessage(message, request)) reject()
          inserted = true
        }
      } else if (event.type === 'tool/call') {
        results.set(event.data.callId, event.data)
      } else if (event.type === 'tool/result') {
        const { message, turn, step } = event.data, call = results.get(message.toolCallId)
        if (!call || call.turn !== turn || call.step !== step || message.source.kind !== 'tool' || message.source.callId !== message.toolCallId) reject()
        results.delete(message.toolCallId)
      } else if (event.type === 'request/header' && event.data.header.tools?.some(tool => !request.tools.includes(tool.name))) reject()
    }
    if (request.systemPrompt && event.type === 'system/message') {
      const message = event.data.message
      if (message.role !== 'system' || message.source.kind !== 'system-prompt' || message.content.length !== 1 ||
        message.content[0]?.type !== 'text' || message.content[0].text !== request.systemPrompt) reject()
    }
    if (event.type === 'user/message') {
      if (taskSeq === undefined && matchesTaskMessage(event.data, request)) taskSeq = event.seq
      else if (wake && matchesTaskMessage(event.data, wake)) wake = undefined
      else reject()
    } else if (event.type === 'turn/end' && taskSeq !== undefined) {
      const { kind } = event.data.reason
      ended = kind
      wake = request.resume && (kind === 'interrupted' || kind === 'aborted')
        ? { id: `${request.id}:resume:${event.seq}`, text: JSON.stringify({ resume: request.id }) } : undefined
    } else if (event.type === 'tool/call' && (taskSeq === undefined || !request.tools.includes(event.data.name))
      || (event.type === 'assistant/message' || event.type === 'assistant/attempt') && taskSeq === undefined
      || (event.type as string) === 'working-directory/change') reject()
  }
  // A claimed inbox item can still be visible while its turn is being committed. It is not a second history event.
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  if (pending.length > 1 || pending.some(message => !matchesTaskMessage(message, request) && !(wake && matchesTaskMessage(message, wake)))) reject()
  return { taskSeq, pending: pending[0], wake, ended, inserted, events }
}

export function requireNativeCall(agent: Agent, request: Request, name: string, args: unknown, exec: ToolRunContext): void {
  const { events, taskSeq, ended } = sealedHistory(agent, request)
  if (taskSeq === undefined || (!request.resume && ended !== undefined) || exec.agent !== agent || !exec.callId || exec.rootCallId !== exec.callId || exec.parent !== undefined) {
    throw new Error('Only an open native model call from the assigned Session is authorized')
  }
  const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === exec.callId)
  const call = calls[0]
  if (calls.length !== 1 || call?.type !== 'tool/call' || call.seq <= taskSeq || call.data.name !== name
    || !isDeepStrictEqual(JSON.parse(call.data.arguments), args) || events.some(event =>
      event.type === 'tool/call' && event.data.turn === call.data.turn && event.data.step === call.data.step && event.data.callId !== exec.callId
      || event.seq > call.seq && (event.type === 'tool/result' && event.data.message.toolCallId === exec.callId || event.type === 'turn/end' || event.type === 'step/end'))) {
    throw new Error('Tool invocation does not match this Session\'s open native model call')
  }
}

/** Check the native invocation again after checkout verification, immediately before the atomic verdict write. */
export function registerScopeTool(agent: Agent, current: () => RequirementScopeTask, verify: (task: RequirementScopeTask) => Promise<void>,
  record: (verdict: ScopeVerdict) => void): () => void {
  return agent.ctx.tools.register({ name: scopeToolName, description, parameters: z.toJSONSchema(RequirementScopeVerdictSchema),
    output: { schema: { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (raw, exec) => {
      const verdict = RequirementScopeVerdictSchema.parse(raw)
      const check = () => {
        exec.signal.throwIfAborted()
        const task = current()
        requireNativeCall(agent, scopeRequest(task), scopeToolName, verdict, exec)
        return task
      }
      await verify(check())
      check()
      record(verdict)
      exec.concludeTurn()
      return { recorded: true }
    } })
}
