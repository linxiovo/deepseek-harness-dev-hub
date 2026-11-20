/** Read-only GitHub Actions job and artifact evidence for an owned commit. */
import { z } from 'zod'
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

const Run = z.looseObject({ id: z.number(), head_sha: z.string(), run_attempt: z.number().int().positive(),
  status: z.string().nullable(), conclusion: z.string().nullable(), html_url: z.string(),
  workflow_id: z.number().int().positive(), run_number: z.number().int().positive(),
  pull_requests: z.array(z.looseObject({ number: z.number().int().positive(),
    head: z.looseObject({ sha: z.string() }), base: z.looseObject({ sha: z.string() }) })).optional() })
const Job = z.looseObject({ id: z.number(), run_id: z.number(), head_sha: z.string(), name: z.string(),
  status: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable(), run_attempt: z.number().int().positive().optional() })
const Artifact = z.looseObject({ id: z.number(), name: z.string(), archive_download_url: z.string(), expired: z.boolean(),
  workflow_run: z.looseObject({ id: z.number(), head_sha: z.string() }).nullish() })
const CountedPage = z.looseObject({ total_count: z.number().int().nonnegative() })

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
  pr?: { number: number; baseSha: string; mergeSha?: string }): Promise<ActionsEvidence> {
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
      (pr && !run.pull_requests?.some(link => link.number === pr.number && link.head.sha === sha && link.base.sha === pr.baseSha))) continue
    const previous = selected.get(workflowId)
    // A late update or rerun of an older execution does not supersede a newer run of this workflow.
    if (!previous || run.run_number > previous.run_number ||
      (run.run_number === previous.run_number && run.run_attempt > previous.run_attempt)) selected.set(workflowId, run)
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
