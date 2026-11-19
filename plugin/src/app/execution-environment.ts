/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { ExecutionIdentity, Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { githubEnvironment } from '../sources/github-environment.ts'

/** Variables registered by the Executor; ticket entries require a ticket, and identity entries require pinned preparation facts. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true; identity?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', ticket: true, identity: true, description: { zh: '执行器确认的本地仓库规范绝对路径，不是 GitHub 仓库名', en: 'Canonical absolute path to the executor-selected local repository, not the GitHub repository name' } },
  { key: 'DSH_SUPERAGENT_BASE_REF', ticket: true, identity: true, description: { zh: '创建工单工作树时解析的明确 Git 基准引用', en: 'Explicit Git base ref resolved for this ticket worktree' } },
  { key: 'DSH_SUPERAGENT_BASE_SHA', ticket: true, identity: true, description: { zh: '该基准引用解析出的完整、固定 Git 提交 ID', en: 'Full pinned Git commit ID resolved from the base ref; use this immutable commit for preparation' } },
  { key: 'DSH_SUPERAGENT_BRANCH', ticket: true, identity: true, description: { zh: '此工单唯一的 Git 分支名', en: 'Git branch reserved for this ticket worktree' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

/** Worktree facts are supplied by the executor, never inferred from the Hub or mutable deployment settings. */
export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings;
  ticket?: { id: string; name: string; directory: string; identity?: Pick<ExecutionIdentity, 'repository' | 'base' | 'branch'> }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? {
    DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
    ...ticket.identity ? { DSH_SUPERAGENT_REPOSITORY: ticket.identity.repository, DSH_SUPERAGENT_BASE_REF: ticket.identity.base.ref,
      DSH_SUPERAGENT_BASE_SHA: ticket.identity.base.sha, DSH_SUPERAGENT_BRANCH: ticket.identity.branch } : {},
  } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => (!spec.ticket || !!ticket) && (!spec.identity || !!ticket?.identity))
    .map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  const inputContext = { deployment, ...trigger ? { trigger } : {} }
  const append = (owner: string, variables: readonly VariableSpec[], values: Record<string, string>) => {
    for (const spec of variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner })
  }
  if (deployment.managed) append('github', githubEnvironment.variables, githubEnvironment.values(inputContext))
  for (const { kind, environment, config } of sources.environments(settings)) {
    if (deployment.managed && kind.kind === 'github') continue
    append(kind.kind, environment.variables, environment.values({ ...inputContext, config }))
  }
  return result
}

/** Combines fixed ticket fields with the pinned claim prepared by the executor, if any. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }): Variable[] {
  const { ticket, trigger, ...rest } = input
  const execution = ticket.execution
  const identity = execution?.ownership?.identity ?? (execution?.repository && execution.branch && execution.base
    ? { repository: execution.repository, branch: execution.branch, base: execution.base } : undefined)
  const values = { id: ticket.id, name: execution?.name ?? '', directory: execution?.directory ?? '', ...identity ? { identity } : {} }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
