import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands } from '../src/infra/commands.ts'
import { githubKind } from '../src/sources/github.ts'
import { observePull } from '../src/sources/github-pull.ts'
import { feishu, startManagedProject, startRuntime, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import type { MainlineRepair } from '../src/core/model.ts'
import type { MainlineIntent } from '../src/app/mainline-queue.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

const runCommand = Commands.prototype.run
const slug = 'acme/widgets'
const targetRef = 'refs/heads/main'
const canonicalUrl = `https://github.com/${slug}.git`
const hub = (tool: string, input: object) => h.runTool(h.runtime.masterId, tool, input)
const read = (resource: string) => hub('orchestrator_read', { resource })
const queue = (ticket_id: string, candidate: string) => hub('orchestrator_queue_merge', { ticket_id, candidate })
const delivery = (ticket: string) => read(`ticket/${ticket}/delivery-check`)

it('mounts the Mainline queue tool on the Hub but not on a Worker', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('mainline-auth', '@bot Fix the display label'))
  const args = { ticket_id: ticket.id, candidate: h.localGit!.base.sha }
  await expect(h.runTool(sessionId, 'orchestrator_queue_merge', args)).rejects.toThrow(/not registered/i)
  // Ineligible work must reach the Hub handler and be refused there, not fail as a missing tool.
  await expect(queue(ticket.id, args.candidate)).rejects.toThrow(/registered Plan Ticket/i)
})

it('keeps Plan completion waiting for formally delivered Tickets', async () => {
  const { id, workers: { trim } } = await registerPlan({ start: ['trim'] })
  const resource = `plan/${id}/delivery`
  await h.runTool(trim.session, 'orchestrator_report', { state: 'ready', summary: 'Local checks are green.' })
  await h.runtime.idle()
  expect(await read(resource)).toMatchObject({ planId: id, status: 'awaiting-tickets',
    waitingFor: ['trim', 'lowercase', 'combined-check'] })
  expect(h.jsonRelays(h.runtime.masterId, 'plan-delivered')).toEqual([])
}, 90_000)

const claimIdentity = z.object({ ticketId: z.string(), assignmentId: z.string(), session: z.string() })
type Worker = z.infer<typeof claimIdentity> & { directory: string }
type Pull = { sha: string; base: string; branch: string; closed: boolean }

const write = (dir: string, path: string, body: string) => writeFileSync(join(dir, path), body)
const routeDoc = 'docs/labels.md'
const contractDoc = 'docs/label-contract.md'
const labelFile = 'label.mjs'
const exampleFile = 'label.example.json'

/** One overlapping line in code and one in the actual Doc Tree navigation route. */
function formatLabel(directory: string, expression: string, contract: string) {
  write(directory, labelFile, `export const label = value => ${expression}\n`)
  write(directory, routeDoc, `# Labels\n\n| Name | Responsibility | Path |\n| --- | --- | --- |\n| Label | ${contract} | [Contract](label-contract.md) |\n`)
  write(directory, contractDoc, `# Public label formatter\n\n${contract}.\n`)
}

function commit(directory: string, message: string) {
  const { git } = h.localGit!
  git('-C', directory, 'add', '--all')
  git('-C', directory, 'commit', '-qm', message)
  return git('-C', directory, 'rev-parse', 'HEAD')
}

function mainlineRepository() {
  const { repository, git } = h.localGit!
  mkdirSync(join(repository, 'docs'))
  write(repository, 'DOCS.md', '# Documentation\n\n- [Label documentation](docs/labels.md)\n')
  formatLabel(repository, 'value', 'Display labels unchanged')
  const base = commit(repository, 'Define the original label contract')
  const remote = join(h.directory, 'remote.git')
  git('init', '-q', '--bare', '--initial-branch=main', remote)
  git('push', remote, `HEAD:${targetRef}`)
  const tip = () => git('-C', remote, 'rev-parse', targetRef)
  const runGit = (commands: Commands, args: string[], cwd: string) => runCommand.call(commands, 'git',
    args.includes(canonicalUrl) ? ['-c', 'protocol.file.allow=always', ...args.map(arg => arg === canonicalUrl ? remote : arg)] : args, cwd)
  return { repository, git, base, remote, tip, runGit }
}

const labelNodes = ['trim', 'lowercase'] as const
type LabelNode = typeof labelNodes[number]

async function registerPlan<Node extends LabelNode>({ start, checkDependsOn = labelNodes }: {
  start: readonly Node[]
  checkDependsOn?: readonly LabelNode[]
}) {
  const criteria = [
    { statement: 'Trim label whitespace', observable: 'A padded label loses its surrounding spaces', delivery: 'backend' },
    { statement: 'Lowercase labels', observable: 'A mixed-case label becomes lowercase', delivery: 'backend' },
    { statement: 'Check the combined formatter', observable: 'A mixed-case padded label is lowercase and unpadded', delivery: 'backend' },
  ]
  const brief = { project: { repository: slug, workspace: h.localGit!.repository }, goal: 'Normalize display labels.', constraints: [],
    acceptanceScope: criteria.map(item => item.statement), authorization: { scope: 'Normalize display labels', release: 'not-authorized' } }
  const confirmation = JSON.stringify({ confirmed: true, brief })
  h.sendUserMessage(h.runtime.masterId, confirmation)
  const { id } = await hub('orchestrator_handoff_confirm', { ...brief, confirmation }) as { id: string }
  await h.idlePlanning()
  const { spec } = await h.runTool(`planner-${id}`, 'orchestrator_spec_publish', { handoffId: id,
    body: 'Trim labels and lowercase them. Independently verify the composed behavior.', acceptance: criteria,
    testInterfaces: [{ seam: 'label()', kind: 'existing', note: 'Call the exported public formatter.' }], outOfScope: [] }) as { spec: { id: string } }
  await h.runtime.idle()
  const nodes = [
    { id: 'trim', acceptance: [1], blockedBy: [] },
    { id: 'lowercase', acceptance: [2], blockedBy: [] },
    { id: 'combined-check', acceptance: [3], blockedBy: checkDependsOn },
  ].map(node => ({ ...node, featureId: node.id, title: node.id, role: 'backend', demonstration: 'Call the public label formatter.' }))
  await h.runTool(`splitter-${id}`, 'orchestrator_plan_register', { handoffId: id, specId: spec.id,
    features: nodes.map(node => ({ id: node.id, kind: 'backend' })), nodes })

  const dispatch = (nodeId: string) => hub('orchestrator_plan_dispatch', { planId: id, nodeId })
  const claims = await Promise.all(start.map(async node => {
    const result = await dispatch(node)
    return { node, claim: claimIdentity.parse(result.claim) }
  }))
  await h.runtime.idle()
  const workers = await Promise.all(claims.map(async ({ node, claim }) => {
    const { directory } = await read(`ticket/${claim.ticketId}`)
    expect(directory).toEqual(expect.any(String))
    return [node, { ...claim, directory: String(directory) }] as const
  }))
  return { id, workers: Object.fromEntries(workers) as Record<Node, Worker>, dispatch }
}

async function registerSingleIntegrationPlan(release: 'authorized' | 'not-authorized' = 'not-authorized') {
  const acceptance = [{ statement: 'Trim display labels', observable: 'A padded label has no surrounding spaces', delivery: 'backend' }]
  const brief = { project: { repository: slug, workspace: h.localGit!.repository }, goal: 'Trim display labels.', constraints: [],
    acceptanceScope: [acceptance[0]!.statement], authorization: { scope: 'Trim display labels', release } }
  const confirmation = JSON.stringify({ confirmed: true, brief })
  h.sendUserMessage(h.runtime.masterId, confirmation)
  const { id } = await hub('orchestrator_handoff_confirm', { ...brief, confirmation }) as { id: string }
  await h.idlePlanning()
  const { spec } = await h.runTool(`planner-${id}`, 'orchestrator_spec_publish', { handoffId: id, body: brief.goal, acceptance,
    testInterfaces: [{ seam: 'label()', kind: 'existing', note: 'Call the public formatter.' }], outOfScope: [] }) as { spec: { id: string } }
  await h.runtime.idle()
  await h.runTool(`splitter-${id}`, 'orchestrator_plan_register', { handoffId: id, specId: spec.id,
    features: [{ id: 'integration', kind: 'backend' }],
    nodes: [{ id: 'integration', featureId: 'integration', title: 'integration', role: 'backend', acceptance: [1],
      demonstration: 'Run the public formatter.', blockedBy: [] }] })
  const result = await hub('orchestrator_plan_dispatch', { planId: id, nodeId: 'integration' })
  const claim = claimIdentity.parse(result.claim)
  await h.runtime.idle()
  const ticket = await read(`ticket/${claim.ticketId}`)
  expect(ticket.directory).toEqual(expect.any(String))
  return { id, worker: { ...claim, directory: String(ticket.directory) } as Worker }
}

