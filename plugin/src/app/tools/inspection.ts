/** The complete model surface for one sealed inspection: paged Git reads and one evidenced conclusion. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolOutputDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { InspectionPage } from '../../executor/inspection-git.ts'
import type { InspectionFindingInput, InspectionTask } from '../idle-inspection.ts'
import { promptFile } from '../skill-files.ts'
import { requireNativeCall } from './requirement-scope.ts'

export interface InspectionHost {
  task(sessionId: string): InspectionTask | undefined
  read(sessionId: string, path: string, offset: number): Promise<InspectionPage>
  finish(sessionId: string, findings: InspectionFindingInput[], assertNativeCall: () => void): Promise<void>
  abandon(sessionId: string, reason: string): void
}

const readTool = 'orchestrator_inspection_read', finishTool = 'orchestrator_inspection_finish'
export const inspectionTools: readonly string[] = [readTool, finishTool]
const systemPrompt = promptFile('idle-inspection'), readDescription = promptFile('inspection-read-tool'), finishDescription = promptFile('inspection-finish-tool')
const page = z.strictObject({ path: z.string().min(1).max(1024), offset: z.number().int().nonnegative().optional() })
const findings = z.strictObject({ findings: z.array(page.extend({ evidence: z.string().min(1).max(1000).regex(/^[^\r\n]+$/),
  summary: z.string().regex(/\S/).max(500) })).max(32) })
const output: ToolOutputDefinition = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export function inspectionRequest(task: InspectionTask) {
  return { id: `inspection:${task.sessionId}:${task.creationToken}:task`, text: JSON.stringify({ scope: task.scope, commit: task.commit }),
    tools: inspectionTools, systemPrompt }
}

export function registerInspection(agent: Agent, host: InspectionHost, current: () => InspectionTask, disposers: (() => void)[]): void {
  const check = (name: string, args: unknown, exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    requireNativeCall(agent, inspectionRequest(current()), name, args, exec)
  }
  const prompt = agent.ctx.systemPrompt
  disposers.push(agent.ctx.tools.presentAs('native'))
  // A complete section does not suppress runtime user messages. Shadow the mandatory cwd fact as well as optional contexts.
  disposers.push(prompt.section({ name: 'dsh-superagent-inspection', order: 9999, complete: true, interpolate: false, text: systemPrompt }))
  disposers.push(prompt.context({ name: 'working-directory:current', order: 0, text: '' }))
  disposers.push(prompt.suppressRuntimeContext())
  disposers.push(agent.ctx.tools.register({ name: readTool, description: readDescription, parameters: z.toJSONSchema(page), output,
    execute: async (raw, exec) => {
      const args = page.parse(raw)
      check(readTool, args, exec)
      const result = await host.read(agent.id, args.path, args.offset ?? 0)
      check(readTool, args, exec)
      return result
    } }))
  disposers.push(agent.ctx.tools.register({ name: finishTool, description: finishDescription, parameters: z.toJSONSchema(findings), output,
    execute: async (raw, exec) => {
      const args = findings.parse(raw)
      const assertNativeCall = () => check(finishTool, args, exec)
      assertNativeCall()
      await host.finish(agent.id, args.findings.map(({ path, offset = 0, evidence, summary }) => ({ path, offset, evidence, summary })), assertNativeCall)
      exec.concludeTurn()
      return { recorded: true }
    } }))
}
