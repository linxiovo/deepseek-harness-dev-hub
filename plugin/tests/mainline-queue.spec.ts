import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { githubKind } from '../src/sources/github.ts'
import { observePull } from '../src/sources/github-pull.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
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

type Worker = { ticketId: string; session: string; directory: string }
type Pull = { sha: string; base: string; branch: string; closed: boolean }

const write = (dir: string, path: string, body: string) => writeFileSync(join(dir, path), body)
const routeDoc = 'docs/labels.md'
const contractDoc = 'docs/label-contract.md'
const labelFile = 'label.mjs'

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

async function registerPlan() {
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
    { id: 'combined-check', acceptance: [3], blockedBy: ['trim', 'lowercase'] },
  ].map(node => ({ ...node, featureId: node.id, title: node.id, role: 'backend', demonstration: 'Call the public label formatter.' }))
  await h.runTool(`splitter-${id}`, 'orchestrator_plan_register', { handoffId: id, specId: spec.id,
    features: nodes.map(node => ({ id: node.id, kind: 'backend' })), nodes })

  const dispatch = (nodeId: string) => hub('orchestrator_plan_dispatch', { planId: id, nodeId })
  const claims = await Promise.all(['trim', 'lowercase'].map(async node => {
    const result = await dispatch(node)
    expect(result).toMatchObject({ claim: { ticketId: expect.any(String), session: expect.any(String) } })
    return result.claim as Pick<Worker, 'ticketId' | 'session'>
  }))
  await h.runtime.idle()
  const workers = await Promise.all(claims.map(async claim => {
    const { directory } = await read(`ticket/${claim.ticketId}`)
    expect(directory).toEqual(expect.any(String))
    return { ...claim, directory: String(directory) }
  }))
  return { id, a: workers[0]!, b: workers[1]!, dispatch }
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

async function recordEvidence(worker: Worker, plan: string, base: string, candidate: string, criterion: string, expected: string, staleTest?: string) {
  const { session, directory } = worker
  const call = (tool: string, input: object) => h.runTool(session, tool, { candidate, ...input })
  for (const axis of ['standards', 'spec'] as const) {
    const reviewer = await h.reviewSubagent(session, axis)
    const result = await h.runTool(reviewer, 'orchestrator_review_submit', { candidate, axis,
      basis: [axis === 'standards' ? 'DOCS.md' : `spec/${plan}`], conclusion: 'passed',
      summary: 'Checked the public formatter and its documented contract.', blockers: [] })
    expect(result).toMatchObject({ evidence: { base, candidate, reviewer_session: reviewer } })
  }
  const command = runLabelCheck(directory, '  ALERT  ', expected)
  const test = await call('orchestrator_test_evidence', { scope: 'focused', reason: 'The label() export is the only changed behavior.', red: null,
    checks: [{ directory: '.', command, status: 'passed', observed: 'exit 0' }] })
  expect(test).toMatchObject({ base, candidate, result: 'reported_passed', read: expect.any(String) })
  await expect(call('orchestrator_doc_impact', { root: 'DOCS.md', routes: [routeDoc], leaves: [contractDoc],
    impact: { kind: 'updated', documents: [routeDoc, contractDoc], contracts: [contractDoc] } }))
    .resolves.toMatchObject({ base, candidate, structure: 'checked', issues: [] })
  await call('orchestrator_retro_evidence', { kind: 'first-retro', findings: [] })
  if (staleTest) await expect(accept(worker, candidate, criterion, staleTest)).rejects.toThrow(/match the current revision/i)
  await accept(worker, candidate, criterion, String(test.read))
  await call('orchestrator_retro_evidence', { kind: 'final-retro', findings: [] })
  return String(test.read)
}

async function configureCI() {
  const source = await read('settings/source:github')
  const { revision, value } = JSON.parse(String(source.text))
  await hub('orchestrator_settings_save', { block: 'source', source: 'github', revision,
    value: { ...value, config: { ...value.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } } })
}