async function delivered(plan: string, nodeId: string, worker: Worker, intent: Record<string, unknown>, base: string, candidate: string, integration: string, actual = integration) {
  const { ended, state } = await read(`ticket/${worker.ticketId}`)
  expect(state).toBe('merged')
  expect(ended).toMatchObject({ by: 'delivery', at: expect.any(String) })
  expect(intent.generation).toEqual(expect.any(Number))
  const node = await read(`plan/${plan}/node/${nodeId}`)
  expect(node).toMatchObject({ status: 'delivered', delivery: { receiptId: intent.id, ticketId: worker.ticketId, assignmentId: worker.assignmentId,
    base, generation: intent.generation, candidate, integration, actual, verifiedAt: expect.any(String) } })
  expect(await delivery(worker.ticketId)).toMatchObject({ formal_delivery: { status: 'delivered', receipt: node.delivery } })
  return { ended, receipt: node.delivery }
}

// Count what actually arrived, including unexpected launches into a second Worker Session.
const combinedAssignments = () => h.deliveries.mock.calls.flatMap(([call]) => {
  if (!call.sessionId.startsWith('worker-') || !call.text.startsWith('{')) return []
  const message = JSON.parse(call.text)
  return message.title === 'combined-check' ? [{ ticketId: message.ticket_id, session: call.sessionId }] : []
})

async function claimCombined(plan: string, dispatch: (nodeId: string) => Promise<Record<string, unknown>>) {
  const [first, replay] = await Promise.all([dispatch('combined-check'), dispatch('combined-check')])
  const claim = claimIdentity.parse(first.claim)
  expect([first.reused, replay.reused].sort()).toEqual([false, true])
  expect(replay).toMatchObject({ claim })
  await h.runtime.idle()
  expect(await read(`plan/${plan}/node/combined-check`)).toMatchObject({ status: 'running', claim })
  expect(combinedAssignments()).toEqual([{ ticketId: claim.ticketId, session: claim.session }])
  return claim
}

const accept = ({ session }: Worker, candidate: string, criterion: string, evidence: string) =>
  h.runTool(session, 'orchestrator_retro_evidence', { candidate, kind: 'acceptance',
    results: [{ id: criterion, status: 'passed', evidence: [evidence] }] })

const runLabelCheck = (directory: string, input: string, output: string) => {
  const check = `import assert from 'node:assert/strict'; import { label } from './label.mjs'; assert.equal(label(${JSON.stringify(input)}), ${JSON.stringify(output)})`
  const args = ['--input-type=module', '-e', check]
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return `node --input-type=module -e ${JSON.stringify(check)}`
}

async function reviewAndTest(worker: Worker, plan: string, base: string, candidate: string, expected: string) {
  for (const axis of ['standards', 'spec'] as const) {
    const { session } = worker
    const reviewer = await h.reviewSubagent(session, axis)
    const result = await h.runTool(reviewer, 'orchestrator_review_submit', { candidate, axis,
      basis: [axis === 'standards' ? 'DOCS.md' : `spec/${plan}`], conclusion: 'passed',
      summary: 'Checked the public formatter and its documented contract.', blockers: [] })
    expect(result).toMatchObject({ evidence: { base, candidate, reviewer_session: reviewer } })
  }
  const command = runLabelCheck(worker.directory, '  ALERT  ', expected)
  const test = await h.runTool(worker.session, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'The label() export is the only changed behavior.', red: null,
    checks: [{ directory: '.', command, status: 'passed', observed: 'exit 0' }] })
  expect(test).toMatchObject({ base, candidate, result: 'reported_passed', read: expect.any(String) })
  return String(test.read)
}

const inspectDocs = (worker: Worker, candidate: string) => h.runTool(worker.session, 'orchestrator_doc_impact', {
  candidate, root: 'DOCS.md', routes: [routeDoc], leaves: [contractDoc],
  impact: { kind: 'updated', documents: [routeDoc, contractDoc], contracts: [contractDoc] },
})

const retro = (worker: Worker, candidate: string, event: object) => h.runTool(worker.session, 'orchestrator_retro_evidence', { candidate, ...event })

async function recordEvidence(worker: Worker, plan: string, base: string, candidate: string, criterion: string, expected: string, staleTest?: string) {
  const test = await reviewAndTest(worker, plan, base, candidate, expected)
  await expect(inspectDocs(worker, candidate)).resolves.toMatchObject({ base, candidate, structure: 'checked', issues: [] })
  // A same-base repair carries its first retro; the affected tests, route, acceptance and final retro must be fresh.
  if (!staleTest) await retro(worker, candidate, { kind: 'first-retro', findings: [] })
  if (staleTest) await expect(accept(worker, candidate, criterion, staleTest)).rejects.toThrow(/match the current revision/i)
  await accept(worker, candidate, criterion, test)
  await retro(worker, candidate, { kind: 'final-retro', findings: [] })
  return test
}

// Fault setup only: the API intentionally has no eraser for a verified observation. Each replay starts
// with the same authentic history, minus exactly one record; keep old candidate records in place.
function evidenceLoss(worker: Worker, candidate: string, findingCandidate: string) {
  const { tickets } = h.runtime.store
  const baseline = tickets.get(worker.ticketId)!
  const ledger = baseline.deliveryCheck!
  const reviews = baseline.assignments.find(item => item.id === worker.assignmentId)!.reviews!
  return (omit?: 'standards' | 'spec' | 'acceptance' | 'docs' | 'tests' | 'repair' | 'first-retro' | 'final-retro') => {
    const ticket = tickets.get(worker.ticketId)!
    const assignment = ticket.assignments.find(item => item.id === worker.assignmentId)!
    assignment.reviews = { ...reviews, evidence: reviews.evidence.filter(item => item.candidate !== candidate || item.axis !== omit) }
    ticket.deliveryCheck = { events: ledger.events.filter(item => item.kind !== omit ||
      item.revision.candidate !== (omit === 'first-retro' ? findingCandidate : candidate)) }
    tickets.save(ticket)
  }
}

async function configureCI() {
  const source = await read('settings/source:github')
  const { revision, value } = JSON.parse(String(source.text))
  await hub('orchestrator_settings_save', { block: 'source', source: 'github', revision,
    value: { ...value, config: { ...value.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } } })
}

/** Keep hosting responses tied to the specific revisions explicitly published by the test. */
function actionsHost(beforeRuns?: (sha: string) => Promise<void>) {
  const runs = new Map<string, { id: number; sha: string; base?: string; branch?: string; detachPull?: boolean; conclusion?: 'success' | 'failure' }>()
  let pull: Pull | undefined
  const number = 29
  let discoveryAvailable = true
  let runId = 20
  const repo = { full_name: slug }
  const url = `https://github.com/${slug}`
  const pullResponse = ({ sha, base, branch, closed }: Pull) => ({ number,
    state: closed ? 'closed' : 'open', merged: false, merge_commit_sha: null,
    html_url: `${url}/pull/${number}`, user: { login: 'agent-bot' },
    head: { sha, ref: branch, repo }, base: { sha: base, ref: 'main', repo } })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([method, path]) => {
    if (method !== 'api' || !path) throw new Error(`Unexpected hosting command: ${method} ${path}`)
    if (path === 'user') return { login: 'agent-bot' }
    if (path === `repos/${slug}`) return { default_branch: 'main', permissions: { push: true } }
    if (path.startsWith(`repos/${slug}/pulls?`)) {
      if (!discoveryAvailable) throw new Error('PR discovery unavailable')
      return []
    }
    if (path === `repos/${slug}/pulls/${number}` && pull) return pullResponse(pull)
    const query = new URL(`/${path}`, 'https://github.com')
    if (query.pathname === `/repos/${slug}/actions/runs`) {
      const sha = query.searchParams.get('head_sha') ?? ''
      if (beforeRuns) await beforeRuns(sha)
      const run = runs.get(sha)
      const workflow_runs = run ? [{ id: run.id, workflow_id: 4, run_number: run.id, head_sha: run.sha, run_attempt: 1,
        status: 'completed', conclusion: run.conclusion ?? 'success', html_url: `${url}/actions/runs/${run.id}`, event: run.base ? 'pull_request' : 'push',
        head_branch: run.branch,
        pull_requests: run.base && !run.detachPull ? [{ number, head: { sha: run.sha }, base: { sha: run.base } }] : [] }] : []
      return { total_count: workflow_runs.length, workflow_runs }
    }
    for (const run of runs.values()) {
      const pathPrefix = `repos/${slug}/actions/runs/${run.id}`
      if (path.startsWith(`${pathPrefix}/jobs?`) || path.startsWith(`${pathPrefix}/attempts/1/jobs?`)) {
        return { total_count: 1, jobs: [{ id: run.id + 100, run_id: run.id, run_attempt: 1, head_sha: run.sha,
          name: 'build', status: 'completed', conclusion: 'success', html_url: `${url}/actions/runs/${run.id}/job/${run.id + 100}` }] }
      }
      if (path.startsWith(`${pathPrefix}/artifacts?`)) return { total_count: 0, artifacts: [] }
    }
    throw new Error(`Unexpected hosting request: ${path}`)
  })
  return { number, publish: (sha: string, base?: string, branch?: string) => runs.set(sha, { id: ++runId, sha, base, branch }),
    withdraw: (sha: string) => runs.delete(sha),
    respondWithRun: (requestedSha: string, oldSha: string) => {
      const run = runs.get(oldSha)
      if (!run) throw new Error(`No Actions run published for ${oldSha}`)
      runs.set(requestedSha, run)
    },
    saveRun(sha: string) {
      const run = runs.get(sha)
      if (!run) throw new Error(`No Actions run published for ${sha}`)
      return () => { runs.set(sha, run) }
    },
    detachPull: (sha: string, conclusion: 'success' | 'failure' = 'success') => {
      const run = runs.get(sha)
      if (!run?.base) throw new Error(`No Actions PR run published for ${sha}`)
      runs.set(sha, { ...run, detachPull: true, conclusion })
    },
    stopDiscovery: () => { discoveryAvailable = false },
    setPull: (value: Pull) => { pull = value; return pullResponse(value) } }
}

