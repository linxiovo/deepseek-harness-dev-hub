/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { PlanVerificationConfig } from './core/plan-integration.ts'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) =>
  s.string().pattern(process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/])/ : /^\//).description(`${description} Absolute path.`)
export const credentialIdPattern = /^[a-z][a-z0-9-]{0,63}$/
const CredentialCheckConfig: s<Partial<CredentialCheck>, CredentialCheck> = s.object({
  projectId: s.string().pattern(/^[a-f0-9]{32}$/).required(),
  id: s.string().pattern(credentialIdPattern).required(),
  executable: absolute('Trusted test-account verifier executable.').required(),
  args: s.array(s.string()).default([]),
  providerUrl: s.string().description('Optional HTTPS configuration page, without embedded credentials, query or fragment.'),
})
type PlanVerificationConfigInput = Omit<PlanVerificationConfig, 'jobs'> & { jobs: string[] }
const PlanVerificationConfigSchema: s<PlanVerificationConfigInput> = s.object({
  projectId: s.string().pattern(/^[a-f0-9]{32}$/).required(),
  workflowId: s.string().pattern(/^[1-9][0-9]*$/).required(),
  jobs: s.array(s.string().pattern(/^[^\p{Cc}\p{Cf}]{1,128}$/u)).min(1).max(16).required(),
  artifactName: s.string().pattern(/^[a-zA-Z0-9_.-]{1,80}$/).required(),
  configuration: s.string().pattern(/^[a-zA-Z0-9_.-]{1,120}$/).required(),
  environment: s.string().pattern(/^[a-zA-Z0-9_.-]{1,120}$/).required(),
})
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  runtimeMode: s.union([s.const('desktop'), s.const('headless')]).default('desktop'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  credentialChecks: s.array(CredentialCheckConfig).default([]).description('Project test-account checks. Credentials must not appear in arguments.'),
  planVerification: s.array(PlanVerificationConfigSchema).default([]).description('Trusted non-production full regression workflows by project.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export type RuntimeMode = 'desktop' | 'headless'

/** Operator-controlled check for a named project credential; command input contains no credential values. */
export interface CredentialCheck { projectId: string; id: string; executable: string; args: string[]; providerUrl?: string }
export interface Machine {
  stateDir: string
  runtimeMode?: RuntimeMode
  credentialChecks?: readonly CredentialCheck[]
  planVerification?: readonly PlanVerificationConfig[]
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'executor.repository in the Execution settings',
  baseRef: 'executor.baseRef in the Execution settings', worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, runtimeMode, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, credentialChecks, planVerification } = config
  if (new Set(credentialChecks.map(check => `${check.projectId}:${check.id}`)).size !== credentialChecks.length) {
    throw new Error('Duplicate credential check for the same project and credential ID')
  }
  for (const { providerUrl } of credentialChecks) if (providerUrl !== undefined) {
    const url = URL.parse(providerUrl)
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Credential provider URL must be HTTPS without credentials, a query or a fragment')
    }
  }
  if (new Set(planVerification.map(check => check.projectId)).size !== planVerification.length)
    throw new Error('Duplicate Plan verification for the same project')
  for (const { jobs } of planVerification) if (new Set(jobs).size !== jobs.length || jobs.some(job => !job.trim()))
    throw new Error('Plan verification requires unique, non-blank full regression job names')
  return { stateDir, runtimeMode: runtimeMode ?? 'desktop', promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs,
    ...(credentialChecks.length ? { credentialChecks } : {}), ...(planVerification.length ? { planVerification } : {}) }
}

const RepositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name')
  .refine(name => name.split('/').every(part => part !== '.' && part !== '..'), 'owner/name')
export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface VerifiedGithub { cli: string; id: number; login: string; noreply: string }
export interface ManagedGithub { repository: string; github: VerifiedGithub }
export interface Deployment extends Machine {
  repository: string
  github: Omit<VerifiedGithub, 'id'> & { id?: number }
  managed?: true
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (!isAbsolute(name) && (name.includes('/') || (process.platform === 'win32' && (name.includes('\\') || /^[A-Za-z]:/.test(name))))) {
    throw new Error(`${name} must be a command name or an absolute path`)
  }
  const dirs = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  const parsedExt = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase()).filter(ext => ext.startsWith('.'))
    : []
  const extensions = process.platform === 'win32' ? (parsedExt.length ? parsedExt : ['.com', '.exe', '.bat', '.cmd']) : []
  const candidates = dirs.flatMap(base => {
    if (!extensions.length) return [base]
    const lower = base.toLowerCase()
    return extensions.some(ext => lower.endsWith(ext)) ? [base] : [...extensions.map(ext => `${base}${ext}`), base]
  })
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[], env?: Record<string, string>) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return (argv, env) => runAsWorker(subprocess, argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    { PATH: path, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', ...env })
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: RepositoryName, push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
type GithubProbeMode = 'onboarding' | 'legacy'
const githubApi = async (probe: Probe, mode: GithubProbeMode, cli: string, endpoint: string, ...args: string[]): Promise<string> =>
  mode === 'legacy' ? probe([cli, 'api', endpoint, ...args])
    : probe([cli, 'api', endpoint, '--hostname', 'github.com', ...args], { GH_PROMPT_DISABLED: '1', GH_TOKEN: '', GITHUB_TOKEN: '' })
const diagnostic = (mode: GithubProbeMode, error: unknown): Record<string, string> => mode === 'legacy' ? { output: reason(error) } : {}

async function githubAccount(machine: Machine, name: string, probe: Probe, path: string, mode: GithubProbeMode): Promise<VerifiedGithub> {
  if (!name.trim()) throw new SetupError('agentCliUnset')
  const shims = workerBin(machine.stateDir)
  let cli: string
  try {
    cli = executable(name.trim(), path, shims)
    if (mode === 'onboarding') {
      cli = resolve(cli)
      if (sameDirectory(dirname(cli), shims) || sameDirectory(dirname(realpathSync.native(cli)), shims)) throw new SetupError('agentCliMissing')
    }
  } catch (error) { throw new SetupError('agentCliMissing', diagnostic(mode, error)) }
  const text = await githubApi(probe, mode, cli, 'user').catch((error: unknown) => {
    throw new SetupError('agentCliSignedOut', diagnostic(mode, error))
  })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  return { cli, id: agent.id, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` }
}

async function githubRepository(account: VerifiedGithub, repository: string, probe: Probe, mode: GithubProbeMode): Promise<string> {
  const remote = repository.trim()
  if (!RepositoryName.safeParse(remote).success) throw new SetupError('repositoryUnset')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await githubApi(probe, mode, account.cli, `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}').catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: account.login, repository: remote, ...diagnostic(mode, error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: account.login, repository: access.name })
  return access.name
}

export function verifyGithubAccount(machine: Machine, name: string, probe: Probe, path = process.env.PATH ?? ''): Promise<VerifiedGithub> {
  return githubAccount(machine, name, probe, path, 'onboarding')
}

export function verifyGithubRepository(account: VerifiedGithub, repository: string, probe: Probe): Promise<string> {
  return githubRepository(account, repository, probe, 'onboarding')
}

/** Verify the legacy GitHub Source's CLI identity and repository access. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { repository, cli } = GithubAccountsSchema.parse(github ?? {})
  if (!repository) throw new SetupError('repositoryUnset')
  const account = await githubAccount(machine, cli, probe, path, 'legacy')
  const canonical = await githubRepository(account, repository, probe, 'legacy')
  return { ...machine, repository: canonical, github: { cli: account.cli, login: account.login, noreply: account.noreply } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> =>
    probe([cli, ...args], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