/** Keep hosting responses tied to the specific revisions explicitly published by the test. */
function actionsHost() {
  const runs = new Map<string, { id: number; sha: string; base?: string; branch?: string }>()
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
      const run = runs.get(query.searchParams.get('head_sha') ?? '')
      const workflow_runs = run ? [{ id: run.id, workflow_id: 4, run_number: run.id, head_sha: run.sha, run_attempt: 1,
        status: 'completed', conclusion: 'success', html_url: `${url}/actions/runs/${run.id}`, event: run.base ? 'pull_request' : 'push',
        head_branch: run.branch,
        pull_requests: run.base ? [{ number, head: { sha: run.sha }, base: { sha: run.base } }] : [] }] : []
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
    stopDiscovery: () => { discoveryAvailable = false },
    setPull: (value: Pull) => { pull = value; return pullResponse(value) } }
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
  const { id: planId, a } = await registerPlan()
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
  const { a, b } = await registerPlan()
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

it('serializes two reviewed Plan candidates, then verifies a conflict repair only with fresh evidence', async () => {
  const { repository, git } = h.localGit!
  mkdirSync(join(repository, 'docs'))
  write(repository, 'DOCS.md', '# Documentation\n\n- [Label documentation](docs/labels.md)\n')
  formatLabel(repository, 'value', 'Display labels unchanged')
  const base = commit(repository, 'Define the original label contract')
  const remote = join(h.directory, 'remote.git')
  git('init', '-q', '--bare', '--initial-branch=main', remote)
  git('push', remote, `HEAD:${targetRef}`)
  const tip = () => git('-C', remote, 'rev-parse', targetRef)
  const firstPush = Promise.withResolvers<void>()
  const releasePush = Promise.withResolvers<void>()
  let pausedPush = false
  const writes: string[][] = []
  // Change only the transport destination. All Git inspection, ancestry checks, writes and verification still run real commands.
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl)) return runCommand.call(this, 'git', args, cwd)
    if (args.includes('push')) {
      writes.push(args)
      if (!pausedPush) { pausedPush = true; firstPush.resolve(); await releasePush.promise }
    }
    return runCommand.call(this, 'git', ['-c', 'protocol.file.allow=always', ...args.map(arg => arg === canonicalUrl ? remote : arg)], cwd)
  })

  const ci = actionsHost()
  await configureCI()
  const { id, a, b, dispatch } = await registerPlan()
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
  await h.runTool(b.session, 'orchestrator_report', { state: 'progress', pr_number: ci.number, summary: 'Verified the lowercase formatter.' })

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
  }
  for (const [worker, candidate] of [[a, shaA], [b, shaB]] as const) {
    expect(await delivery(worker.ticketId)).toMatchObject({ ready: true, base, candidate, ci_status: 'passed', mainline: { status: 'pending_merge' } })
  }
  await expect(h.runTool(b.session, 'orchestrator_queue_merge', { ticket_id: b.ticketId, candidate: shaB })).rejects.toThrow(/not registered/i)

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
  const fresh = commit(b.directory, 'Resolve code and Doc Tree conflicts')
  expect(git('-C', b.directory, 'show', '-s', '--format=%P', fresh)).toBe(`${shaB} ${integratedA}`)
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, base: integratedA, candidate: fresh,
    missing: expect.arrayContaining(['dual-review', 'acceptance', 'docs', 'tests', 'required_ci']) })
  await expect(queue(b.ticketId, fresh)).rejects.toThrow(/Candidate is not ready to queue/i)

  await recordEvidence(b, id, integratedA, fresh, '2', 'alert', priorTest)
  git('-C', b.directory, 'push', remote, `HEAD:refs/heads/${branchB}`)
  ci.setPull({ sha: fresh, base: integratedA, branch: branchB, closed: false })
  expect(await delivery(b.ticketId)).toMatchObject({ ready: false, ci_status: 'not_passed', missing: ['required_ci'] })
  await expect(queue(b.ticketId, fresh)).rejects.toThrow(/required_ci/)
  ci.publish(fresh, integratedA)
  expect(await delivery(b.ticketId)).toMatchObject({ ready: true, base: integratedA, candidate: fresh, ci_status: 'passed' })
  const retried = await queue(b.ticketId, fresh)
  expect(retried).toMatchObject({ status: 'queued', id: expect.any(String), base: integratedA, candidate: fresh, target })
  expect(retried.id).not.toBe(queuedB.id)
  await h.runtime.idle()
  const integratedB = tip()
  expect(git('rev-parse', `${integratedB}^`)).toBe(fresh)
  await show(b, { status: 'verified', id: retried.id, base: integratedA, candidate: fresh, actual: integratedB, integration: integratedB, target, verification })
  expect(writes).toHaveLength(2)
  await assertNoReceipt()
  await h.restart()
  await h.runtime.idle()
  await show(a, { status: 'verified', id: queuedA.id, candidate: shaA, actual: integratedA, verification })
  await show(b, { status: 'verified', id: retried.id, candidate: fresh, actual: integratedB, verification })
  expect(writes).toHaveLength(2)
  await assertNoReceipt()
}, 90_000)