it.each([
  { release: 'not-authorized' as const, dispatchFailure: 'lost-response' as const },
  { release: 'authorized' as const, dispatchFailure: 'lost-response' as const },
  { release: 'not-authorized' as const, dispatchFailure: 'forbidden' as const, pauseOnRefusal: true },
  { release: 'not-authorized' as const, dispatchFailure: 'lost-response' as const, rerunDuringDownload: true },
  { release: 'not-authorized' as const, dispatchFailure: 'lost-response' as const, advanceTargetDuringFinalRunLookup: true },
 ] as const)('verifies the integrated package after $dispatchFailure and respects $release release scope',
  async ({ release, dispatchFailure, pauseOnRefusal, rerunDuringDownload, advanceTargetDuringFinalRunLookup }) => {
  await h.stop()
  const verification = { workflowId: '44', identityJob: 'integration-identity',
    jobs: ['integration-identity', 'windows', 'check', 'integration-bundle'], artifactName: 'plugin-bundle',
    configuration: 'plugin-check-v1', environment: 'github-hosted-node22-pnpm11-v1' }
  const mounted = await startManagedProject({ withFeishu: false, machine: project => ({ planVerification: [{ projectId: project.id, ...verification }] }) })
  h = mounted.host
  const { repository, git, base, remote, tip, runGit } = mainlineRepository()
  const ci = actionsHost()
  await configureCI()
  const actionRuns = new Map<string, { id: number; sha: string; branch: string; context: string }>()
  let latestAttempt = 1
  let artifactDownloadStarted = false, targetAdvanced = false
  const advanceTarget = () => {
    git('-C', repository, 'fetch', '--no-tags', remote, targetRef)
    git('-C', repository, 'checkout', '--detach', 'FETCH_HEAD')
    write(repository, 'after-validation.txt', 'The target advanced during the final Actions read.\n')
    commit(repository, 'Advance the target during final Actions read')
    git('-C', repository, 'push', remote, `HEAD:${targetRef}`)
    targetAdvanced = true
  }
  const github = vi.spyOn(Commands.prototype, 'gh')
  const githubFallback = github.getMockImplementation()!
  github.mockImplementation(async function (this: Commands, args) {
    const [method, endpoint] = args
    if (method !== 'api' || !endpoint) return githubFallback.call(this, args)
    const path = new URL(`/${endpoint}`, 'https://github.com')
    if (path.pathname === `/repos/${slug}/actions/workflows/44/runs`) {
      const runs = [...actionRuns.values()].filter(run => run.sha === path.searchParams.get('head_sha') &&
        run.branch === path.searchParams.get('branch'))
      if (advanceTargetDuringFinalRunLookup && artifactDownloadStarted && !targetAdvanced) advanceTarget()
      return { total_count: runs.length, workflow_runs: runs.map(run => ({ id: run.id, workflow_id: 44, run_number: run.id,
        run_attempt: latestAttempt, head_sha: run.sha, head_branch: run.branch, event: 'workflow_dispatch',
        display_title: `dsh-plan-verification:${run.context}`, status: 'completed', conclusion: 'success' })) }
    }
    const jobs = path.pathname.match(new RegExp(`/actions/runs/(\\d+)/attempts/(\\d+)/jobs$`))
    if (jobs) {
      const run = [...actionRuns.values()].find(value => value.id === Number(jobs[1]))
      if (run) return { total_count: verification.jobs.length, jobs: verification.jobs.map((name, index) => ({ id: run.id * 10 + index,
        run_id: run.id, run_attempt: Number(jobs[2]), head_sha: run.sha, name, status: 'completed', conclusion: 'success' })) }
    }
    const artifacts = path.pathname.match(new RegExp(`/actions/runs/(\\d+)/artifacts$`))
    if (artifacts) {
      const run = [...actionRuns.values()].find(value => value.id === Number(artifacts[1]))
      if (run) return { total_count: 1, artifacts: [{ id: run.id * 100, name: `${verification.artifactName}-${run.sha}-${latestAttempt}`,
        expired: false, size_in_bytes: 1200, workflow_run: { id: run.id, head_sha: run.sha } }] }
    }
    return githubFallback.call(this, args)
  })
  let loseDispatchReceipt = dispatchFailure === 'lost-response', rejectDispatch = dispatchFailure === 'forbidden'
  let dispatches = 0
  const command = vi.spyOn(Commands.prototype, 'run')
  const commandFallback = command.getMockImplementation()!
  command.mockImplementation(async function (this: Commands, program, args, cwd, input) {
    if (args[0] === 'run' && args[1] === 'download') {
      const runId = Number(args[2]), attempt = latestAttempt, artifactName = args[args.indexOf('--name') + 1]!
      const destination = args[args.indexOf('--dir') + 1]!, run = [...actionRuns.values()].find(value => value.id === runId)!
      const packageName = 'dsh-superagent-0.1.0.tgz', bytes = Buffer.from(`${run.sha}-${attempt}`)
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, packageName), bytes)
      writeFileSync(join(destination, 'dsh-artifact.json'), JSON.stringify({ repository: slug, ref: targetRef, sha: run.sha,
        context: run.context, configuration: verification.configuration, environment: verification.environment,
        runId, attempt, fileName: packageName, contentType: 'application/gzip', sha256: createHash('sha256').update(bytes).digest('hex') }))
      if (rerunDuringDownload && attempt === 1) latestAttempt = 2
      artifactDownloadStarted = true
      expect(artifactName).toBe(`${verification.artifactName}-${run.sha}-${attempt}`)
      return ''
    }
    if (args[0] === 'api' && args[1] === `repos/${slug}/actions/workflows/44/dispatches`) {
      const field = (name: string) => args.find(value => value.startsWith(`inputs[${name}]=`))?.split('=')[1]
      const sha = field('dsh_commit')!, context = field('dsh_context')!, branch = args[args.indexOf('-f') + 1]!.slice('ref='.length)
      const runId = 900 + ++dispatches
      if (rejectDispatch) {
        rejectDispatch = false
        if (pauseOnRefusal) await h.runtime.settings.pause(true, 'panel')
        throw new CliError('GitHub denied workflow dispatch', 403)
      }
      actionRuns.set(context, { id: runId, sha, branch, context })
      if (loseDispatchReceipt) { loseDispatchReceipt = false; throw new Error('Dispatch response was lost') }
      return JSON.stringify({ workflow_run_id: runId })
    }
    return commandFallback.call(this, program, args, cwd, input)
  })
  const localGit = vi.spyOn(Commands.prototype, 'git')
  localGit.mockImplementation(async function (this: Commands, args, cwd) {
    return runGit(this, args, cwd)
  })

  const { id, worker } = await registerSingleIntegrationPlan(release)
  formatLabel(worker.directory, 'value.trim()', 'Trim surrounding whitespace')
  const candidate = commit(worker.directory, 'Trim display labels')
  const branch = git('-C', worker.directory, 'branch', '--show-current')
  await recordEvidence(worker, id, base, candidate, '1', 'ALERT')
  ci.publish(candidate, undefined, branch)
  await h.runTool(worker.session, 'orchestrator_report', { state: 'ready', summary: 'The checked candidate is ready.' })
  const candidateEvidence = await delivery(worker.ticketId)
  expect(candidateEvidence).toMatchObject({ base, candidate, ready: true, ci_status: 'passed' })
  await expect(h.runTool(worker.session, 'orchestrator_read', { resource: `plan/${id}/delivery` }))
    .rejects.toThrow('This resource belongs to the main Session')

  const intent = await queue(worker.ticketId, candidate)
  await h.runtime.idle()
  const integration = tip()
  const closedTicket = await read(`ticket/${worker.ticketId}`), mainlinePage = await read(`ticket/${worker.ticketId}/mainline`)
  expect({ ticketState: closedTicket.state, mainline: mainlinePage.items, tip: integration, intent },
    JSON.stringify({ ticketState: closedTicket.state, mainline: mainlinePage.items, tip: integration, intent }))
    .toMatchObject({ ticketState: 'merged', mainline: [expect.objectContaining({ status: 'verified' })] })
  expect(intent).toMatchObject({ candidate, base, status: 'queued' })
  const beforeRecovery = await read(`plan/${id}/delivery`)
  expect(beforeRecovery).toMatchObject({ status: 'blocked',
    reason: dispatchFailure === 'forbidden' ? 'actions_unavailable' : 'dispatch_unconfirmed', version: { sha: integration } })
  expect(dispatches).toBe(1)
  if (dispatchFailure === 'forbidden') {
    const refusedContext = z.object({ version: z.object({ context: z.string() }) }).parse(beforeRecovery).version.context
    expect(h.runtime.store.get(KV.plans.integrationDispatch(refusedContext))).toBeUndefined()
    await h.runtime.settings.pause(false, 'panel')
  }

  await h.restart()
  await h.runtime.idle()
  const initial = await read(`plan/${id}/delivery`)
  const initialView = z.object({ version: z.object({ context: z.string() }) }).parse(initial)
  expect(h.runtime.store.get(KV.plans.integrationDispatch(initialView.version.context))).toBe(true)
  if (advanceTargetDuringFinalRunLookup) {
    expect(await read(`plan/${id}/delivery`)).toMatchObject({ status: 'blocked', reason: 'target_changed', version: { sha: integration } })
    expect(dispatches).toBe(1)
    expect(h.jsonRelays(h.runtime.masterId, 'plan-delivered')).toEqual([])
    return
  }
  const attempts = rerunDuringDownload ? 2 : 1
  const resource = await read(`plan/${id}/delivery`), packageBytes = Buffer.from(`${integration}-${attempts}`)
  expect(resource).toMatchObject({ planId: id, status: release === 'authorized' ? 'awaiting-release-verification' : 'delivered',
    version: { repository: slug, ref: targetRef, sha: integration, context: expect.stringMatching(/^[a-f0-9]{64}$/),
      configuration: verification.configuration, environment: verification.environment },
    run: { id: expect.any(Number), attempt: attempts },
    artifact: { id: expect.any(Number), name: `plugin-bundle-${integration}-${attempts}`, url: expect.stringContaining('/actions/runs/'),
      fileName: 'dsh-superagent-0.1.0.tgz', contentType: 'application/gzip', size: packageBytes.length,
      sha256: createHash('sha256').update(packageBytes).digest('hex') },
    verifiedAt: expect.any(String) })
  expect(dispatches).toBe(dispatchFailure === 'forbidden' ? 2 : 1)
  const relays = h.jsonRelays(h.runtime.masterId, 'plan-delivered')
  if (release === 'authorized') expect(relays).toEqual([])
  else expect(relays).toEqual([expect.objectContaining({ planId: id, version: expect.objectContaining({ sha: integration }),
    verification: expect.stringContaining('/actions/runs/'), artifact: expect.objectContaining({ url: expect.stringContaining('/artifacts/') }),
    harness: expect.stringContaining(`superagentTicket=${worker.ticketId}`), read: `plan/${id}/delivery` })])
  expect(await h.api('GET', `plans/${id}/delivery`, undefined, mounted.project.id)).toMatchObject({ status: 200, body: resource })

  await h.restart()
  await h.runtime.idle()
  expect(await read(`plan/${id}/delivery`)).toEqual(resource)
  expect(dispatches).toBe(dispatchFailure === 'forbidden' ? 2 : 1)
  expect(h.jsonRelays(h.runtime.masterId, 'plan-delivered')).toHaveLength(release === 'authorized' ? 0 : 1)
}, 180_000)
async function interruptedByRestart(lifetime: AbortSignal): Promise<never> {
  if (!lifetime.aborted) {
    const stopped = Promise.withResolvers<void>()
    lifetime.addEventListener('abort', () => stopped.resolve(), { once: true })
    await stopped.promise
  }
  lifetime.throwIfAborted()
  throw new Error('Unexpected continuation past the interruption')
}
/** Move a real Plan Ticket's durable queue projection into repair without adding a test-only production hook. */
function repairIntent(ticketId: string): MainlineIntent {
  const ticket = h.runtime.store.tickets.get(ticketId)!
  const assignment = ticket.assignments.at(-1)!
  const base = h.localGit!.base.sha
  return { id: `repair-${ticketId}`, ticket_id: ticketId, queued_at: new Date().toISOString(), status: 'repair',
    target: { repository: h.localGit!.repository, slug, ref: targetRef }, base, candidate: base,
    assignment: assignment.id, generation: assignment.writer!.generation, actual: base,
    reason: 'Worker repair request has not succeeded: dispatch failed once' }
}

