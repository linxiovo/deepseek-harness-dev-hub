/** Native delivery and model-call evidence for the one tool mounted on a requirement scope reviewer. */
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

type Request = { id: string; text: string }
export function scopeRequest(task: RequirementScopeTask): Request {
  return { id: `requirement-scope:${task.input.proposalId}:task`, text: JSON.stringify(task.input) }
}
function matches(message: UserMessage, request: Request): boolean {
  return message.id === messageId(key(request.id)) && message.role === 'user'
    && message.source.kind === 'dsh-superagent' && message.source.form === 'relay'
    && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === request.text
}

/** Only the sealed task and a host wake for its exact interrupted turn can enter this Session. */
export function scopeHistory(agent: Agent, request: Request) {
  let taskSeq: number | undefined, wake: Request | undefined
  const events = agent.session.snapshotEvents()
  const reject = (): never => { throw new Error('Requirement scope Session has conflicting task history') }
  for (const event of events) {
    if (typeof event.surfaceOp === 'object' || event.type === 'developer/message') reject()
    if (event.type === 'user/message') {
      if (taskSeq === undefined && matches(event.data, request)) taskSeq = event.seq
      else if (wake && matches(event.data, wake)) wake = undefined
      else reject()
    } else if (event.type === 'turn/end' && taskSeq !== undefined) {
      const { kind } = event.data.reason
      wake = kind === 'interrupted' || kind === 'aborted' ? { id: `${request.id}:resume:${event.seq}`, text: JSON.stringify({ resume: request.id }) } : undefined
    } else if (event.type === 'tool/call' && (taskSeq === undefined || event.data.name !== scopeToolName)
      || (event.type === 'assistant/message' || event.type === 'assistant/attempt') && taskSeq === undefined
      || (event.type as string) === 'working-directory/change') reject()
  }
  // A claimed inbox item can still be visible while its turn is being committed. It is not a second history event.
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  if (pending.length > 1 || pending.some(message => !matches(message, request) && !(wake && matches(message, wake)))) reject()
  return { taskSeq, pending: pending[0], wake, events }
}

function modelCall(agent: Agent, request: Request, args: ScopeVerdict, exec: ToolRunContext): void {
  const { events, taskSeq } = scopeHistory(agent, request)
  if (taskSeq === undefined || exec.agent !== agent || !exec.callId || exec.rootCallId !== exec.callId || exec.parent !== undefined) {
    throw new Error('Only a model call from the assigned scope reviewer can submit its judgment')
  }
  const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === exec.callId)
  const call = calls[0]
  if (calls.length !== 1 || call?.type !== 'tool/call' || call.seq <= taskSeq || call.data.name !== scopeToolName
    || !isDeepStrictEqual(JSON.parse(call.data.arguments), args) || events.some(event =>
      event.type === 'tool/call' && event.data.turn === call.data.turn && event.data.step === call.data.step && event.data.callId !== exec.callId
      || event.seq > call.seq && (event.type === 'tool/result' && event.data.message.toolCallId === exec.callId || event.type === 'turn/end' || event.type === 'step/end'))) {
    throw new Error('The scope judgment does not match this Session\'s open native model call')
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
        modelCall(agent, scopeRequest(task), verdict, exec)
        return task
      }
      await verify(check())
      check()
      record(verdict)
      exec.concludeTurn()
      return { recorded: true }
    } })
}
