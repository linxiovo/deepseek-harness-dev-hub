import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { actionsEvidence, dispatchPlanActions, observePlanActions } from '../src/sources/actions-evidence.ts'
import { testDeployment } from './fixtures/deployment.ts'

const SHA = 'a'.repeat(40)
const MERGE_SHA = 'c'.repeat(40)
const BASE_SHA = 'd'.repeat(40)
const BUILD = [{ id: 'build', workflowId: '4' }]
const PR = { number: 14, baseSha: BASE_SHA, mergeSha: MERGE_SHA }
const RUN_URL = 'https://github.com/acme/widgets/actions/runs/21'
const JOB_URL = 'https://github.com/acme/widgets/actions/runs/21/job/37'
const ARTIFACT_URL = 'https://api.github.com/repos/acme/widgets/actions/artifacts/43/zip'
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

it('reports completed successful jobs for the exact commit with original run and downloadable artifact references', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 2, status: 'completed', conclusion: 'success', html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, artifacts: [
    { id: 43, name: 'build-output', archive_download_url: ARTIFACT_URL, expired: false, workflow_run: { id: 21, head_sha: SHA } },
  ] })

  expect(await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)).toEqual({
    provider: 'github-actions', repository: 'acme/widgets', work: { kind: 'ticket', id: 'T-14' }, sha: SHA,
    required: ['build'], satisfied: true, checks: [{ name: 'build', workflowId: '4', status: 'completed', conclusion: 'success', passed: true,
      run: { id: 21, attempt: 2, sha: SHA, url: RUN_URL }, job: { id: 37, url: JOB_URL },
      artifacts: [{ id: 43, name: 'build-output', url: ARTIFACT_URL, expired: false }] }],
  })
  expect(gh.mock.calls.map(([args]) => args)).toEqual([
    ['api', `repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100&page=1`],
    ['api', 'repos/acme/widgets/actions/runs/21/jobs?filter=latest&per_page=100&page=1'],
    ['api', 'repos/acme/widgets/actions/runs/21/artifacts?per_page=100&page=1'],
  ])
})

it.each(['failure', 'cancelled'] as const)('rejects a %s workflow even when its required job succeeded', async conclusion => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 2, status: 'completed', conclusion, html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toMatchObject([{ name: 'build', status: 'completed', conclusion: 'success', passed: false,
    run: { id: 21, attempt: 2, sha: SHA, url: RUN_URL }, job: { id: 37, url: JOB_URL } }])
})

it.each([
  ['failure', 'completed', 'failure'],
  ['cancelled', 'completed', 'cancelled'],
  ['queued', 'queued', null],
  ['waiting', 'waiting', null],
  ['skipped', 'completed', 'skipped'],
] as const)('does not accept a %s required job', async (_label, status, conclusion) => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 2, status, conclusion, html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'build', status, conclusion, html_url: status === 'queued' ? null : JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toMatchObject([{ name: 'build', status, conclusion, passed: false }])
})

it('marks an unscheduled required job not_run in an otherwise successful workflow', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'plan', id: 'P-1' }, SHA, [...BUILD, { id: 'lint', workflowId: '4' }])
  expect(result.satisfied).toBe(false)
  expect(result.checks).toMatchObject([
    { name: 'build', status: 'completed', conclusion: 'success', passed: true },
    { name: 'lint', status: 'not_run', conclusion: null, passed: false,
      run: { id: 21, attempt: 1, sha: SHA, url: RUN_URL }, artifacts: [] },
  ])
})

it('does not certify a commit when no required checks are configured', async () => {
  const gh = vi.spyOn(commands, 'gh')
  expect(await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, [])).toEqual({
    provider: 'github-actions', repository: 'acme/widgets', work: { kind: 'ticket', id: 'T-14' }, sha: SHA,
    required: [], checks: [], satisfied: false, reason: 'required_checks_unconfigured',
  })
  expect(gh).not.toHaveBeenCalled()
})

it('requires workflow IDs for legacy name-only settings before querying Actions', async () => {
  const gh = vi.spyOn(commands, 'gh')
  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, [...BUILD, { id: 'lint' }])
  expect(result).toMatchObject({ required: ['build', 'lint'], satisfied: false, reason: 'required_workflow_unconfigured' })
  expect(gh).not.toHaveBeenCalled()
})