it('clears a failed durable repair reason after a restart resumes the same repair intent', async () => {
  const { id: planId, workers: { trim: a } } = await registerPlan({ start: ['trim'] })
  const intent = repairIntent(a.ticketId)
  h.runtime.store.set(KV.mainline.ticket(a.ticketId), [intent])
  const calls: { ticketId: string; repairId: string }[] = []
  vi.spyOn(Object.getPrototypeOf(h.runtime.executor), 'requestMainlineRepair').mockImplementation(async function (...args: unknown[]) {
    const [ticketId, repair] = args as [string, MainlineRepair]
    calls.push({ ticketId, repairId: repair.id })
    if (calls.length === 1) throw new Error('dispatch failed once')
  })
  h.runtime.effects.enqueue('mainlineRepair', intent.id, { ticketId: a.ticketId })
  await h.runtime.effects.idle('mainlineRepair')

  const first = await read(`ticket/${a.ticketId}`)
  expect(first.mainline).toMatchObject({ id: intent.id, status: 'repair', reason: 'Worker repair request has not succeeded: dispatch failed once' })
  expect(first.mainline).not.toHaveProperty('verification')
  expect(await read(`plan/${planId}/node/trim`)).not.toHaveProperty('delivery')

  await h.restart()
  const retry = Promise.withResolvers<void>()
  setTimeout(retry.resolve, 2_100)
  await retry.promise
  await h.runtime.effects.idle('mainlineRepair')
  const ticket = await read(`ticket/${a.ticketId}`)
  expect(ticket.mainline).toMatchObject({ id: intent.id, status: 'repair', repair_requested: true })
  expect(ticket.mainline).not.toHaveProperty('reason')
  expect(ticket.mainline).not.toHaveProperty('verification')
  const served = await h.api('GET', `tickets/${a.ticketId}`)
  expect(served.status).toBe(200)
  expect(served.body.mainline).toEqual(ticket.mainline)
  expect(await read(`plan/${planId}/node/trim`)).not.toHaveProperty('delivery')
  expect(calls).toEqual([{ ticketId: a.ticketId, repairId: intent.id }, { ticketId: a.ticketId, repairId: intent.id }])
}, 90_000)

it('does not let a repair callback clear failure state for a different ticket or superseded intent', async () => {
  const { workers: { trim: a, lowercase: b } } = await registerPlan({ start: labelNodes })
  const intent = repairIntent(a.ticketId)
  h.runtime.store.set(KV.mainline.ticket(a.ticketId), [intent])
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const repair = vi.spyOn(h.runtime.executor, 'requestMainlineRepair').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
  })

  h.runtime.effects.enqueue('mainlineRepair', intent.id, { ticketId: b.ticketId })
  await h.runtime.effects.idle('mainlineRepair')
  expect(repair).not.toHaveBeenCalled()

  h.runtime.effects.enqueue('mainlineRepair', intent.id, { ticketId: a.ticketId })
  const idle = h.runtime.effects.idle('mainlineRepair')
  await entered.promise
  const superseding = { ...intent, id: `replacement-${intent.id}` }
  h.runtime.store.set(KV.mainline.ticket(a.ticketId), [intent, superseding])
  finish.resolve()
  await idle

  const ticket = await read(`ticket/${a.ticketId}`)
  expect(repair).toHaveBeenCalledOnce()
  expect(ticket.mainline).toMatchObject({ id: superseding.id, status: 'repair',
    reason: 'Worker repair request has not succeeded: dispatch failed once' })
  expect(ticket.mainline).not.toHaveProperty('repair_requested')
  expect(ticket.mainline).not.toHaveProperty('verification')
})