it.each(['intent stored', 'Git advanced', 'candidate already present', 'external advance during write'] as const)('reconciles mainline when %s', async point => {
  const { repository, git } = h.localGit!
  mkdirSync(join(repository, 'docs'))
  write(repository, 'DOCS.md', '# Documentation\n\n- [Label documentation](docs/labels.md)\n')
  formatLabel(repository, 'value', 'Display labels unchanged')
  const base = commit(repository, 'Define the original label contract')
  const remote = join(h.directory, 'recovery.git')
  git('init', '-q', '--bare', '--initial-branch=main', remote)
  git('push', remote, `HEAD:${targetRef}`)
  const tip = () => git('-C', remote, 'rev-parse', targetRef)
  const ci = actionsHost()
  await configureCI()
  const { id, a } = await registerPlan()
  formatLabel(a.directory, 'value.trim()', 'Trim leading and trailing whitespace')
  const candidate = commit(a.directory, 'Trim display labels')
  await recordEvidence(a, id, base, candidate, '1', 'ALERT')
  ci.publish(candidate, undefined, git('-C', a.directory, 'branch', '--show-current'))
  await h.runTool(a.session, 'orchestrator_report', { state: 'ready', summary: 'Verified the formatter.' })
  await h.runtime.idle()

  const reached = Promise.withResolvers<void>(), lifetime = h.runtime.lifetime
  let interrupted = false, writes = 0
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    if (!args.includes(canonicalUrl)) return runCommand.call(this, 'git', args, cwd)
    const push = args.includes('push')
    if (push) writes++
    const breakHere = !interrupted && (point === 'intent stored' ? args.includes('fetch') : point !== 'candidate already present' && push)
    const run = () => runCommand.call(this, 'git', ['-c', 'protocol.file.allow=always', ...args.map(arg => arg === canonicalUrl ? remote : arg)], cwd)
    if (!breakHere) return run()
    if (point === 'external advance during write') git('-C', a.directory, 'push', remote, `${candidate}:${targetRef}`)
    else if (push) await run()
    interrupted = true
    reached.resolve()
    const stopped = Promise.withResolvers<void>()
    if (!lifetime.aborted) {
      lifetime.addEventListener('abort', () => stopped.resolve(), { once: true })
      await stopped.promise
    }
    lifetime.throwIfAborted()
    throw new Error('Unexpected continuation past the interruption')
  })
  if (point === 'candidate already present') git('-C', a.directory, 'push', remote, `${candidate}:${targetRef}`)

  const intent = await queue(a.ticketId, candidate)
  expect(intent).toMatchObject({ status: 'queued', base, candidate })
  if (point !== 'candidate already present') {
    await Promise.race([reached.promise, h.runtime.idle().then(() => { throw new Error('Git never reached the interruption point') })])
    const inFlight = (await read(`ticket/${a.ticketId}`)).mainline
    const integration = inFlight && typeof inFlight === 'object' && 'integration' in inFlight ? inFlight.integration : undefined
    expect(tip()).toBe(point === 'Git advanced' ? integration : point === 'intent stored' ? base : candidate)
    expect(inFlight).toMatchObject({ id: intent.id, status: point === 'intent stored' ? 'queued' : 'applying', candidate })
    ci.stopDiscovery()
    await h.restart()
  }
  await h.runtime.idle()
  const { mainline } = await read(`ticket/${a.ticketId}`)
  if (point === 'candidate already present' || point === 'external advance during write') {
    expect(tip()).toBe(candidate)
    expect(mainline).toMatchObject({ status: 'waiting', actual: candidate })
    expect(mainline).not.toHaveProperty('verification')
    expect(writes).toBe(point === 'candidate already present' ? 0 : 1)
  } else {
    expect(git('rev-parse', `${tip()}^`)).toBe(candidate)
    expect(mainline).toMatchObject({ id: intent.id, status: 'verified', candidate, actual: tip(), integration: tip(), verification: { status: 'passed' } })
    expect(writes).toBe(1)
  }
  expect(await read(`plan/${id}/node/trim`)).not.toHaveProperty('delivery')
}, 90_000)
