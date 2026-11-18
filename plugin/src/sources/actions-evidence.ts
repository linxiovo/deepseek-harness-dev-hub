/** Read-only GitHub Actions job and artifact evidence for an owned commit. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'

export type EvidenceWork = { kind: 'ticket' | 'plan'; id: string }
export interface ActionsEvidence {
  provider: 'github-actions'
  repository: string
  work: EvidenceWork
  sha: string
  required: string[]
  checks: {
    name: string
    status: string
    conclusion: string | null
    passed: boolean
    run?: { id: number; attempt: number; sha: string; mergeSha?: string; url: string }
    job?: { id: number; url: string }
    artifacts: { id: number; name: string; url: string; expired: boolean }[]
  }[]
  satisfied: boolean
  reason?: 'required_checks_unconfigured'
}

const Run = z.looseObject({ id: z.number(), head_sha: z.string(), run_attempt: z.number().int().positive(),
  status: z.string().nullable(), conclusion: z.string().nullable(), html_url: z.string(),
  workflow_id: z.number().optional(), updated_at: z.string().optional(),
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
export async function actionsEvidence(commands: Commands, work: EvidenceWork, sha: string, required: readonly string[],
  pr?: { number: number; baseSha: string; mergeSha?: string }): Promise<ActionsEvidence> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('A complete lowercase commit SHA is required')
  if (pr && (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[0-9a-f]{40}$/.test(pr.baseSha) ||
    (pr.mergeSha != null && !/^[0-9a-f]{40}$/.test(pr.mergeSha)))) {
    throw new Error('A positive pull request number and complete lowercase base/merge SHAs are required')
  }
  if (required.length === 0) return { provider: 'github-actions', repository: commands.repository, work, sha,
    required: [], checks: [], satisfied: false, reason: 'required_checks_unconfigured' }
  const runs = await actionPages(commands, `actions/runs?head_sha=${sha}`, 'workflow_runs', Run)
  const found = new Map<string, { evidence: ActionsEvidence['checks'][number]; workflowId?: number }>()
  const requiredNames = new Set(required)
  // GitHub normally returns newest first; process oldest first so newer executions replace previous ones.
  runs.sort((a, b) => a.updated_at && b.updated_at ? a.updated_at.localeCompare(b.updated_at) || a.id - b.id : a.id - b.id)
  for (const workflowRun of runs) {
    if (workflowRun.head_sha !== sha ||
      (pr && !workflowRun.pull_requests?.some(link => link.number === pr.number && link.head.sha === sha && link.base.sha === pr.baseSha))) continue
    const jobs = await actionPages(commands, `actions/runs/${workflowRun.id}/jobs?filter=latest`, 'jobs', Job)
    const artifacts = await actionPages(commands, `actions/runs/${workflowRun.id}/artifacts`, 'artifacts', Artifact)
    const latest = new Map<string, z.infer<typeof Job>>()
    for (const job of jobs) {
      if (job.run_id !== workflowRun.id || job.head_sha !== sha ||
        job.run_attempt !== workflowRun.run_attempt || !requiredNames.has(job.name)) continue
      const previous = latest.get(job.name)
      if (!previous || job.id > previous.id) latest.set(job.name, job)
    }
    const runArtifacts: ActionsEvidence['checks'][number]['artifacts'] = []
    for (const artifact of artifacts) {
      if (artifact.workflow_run != null && (artifact.workflow_run.id !== workflowRun.id || artifact.workflow_run.head_sha !== sha)) continue
      runArtifacts.push({ id: artifact.id, name: artifact.name, url: artifact.archive_download_url, expired: artifact.expired })
    }
    const runEvidence = { id: workflowRun.id, attempt: workflowRun.run_attempt, sha: workflowRun.head_sha, url: workflowRun.html_url,
      ...pr?.mergeSha ? { mergeSha: pr.mergeSha } : {} }
    for (const name of required) {
      const job = latest.get(name)
      if (!job) {
        const previous = found.get(name)
        // An unscheduled job on a newer execution supersedes the same workflow's previous green job.
        if (!previous || workflowRun.workflow_id == null || previous.workflowId == null || workflowRun.workflow_id === previous.workflowId) {
          const unscheduledOnSuccess = workflowRun.status === 'completed' && workflowRun.conclusion === 'success'
          found.set(name, { workflowId: workflowRun.workflow_id, evidence: { name,
            status: unscheduledOnSuccess ? 'not_run' : workflowRun.status ?? 'pending',
            conclusion: unscheduledOnSuccess ? null : workflowRun.conclusion,
            passed: false, run: runEvidence, artifacts: runArtifacts } })
        }
        continue
      }
      found.set(name, { workflowId: workflowRun.workflow_id, evidence: { name, status: job.status, conclusion: job.conclusion,
        passed: workflowRun.status === 'completed' && workflowRun.conclusion === 'success' &&
          job.status === 'completed' && job.conclusion === 'success',
        run: runEvidence,
        ...job.html_url ? { job: { id: job.id, url: job.html_url } } : {}, artifacts: runArtifacts } })
    }
  }
  const checks = required.map(name => found.get(name)?.evidence ??
    { name, status: 'not_run', conclusion: null, passed: false, artifacts: [] })
  return { provider: 'github-actions', repository: commands.repository, work, sha, required: [...required], checks,
    satisfied: checks.every(check => check.passed) }
}