it('reuses unaffected acceptance after a documentation-only final retro repair', async () => {
  const { git, base } = mainlineRepository()
  const ci = actionsHost()
  await configureCI()
  const { id, workers: { trim: worker }, dispatch } = await registerPlan({ start: ['trim'], checkDependsOn: ['trim'] })
  const { directory, ticketId, session } = worker
  formatLabel(directory, 'value.trim()', 'Trim surrounding whitespace')
  write(directory, contractDoc, '# Public label formatter\n\nTrim surrounding whitespace and lowercase letters.\n')
  const before = commit(directory, 'Trim labels but overstate the contract')
  const test = await reviewAndTest(worker, id, base, before, 'ALERT')
  const docs = await inspectDocs(worker, before)
  expect(docs).toMatchObject({ structure: 'checked' }) // Structure passes even though the contract is wrong.
  await retro(worker, before, { kind: 'first-retro', findings: [] })
  await accept(worker, before, '1', test)
  await retro(worker, before, { kind: 'final-retro', findings: [{ id: 'contract', category: 'standard', affects: ['docs'],
    summary: 'The contract promises lowercase output but the casing is unchanged.', evidence: [docs.read, test] }] })
  expect(await delivery(ticketId)).toMatchObject({ ready: false, missing: expect.arrayContaining(['repair:contract']) })

  write(directory, contractDoc, '# Public label formatter\n\nTrim surrounding whitespace and preserve case.\n')
  const candidate = commit(directory, 'Document the actual label format')
  await retro(worker, candidate, { kind: 'repair', fixes: [{ id: 'contract', evidence: [`${candidate}:${contractDoc}`] }] })
  const review = async (axis: 'standards' | 'spec') => {
    const reviewer = await h.reviewSubagent(session, axis)
    await h.runTool(reviewer, 'orchestrator_review_submit', { candidate, axis, conclusion: 'passed', blockers: [],
      basis: [axis === 'standards' ? contractDoc : `spec/${id}`, test], summary: 'The correction changes the contract text, not the formatter.',
      reuses: ['docs', 'tests', 'acceptance:1'] })
  }
  await review('standards')
  expect(await delivery(ticketId)).toMatchObject({ ready: false, missing: expect.arrayContaining(['dual-review', 'tests', 'acceptance:1']) })
  await review('spec')
  const recheck = await delivery(ticketId)
  expect(recheck).toMatchObject({ candidate, ready: false, missing: expect.arrayContaining(['docs', 'final-retro']) })
  expect(recheck.missing).not.toContain('acceptance:1')
  expect(recheck.missing).not.toContain('tests')

  await expect(inspectDocs(worker, candidate)).resolves.toMatchObject({ candidate, structure: 'checked' })
  await retro(worker, candidate, { kind: 'final-retro', findings: [] })
  expect(await delivery(ticketId)).toMatchObject({ ready: false, missing: ['required_ci'] })
  ci.publish(candidate, undefined, git('-C', directory, 'branch', '--show-current'))
  expect(await delivery(ticketId)).toMatchObject({ ready: true, base, candidate, mainline: { status: 'pending_merge' } })
  expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['trim'] })
}, 90_000)