it('rejects stale green workflow runs even when GitHub returns them for the SHA filter', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: 'b'.repeat(40), run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL },
  ] })
  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status: 'not_run', conclusion: null, passed: false, artifacts: [] }])
  expect(gh).toHaveBeenCalledTimes(1)
})

it('ignores a green job when its head_sha differs from the requested commit', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 1, head_sha: 'b'.repeat(40), name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })
  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks[0]).toMatchObject({ name: 'build', status: 'not_run', passed: false })
})

it.each([
  ['failed', 'completed', 'failure', 'completed', 'failure'],
  ['waiting', 'queued', null, 'queued', null],
  ['cancelled with green job', 'completed', 'cancelled', 'completed', 'success'],
] as const)('prefers a newer %s execution over older green jobs regardless of response ordering', async (_label, status, conclusion, jobStatus, jobConclusion) => {
  const newestUrl = 'https://github.com/acme/widgets/actions/runs/22'
  const newestJobUrl = 'https://github.com/acme/widgets/actions/runs/22/job/38'
  const routes = new Map<string, unknown>([
    [`repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100&page=1`, { total_count: 2, workflow_runs: [
      { id: 22, workflow_id: 4, run_number: 22, head_sha: SHA, run_attempt: 2, status, conclusion, html_url: newestUrl, updated_at: '2026-10-02T00:00:00Z' },
      { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL, updated_at: '2026-10-03T00:00:00Z' },
    ] }],
    ['repos/acme/widgets/actions/runs/22/jobs?filter=latest&per_page=100&page=1', { total_count: 2, jobs: [
      { id: 37, run_id: 22, run_attempt: 1, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
      { id: 38, run_id: 22, run_attempt: 2, head_sha: SHA, name: 'build', status: jobStatus, conclusion: jobConclusion, html_url: newestJobUrl },
    ] }],
    ['repos/acme/widgets/actions/runs/22/artifacts?per_page=100&page=1', { total_count: 0, artifacts: [] }],
  ])
  const gh = vi.spyOn(commands, 'gh').mockImplementation(async ([method, path]) => {
    if (method !== 'api' || !routes.has(path!)) throw new Error(`Unexpected GitHub API request: ${path}`)
    return routes.get(path!) as never
  })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toMatchObject([{ name: 'build', status: jobStatus, conclusion: jobConclusion, passed: false,
    run: { id: 22, attempt: 2, sha: SHA, url: newestUrl }, job: { id: 38, url: newestJobUrl } }])
  expect(gh.mock.calls.every(([args]) => args[1]!.startsWith('repos/acme/widgets/'))).toBe(true)
})

it('reads later run, job, and artifact pages instead of inferring absent checks', async () => {
  const routes = new Map<string, unknown>([
    [`repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100&page=1`, { total_count: 2, workflow_runs: [
      { id: 20, workflow_id: 4, run_number: 20, head_sha: 'b'.repeat(40), run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL },
    ] }],
    [`repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100&page=2`, { total_count: 2, workflow_runs: [
      { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL },
    ] }],
    ['repos/acme/widgets/actions/runs/21/jobs?filter=latest&per_page=100&page=1', { total_count: 2, jobs: [
      { id: 36, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'unrelated', status: 'completed', conclusion: 'success', html_url: JOB_URL },
    ] }],
    ['repos/acme/widgets/actions/runs/21/jobs?filter=latest&per_page=100&page=2', { total_count: 2, jobs: [
      { id: 37, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
    ] }],
    ['repos/acme/widgets/actions/runs/21/artifacts?per_page=100&page=1', { total_count: 2, artifacts: [
      { id: 42, name: 'stale', archive_download_url: ARTIFACT_URL, expired: false, workflow_run: { id: 21, head_sha: 'b'.repeat(40) } },
    ] }],
    ['repos/acme/widgets/actions/runs/21/artifacts?per_page=100&page=2', { total_count: 2, artifacts: [
      { id: 43, name: 'build-output', archive_download_url: ARTIFACT_URL, expired: false, workflow_run: { id: 21, head_sha: SHA } },
    ] }],
  ])
  const gh = vi.spyOn(commands, 'gh').mockImplementation(async ([method, path]) => {
    if (method !== 'api' || !routes.has(path!)) throw new Error(`Unexpected GitHub API request: ${path}`)
    return routes.get(path!) as never
  })

  const result = await actionsEvidence(commands, { kind: 'plan', id: 'P-1' }, SHA, BUILD)
  expect(result.satisfied).toBe(true)
  expect(result.checks[0]?.artifacts).toEqual([{ id: 43, name: 'build-output', url: ARTIFACT_URL, expired: false }])
  expect(gh.mock.calls.map(([args]) => args[1])).toEqual([...routes.keys()])
})

it('propagates GitHub REST errors without inventing a successful result', async () => {
  vi.spyOn(commands, 'gh').mockRejectedValueOnce(new Error('HTTP 403'))
  await expect(actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)).rejects.toThrow('HTTP 403')
})

it.each([
  ['required', 4, 5, false],
  ['unrelated', 5, 4, true],
] as const)('uses only the configured workflow when a %s workflow is queued', async (_label, pendingWorkflow, greenWorkflow, expected) => {
  const pendingUrl = 'https://github.com/acme/widgets/actions/runs/21'
  const greenUrl = 'https://github.com/acme/widgets/actions/runs/22'
  const gh = vi.spyOn(commands, 'gh').mockImplementation(async ([, path]) => {
    if (path?.includes('head_sha=')) return { total_count: 2, workflow_runs: [
      { id: 22, workflow_id: greenWorkflow, run_number: 2, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: greenUrl },
      { id: 21, workflow_id: pendingWorkflow, run_number: 2, head_sha: SHA, run_attempt: 1, status: 'queued', conclusion: null, html_url: pendingUrl },
    ] }
    if (path?.includes('/runs/21/jobs?')) return { total_count: 0, jobs: [] }
    if (path?.includes('/runs/22/jobs?')) return { total_count: 1, jobs: [
      { id: 37, run_id: 22, run_attempt: 1, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: null },
    ] }
    if (path?.includes('/artifacts?')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub API path: ${path}`)
  })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(expected)
  expect(result.checks[0]).toMatchObject(expected
    ? { name: 'build', workflowId: '4', passed: true, run: { id: 22 } }
    : { name: 'build', workflowId: '4', status: 'queued', passed: false, run: { id: 21 } })
  expect(gh.mock.calls.some(([args]) => args[1]?.includes(`/runs/${expected ? 21 : 22}/jobs?`))).toBe(false)
})

it.each(['queued', 'waiting'] as const)('reports a %s workflow with no scheduled job and its original link', async status => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status, conclusion: null, html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, jobs: [] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status, conclusion: null, passed: false,
    run: { id: 21, attempt: 1, sha: SHA, url: RUN_URL }, artifacts: [] }])
})

it.each(['failure', 'cancelled'] as const)('reports a completed %s workflow without scheduled jobs', async conclusion => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion, html_url: RUN_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, jobs: [] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status: 'completed', conclusion, passed: false,
    run: { id: 21, attempt: 1, sha: SHA, url: RUN_URL }, artifacts: [] }])
})

it('reports not_run when no matching workflow execution exists', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 0, workflow_runs: [] })
  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status: 'not_run', conclusion: null, passed: false, artifacts: [] }])
})

it('certifies a PR head run only when linked to the candidate and current base SHA', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 2, status: 'completed', conclusion: 'success', html_url: RUN_URL,
      pull_requests: [{ number: 14, head: { sha: SHA }, base: { sha: BASE_SHA } }] },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 1, artifacts: [
    { id: 43, name: 'build-output', archive_download_url: ARTIFACT_URL, expired: false, workflow_run: { id: 21, head_sha: SHA } },
  ] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD, PR)
  expect(result.satisfied).toBe(true)
  expect(result.sha).toBe(SHA)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status: 'completed', conclusion: 'success', passed: true,
    run: { id: 21, attempt: 2, sha: SHA, mergeSha: MERGE_SHA, url: RUN_URL }, job: { id: 37, url: JOB_URL },
    artifacts: [{ id: 43, name: 'build-output', url: ARTIFACT_URL, expired: false }] }])
  expect(gh.mock.calls.map(([args]) => args[1])).toEqual([
    `repos/acme/widgets/actions/runs?head_sha=${SHA}&per_page=100&page=1`,
    'repos/acme/widgets/actions/runs/21/jobs?filter=latest&per_page=100&page=1',
    'repos/acme/widgets/actions/runs/21/artifacts?per_page=100&page=1',
  ])
})

it.each([
  ['stale candidate head', SHA, [{ number: 14, head: { sha: 'b'.repeat(40) }, base: { sha: BASE_SHA } }]],
  ['unrelated pull request', SHA, [{ number: 15, head: { sha: SHA }, base: { sha: BASE_SHA } }]],
  ['stale base', SHA, [{ number: 14, head: { sha: SHA }, base: { sha: 'b'.repeat(40) } }]],
  ['wrong run SHA', 'b'.repeat(40), [{ number: 14, head: { sha: SHA }, base: { sha: BASE_SHA } }]],
  ['missing pull request link', SHA, []],
] as const)('does not certify a %s PR run', async (_label, headSha, pullRequests) => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: headSha, run_attempt: 2, status: 'completed', conclusion: 'success', html_url: RUN_URL,
      pull_requests: pullRequests },
  ] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD, PR)
  expect(result.satisfied).toBe(false)
  expect(result.checks).toEqual([{ name: 'build', workflowId: '4', status: 'not_run', conclusion: null, passed: false, artifacts: [] }])
  expect(gh).toHaveBeenCalledTimes(1)
})

it.each([
  ['previous run attempt', 1, SHA],
  ['missing run attempt', undefined, SHA],
  ['different executed SHA', 2, 'b'.repeat(40)],
] as const)('rejects a green %s job in a PR head run', async (_label, attempt, headSha) => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 4, run_number: 21, head_sha: SHA, run_attempt: 2, status: 'completed', conclusion: 'success', html_url: RUN_URL,
      pull_requests: [{ number: 14, head: { sha: SHA }, base: { sha: BASE_SHA } }] },
  ] }).mockResolvedValueOnce({ total_count: 1, jobs: [
    { id: 37, run_id: 21, run_attempt: attempt, head_sha: headSha, name: 'build', status: 'completed', conclusion: 'success', html_url: JOB_URL },
  ] }).mockResolvedValueOnce({ total_count: 0, artifacts: [] })

  const result = await actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA, BUILD, PR)
  expect(result.satisfied).toBe(false)
  expect(result.checks[0]).toMatchObject({ name: 'build', status: 'not_run', passed: false,
    run: { id: 21, attempt: 2, sha: SHA, mergeSha: MERGE_SHA, url: RUN_URL } })
})

it('rejects abbreviated or query-contaminated commit IDs before calling GitHub', async () => {
  const gh = vi.spyOn(commands, 'gh')
  await expect(actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, `${SHA}&page=2`, BUILD)).rejects.toThrow('complete lowercase commit SHA')
  await expect(actionsEvidence(commands, { kind: 'ticket', id: 'T-14' }, SHA.slice(0, 7), BUILD)).rejects.toThrow('complete lowercase commit SHA')
  expect(gh).not.toHaveBeenCalled()
})

const PLAN = {
  repository: 'acme/widgets', ref: 'refs/heads/release/next', sha: SHA, context: 'b'.repeat(64),
  verification: { projectId: 'project-1', workflowId: '44', identityJob: 'full regression', jobs: ['full regression', 'package'], artifactName: 'release',
    configuration: 'production-like', environment: 'staging' },
} as const

it('dispatches only the dedicated verification workflow with exact branch and inputs', async () => {
  const run = vi.spyOn(commands, 'run').mockResolvedValueOnce('{"workflow_run_id":21}')
  await dispatchPlanActions(commands, PLAN)
  expect(run.mock.calls[0]?.[1]).toEqual(['api', 'repos/acme/widgets/actions/workflows/44/dispatches', '--method', 'POST',
    '-H', 'X-GitHub-Api-Version: 2026-03-10', '-f', 'ref=release/next', '-f', `inputs[dsh_commit]=${SHA}`,
    '-f', `inputs[dsh_context]=${PLAN.context}`, '-f', 'inputs[dsh_configuration]=production-like', '-f', 'inputs[dsh_environment]=staging'])
})

it('observes only the latest matching contextual run and its same-attempt artifact', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 2, workflow_runs: [
    { id: 20, workflow_id: 44, run_number: 20, run_attempt: 1, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
    { id: 21, workflow_id: 44, run_number: 21, run_attempt: 2, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
  ] }).mockResolvedValueOnce({ total_count: 2, jobs: [
    { id: 31, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'full regression', status: 'completed', conclusion: 'success' },
    { id: 32, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'package', status: 'completed', conclusion: 'success' },
  ] }).mockResolvedValueOnce({ total_count: 2, artifacts: [
    { id: 41, name: `release-${SHA}-1`, expired: false, size_in_bytes: 100, workflow_run: { id: 20, head_sha: SHA } },
    { id: 42, name: `release-${SHA}-2`, expired: false, size_in_bytes: 100, workflow_run: { id: 21, head_sha: SHA } },
  ] }).mockResolvedValueOnce({ total_count: 2, workflow_runs: [
    { id: 20, workflow_id: 44, run_number: 20, run_attempt: 1, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
    { id: 21, workflow_id: 44, run_number: 21, run_attempt: 2, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
  ] })

  expect(await observePlanActions(commands, PLAN)).toEqual({ status: 'passed', run: { id: 21, attempt: 2,
    url: 'https://github.com/acme/widgets/actions/runs/21', checks: [
      { name: 'full regression', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/actions/runs/21/job/31' },
      { name: 'package', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/actions/runs/21/job/32' },
    ] }, artifact: { id: 42, name: `release-${SHA}-2`, url: 'https://github.com/acme/widgets/actions/runs/21/artifacts/42' } })
  expect(gh.mock.calls[0]?.[0]).toEqual(['api', `repos/acme/widgets/actions/workflows/44/runs?head_sha=${SHA}&branch=release%2Fnext&event=workflow_dispatch&per_page=100&page=1`])
})

it('does not accept an older successful attempt when a rerun starts during artifact inspection', async () => {
  const run = (id: number, attempt: number, status: string, conclusion: string | null) => ({ id, workflow_id: 44,
    run_number: 21, run_attempt: attempt, head_sha: SHA, head_branch: 'release/next', event: 'workflow_dispatch',
    display_title: `dsh-plan-verification:${PLAN.context}`, status, conclusion })
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [run(21, 1, 'completed', 'success')] })
    .mockResolvedValueOnce({ total_count: 2, jobs: [
      { id: 31, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'full regression', status: 'completed', conclusion: 'success' },
      { id: 32, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'package', status: 'completed', conclusion: 'success' },
    ] }).mockResolvedValueOnce({ total_count: 1, artifacts: [
      { id: 41, name: `release-${SHA}-1`, expired: false, size_in_bytes: 100, workflow_run: { id: 21, head_sha: SHA } },
    ] }).mockResolvedValueOnce({ total_count: 1, workflow_runs: [run(21, 2, 'in_progress', null)] })
  expect(await observePlanActions(commands, PLAN)).toEqual({ status: 'pending', run: { id: 21, attempt: 2,
    url: 'https://github.com/acme/widgets/actions/runs/21', checks: [] } })
})

it('does not accept an older green run when the latest exact-context run has skipped regression work', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 2, workflow_runs: [
    { id: 20, workflow_id: 44, run_number: 20, run_attempt: 1, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
    { id: 21, workflow_id: 44, run_number: 21, run_attempt: 1, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
  ] }).mockResolvedValueOnce({ total_count: 2, jobs: [
    { id: 31, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'full regression', status: 'completed', conclusion: 'success' },
    { id: 32, run_id: 21, run_attempt: 1, head_sha: SHA, name: 'package', status: 'completed', conclusion: 'skipped' },
  ] })
  expect(await observePlanActions(commands, PLAN)).toMatchObject({ status: 'failed', reason: 'full_regression_missing', run: { id: 21 } })
})

it('rejects an artifact from an older attempt of the selected run', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValueOnce({ total_count: 1, workflow_runs: [
    { id: 21, workflow_id: 44, run_number: 21, run_attempt: 2, head_sha: SHA, head_branch: 'release/next',
      event: 'workflow_dispatch', display_title: `dsh-plan-verification:${PLAN.context}`, status: 'completed', conclusion: 'success' },
  ] }).mockResolvedValueOnce({ total_count: 2, jobs: [
    { id: 31, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'full regression', status: 'completed', conclusion: 'success' },
    { id: 32, run_id: 21, run_attempt: 2, head_sha: SHA, name: 'package', status: 'completed', conclusion: 'success' },
  ] }).mockResolvedValueOnce({ total_count: 1, artifacts: [
    { id: 41, name: `release-${SHA}-1`, expired: false, size_in_bytes: 100, workflow_run: { id: 21, head_sha: SHA } },
  ] })
  expect(await observePlanActions(commands, PLAN)).toMatchObject({ status: 'failed', reason: 'artifact_unavailable', run: { id: 21, attempt: 2 } })
})
