/** GitHub Actions evidence for owned commits and dedicated plan verification. */
import { z } from 'zod'
import type { PlanActionsObservation, PlanVerificationRequest, PlanVerificationRun } from '../core/plan-integration.ts'
import type { Commands } from '../infra/commands.ts'

export type EvidenceWork = { kind: 'ticket' | 'plan'; id: string }
/** GitHub workflow ID and exact job name; a legacy name-only setting cannot certify a check. */
export const RequiredActionsCheckSchema = z.strictObject({ id: z.string().min(1), workflowId: z.string().regex(/^[1-9][0-9]*$/).optional() })
type RequiredActionsCheck = z.output<typeof RequiredActionsCheckSchema>
export interface ActionsEvidence {
  provider: 'github-actions'
  repository: string
  work: EvidenceWork
  sha: string
  required: string[]
  checks: {
    name: string
    workflowId: string
    status: string
    conclusion: string | null
    passed: boolean
    run?: { id: number; attempt: number; sha: string; mergeSha?: string; url: string }
    job?: { id: number; url: string }
    artifacts: { id: number; name: string; url: string; expired: boolean }[]
  }[]
  satisfied: boolean
  reason?: 'required_checks_unconfigured' | 'required_workflow_unconfigured'
}

const Run = z.looseObject({ id: z.number().int().positive(), head_sha: z.string(), run_attempt: z.number().int().positive(),
  status: z.string().nullable(), conclusion: z.string().nullable(), html_url: z.string(),
  event: z.string().optional(), head_branch: z.string().nullish(),
  workflow_id: z.number().int().positive(), run_number: z.number().int().positive(),
  pull_requests: z.array(z.looseObject({ number: z.number().int().positive(),
    head: z.looseObject({ sha: z.string() }), base: z.looseObject({ sha: z.string() }) })).optional() })
const Job = z.looseObject({ id: z.number(), run_id: z.number(), head_sha: z.string(), name: z.string(),
  status: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable(), run_attempt: z.number().int().positive().optional() })
const Artifact = z.looseObject({ id: z.number(), name: z.string(), archive_download_url: z.string(), expired: z.boolean(),
  workflow_run: z.looseObject({ id: z.number(), head_sha: z.string() }).nullish() })
const CountedPage = z.looseObject({ total_count: z.number().int().nonnegative() })
const PlanRun = z.looseObject({ id: z.number().int().positive().safe(), workflow_id: z.number().int().positive().safe(),
  run_number: z.number().int().positive().safe(), run_attempt: z.number().int().positive().safe(), head_sha: z.string(),
  head_branch: z.string().nullish(), event: z.string(), display_title: z.string(), status: z.string(), conclusion: z.string().nullable() })
const PlanJob = z.looseObject({ id: z.number().int().positive().safe(), run_id: z.number().int().positive().safe(),
  run_attempt: z.number().int().positive().safe().optional(), head_sha: z.string(), name: z.string(), status: z.string(), conclusion: z.string().nullable() })
const PlanArtifactEntry = z.looseObject({ id: z.number().int().positive().safe(), name: z.string(), expired: z.boolean(),
  size_in_bytes: z.number().int().nonnegative().safe(), workflow_run: z.looseObject({ id: z.number().int().positive().safe(), head_sha: z.string() }).nullish() })

type AttemptOrder = { run_number: number; run_attempt: number }
function isNewerRun(candidate: AttemptOrder, current: AttemptOrder): boolean {
  return candidate.run_number > current.run_number || candidate.run_number === current.run_number && candidate.run_attempt > current.run_attempt
}
function latestRun<T extends AttemptOrder>(runs: readonly T[]): T | undefined {
  let latest: T | undefined
  for (const run of runs) if (!latest || isNewerRun(run, latest)) latest = run
  return latest
}

function planRunView(run: z.infer<typeof PlanRun>, repository: string): PlanVerificationRun {
  return { id: run.id, attempt: run.run_attempt, url: `https://github.com/${repository}/actions/runs/${run.id}`, checks: [] }
}