it('serializes two reviewed Plan candidates, then verifies a conflict repair only with fresh evidence', async () => {
  const { repository, git, base, remote, tip, runGit } = mainlineRepository()
  const firstPush = Promise.withResolvers<void>()
  const releasePush = Promise.withResolvers<void>()
  let pausedPush = false
  const writes: string[][] = []
  let afterPush: (() => void) | undefined
  // Change only the transport destination. All Git inspection, ancestry checks, writes and verification still run real commands.
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl)) return runGit(this, args, cwd)
    if (args.includes('push')) {
      writes.push(args)
      if (!pausedPush) { pausedPush = true; firstPush.resolve(); await releasePush.promise }
    }
    const result = await runGit(this, args, cwd)
    if (args.includes('push')) afterPush?.()
    return result
  })

  let actionsReads = 0
  const ci = actionsHost(async () => { actionsReads++ })
  await configureCI()
  const { id, workers: { trim: a, lowercase: b }, dispatch } = await registerPlan({ start: labelNodes })
  formatLabel(a.directory, 'value.trim()', 'Trim leading and trailing whitespace')
  const shaA = commit(a.directory, 'Trim display labels')
  formatLabel(b.directory, 'value.toLowerCase()', 'Convert letters to lowercase')
  const shaB = commit(b.directory, 'Lowercase display labels')
  const branchB = git('-C', b.directory, 'branch', '--show-current')
  for (const [worker, sha] of [[a, shaA], [b, shaB]] as const) {
    expect(git('-C', worker.directory, 'rev-parse', `${sha}^`)).toBe(base)
    git('-C', worker.directory, 'push', remote, `HEAD:refs/heads/${git('-C', worker.directory, 'branch', '--show-current')}`)
  }
  await recordEvidence(a, id, base, shaA, '1', 'ALERT')
  const priorTest = await recordEvidence(b, id, base, shaB, '2', '  alert  ')
  const branchA = git('-C', a.directory, 'branch', '--show-current')
  ci.publish(shaA, base, branchA)
  await expect(queue(a.ticketId, shaA)).rejects.toThrow(/required_ci/)
  ci.publish(shaA, undefined, branchA)
  ci.publish(shaB, base)
  ci.setPull({ sha: shaB, base, branch: branchB, closed: false })
  await h.runTool(b.session, 'orchestrator_report', { state: 'ready', pr_number: ci.number, summary: 'delivery-check passed: ready for delivery.' })

  const target = { repository, slug, ref: targetRef }
  const show = async (worker: Worker, mainline: object) => {
    const ticket = await read(`ticket/${worker.ticketId}`)
    expect(ticket).toMatchObject({ mainline })
    const served = await h.api('GET', `tickets/${worker.ticketId}`)
    expect(served.status).toBe(200)
    expect(served.body.mainline).toEqual(ticket.mainline)
    return ticket
  }
  const assertNoReceipt = async () => {
    for (const node of ['trim', 'lowercase']) expect(await read(`plan/${id}/node/${node}`)).not.toHaveProperty('delivery')
    expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['trim', 'lowercase'] })
    expect(combinedAssignments()).toEqual([])
  }
  for (const [worker, candidate] of [[a, shaA], [b, shaB]] as const) {
    expect(await delivery(worker.ticketId)).toMatchObject({ ready: true, base, candidate, ci_status: 'passed', mainline: { status: 'pending_merge' } })
    expect(await delivery(worker.ticketId)).toMatchObject({ formal_delivery: { status: 'blocked', missing: expect.arrayContaining(['mainline_verification']) } })
  }
  await expect(h.runTool(b.session, 'orchestrator_queue_merge', { ticket_id: b.ticketId, candidate: shaB })).rejects.toThrow(/not registered/i)
  await assertNoReceipt()

  await observePull(h.runtime.context(githubKind), ci.setPull({ sha: shaB, base, branch: branchB, closed: true }))
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, missing: expect.arrayContaining(['required_ci']), mainline: { status: 'pending_merge' } })
  await expect(queue(b.ticketId, shaB)).rejects.toThrow(/required_ci/)
  expect(tip()).toBe(base)
  expect(writes).toHaveLength(0)
  await assertNoReceipt()
  await observePull(h.runtime.context(githubKind), ci.setPull({ sha: shaB, base, branch: branchB, closed: false }))

  const queuedA = await queue(a.ticketId, shaA)
  let queuedB: Record<string, unknown>
  try {
    expect(queuedA).toMatchObject({ status: 'queued', id: expect.any(String), base, candidate: shaA, target })
    // Hold the first external write, not the queue. Both candidates must be admitted before the target moves.
    await Promise.race([firstPush.promise, h.runtime.idle().then(() => { if (!pausedPush) throw new Error('A settled without reaching the Git push') })])
    await show(a, { status: 'applying', id: queuedA.id, base, candidate: shaA, actual: base, target })
    queuedB = await queue(b.ticketId, shaB)
    expect(queuedB).toMatchObject({ status: 'queued', id: expect.any(String), base, candidate: shaB, target })
    await show(b, { status: 'queued', id: queuedB.id, base, candidate: shaB, target })
  } finally {
    releasePush.resolve()
  }

  await h.runtime.idle()
  const verification = { status: 'passed', method: 'integration_on_target', at: expect.any(String) }
  const integratedA = tip()
  expect(git('rev-parse', `${integratedA}^`)).toBe(shaA)
  expect(git('rev-parse', `${integratedA}^{tree}`)).toBe(git('rev-parse', `${shaA}^{tree}`))
  await show(a, { status: 'verified', id: queuedA.id, base, candidate: shaA, actual: integratedA, integration: integratedA, target, verification })
  const closedA = await delivered(id, 'trim', a, queuedA, base, shaA, integratedA)
  expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['lowercase'] })
  expect(await read(`plan/${id}/node/lowercase`)).not.toHaveProperty('delivery')
  expect(combinedAssignments()).toEqual([])
  const repairedTicket = await show(b, { status: 'repair', id: queuedB.id, base, candidate: shaB, actual: integratedA, target })
  expect(repairedTicket.mainline).not.toHaveProperty('verification')
  expect(repairedTicket).toMatchObject({ execution: { base: { sha: integratedA, ref: targetRef } } })
  expect(h.relays(b.session)).toContainEqual(expect.objectContaining({ kind: 'mainline-repair', id: queuedB.id, base: integratedA,
    candidate: shaB, ref: targetRef, instructions: expect.stringContaining(`git merge ${integratedA}`) }))
  const repairInput = await read(`ticket/${b.ticketId}/input/${String(queuedB.id)}`)
  expect(JSON.parse(String(repairInput.text))).toMatchObject({ kind: 'mainline-repair', id: queuedB.id, base: integratedA, candidate: shaB, ref: targetRef })
  expect(git('-C', b.directory, 'rev-parse', 'HEAD')).toBe(shaB)
  expect(tip()).toBe(integratedA)
  expect(writes).toHaveLength(1)
  await expect(queue(b.ticketId, shaB)).rejects.toThrow(/Candidate is not ready to queue/i)

  // The Worker, not the queue, integrates the exact repair base and resolves both real conflicts.
  expect(() => git('-C', b.directory, 'merge', '--no-edit', integratedA)).toThrow()
  expect(git('-C', b.directory, 'diff', '--name-only', '--diff-filter=U').split(/\r?\n/)).toEqual([contractDoc, routeDoc, labelFile])
  formatLabel(b.directory, 'value.trim().toLowerCase()', 'Trim surrounding whitespace and convert letters to lowercase')
  write(b.directory, routeDoc, '# Labels\n\n[Contract](missing-contract.md)\n')
  const broken = commit(b.directory, 'Resolve formatter conflict but leave a broken documentation route')
  expect(git('-C', b.directory, 'show', '-s', '--format=%P', broken)).toBe(`${shaB} ${integratedA}`)
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, base: integratedA, candidate: broken,
    missing: expect.arrayContaining(['dual-review', 'acceptance', 'docs', 'tests', 'required_ci']) })
  await expect(queue(b.ticketId, broken)).rejects.toThrow(/Candidate is not ready to queue/i)
  await reviewAndTest(b, id, integratedA, broken, 'alert')
  const brokenRoute = await inspectDocs(b, broken)
  expect(brokenRoute).toMatchObject({ candidate: broken, structure: 'issues', issues: expect.arrayContaining([
    expect.objectContaining({ kind: 'broken-link', path: routeDoc, target: 'missing-contract.md' }),
  ]) })
  const finding = 'combined-contract-route'
  await retro(b, broken, { kind: 'first-retro', findings: [{ id: finding, category: 'standard',
    summary: 'The combined formatter contract is unreachable.', evidence: [brokenRoute.read], affects: ['docs'] }] })
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, missing: expect.arrayContaining(['docs', `repair:${finding}`]) })
  await expect(queue(b.ticketId, broken)).rejects.toThrow(/repair:combined-contract-route/)
  expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['lowercase'] })

  formatLabel(b.directory, 'value.trim().toLowerCase()', 'Trim surrounding whitespace and convert letters to lowercase')
  const fresh = commit(b.directory, 'Restore the route to the combined label contract')
  await retro(b, fresh, { kind: 'repair', fixes: [{ id: finding, evidence: [`https://github.com/${slug}/commit/${fresh}`] }] })

  await recordEvidence(b, id, integratedA, fresh, '2', 'alert', priorTest)
  git('-C', b.directory, 'push', remote, `HEAD:refs/heads/${branchB}`)
  ci.setPull({ sha: fresh, base: integratedA, branch: branchB, closed: false })
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, ci_status: 'not_passed', missing: ['required_ci'] })
  await expect(queue(b.ticketId, fresh)).rejects.toThrow(/required_ci/)
  ci.publish(fresh, integratedA)
  expect(await delivery(b.ticketId)).toMatchObject({ ready: true, base: integratedA, candidate: fresh, ci_status: 'passed' })
  // The queue admission and final prewrite check see good CI. Lose only this run after the real Git write.
  afterPush = () => { ci.withdraw(fresh) }
  const retried = await queue(b.ticketId, fresh)
  expect(retried).toMatchObject({ status: 'queued', id: expect.any(String), base: integratedA, candidate: fresh, target })
  expect(retried.id).not.toBe(queuedB.id)
  await h.runtime.idle()
  const integratedB = tip()
  expect(git('rev-parse', `${integratedB}^`)).toBe(fresh)
  await show(b, { status: 'verified', id: retried.id, base: integratedA, candidate: fresh, actual: integratedB, integration: integratedB, target, verification })
  expect(writes).toHaveLength(2)
  const assertFormalBlock = async (reason: string, ciSkipped = false) => {
    const page = await read(`ticket/${b.ticketId}/mainline`)
    const latest = z.array(z.looseObject({ id: z.string(), delivery_missing: z.array(z.string()).optional() })).parse(page.items)[0]
    expect(latest).toMatchObject({ id: retried.id, status: 'verified', delivery_missing: expect.arrayContaining([reason]) })
    const check = await delivery(b.ticketId)
    expect(check).toMatchObject({ formal_delivery: { status: 'blocked', missing: expect.arrayContaining([reason]) } })
    if (ciSkipped) {
      expect.soft(latest?.delivery_missing, reason).not.toContain('required_ci')
      expect.soft(check.formal_delivery, reason).toMatchObject({ missing: expect.not.arrayContaining(['required_ci']) })
    }
    expect(await read(`ticket/${b.ticketId}`)).not.toHaveProperty('ended')
    expect(await read(`plan/${id}/node/lowercase`)).not.toHaveProperty('delivery')
    expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['lowercase'] })
    expect(combinedAssignments()).toEqual([])
    expect(writes).toHaveLength(2)
  }
  const recheck = async () => {
    expect(await queue(b.ticketId, fresh)).toMatchObject({ id: retried.id, status: 'verified' })
    await h.runtime.idle()
  }
  await assertFormalBlock('required_ci')
  ci.publish(fresh, integratedA)
  const lose = evidenceLoss(b, fresh, broken)
  for (const [observation, missing] of [
    ['acceptance', 'acceptance:2'], ['standards', 'dual-review:standards'], ['spec', 'dual-review:spec'],
    ['tests', 'tests'], ['docs', 'docs'], ['first-retro', 'first-retro'], ['final-retro', 'final-retro'], ['repair', `repair:${finding}`],
  ] as const) {
    lose(observation)
    const readsBefore = actionsReads
    await recheck()
    expect(actionsReads, `Formal CI queried despite missing ${observation}`).toBe(readsBefore)
    await assertFormalBlock(missing, true)
  }
  lose()
  // Even a previously verified attempt is not enough if an external write removed its integration.
  git('-C', remote, 'update-ref', targetRef, fresh, integratedB)
  await recheck()
  await assertFormalBlock('mainline_verification')
  git('-C', remote, 'update-ref', targetRef, integratedB, fresh)
  await recheck()
  const closedB = await delivered(id, 'lowercase', b, retried, integratedA, fresh, integratedB)
  const c = await claimCombined(id, dispatch)
  await h.restart()
  await h.runtime.idle()
  await show(a, { status: 'verified', id: queuedA.id, candidate: shaA, actual: integratedA, verification })
  await show(b, { status: 'verified', id: retried.id, candidate: fresh, actual: integratedB, verification })
  expect(writes).toHaveLength(2)
  await Promise.all([queue(a.ticketId, shaA), queue(b.ticketId, fresh)])
  expect(await dispatch('combined-check')).toMatchObject({ reused: true, claim: c })
  await h.runtime.idle()
  expect(await delivered(id, 'trim', a, queuedA, base, shaA, integratedA)).toEqual(closedA)
  expect(await delivered(id, 'lowercase', b, retried, integratedA, fresh, integratedB)).toEqual(closedB)
  expect(combinedAssignments()).toEqual([{ ticketId: c.ticketId, session: c.session }])
  expect(writes).toHaveLength(2)
}, 240_000)

/** B is C's last prerequisite. The one authorized push succeeded, but its Actions run disappeared before closure. */
async function verifiedLowercaseWithoutCI(linkExample = false) {
  const { git, base, remote, tip, runGit } = mainlineRepository()
  const ci = actionsHost()
  await configureCI()
  const { id, workers: { lowercase: b }, dispatch } = await registerPlan({ start: ['lowercase'], checkDependsOn: ['lowercase'] })
  formatLabel(b.directory, 'value.toLocaleLowerCase()', 'Convert letters to lowercase')
  if (linkExample) {
    write(b.directory, exampleFile, '{"label":"alert"}\n')
    write(b.directory, contractDoc, `# Public label formatter\n\nConvert letters to lowercase.\n\n[An example](../${exampleFile})\n`)
  }
  const candidate = commit(b.directory, 'Lowercase display labels')
  const branch = git('-C', b.directory, 'branch', '--show-current')
  await recordEvidence(b, id, base, candidate, '2', '  alert  ')
  ci.publish(candidate, undefined, branch)

  const transport: { writes: number; afterFetch?: () => void } = { writes: 0 }
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl)) return runGit(this, args, cwd)
    if (args.includes('push')) transport.writes++
    const result = await runGit(this, args, cwd)
    if (args.includes('push')) ci.withdraw(candidate)
    if (args.includes('fetch')) transport.afterFetch?.()
    return result
  })
  const intent = await queue(b.ticketId, candidate)
  expect(intent).toMatchObject({ status: 'queued', id: expect.any(String), candidate, base })
  await h.runtime.idle()
  const integration = tip()
  expect(git('rev-parse', `${integration}^`)).toBe(candidate)
  const blocked = async () => {
    expect(await read(`ticket/${b.ticketId}`)).not.toHaveProperty('ended')
    expect(await read(`plan/${id}/node/lowercase`)).not.toHaveProperty('delivery')
    expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['lowercase'] })
    expect(combinedAssignments()).toEqual([])
    expect(transport.writes).toBe(1)
  }
  const formalBlock = async (reason: string | RegExp) => {
    const missing = expect.arrayContaining([typeof reason === 'string' ? reason : expect.stringMatching(reason)])
    expect(await delivery(b.ticketId)).toMatchObject({ formal_delivery: { status: 'blocked', missing },
      mainline: { status: 'verified', id: intent.id, candidate, integration, delivery_missing: missing } })
    await blocked()
  }
  await formalBlock('required_ci')
  ci.publish(candidate, undefined, branch)
  const replay = async () => {
    expect(await queue(b.ticketId, candidate)).toMatchObject({ id: intent.id, status: 'verified' })
    await h.runtime.idle()
    expect(transport.writes).toBe(1)
  }
  return { git, base, remote, tip, ci, id, b, dispatch, branch, candidate, integration, intent, transport, blocked, formalBlock, replay }
}

it('rechecks the Worker checkout after the real target fetch before closing a verified intent', async () => {
  const { git, id, b, dispatch, base, intent, candidate, integration, transport, formalBlock, replay } = await verifiedLowercaseWithoutCI()
  expect(git('-C', b.directory, 'status', '--porcelain')).toBe('')
  // Only the external transport changes the checkout; there is no tool call or SQLite mutation to invalidate the approval.
  transport.afterFetch = () => write(b.directory, labelFile, 'export const label = () => "wrong"\n')
  await replay()
  delete transport.afterFetch
  expect(git('-C', b.directory, 'rev-parse', 'HEAD')).toBe(candidate)
  expect(git('-C', b.directory, 'diff', '--name-only')).toBe(labelFile)
  await formalBlock(/^(clean_worktree|delivery_target_changed)$/)

  git('-C', b.directory, 'restore', '--', labelFile)
  await replay()
  await delivered(id, 'lowercase', b, intent, base, candidate, integration)
  await claimCombined(id, dispatch)
}, 180_000)

it('checks the ticket Doc Tree at the actual descendant and receipts an unrelated advance', async () => {
  const { git, base, remote, tip, id, b, dispatch, candidate, integration, intent, formalBlock, replay } = await verifiedLowercaseWithoutCI(true)
  const upstream = join(h.directory, 'upstream')
  h.localGit!.worktree(upstream, 'upstream', integration)
  const advance = (message: string) => {
    const sha = commit(upstream, message)
    git('-C', upstream, 'push', remote, `HEAD:${targetRef}`)
    expect(tip()).toBe(sha)
    return sha
  }
  // Both bad heads fast-forward the actual integration. Neither changes the verified Worker checkout.
  write(upstream, routeDoc, '# Labels\n\n- [Contract](missing-contract.md)\n')
  advance('Break the navigation route on main')
  await replay()
  await formalBlock('mainline_docs')
  git('-C', upstream, 'restore', '--source', integration, '--', routeDoc)
  git('-C', upstream, 'rm', '--', contractDoc)
  advance('Restore navigation but remove its contract on main')
  await replay()
  await formalBlock('mainline_docs')

  git('-C', upstream, 'restore', '--source', integration, '--staged', '--worktree', '--', contractDoc)
  git('-C', upstream, 'rm', '--', exampleFile)
  const missingExample = advance('Restore the contract but remove its linked example')
  expect(git('diff', '--name-only', integration, missingExample)).toBe(exampleFile)
  await replay()
  await formalBlock('mainline_docs')

  git('-C', upstream, 'restore', '--source', integration, '--staged', '--worktree', '--', exampleFile)
  write(upstream, labelFile, 'export const label = value => value\n')
  const revertedCode = advance('Restore the example but revert the reviewed behavior')
  expect(git('diff', '--name-only', integration, revertedCode)).toBe(labelFile)
  await replay()
  await formalBlock('mainline_candidate_changed')

  git('-C', upstream, 'restore', '--source', integration, '--worktree', '--', labelFile)
  write(upstream, 'release-notes.txt', 'Unrelated release housekeeping.\n')
  const actual = advance('Restore the contract and add unrelated release notes')
  expect(git('diff', '--name-only', integration, actual)).toBe('release-notes.txt')
  await replay()
  await delivered(id, 'lowercase', b, intent, base, candidate, integration, actual)
  await claimCombined(id, dispatch)
}, 180_000)

it('admits a fresh candidate after verified-but-unclosed delivery and requests repair on the actual integration', async () => {
  const { git, base, tip, ci, id, b, dispatch, branch, candidate, integration, intent, transport, blocked } = await verifiedLowercaseWithoutCI()
  formatLabel(b.directory, 'value.toLowerCase()', 'Convert letters to lowercase independently of the host locale')
  const replacement = commit(b.directory, 'Make lowercasing independent of the host locale')
  await recordEvidence(b, id, base, replacement, '2', '  alert  ')
  ci.publish(replacement, undefined, branch)
  expect(await delivery(b.ticketId)).toMatchObject({ ready: true, base, candidate: replacement, ci_status: 'passed' })
  const next = await queue(b.ticketId, replacement)
  expect(next).toMatchObject({ id: expect.any(String), status: 'queued', base, candidate: replacement })
  expect(next.id).not.toBe(intent.id)
  await h.runtime.idle()
  expect(tip()).toBe(integration)
  expect(await read(`ticket/${b.ticketId}`)).toMatchObject({ mainline: { id: next.id, status: 'repair', actual: integration,
    repair_requested: true, candidate: replacement }, execution: { base: { sha: integration, ref: targetRef } } })
  const input = await read(`ticket/${b.ticketId}/input/${String(next.id)}`)
  expect(JSON.parse(String(input.text))).toMatchObject({ kind: 'mainline-repair', id: next.id, base: integration, candidate: replacement, ref: targetRef })
  await blocked()

  git('-C', b.directory, 'merge', '--no-edit', integration)
  const repaired = git('-C', b.directory, 'rev-parse', 'HEAD')
  await recordEvidence(b, id, integration, repaired, '2', '  alert  ')
  ci.publish(repaired, undefined, branch)
  const final = await queue(b.ticketId, repaired)
  expect(final).toMatchObject({ status: 'queued', base: integration, candidate: repaired })
  await h.runtime.idle()
  const actual = tip()
  expect(git('rev-parse', `${actual}^`)).toBe(repaired)
  const closed = await delivered(id, 'lowercase', b, final, integration, repaired, actual)
  await claimCombined(id, dispatch)
  await expect(queue(b.ticketId, candidate)).rejects.toThrow()
  await h.runtime.idle()
  expect(await delivered(id, 'lowercase', b, final, integration, repaired, actual)).toEqual(closed)
  expect(tip()).toBe(actual)
  expect(transport.writes).toBe(2)
}, 240_000)