async function matchingPlanRuns(commands: Commands, request: PlanVerificationRequest, workflowId: string, branch: string, runName: string) {
  const query = new URLSearchParams({ head_sha: request.sha, branch, event: 'workflow_dispatch' })
  const runs = await actionPages(commands, `actions/workflows/${workflowId}/runs?${query}`, 'workflow_runs', PlanRun)
  return runs.filter(run => String(run.workflow_id) === workflowId && run.event === 'workflow_dispatch' &&
    run.head_branch === branch && run.head_sha === request.sha && run.display_title === runName)
}

function planInputs(request: PlanVerificationRequest, repository: string): { workflowId: string; branch: string } {
  const { verification } = request
  const workflowId = verification.workflowId
  if (request.repository.toLowerCase() !== repository.toLowerCase() || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(request.repository) ||
    request.repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Plan verification repository must match the configured GitHub repository')
  }
  if (!/^[1-9][0-9]*$/.test(workflowId) || !Number.isSafeInteger(Number(workflowId))) {
    throw new Error('A configured numeric workflow ID is required')
  }
  if (!/^refs\/heads\//.test(request.ref)) throw new Error('Plan verification requires a branch ref')
  const branch = request.ref.slice('refs/heads/'.length)
  if (!branch || branch === '@' || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') ||
    branch.includes('//') || branch.includes('@{') || /[\\~^:?*\[\x00-\x20\x7f]/.test(branch) || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Plan verification requires a valid plain branch ref')
  }
  if (!/^[0-9a-f]{40}$/.test(request.sha)) throw new Error('A complete lowercase commit SHA is required')
  if (!/^[0-9a-f]{64}$/.test(request.context)) throw new Error('A 64-character lowercase plan context is required')
  if (!verification.jobs.length || !verification.jobs.includes(verification.identityJob) || new Set(verification.jobs).size !== verification.jobs.length ||
    verification.jobs.some(name => !name.trim()) || !verification.artifactName.trim() || !verification.configuration.trim() || !verification.environment.trim()) {
    throw new Error('Plan verification requires a listed identity job, full regression jobs, artifact, configuration, and environment')
  }
  return { workflowId, branch }
}

/** Dispatches the dedicated non-production verification workflow for one exact branch and commit. */
export async function dispatchPlanActions(commands: Commands, request: PlanVerificationRequest): Promise<void> {
  const { workflowId, branch } = planInputs(request, commands.repository)
  await commands.api(`actions/workflows/${workflowId}/dispatches`, '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2026-03-10',
    '-f', `ref=${branch}`, '-f', `inputs[dsh_commit]=${request.sha}`, '-f', `inputs[dsh_context]=${request.context}`,
    '-f', `inputs[dsh_configuration]=${request.verification.configuration}`, '-f', `inputs[dsh_environment]=${request.verification.environment}`)
}

/** Reads only the latest exact-context run; this function never dispatches or reruns workflows. */
export async function observePlanActions(commands: Commands, request: PlanVerificationRequest): Promise<PlanActionsObservation> {
  const { workflowId, branch } = planInputs(request, commands.repository)
  const { verification } = request
  const repository = commands.repository.toLowerCase()
  const runName = `dsh-plan-verification:${request.context}`
  const matching = await matchingPlanRuns(commands, request, workflowId, branch, runName)
  const latest = latestRun(matching)
  if (!latest) return { status: 'missing' }
  const run = planRunView(latest, repository)
  if (latest.status !== 'completed') return { status: 'pending', run }
  if (latest.conclusion !== 'success') return { status: 'failed', reason: 'regression_failed', run }
  const jobs = await actionPages(commands, `actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs`, 'jobs', PlanJob)
  const exactJobs = jobs.filter(job => job.run_id === latest.id && (job.run_attempt == null || job.run_attempt === latest.run_attempt) && job.head_sha === request.sha)
  const requiredJobs = verification.jobs.map(name => ({ name, matches: exactJobs.filter(job => job.name === name) }))
  run.checks = requiredJobs.map(({ name, matches }) => {
    const job = matches.length === 1 ? matches[0] : undefined
    return { name, status: job?.status ?? (matches.length ? 'ambiguous' : 'missing'), conclusion: job?.conclusion ?? null,
      ...(job ? { url: `https://github.com/${repository}/actions/runs/${latest.id}/job/${job.id}` } : {}) }
  })
  if (run.checks.some(check => check.status !== 'completed' || check.conclusion !== 'success')) {
    const missingOrSkipped = run.checks.some(check => check.status === 'missing' || check.status === 'ambiguous' ||
      check.status === 'completed' && check.conclusion === 'skipped')
    return { status: 'failed', reason: missingOrSkipped ? 'full_regression_missing' : 'regression_failed', run }
  }

  const artifactName = `${verification.artifactName}-${request.sha}-${latest.run_attempt}`
  const artifacts = await actionPages(commands, `actions/runs/${latest.id}/artifacts`, 'artifacts', PlanArtifactEntry)
  const exactArtifacts = artifacts.filter(artifact => artifact.name === artifactName && artifact.workflow_run?.id === latest.id &&
    artifact.workflow_run.head_sha === request.sha && artifact.expired === false && artifact.size_in_bytes > 0)
  if (exactArtifacts.length !== 1) return { status: 'failed', reason: 'artifact_unavailable', run }
  const artifact = exactArtifacts[0]!
  const current = latestRun(await matchingPlanRuns(commands, request, workflowId, branch, runName))
  if (!current) return { status: 'missing' }
  const currentRun = planRunView(current, repository)
  if (current.id !== latest.id || current.run_attempt !== latest.run_attempt)
    return current.status === 'completed' && current.conclusion !== 'success'
      ? { status: 'failed', reason: 'regression_failed', run: currentRun }
      : { status: 'pending', run: currentRun }
  if (current.status !== 'completed') return { status: 'pending', run: currentRun }
  if (current.conclusion !== 'success') return { status: 'failed', reason: 'regression_failed', run: currentRun }
  return { status: 'passed', run, artifact: { id: artifact.id, name: artifact.name,
    url: `https://github.com/${repository}/actions/runs/${latest.id}/artifacts/${artifact.id}` } }
}

/** Rechecks the exact run after the package download, immediately before delivery is committed. */
export async function isLatestPlanActions(commands: Commands, request: PlanVerificationRequest, expected: PlanVerificationRun): Promise<boolean> {
  const { workflowId, branch } = planInputs(request, commands.repository)
  const runName = `dsh-plan-verification:${request.context}`
  const current = latestRun(await matchingPlanRuns(commands, request, workflowId, branch, runName))
  return current?.id === expected.id && current.run_attempt === expected.attempt && current.head_sha === request.sha &&
    current.status === 'completed' && current.conclusion === 'success'
}


/** Paginate GitHub's object-wrapped Actions collections without truncating required evidence. */
async function actionPages<T>(commands: Commands, path: string, field: 'workflow_runs' | 'jobs' | 'artifacts', item: z.ZodType<T>): Promise<T[]> {
  const results: T[] = []
  const entriesSchema = z.array(item)
  const pagePath = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=`
  for (let page = 1; ; page++) {
    const response = await commands.api(CountedPage, `${pagePath}${page}`)
    const entries = entriesSchema.parse(response[field])
    if (!entries.length && results.length < response.total_count) throw new Error(`Incomplete GitHub Actions ${field} listing`)
    results.push(...entries)
    if (results.length >= response.total_count) return results
  }
}

/** Reads Actions evidence for a commit; PR runs must match the current head and base, not a synthetic merge run SHA. */
export async function actionsEvidence(commands: Commands, work: EvidenceWork, sha: string, required: readonly RequiredActionsCheck[],
  pr?: { number: number; baseSha: string; mergeSha?: string; boundRuns?: Readonly<Record<string, number>> },
  candidateBranch?: string): Promise<ActionsEvidence> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('A complete lowercase commit SHA is required')
  if (pr && (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[0-9a-f]{40}$/.test(pr.baseSha) ||
    (pr.mergeSha != null && !/^[0-9a-f]{40}$/.test(pr.mergeSha)))) {
    throw new Error('A positive pull request number and complete lowercase base/merge SHAs are required')
  }
  const summary = { provider: 'github-actions' as const, repository: commands.repository, work, sha, required: required.map(check => check.id) }
  if (!required.length) return { ...summary, checks: [], satisfied: false, reason: 'required_checks_unconfigured' }
  if (!required.every((check): check is Required<RequiredActionsCheck> => !!check.workflowId)) {
    return { ...summary, checks: [], satisfied: false, reason: 'required_workflow_unconfigured' }
  }
  const workflows = new Map<string, Set<string>>()
  for (const { id, workflowId } of required) {
    let names = workflows.get(workflowId)
    if (!names) workflows.set(workflowId, names = new Set())
    names.add(id)
  }
  const runs = await actionPages(commands, `actions/runs?head_sha=${sha}`, 'workflow_runs', Run)
  const selected = new Map<string, z.infer<typeof Run>>()
  for (const run of runs) {
    const workflowId = String(run.workflow_id)
    if (!workflows.has(workflowId) || run.head_sha !== sha ||
      (candidateBranch !== undefined && (run.head_branch !== candidateBranch || !['push', 'workflow_dispatch'].includes(run.event ?? '')))) continue
    if (pr) {
      const links = run.pull_requests
      // GitHub can remove the association after the fast-forward. Only a run proved before that write can supply it.
      const pinned = links?.length === 0 && pr.boundRuns?.[workflowId] === run.id
      if (!pinned && !links?.some(link => link.number === pr.number && link.head.sha === sha && link.base.sha === pr.baseSha)) continue
    }
    const previous = selected.get(workflowId)
    // A late update or rerun of an older execution does not supersede a newer run of this workflow.
    if (!previous || isNewerRun(run, previous)) selected.set(workflowId, run)
  }
  const found = new Map<string, Map<string, ActionsEvidence['checks'][number]>>()
  for (const [workflowId, run] of selected) {
    const jobs = await actionPages(commands, `actions/runs/${run.id}/jobs?filter=latest`, 'jobs', Job)
    const artifacts = await actionPages(commands, `actions/runs/${run.id}/artifacts`, 'artifacts', Artifact)
    const names = workflows.get(workflowId)!
    const latest = new Map<string, z.infer<typeof Job>>()
    for (const job of jobs) {
      if (job.run_id !== run.id || job.head_sha !== sha || job.run_attempt !== run.run_attempt || !names.has(job.name)) continue
      const previous = latest.get(job.name)
      if (!previous || job.id > previous.id) latest.set(job.name, job)
    }
    const runArtifacts = artifacts.filter(artifact => artifact.workflow_run == null ||
      (artifact.workflow_run.id === run.id && artifact.workflow_run.head_sha === sha))
      .map(artifact => ({ id: artifact.id, name: artifact.name, url: artifact.archive_download_url, expired: artifact.expired }))
    const runEvidence = { id: run.id, attempt: run.run_attempt, sha, url: run.html_url, ...pr?.mergeSha ? { mergeSha: pr.mergeSha } : {} }
    const success = run.status === 'completed' && run.conclusion === 'success'
    const checks = new Map<string, ActionsEvidence['checks'][number]>()
    for (const name of names) {
      const job = latest.get(name)
      checks.set(name, { name, workflowId, run: runEvidence, artifacts: runArtifacts,
        status: job?.status ?? (success ? 'not_run' : run.status ?? 'pending'),
        conclusion: job ? job.conclusion : success ? null : run.conclusion,
        passed: success && job?.status === 'completed' && job.conclusion === 'success',
        ...job?.html_url ? { job: { id: job.id, url: job.html_url } } : {} })
    }
    found.set(workflowId, checks)
  }
  const checks = required.map(({ id: name, workflowId }) => found.get(workflowId)?.get(name) ??
    { name, workflowId, status: 'not_run', conclusion: null, passed: false, artifacts: [] })
  return { ...summary, checks, satisfied: checks.every(check => check.passed) }
}