it('distinguishes a missing formal receipt from exhausted successor quota', async () => {
  await h.stop()
  const { host, project } = await startManagedProject({ withFeishu: false })
  h = host
  const { git, base, tip, runGit } = mainlineRepository()
  const ci = actionsHost()
  await configureCI()
  const { id, workers: { lowercase: b }, dispatch } = await registerPlan({ start: ['lowercase'], checkDependsOn: ['lowercase'] })
  const successor = 'combined-check'
  const setSuccessorBudget = async (tokens: number) => {
    const settings = await h.api('GET', 'settings', undefined, project.id)
    expect(settings.status).toBe(200)
    const { executor } = z.object({ executor: z.object({ revision: z.number(), value: z.record(z.string(), z.unknown()) }) })
      .parse(settings.body.blocks)
    expect(await h.api('PUT', 'settings/executor', { revision: executor.revision, value: { ...executor.value,
      runLimits: { ticketOverrides: [{ planId: id, nodeId: successor, tokens }] },
    } }, project.id)).toMatchObject({ status: 200 })
  }
  const noSuccessor = async () => {
    expect(await read(`plan/${id}/node/${successor}`)).not.toHaveProperty('claim')
    expect([...h.agents.keys()].filter(session => session.startsWith('worker-') && session !== b.session)).toEqual([])
    expect(combinedAssignments()).toEqual([])
  }
  const blocked = async () => {
    expect(await dispatch(successor)).toMatchObject({ status: 'blocked', reused: false, waitingOn: ['lowercase'], limits: { ticketTokens: 0 } })
    expect(await read(`ticket/${b.ticketId}`)).not.toHaveProperty('ended')
    expect(await read(`plan/${id}/node/lowercase`)).not.toHaveProperty('delivery')
    await noSuccessor()
  }
  await setSuccessorBudget(0)
  await blocked()

  formatLabel(b.directory, 'value.toLocaleLowerCase()', 'Convert letters to lowercase')
  const oldCandidate = commit(b.directory, 'Lowercase display labels using the host locale')
  const branch = git('-C', b.directory, 'branch', '--show-current')
  ci.publish(oldCandidate, undefined, branch)
  formatLabel(b.directory, 'value.toLowerCase()', 'Convert letters to lowercase independently of the host locale')
  const candidate = commit(b.directory, 'Make lowercasing independent of the host locale')
  await recordEvidence(b, id, base, candidate, '2', '  alert  ')
  ci.publish(candidate, base, branch)
  ci.setPull({ sha: candidate, base, branch, closed: false })
  await h.runTool(b.session, 'orchestrator_report', { state: 'ready', pr_number: ci.number, summary: 'The reviewed candidate is ready for handoff.' })
  await h.runtime.idle()
  await blocked()

  const originalRun = ci.saveRun(candidate)

  let writes = 0
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl) || !args.includes('push')) return runGit(this, args, cwd)
    writes++
    const result = await runGit(this, args, cwd)
    ci.setPull({ sha: candidate, base, branch, closed: true })
    ci.respondWithRun(candidate, oldCandidate)
    return result
  })
  const intent = await queue(b.ticketId, candidate)
  expect(intent).toMatchObject({ status: 'queued', base, candidate })
  await h.runtime.idle()
  const integration = tip()
  expect(git('rev-parse', `${integration}^`)).toBe(candidate)
  const verifiedWithoutReceipt = async () => {
    expect(await delivery(b.ticketId)).toMatchObject({ formal_delivery: { status: 'blocked', missing: ['required_ci'] },
      mainline: { id: intent.id, status: 'verified', integration, verification: { status: 'passed' } } })
    expect(tip()).toBe(integration)
    expect(writes).toBe(1)
    await blocked()
  }
  await verifiedWithoutReceipt()

  const replay = async () => {
    expect(await queue(b.ticketId, candidate)).toMatchObject({ id: intent.id, status: 'verified' })
    await h.runtime.idle()
  }
  await h.restart()
  await h.runtime.idle()
  await expect(hub('orchestrator_queue_merge', { ticket_id: b.ticketId, candidate, ci_status: 'passed' })).rejects.toThrow(/unrecognized key.*ci_status/i)
  await replay()
  await verifiedWithoutReceipt()

  // GitHub can clear pull_requests after the actual fast-forward closes the PR. A different green run cannot replace the original.
  ci.publish(candidate, base, branch)
  ci.detachPull(candidate)
  await replay()
  await verifiedWithoutReceipt()
  originalRun()
  ci.detachPull(candidate, 'failure')
  await replay()
  await verifiedWithoutReceipt()
  ci.detachPull(candidate)
  await replay()
  const closed = await delivered(id, 'lowercase', b, intent, base, candidate, integration)
  const paused = await dispatch(successor)
  expect(paused).toMatchObject({ status: 'quota-paused', reused: false, limits: { ticketTokens: 0 }, reason: 'ticket budget: exhausted' })
  expect(paused).not.toHaveProperty('claim')
  expect(paused).not.toHaveProperty('waitingOn')
  await h.runtime.idle()
  await noSuccessor()
  expect(await dispatch('lowercase')).toMatchObject({ status: 'delivered', reused: true })
  expect(await delivered(id, 'lowercase', b, intent, base, candidate, integration)).toEqual(closed)

  await setSuccessorBudget(80)
  const claim = await claimCombined(id, dispatch)
  expect(await dispatch(successor)).toMatchObject({ reused: true, claim, limits: { ticketTokens: 80 } })
  expect(await h.api('GET', `tickets/${claim.ticketId}/run-limits`, undefined, project.id)).toMatchObject({ status: 200,
    body: { budget: { state: 'available', limitTokens: 80, availableTokens: 80 } } })
  await replay()
  expect(await delivered(id, 'lowercase', b, intent, base, candidate, integration)).toEqual(closed)
  expect(combinedAssignments()).toEqual([{ ticketId: claim.ticketId, session: claim.session }])
  expect(tip()).toBe(integration)
  expect(writes).toBe(1)
}, 180_000)

it.each(['intent stored', 'Git advanced', 'candidate already present', 'external advance during write'] as const)('reconciles mainline when %s', async point => {
  const { git, base, remote, tip, runGit } = mainlineRepository()
  // For the post-push crash, interrupt recovery once more inside the formal gate's external CI read.
  const inFormalCheck = Promise.withResolvers<void>()
  let interruptCI = false
  const ci = actionsHost(async sha => {
    if (!interruptCI || sha !== candidate) return
    interruptCI = false
    const signal = h.runtime.lifetime
    inFormalCheck.resolve()
    await interruptedByRestart(signal)
  })
  await configureCI()
  // Isolate recovery of the last prerequisite here; the serialization scenario above covers the two-way join.
  const { id, workers: { trim: a }, dispatch } = await registerPlan({ start: ['trim'], checkDependsOn: ['trim'] })
  formatLabel(a.directory, 'value.trim()', 'Trim leading and trailing whitespace')
  const candidate = commit(a.directory, 'Trim display labels')
  await recordEvidence(a, id, base, candidate, '1', 'ALERT')
  ci.publish(candidate, undefined, git('-C', a.directory, 'branch', '--show-current'))
  await h.runTool(a.session, 'orchestrator_report', { state: 'ready', summary: 'delivery-check passed; the formatter is delivered.' })
  await h.runtime.idle()
  const blocked = async () => {
    expect(await read(`ticket/${a.ticketId}`)).not.toHaveProperty('ended')
    expect(await read(`plan/${id}/node/trim`)).not.toHaveProperty('delivery')
    expect(await dispatch('combined-check')).toMatchObject({ status: 'blocked', waitingOn: ['trim'] })
    expect(combinedAssignments()).toEqual([])
  }
  await blocked()

  const reached = Promise.withResolvers<void>(), lifetime = h.runtime.lifetime
  let interrupted = false, writes = 0
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl)) return runGit(this, args, cwd)
    const push = args.includes('push')
    if (push) writes++
    const breakHere = !interrupted && (point === 'intent stored' ? args.includes('fetch') : point !== 'candidate already present' && push)
    const run = () => runGit(this, args, cwd)
    if (!breakHere) return run()
    if (point === 'external advance during write') git('-C', a.directory, 'push', remote, `${candidate}:${targetRef}`)
    else await run() // Interrupt after the real fetch or push, before its result reaches the host.
    interrupted = true
    reached.resolve()
    return interruptedByRestart(lifetime)
  })
  if (point === 'candidate already present') {
    git('-C', a.directory, 'push', remote, `${candidate}:${targetRef}`)
    await blocked() // Candidate present before a Hub intent exists is not a delivery.
  }

  const intent = await queue(a.ticketId, candidate)
  expect(intent).toMatchObject({ status: 'queued', base, candidate })
  if (point !== 'candidate already present') {
    await Promise.race([reached.promise, h.runtime.idle().then(() => { throw new Error('Git never reached the interruption point') })])
    const inFlight = (await read(`ticket/${a.ticketId}`)).mainline
    const integration = inFlight && typeof inFlight === 'object' && 'integration' in inFlight ? inFlight.integration : undefined
    expect(tip()).toBe(point === 'Git advanced' ? integration : point === 'intent stored' ? base : candidate)
    expect(inFlight).toMatchObject({ id: intent.id, status: point === 'intent stored' ? 'queued' : 'applying', candidate })
    expect(inFlight).not.toHaveProperty('verification')
    await blocked()
    ci.stopDiscovery()
    interruptCI = point === 'Git advanced'
    await h.restart()
    if (point === 'Git advanced') {
      await Promise.race([inFormalCheck.promise, h.runtime.idle().then(() => { throw new Error('Recovery did not reach the formal CI check') })])
      expect(await read(`ticket/${a.ticketId}`)).toMatchObject({ mainline: { id: intent.id, status: 'verified', integration: tip() } })
      await blocked()
      expect(writes).toBe(1)
      await h.restart()
    }
  }
  await h.runtime.idle()
  const { mainline } = await read(`ticket/${a.ticketId}`)
  if (point === 'candidate already present' || point === 'external advance during write') {
    expect(tip()).toBe(candidate)
    expect(mainline).toMatchObject({ status: 'waiting', actual: candidate })
    expect(mainline).not.toHaveProperty('verification')
    expect(writes).toBe(point === 'candidate already present' ? 0 : 1)
    await blocked()
  } else {
    expect(git('rev-parse', `${tip()}^`)).toBe(candidate)
    expect(mainline).toMatchObject({ id: intent.id, status: 'verified', candidate, actual: tip(), integration: tip(), verification: { status: 'passed' } })
    expect(writes).toBe(1)
    const closed = await delivered(id, 'trim', a, intent, base, candidate, tip())
    const c = await claimCombined(id, dispatch)
    await h.restart()
    await h.runtime.idle()
    expect(await queue(a.ticketId, candidate)).toMatchObject({ id: intent.id, status: 'verified' })
    expect(await dispatch('combined-check')).toMatchObject({ reused: true, claim: c })
    await h.runtime.idle()
    expect(await delivered(id, 'trim', a, intent, base, candidate, tip())).toEqual(closed)
    expect(combinedAssignments()).toEqual([{ ticketId: c.ticketId, session: c.session }])
    expect(writes).toBe(1)
  }
}, 120_000)
