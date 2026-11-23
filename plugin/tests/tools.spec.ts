/** Session tool registration, role-scoped resource reads, and routing/settings tool contracts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TICKET_STATES } from '../src/app/cards.ts'
import { builtInParts, defaultPrompts, type PromptConfig } from '../src/app/prompts.ts'
import { key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { IM_WORDS, NOTE_WORDS } from '../src/infra/text.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
const importPromptSnapshot = (config: PromptConfig, revision: number) => {
  h.runtime.store.set(KV.prompts.version(revision), { revision, previousRevision: revision ? revision - 1 : null,
    savedAt: '', source: 'panel', config })
  h.runtime.store.set(KV.prompts.revision, revision)
  h.runtime.store.set(KV.prompts.active, revision)
}
const read = (resource: string, page: { offset?: number; limit?: number } = {}) =>
  h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })
/** Stand in for the external git CLI, not the resource or Commands adapter, so checkout ownership is exercised. */
const checkouts = (directories: Record<string, { sha: string; remote?: string; root?: string }>) =>
  vi.spyOn(Commands.prototype, 'git').mockClear().mockImplementation(async (args, directory) => {
    const entry = directories[directory]
    if (!entry) throw new Error(`No checkout at ${directory}`)
    switch (args.join(' ')) {
      case 'rev-parse --show-toplevel': return `${entry.root ?? directory}\n`
      case 'remote get-url origin': return `${entry.remote ?? 'https://github.com/acme/widgets.git'}\n`
      case 'rev-parse --verify HEAD': return `${entry.sha}\n`
      default: throw new Error(`Unexpected git command: ${args.join(' ')}`)
    }
  })

it('reads the lists, a ticket, a decision, the settings, the prompts and the models as resources', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const tickets = await read('tickets', { limit: 1 })
  expect(tickets).toEqual({ items: [expect.objectContaining({ ticket_id: expect.any(String), state: 'working' })], next_offset: 1 })
  expect(await read('tickets', { offset: 1 })).toMatchObject({ items: [expect.objectContaining({ ticket_id: ticket.id })], next_offset: null })
  const triggers = await read('triggers') as { items: { trigger_id: string }[] }
  expect(triggers.items.map(item => item.trigger_id)).toEqual([expect.any(String), trigger.id])
  expect(await read('threads')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ tickets: [ticket.id] })]) })
  const decisions = await read('decisions') as { items: { decision_id: string; read: string }[] }
  const accepted = expect.objectContaining({ kind: 'accept', ticket_id: ticket.id, trigger_ids: [trigger.id], read: expect.stringMatching(/^decision\//) })
  expect(decisions.items).toContainEqual(accepted)
  expect(await read(decisions.items.at(-1)!.read)).toMatchObject({ kind: 'accept', ticket_id: ticket.id, mandate: { strength: 'explicit' } })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, state: 'working', directory: ticket.execution!.directory,
    trigger_id: trigger.id, assignments: { items: [expect.objectContaining({ state: 'running' })] }, assignment: `ticket/${ticket.id}/assignment` })
  // The settings name each block's revision and hold the small blocks; a block reads whole by the name a save takes.
  const settings = await read('settings')
  expect(settings).toMatchObject({ eval: { value: { mode: 'auto' } }, policy: { revision: expect.any(Number), allowed: { feishu: 1, github: 1 }, read: 'settings/policy' },
    pause: { value: { paused: false } }, sources: expect.arrayContaining([expect.objectContaining({ id: 'github', read: 'settings/source:github' })]) })
  expect(JSON.stringify(settings)).not.toContain('ou_alice')
  for (const block of ['policy', 'eval', 'executor', 'pause', 'source:github']) {
    const page = await read(`settings/${block}`) as { text: string }
    expect(JSON.parse(page.text)).toEqual({ block, revision: h.runtime.store.blockRevision(block as 'policy'), value: h.runtime.settings.block(block).value })
  }
  expect(JSON.parse((await read('settings/policy') as { text: string }).text).value.sources.feishu.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  await expect(read('settings/source:retired')).rejects.toThrow('Unknown settings block')
  const skills = { built_in: ['dsh-superagent-feishu', 'dsh-superagent-github', 'dsh-superagent-doc-tree',
    'dsh-worker-implement', 'dsh-worker-tdd', 'dsh-worker-test-scope', 'dsh-worker-code-review'], team: [] }
  expect(await read('prompts')).toMatchObject({ revision: 0, read: 'prompts/0', skills, items: [expect.objectContaining({ revision: 0 })], next_offset: null })
  const { body: promptSettings } = await h.api('GET', 'prompts')
  expect(promptSettings.builtin).toEqual(['feishu', 'github', 'to-spec', 'doc-tree'])
  const models = [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }]
  const catalog = { default: { provider: 'p', model: 'm1' }, groups: [{ id: 'p', name: 'Provider', models }], failures: [] }
  Object.assign(h.controller, { modelCatalog: vi.fn(async () => catalog) })
  expect(await read('models')).toMatchObject({ providers: [{ id: 'p', count: 2, read: 'models/p' }], roles: expect.any(Object) })
  expect(await read('models/p', { limit: 1 })).toEqual({ items: [models[0]], next_offset: 1 })
  await expect(read('ticket')).rejects.toThrow('Unknown context resource')
  // A list page holds at most 50 items, the prompt history too.
  const config = h.runtime.prompts.current().config
  for (let revision = 0; revision < 51; revision++) importPromptSnapshot({ ...config, scope: `Scope ${revision}.` }, revision)
  await h.restart()
  expect(await read('prompts', { limit: 8000 })).toMatchObject({ items: expect.objectContaining({ length: 50 }), next_offset: 50 })
})

it('reads verified worktree ownership, actual worker Session, active writer, and preparation rejection through ticket resources and management', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const execution = ticket.execution!
  const ownership = execution.ownership!
  expect(ownership).toMatchObject({ ticket: ticket.id, verified: true, identity: { base: h.localGit!.base } })
  expect(execution).toMatchObject({ repository: h.localGit!.repository, worktree: execution.directory,
    base: h.localGit!.base, session: sessionId, active_writer: { assignment: ticket.assignments[0]!.id, session: sessionId },
    preparation: { state: 'verified' } })
  const { assignment: _assignment, ownership: _ownership, ...shownExecution } = execution
  expect(await read('tickets')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ticket_id: ticket.id,
    execution: shownExecution })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, execution: shownExecution })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ execution: shownExecution })
  const verifiedPage = (await h.api('GET', `tickets/${ticket.id}`)).body
  expect(verifiedPage).toMatchObject({ execution: shownExecution, sessionId })
  expect(verifiedPage).not.toHaveProperty('execution.ownership')

  const reason = 'Worker preparation failed; existing files were preserved.'
  const claim = { ...ownership.identity, ticket: ticket.id, assignment: ticket.assignments[0]!.id,
    generation: ownership.generation, verified: ownership.verified }
  expect(h.runtime.engine.rejectExecution(claim, reason)).toBe(true)
  const shownRejected = { ...shownExecution, preparation: { state: 'rejected', reason } }
  expect(await read('tickets')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ticket_id: ticket.id,
    execution: shownRejected })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, execution: shownRejected })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ execution: shownRejected })
  const rejectedPage = (await h.api('GET', `tickets/${ticket.id}`)).body
  expect(rejectedPage).toMatchObject({ execution: shownRejected })
  expect(rejectedPage).not.toHaveProperty('execution.ownership')
})

it('exposes review submission only to actual Worker descendants and restores independent evidence through ticket resources', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot review the work'))
  expect(h.tools.get(sessionId)?.has('orchestrator_review_submit')).toBe(false)
  await expect(h.runTool(sessionId, 'orchestrator_review_submit', { candidate: h.localGit!.base.sha, axis: 'standards',
    basis: ['plugin/docs/007-architecture.md'], conclusion: 'passed', summary: 'Reviewed.', blockers: [] })).rejects.toThrow(/not registered/i)
  const standardsSession = await h.reviewSubagent(sessionId, 'standards')
  const specSession = await h.reviewSubagent(sessionId, 'spec')
  expect(h.tools.get(standardsSession)?.has('orchestrator_review_submit')).toBe(true)
  expect(h.tools.get(specSession)?.has('orchestrator_review_submit')).toBe(true)
  const unqualified = await h.reviewSubagent(sessionId, 'standards', undefined, false)
  expect(h.tools.get(unqualified)?.has('orchestrator_review_submit')).toBe(false)
  await expect(h.runTool(unqualified, 'orchestrator_review_submit', { candidate: h.localGit!.base.sha, axis: 'standards',
    basis: ['fake reviewer'], conclusion: 'passed', summary: 'Not a reviewer.', blockers: [] })).rejects.toThrow(/not registered/i)
  for (const reviewer of [standardsSession, specSession]) {
    const allowed = h.toolLimits.get(reviewer)!
    expect(allowed.has('bash')).toBe(true)
    expect(allowed.has('write')).toBe(false)
    expect(allowed.has('edit')).toBe(false)
    expect(allowed.has('subagent')).toBe(false)
  }
  const candidate = h.localGit!.git('-C', ticket.execution!.directory, 'rev-parse', 'HEAD')
  const other = await h.acceptedTicket(feishu('2', '@bot another ticket'))
  const foreignReviewer = await h.reviewSubagent(other.sessionId, 'spec')
  const foreign = await h.runTool(foreignReviewer, 'orchestrator_review_submit', { candidate, axis: 'spec',
    basis: ['another ticket'], conclusion: 'passed', summary: 'Cross-ticket review.', blockers: [] })
  expect(foreign.aggregate).toBe('pending')
  await expect(h.runTool(standardsSession, 'orchestrator_review_submit', { candidate, axis: 'spec',
    basis: ['plugin/docs/007-architecture.md'], conclusion: 'passed', summary: 'Wrong lane.', blockers: [] })).rejects.toThrow(/code-review descendant assigned to this axis/)
  const submit = (reviewer: string, axis: 'standards' | 'spec') => h.runTool(reviewer, 'orchestrator_review_submit', {
    candidate, axis, basis: ['plugin/docs/007-architecture.md'], conclusion: 'passed', summary: `${axis} checked.`, blockers: [],
  })
  await expect(h.runTool(standardsSession, 'orchestrator_review_submit', { candidate, axis: 'standards', reviewer_session: 'worker-forged',
    basis: ['plugin/docs/007-architecture.md'], conclusion: 'passed', summary: 'Reviewed.', blockers: [] })).rejects.toThrow()
  const first = await submit(standardsSession, 'standards')
  expect(first.aggregate).toBe('pending')
  const reviewsRead = () => read(`ticket/${ticket.id}/reviews`)
  expect(await reviewsRead()).toMatchObject({ aggregate: 'pending', candidate, standards: [expect.objectContaining({ reviewer_session: standardsSession,
    axis: 'standards', basis: ['plugin/docs/007-architecture.md'] })], spec: [] })
  const second = await submit(specSession, 'spec')
  expect(second.aggregate).toBe('passed')
  expect(await reviewsRead()).toMatchObject({ aggregate: 'passed', standards: [expect.objectContaining({ reviewer_session: standardsSession })],
    spec: [expect.objectContaining({ reviewer_session: specSession, axis: 'spec' })] })
  const evidence = second.evidence
  if (!evidence || typeof evidence !== 'object' || !('id' in evidence) || typeof evidence.id !== 'string') throw new Error('Review evidence has no id')
  const reviewPath = `ticket/${ticket.id}/review/${evidence.id}`
  const historical = { reviewer_session: specSession, base: ticket.execution!.base!.sha, candidate }
  expect(await read(reviewPath)).toMatchObject({ ...historical, aggregate: 'passed', stale: false })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The Worker stopped before delivery.' })
  await h.restart()
  expect(await read(`ticket/${ticket.id}/reviews`, { limit: 1 })).toMatchObject({ history: [expect.any(Object)], next_offset: 1 })
  expect(await reviewsRead()).toMatchObject({ aggregate: 'pending', standards: [], spec: [], history: expect.arrayContaining([expect.any(Object)]) })
  await h.runTool(h.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticket.id })
  await h.runtime.idle()
  expect((await reviewsRead()).assignment_id).not.toBe(ticket.assignments.at(-1)?.id)
  expect(await read(reviewPath)).toMatchObject({ ...historical, aggregate: 'pending', stale: true })
})

it('requires independent review before the first retro, then requires acceptance before the final retro', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('retro-order', '@bot Check the candidate.'))
  const candidate = h.localGit!.base.sha
  const record = (kind: 'first-retro' | 'final-retro') => h.runTool(sessionId, 'orchestrator_retro_evidence', { candidate, kind, findings: [] })
  await expect(record('first-retro')).rejects.toThrow(/review/i)
  for (const axis of ['standards', 'spec'] as const) {
    const reviewer = await h.reviewSubagent(sessionId, axis)
    await expect(h.runTool(reviewer, 'orchestrator_retro_evidence', { candidate, kind: 'first-retro', findings: [] }))
      .rejects.toThrow(/not registered/i)
    await h.runTool(reviewer, 'orchestrator_review_submit', { candidate, axis, basis: ['Ticket acceptance criteria'],
      conclusion: 'passed', summary: 'No blocking findings.', blockers: [] })
  }
  await expect(record('first-retro')).rejects.toThrow(/execution evidence/i)
  const dir = ticket.execution!.directory
  expect(h.localGit!.git('-C', dir, 'status', '--porcelain')).toBe('')
  await h.runTool(sessionId, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'Verify the checkout starts clean.', red: null,
    checks: [{ directory: '.', command: 'git status --porcelain', status: 'passed', observed: 'No paths returned.' }] })
  await record('first-retro')
  await expect(record('final-retro')).rejects.toThrow(/acceptance/i)
})

it('reacquires changed evidence after the final retro and only queues with current required CI', async () => {
  const hub = h.runtime.masterId
  const brief = { project: { repository: 'acme/widgets', workspace: h.localGit!.repository }, goal: 'Format labels.',
    constraints: [], acceptanceScope: ['Trim labels', 'Preserve blank labels'], authorization: { scope: 'Format labels', release: 'not-authorized' } }
  const confirmation = JSON.stringify({ confirmed: true, brief })
  h.sendUserMessage(hub, confirmation)
  const { id } = await h.runTool(hub, 'orchestrator_handoff_confirm', { ...brief, confirmation }) as { id: string }
  await h.idlePlanning()
  const { spec: { id: specId } } = await h.runTool(`planner-${id}`, 'orchestrator_spec_publish', { handoffId: id, body: 'Trim text and preserve blanks.',
    acceptance: [{ statement: 'Trim labels', observable: 'Leading and trailing spaces are removed.', delivery: 'backend' },
      { statement: 'Preserve blank labels', observable: 'An empty label stays empty.', delivery: 'backend' }],
    testInterfaces: [{ seam: 'label()', kind: 'proposed', note: 'Pass labels through the public function.' }], outOfScope: [] }) as { spec: { id: string } }
  await h.runtime.idle()
  await h.runTool(`splitter-${id}`, 'orchestrator_plan_register', { handoffId: id, specId,
    features: [{ id: 'labels', kind: 'backend' }], nodes: [{ id: 'labels', featureId: 'labels', title: 'Label formatting', role: 'backend',
      acceptance: [1, 2], demonstration: 'Format a label and a blank.', blockedBy: [] }] })
  const { claim: { ticketId, session } } = (await h.runTool(hub, 'orchestrator_plan_dispatch', { planId: id, nodeId: 'labels' })) as
    { claim: { ticketId: string; session: string } }
  await h.runtime.idle()
  const { directory } = await read(`ticket/${ticketId}`) as { directory: string }
  const git = (...args: string[]) => h.localGit!.git('-C', directory, ...args)
  const commit = (body: string) => {
    writeFileSync(join(directory, 'label.mjs'), body)
    git('add', 'label.mjs'); git('commit', '-qm', 'format labels')
    return git('rev-parse', 'HEAD')
  }
  const path = `ticket/${ticketId}/delivery-check`
  const inspect = (page = {}) => read(path, page)
  expect(await read(`ticket/${ticketId}`)).toMatchObject({ delivery_check: { read: path } })
  const submit = (candidate: string, event: object) => h.runTool(session, 'orchestrator_retro_evidence', { candidate, ...event })
  const review = async (candidate: string, reuses: string[] = []) => {
    await Promise.all((['standards', 'spec'] as const).map(async axis => {
      const reviewer = await h.reviewSubagent(session, axis)
      return h.runTool(reviewer, 'orchestrator_review_submit', { candidate, axis, summary: `${axis} passed after inspecting the diff.`,
        basis: [axis === 'standards' ? 'Repository guidance' : `spec/${id}`], conclusion: 'passed', blockers: [], reuses })
    }))
  }
  const tests = async (candidate: string, check: string, status: 'passed' | 'failed' | 'not_run' = 'passed') => {
    const code = `import assert from 'node:assert/strict'; import { label } from './label.mjs'; ${check}`
    if (status !== 'not_run') {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(status === 'passed' ? 0 : 1)
      if (status === 'failed') expect(run.stderr).toMatch(/AssertionError/)
    }
    return h.runTool(session, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'Only label() changed.', red: null,
      checks: [{ directory: '.', command: `node --input-type=module -e ${JSON.stringify(code)}`, status,
        observed: status === 'not_run' ? 'Not executed.' : status === 'passed' ? 'exit 0' : 'exit 1' }] })
  }
  const acceptance = (criteria: string[], ref: unknown) => ({ kind: 'acceptance', results: criteria.map(id => ({ id, status: 'passed', evidence: [ref] })) })
  const before = commit('export const label = value => value.trimStart()\n')
  await review(before)
  const original = await tests(before, "assert.equal(label(' alert'), 'alert'); assert.equal(label(''), '')")
  const trailingSpaceCheck = "assert.equal(label(' alert '), 'alert')"
  const failed = await tests(before, trailingSpaceCheck, 'failed')
  const unrun = await tests(before, "assert.equal(label(''), '')", 'not_run')
  const brokenDocs = await h.runTool(session, 'orchestrator_doc_impact', { candidate: before,
    root: 'missing-navigation.md', routes: [], leaves: [], impact: { kind: 'unchanged', reason: 'No changes to navigation.' } })
  expect(brokenDocs).toMatchObject({ structure: 'issues', read: expect.any(String) })
  const latest = await tests(before, "assert.equal(label(' alert'), 'alert'); assert.equal(label(''), '')")
  await submit(before, { kind: 'first-retro', findings: [{ id: 'improve-direction', category: 'optional',
    summary: 'Consider a localized future mode.', evidence: [original.read] }] })
  expect(await read('retro-followups')).toMatchObject({ items: [{ ticket_id: ticketId, id: expect.any(String), summary: 'Consider a localized future mode.' }] })
  await h.runTool(session, 'orchestrator_doc_impact', { candidate: before, root: null, routes: [], leaves: [],
    impact: { kind: 'unchanged', reason: 'No change to documented inputs or outputs.' } })
  for (const ref of [failed.read, unrun.read, brokenDocs.read]) {
    await expect(submit(before, acceptance(['1'], ref))).rejects.toThrow(/successful test or Doc Tree/i)
  }
  await expect(submit(before, acceptance(['1', 'invented'], latest.read))).rejects.toThrow(/canonical/i)
  await submit(before, acceptance(['1', '2'], latest.read))
  await submit(before, { kind: 'final-retro', findings: [{ id: 'trailing-spaces', category: 'correctness',
    summary: 'Trailing spaces still leak into the label.', evidence: [original.read], affects: ['acceptance:1', 'tests'] }] })
  expect(await inspect()).toMatchObject({ ready: false, status: 'return_for_recheck', candidate: before })
  await expect(submit(before, { kind: 'repair', fixes: [{ id: 'trailing-spaces', evidence: [original.read] }] })).rejects.toThrow(/change|new/i)

  const candidate = commit('export const label = value => value.trim()\n')
  const repair = { kind: 'repair', fixes: [{ id: 'trailing-spaces', evidence: [`https://github.com/acme/widgets/commit/${candidate}`] }] }
  await submit(candidate, repair)
  await review(candidate, ['docs', 'acceptance:2', 'tests']) // An affected check cannot be carried even with approval.
  expect(await inspect()).toMatchObject({ ready: false, candidate, missing: expect.arrayContaining(['tests']) })
  const fixed = await tests(candidate, "assert.equal(label(' alert '), 'alert'); assert.equal(label(''), '')")
  expect(await inspect()).toMatchObject({ missing: expect.arrayContaining(['failed_checks_require_recheck']) })
  await tests(candidate, trailingSpaceCheck)
  const foreign = await h.acceptedTicket(feishu('retro-foreign-observation', '@bot Verify a separate label ticket.'))
  const foreignDir = foreign.ticket.execution!.directory
  h.localGit!.git('-C', foreignDir, 'merge', '--ff-only', candidate)
  const blankLabelCheck = "import { label } from './label.mjs'; if (label('') !== '') process.exit(1)"
  const foreignRun = spawnSync(process.execPath, ['--input-type=module', '-e', blankLabelCheck], { cwd: foreignDir, encoding: 'utf8' })
  expect(foreignRun.status, foreignRun.stderr).toBe(0)
  const foreignEvidence = await h.runTool(foreign.sessionId, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'Check blank labels in this ticket.', red: null,
    checks: [{ directory: '.', command: `node --input-type=module -e ${JSON.stringify(blankLabelCheck)}`, status: 'passed', observed: 'exit 0' }] })
  // Exercise both readable address forms against the same acceptance gate, without rebuilding the Plan per cell.
  for (const prefix of ['ticket', 'task']) {
    const current = String(fixed.read).replace(/^ticket\//, `${prefix}/`)
    const stale = String(original.read).replace(/^ticket\//, `${prefix}/`)
    const other = String(foreignEvidence.read).replace(/^ticket\//, `${prefix}/`)
    expect(await read(current)).toMatchObject({ text: expect.stringContaining(candidate) })
    expect(await read(other)).toMatchObject({ text: expect.stringContaining(candidate) })
    await expect(submit(candidate, acceptance(['1'], stale))).rejects.toThrow(/match the current revision/i)
    await expect(submit(candidate, acceptance(['1'], other))).rejects.toThrow(/belongs to another ticket/i)
    await expect(submit(candidate, acceptance(['1'], `${prefix}/${ticketId}/delivery-observation/999`))).rejects.toThrow(/missing/i)
    await expect(submit(candidate, acceptance(['1'], current))).resolves.toMatchObject({ recorded: 'acceptance', candidate })
  }
  await submit(candidate, { kind: 'final-retro', findings: [] })
  await tests(candidate, "assert.equal(label(' alert '), 'alert'); assert.equal(label(''), '')")
  git('reset', '--keep', before)
  await expect(submit(before, { kind: 'first-retro', findings: [] })).rejects.toThrow(/repair lineage/i)
  git('reset', '--keep', candidate)
  expect(await inspect()).toMatchObject({ ready: false, missing: expect.arrayContaining(['required_ci']), ci_status: 'required_checks_unconfigured' })

  const settings = h.runtime.store.settings()
  expect(await h.api('PUT', 'settings/source:github', {
    value: { ...settings.sources.github!, config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } },
    revision: h.runtime.store.blockRevision('source:github') })).toMatchObject({ status: 200 })
  let workflowSha = before
  let remoteHead = candidate
  const branch = git('branch', '--show-current')
  const base = h.localGit!.base.sha
  const url = 'https://github.com/acme/widgets/actions/runs/21'
  let holdCi = false
  let querying = Promise.withResolvers<void>()
  let releaseCi = Promise.withResolvers<void>()
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([, request]) => {
    if (request?.includes('/pulls?')) return []
    if (request?.endsWith('/pulls/29')) return { state: 'open', html_url: 'https://github.com/acme/widgets/pull/29', user: { login: 'agent-bot' },
      head: { sha: remoteHead, ref: branch, repo: { full_name: 'acme/widgets' } }, base: { sha: base, ref: 'main', repo: { full_name: 'acme/widgets' } }, merge_commit_sha: null }
    if (request?.includes(`/actions/runs?head_sha=${candidate}`)) {
      if (holdCi) { querying.resolve(); await releaseCi.promise }
      return { total_count: 1, workflow_runs: [
        { id: 21, workflow_id: 4, run_number: 1, head_sha: workflowSha, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: url,
          event: 'push', head_branch: branch,
          pull_requests: [{ number: 29, head: { sha: candidate }, base: { sha: base } }] },
      ] }
    }
    if (request?.includes('/actions/runs/21/jobs')) return { total_count: 1, jobs: [
      { id: 37, run_id: 21, run_attempt: 1, head_sha: candidate, name: 'build', status: 'completed', conclusion: 'success', html_url: `${url}/job/37` },
    ] }
    if (request?.includes('/actions/runs/21/artifacts')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub request: ${request}`)
  })
  expect(await inspect()).toMatchObject({ ready: false, status: 'return_for_recheck' })
  workflowSha = candidate
  const first = await inspect({ limit: 4000 }) as { text: string; next_offset: number | null }
  expect(first).toMatchObject({ ready: true, status: 'ready_to_queue', candidate, mainline: { status: 'pending_merge' } })
  let details = first.text
  for (let offset = first.next_offset; offset !== null;) {
    const page = await inspect({ offset, limit: 4000 }) as typeof first
    details += page.text
    offset = page.next_offset
  }
  const evidence = JSON.parse(details)
  expect(evidence).toMatchObject({
    local: { followups: [{ id: 'improve-direction' }], docs: { revision: { candidate: before } }, tests: { revision: { candidate } },
      acceptance: [{ id: '1', result: { revision: { candidate } } }, { id: '2', result: { revision: { candidate: before } } }] },
    ci: { evidence: { sha: candidate, satisfied: true, checks: [{ run: { url } }] } },
  })
  for (const [kind, sha] of [['docs', before], ['tests', candidate], ['repair', candidate]] as const) {
    const event = evidence.local.events.findLast((item: { kind: string }) => item.kind === kind)
    expect(event).toMatchObject({ read: expect.any(String) })
    expect(JSON.parse(String((await read(event.read)).text))).toMatchObject({ kind, revision: { base, candidate: sha } })
  }
  for (const lane of evidence.local.reviews) {
    expect(lane).toMatchObject({ read: expect.any(String) })
    expect(await read(lane.read)).toMatchObject({ base, candidate, axis: lane.axis, aggregate: 'passed' })
  }
  // Fault injection only: normal Workers cannot rewrite committed observations. Keep a later PASS in every case.
  const { tickets } = h.runtime.store
  const persisted = tickets.get(ticketId)!
  const ledger = persisted.deliveryCheck!
  const fixedIndex = Number(String(fixed.read).split('/').at(-1))
  for (const events of [
    ledger.events.map((event, index) => index === fixedIndex && event.kind === 'tests' ? { ...event, result: 'unverified' as const } : event),
    ledger.events.map(event => event.kind === 'acceptance' && event.revision.candidate === candidate
      ? { ...event, results: event.results.map(result => ({ ...result, evidence: [String(original.read)] })) } : event),
  ]) {
    tickets.save({ ...persisted, deliveryCheck: { events } })
    const replay = await inspect()
    expect(replay).toMatchObject({ ready: false, missing: expect.arrayContaining(['acceptance:1']) })
    expect(replay.missing).not.toContain('tests')
    expect(replay.missing).not.toContain('dual-review')
  }
  for (const events of [
    ledger.events.filter(event => event.kind !== 'repair'),
    ledger.events.map(event => event.kind === 'repair'
      ? { ...event, fixes: event.fixes.map(fix => ({ ...fix, id: 'another-finding' })) } : event),
  ]) {
    tickets.save({ ...persisted, deliveryCheck: { events } })
    const replay = await inspect()
    expect(replay).toMatchObject({ ready: false, missing: expect.arrayContaining(['repair:trailing-spaces']) })
    expect(replay.missing).not.toContain('dual-review')
  }
  tickets.save(persisted)
  expect(await inspect()).toMatchObject({ ready: true })
  expect(await read(`plan/${id}/node/labels`)).not.toHaveProperty('delivery')
  await h.runTool(session, 'orchestrator_report', { state: 'progress', pr_number: 29, summary: 'Review and acceptance recorded for this PR.' })
  expect(await inspect()).toMatchObject({ ready: true })
  holdCi = true
  const remoteRead = inspect()
  await Promise.race([querying.promise, remoteRead.then(() => { throw new Error('Did not request Actions for the PR') })])
  remoteHead = before
  releaseCi.resolve()
  expect(await remoteRead).toMatchObject({ ready: false, candidate, missing: expect.arrayContaining(['required_ci']) })
  remoteHead = candidate
  querying = Promise.withResolvers<void>(); releaseCi = Promise.withResolvers<void>()
  holdCi = true
  const delivery = inspect()
  await Promise.race([querying.promise, delivery.then(() => { throw new Error('Did not request CI for the candidate') })])
  const changed = commit('export const label = value => value.trim().toLowerCase()\n')
  releaseCi.resolve()
  expect(await delivery).toMatchObject({ ready: false, candidate: changed, missing: expect.arrayContaining(['delivery_target_changed']) })
  await review(changed)
  const regression = await tests(changed, "assert.equal(label(' ALERT '), 'ALERT')", 'failed')
  await submit(changed, { kind: 'first-retro', findings: [] })
  await expect(submit(changed, { kind: 'acceptance', results: [{ id: '1', status: 'failed', evidence: [regression.read] }] }))
    .resolves.toMatchObject({ recorded: 'acceptance', candidate: changed })
  await h.restart(); await h.runtime.idle()
  expect(await inspect()).toMatchObject({ ready: false, status: 'return_for_recheck', missing: expect.arrayContaining(['repair:1']) })
  expect(await read(`plan/${id}/node/labels`)).not.toHaveProperty('delivery')
}, 90_000)

it('checks documentation impact in the active worker candidate and never approves its semantics', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot Add a backend API contract'))
  const worktree = ticket.execution!.directory
  const git = (...args: string[]) => h.localGit!.git('-C', worktree, ...args)
  mkdirSync(join(worktree, 'docs'))
  writeFileSync(join(worktree, 'DOCS.md'), '# Docs\n\n| Name | Responsibility | Path |\n| --- | --- | --- |\n| API | Widget API | [Contract](docs/api.markdown) |\n')
  writeFileSync(join(worktree, 'docs/api.markdown'), '# Widget API\n\nPOST /widgets\n')
  git('add', 'DOCS.md', 'docs/api.markdown')
  git('commit', '-qm', 'add API documentation')
  const candidate = git('rev-parse', 'HEAD')
  writeFileSync(join(worktree, 'docs/api.markdown'), '# Uncommitted\n\n[Broken](missing.md)\n')
  const args = { candidate, root: 'DOCS.md', routes: [], leaves: ['docs/api.markdown'],
    impact: { kind: 'updated', documents: ['DOCS.md', 'docs/api.markdown'], contracts: ['docs/api.markdown'] } }
  const check = (input: unknown = args) => h.runTool(sessionId, 'orchestrator_doc_impact', input)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_doc_impact', args)).rejects.toThrow(/not registered/i)
  await expect(check()).resolves.toMatchObject({ candidate, base: h.localGit!.base.sha, structure: 'checked', issues: [], semantic_review: 'required', impact: args.impact })
  await expect(check({ ...args, impact: { kind: 'unchanged', reason: 'Internal-only refactor.' } })).rejects.toThrow(/changed/i)
  await expect(check({ ...args, impact: { ...args.impact, contracts: ['DOCS.md'] } })).rejects.toThrow(/leaf/i)
  git('add', 'docs/api.markdown')
  git('commit', '-qm', 'change candidate')
  await expect(check()).rejects.toThrow(/candidate|head/i)
  await expect(check({ ...args, candidate: git('rev-parse', 'HEAD') })).resolves.toMatchObject({
    structure: 'issues', issues: [expect.objectContaining({ kind: 'broken-link', path: 'docs/api.markdown' })], semantic_review: 'required',
  })
  git('switch', '-qc', 'wrong-branch')
  await expect(check({ ...args, candidate: git('rev-parse', 'HEAD') })).rejects.toThrow(/branch/i)
})

it('retains an unchanged impact rationale without treating missing navigation as checked', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot Refactor a private helper'))
  const worktree = ticket.execution!.directory
  const git = (...args: string[]) => h.localGit!.git('-C', worktree, ...args)
  writeFileSync(join(worktree, 'helper.ts'), 'const normalize = (name: string) => name.trim()\n')
  git('add', 'helper.ts')
  git('commit', '-qm', 'refactor helper')
  const candidate = git('rev-parse', 'HEAD')
  const reason = 'Only the private helper changed; callers still trim whitespace through the same entry point.'
  const impact = { kind: 'unchanged', reason }
  const args = { candidate, root: null, routes: [], leaves: [], impact }
  const report = await h.runTool(sessionId, 'orchestrator_doc_impact', args)
  expect(report).toMatchObject({ candidate, structure: 'not-applicable', issues: [], impact, semantic_review: 'required' })
  const summary = JSON.stringify(report)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary })
  const assignment = ticket.assignments[0]!.id
  writeFileSync(join(worktree, 'helper.ts'), 'const normalize = (name: string) => name.trimStart().trimEnd()\n')
  git('commit', '-qam', 'update the candidate')
  const amended = git('rev-parse', 'HEAD')
  await h.restart()
  await h.runtime.idle()
  expect(await read(`ticket/${ticket.id}/report/${assignment}`)).toMatchObject({ text: summary })
  await expect(h.runTool(sessionId, 'orchestrator_doc_impact', args)).rejects.toThrow(/candidate|HEAD/)
  await expect(h.runTool(sessionId, 'orchestrator_doc_impact', { ...args, candidate: amended }))
    .resolves.toMatchObject({ candidate: amended, semantic_review: 'required' })
})

it('reports replayable red and green runs for a public behavior in the Worker worktree', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('scoped-tdd', '@bot Trim the displayed label'))
  const worktree = ticket.execution!.directory
  const git = (...args: string[]) => h.localGit!.git('-C', worktree, ...args)
  const write = (path: string, text: string) => writeFileSync(join(worktree, path), text)
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  write('label.mjs', 'export const label = value => value\n')
  commit('add the public label formatter')
  write('label.test.mjs', `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { label } from './label.mjs'
test('trims a displayed label', () => assert.equal(label('  alert  '), 'alert'))\n`)
  const revision = commit('specify trimmed labels')
  const flags = ['--test', '--test-reporter=tap', 'label.test.mjs']
  const command = ['node', ...flags].join(' ')
  const run = () => spawnSync(process.execPath, flags, { cwd: worktree, encoding: 'utf8' })
  const red = run()
  expect(red.status).toBe(1)
  expect(red.stdout).toContain('ERR_ASSERTION')

  write('label.mjs', 'export const label = value => value.trim()\n')
  const candidate = commit('trim the label')
  const green = run()
  expect(green.status).toBe(0)
  expect(green.stdout).toContain('# pass 1')
  const args = { candidate, scope: 'focused', reason: 'The label formatter has one public entry and its source is the only affected module.',
    checks: [{ command, directory: '.', status: 'passed', observed: '# pass 1' }],
    red: [{ revision, command, directory: '.', observed: "ERR_ASSERTION: expected 'alert' for input '  alert  '" }] }
  const evidence = (input: unknown = args) => h.runTool(sessionId, 'orchestrator_test_evidence', input)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_test_evidence', args)).rejects.toThrow(/not registered/i)
  await expect(evidence({ ...args, checks: [] })).resolves.toMatchObject({ result: 'unverified' })
  await expect(evidence({ ...args, red: [] })).resolves.toMatchObject({ result: 'unverified' })
  for (const status of ['not_run', 'pending', 'cancelled', 'failed']) {
    await expect(evidence({ ...args, checks: [{ ...args.checks[0], status }] })).resolves.toMatchObject({
      result: status === 'failed' ? 'failed' : 'unverified',
    })
  }
  await expect(evidence({ ...args, checks: [{ ...args.checks[0], command: 'node --test another.test.mjs' }] }))
    .resolves.toMatchObject({ result: 'unverified' })
  await expect(evidence({ ...args, red: [{ ...args.red[0], revision: candidate }] })).rejects.toThrow(/precede/i)
  git('tag', '-a', 'candidate-label', '-m', 'candidate label')
  const tag = git('rev-parse', 'refs/tags/candidate-label')
  await expect(evidence({ ...args, red: [{ ...args.red[0], revision: tag }] })).rejects.toThrow(/commit hash/i)
  const result = await evidence()
  expect(result).toMatchObject({ ...args, base: h.localGit!.base.sha, result: 'reported_passed', source: 'worker' })
  const summary = JSON.stringify(result)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary })
  write('label.mjs', 'export const label = value => value.trimStart().trimEnd()\n')
  await expect(evidence()).rejects.toThrow(/clean/i)
  commit('revise candidate')
  await h.restart()
  await h.runtime.idle()
  expect(await read(`ticket/${ticket.id}/result`)).toMatchObject({ text: summary })
  await expect(evidence()).rejects.toThrow(/HEAD/i)
}, 45_000) // Repeated native Git checks and a runtime restart exceeded 20 s on Windows CI.

it('reads configured GitHub Actions evidence for a ticket at its complete commit SHA', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const sha = 'a'.repeat(40)
  const git = checkouts({ [ticket.execution!.directory]: { sha } })
  const settings = h.runtime.store.settings()
  expect(await h.api('PUT', 'settings/source:github', {
    value: { ...settings.sources.github!, config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } },
    revision: h.runtime.store.blockRevision('source:github') })).toMatchObject({ status: 200 })
  expect(JSON.parse((await read('settings/source:github') as { text: string }).text).value.config.requiredChecks).toEqual([{ id: 'build', workflowId: '4' }])
  const gh = vi.spyOn(Commands.prototype, 'gh')
    .mockResolvedValueOnce({ total_count: 1, workflow_runs: [
      { id: 21, workflow_id: 4, run_number: 1, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/21' },
    ] })
    .mockResolvedValueOnce({ total_count: 1, jobs: [
      { id: 37, run_id: 21, run_attempt: 1, head_sha: sha, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/21/job/37' },
    ] })
    .mockResolvedValueOnce({ total_count: 0, artifacts: [] })
  const evidence = JSON.parse((await read(`actions/ticket/${ticket.id}/commit/${sha}`) as { text: string }).text)
  expect(evidence).toMatchObject({ provider: 'github-actions', repository: 'acme/widgets', work: { kind: 'ticket', id: ticket.id }, sha,
    required: ['build'], satisfied: true, checks: [{ name: 'build', status: 'completed', conclusion: 'success', passed: true }] })
  expect(gh.mock.calls[0]![0]).toEqual(['api', `repos/acme/widgets/actions/runs?head_sha=${sha}&per_page=100&page=1`])
  expect(git.mock.calls.map(([args]) => args)).toEqual([
    ['rev-parse', '--show-toplevel'], ['remote', 'get-url', 'origin'], ['rev-parse', '--verify', 'HEAD'],
  ])
})

it('binds ticket and handoff evidence to their own commit SHA and required job names', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const { handoff } = h.runtime.handoffs.confirm({ project: { repository: 'acme/widgets', workspace: 'workspaces/widgets' },
    goal: 'Verify the release plan', constraints: [], acceptanceScope: ['CI passes'],
    authorization: { scope: 'Verify CI', release: 'authorized' },
    confirmedBy: { sessionId: h.runtime.masterId, messageId: 'confirm-1', text: 'Confirmed plan' } })
  const shaTicket = 'a'.repeat(40), shaPlan = 'b'.repeat(40)
  checkouts({ [ticket.execution!.directory]: { sha: shaTicket }, [handoff.project.workspace]: { sha: shaPlan } })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!,
    config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'release / build', workflowId: '4' }] } } } })
  const gh = vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([, path]) => {
    const sha = path?.includes('head_sha=') ? path.split('head_sha=')[1]?.split('&')[0] : path?.includes('/runs/11/') ? shaTicket : shaPlan
    const run = sha === shaTicket ? 11 : 22
    if (path?.includes('head_sha=')) return { total_count: 1, workflow_runs: [
      { id: run, workflow_id: 4, run_number: 1, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: `https://github.com/acme/widgets/actions/runs/${run}` },
    ] }
    if (path?.includes('/jobs?')) return { total_count: 1, jobs: [
      { id: run + 100, run_id: run, run_attempt: 1, head_sha: sha, name: 'release / build', status: 'completed', conclusion: 'success',
        html_url: `https://github.com/acme/widgets/actions/runs/${run}/job/${run + 100}` },
    ] }
    if (path?.includes('/artifacts?')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub API path: ${path}`)
  })
  const evidence = async (resource: string) => JSON.parse((await read(resource) as { text: string }).text)
  const ticketEvidence = await evidence(`actions/ticket/${ticket.id}/commit/${shaTicket}`)
  const planEvidence = await evidence(`actions/plan/${handoff.id}/commit/${shaPlan}`)
  expect(ticketEvidence).toMatchObject({ work: { kind: 'ticket', id: ticket.id }, sha: shaTicket, required: ['release / build'], satisfied: true,
    checks: [{ name: 'release / build', run: { id: 11 } }] })
  expect(planEvidence).toMatchObject({ work: { kind: 'plan', id: handoff.id }, sha: shaPlan, required: ['release / build'], satisfied: true,
    checks: [{ name: 'release / build', run: { id: 22 } }] })
  expect(gh.mock.calls.filter(([args]) => args[1]?.includes('head_sha=')).map(([args]) => args[1])).toEqual([
    `repos/acme/widgets/actions/runs?head_sha=${shaTicket}&per_page=100&page=1`,
    `repos/acme/widgets/actions/runs?head_sha=${shaPlan}&per_page=100&page=1`,
  ])
})

it('does not count unconfigured or missing required Actions jobs as passing evidence', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const sha = 'c'.repeat(40), resource = `actions/ticket/${ticket.id}/commit/${sha}`
  checkouts({ [ticket.execution!.directory]: { sha } })
  const gh = vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([, path]) => {
    if (path?.includes('head_sha=')) return { total_count: 1, workflow_runs: [
      { id: 31, workflow_id: 4, run_number: 1, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/31' },
    ] }
    if (path?.includes('/jobs?')) return { total_count: 1, jobs: [
      { id: 32, run_id: 31, head_sha: sha, name: 'build', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/acme/widgets/actions/runs/31/job/32' },
    ] }
    if (path?.includes('/artifacts?')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub API path: ${path}`)
  })
  const unconfigured = JSON.parse((await read(resource) as { text: string }).text)
  expect(unconfigured).toMatchObject({ required: [], satisfied: false, reason: 'required_checks_unconfigured' })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!,
    config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'build', workflowId: '4' }, { id: 'lint', workflowId: '4' }] } } } })
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read(resource, { offset, limit: 70 }) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  expect(JSON.parse(text)).toMatchObject({ required: ['build', 'lint'], satisfied: false })
  expect(gh.mock.calls.every(([args]) => !args[1]?.includes('/logs'))).toBe(true)
})

it('refuses unowned or malformed Actions resources and never exposes them to worker Sessions', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const sha = 'd'.repeat(40)
  const gh = vi.spyOn(Commands.prototype, 'gh').mockClear()
  for (const resource of [`actions/ticket/missing/commit/${sha}`, `actions/plan/missing/commit/${sha}`]) {
    await expect(read(resource)).rejects.toThrow('Unknown ticket or handoff')
  }
  for (const invalid of [sha.slice(1), sha.toUpperCase(), `${sha}d`, `${sha}\n`, `../../${sha}`]) {
    await expect(read(`actions/ticket/${ticket.id}/commit/${invalid}`)).rejects.toThrow('Use actions/')
  }
  await expect(read(`actions/other/${ticket.id}/commit/${sha}`)).rejects.toThrow('Use actions/')
  for (const resource of [`actions/ticket/${ticket.id}/commit/${sha}`, `actions/plan/missing/commit/${sha}`]) {
    await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('belongs to the main Session')
  }
  expect(gh).not.toHaveBeenCalled()
})

it('refuses unrelated green SHAs for existing tickets and handoffs before asking Actions', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const { handoff } = h.runtime.handoffs.confirm({ project: { repository: 'acme/widgets', workspace: 'workspaces/widgets' },
    goal: 'Verify the release plan', constraints: [], acceptanceScope: ['CI passes'],
    authorization: { scope: 'Verify CI', release: 'authorized' },
    confirmedBy: { sessionId: h.runtime.masterId, messageId: 'confirm-1', text: 'Confirmed plan' } })
  const unrelated = 'e'.repeat(40)
  checkouts({ [ticket.execution!.directory]: { sha: 'a'.repeat(40) }, [handoff.project.workspace]: { sha: 'b'.repeat(40) } })
  const gh = vi.spyOn(Commands.prototype, 'gh').mockResolvedValue({ total_count: 1, workflow_runs: [
    { id: 1, workflow_id: 4, run_number: 1, head_sha: unrelated, run_attempt: 1, status: 'completed', conclusion: 'success' },
  ] })
  await expect(read(`actions/ticket/${ticket.id}/commit/${unrelated}`)).rejects.toThrow('not verified for this ticket')
  await expect(read(`actions/plan/${handoff.id}/commit/${unrelated}`)).rejects.toThrow('not verified for this plan')
  expect(gh).not.toHaveBeenCalled()
})

it('refuses handoffs for another repository and ticket directories that cannot prove repository ownership', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const { handoff } = h.runtime.handoffs.confirm({ project: { repository: 'other/widgets', workspace: 'workspaces/widgets' },
    goal: 'Verify the release plan', constraints: [], acceptanceScope: ['CI passes'],
    authorization: { scope: 'Verify CI', release: 'authorized' },
    confirmedBy: { sessionId: h.runtime.masterId, messageId: 'confirm-1', text: 'Confirmed plan' } })
  const sha = 'a'.repeat(40)
  const git = checkouts({ [ticket.execution!.directory]: { sha, remote: 'git@github.com:other/widgets.git' } })
  const gh = vi.spyOn(Commands.prototype, 'gh').mockResolvedValue({ total_count: 0, workflow_runs: [] })
  await expect(read(`actions/plan/${handoff.id}/commit/${sha}`)).rejects.toThrow('repository differs')
  expect(git).not.toHaveBeenCalled()
  await expect(read(`actions/ticket/${ticket.id}/commit/${sha}`)).rejects.toThrow('not verified for this ticket')
  git.mockResolvedValueOnce(`${ticket.execution!.directory}-parent\n`)
  await expect(read(`actions/ticket/${ticket.id}/commit/${sha}`)).rejects.toThrow('not verified for this ticket')
  git.mockRejectedValue(new Error('Checkout unavailable'))
  await expect(read(`actions/ticket/${ticket.id}/commit/${sha}`)).rejects.toThrow('not verified for this ticket')
  expect(gh).not.toHaveBeenCalled()
})

async function acceptEvidencePr(own: boolean) {
  const { ticket } = await h.acceptedTicket(own ? feishu('1', '@bot 修一下回归') : commentTrigger({
    id: 1, body: '@agent-bot please fix the regression', user: { login: 'alice' },
    html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-1', created_at: new Date().toISOString(),
  }, { number: 42, isPr: true }, 'conversation', 'agent-bot'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '42' }, own)
  return ticket
}

it.each([['own', true], ['source', false]] as const)('accepts only a current %s PR head and its matching PR run, never a merge SHA lookup', async (_kind, own) => {
  const ticket = await acceptEvidencePr(own)
  const sha = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!,
    config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } } } })
  const git = vi.spyOn(Commands.prototype, 'git').mockClear().mockRejectedValue(new Error('The PR proves ownership without a local checkout'))
  const gh = vi.spyOn(Commands.prototype, 'gh').mockClear().mockImplementation(async ([, path]) => {
    if (path === 'repos/acme/widgets/pulls/42') return { head: { sha, repo: { full_name: 'acme/widgets' } },
      base: { sha: base }, merge_commit_sha: merge }
    if (path?.includes('head_sha=')) return { total_count: 1, workflow_runs: [
      { id: 21, workflow_id: 4, run_number: 1, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/acme/widgets/actions/runs/21', pull_requests: [{ number: 42, head: { sha }, base: { sha: base } }] },
    ] }
    if (path?.includes('/jobs?')) return { total_count: 1, jobs: [
      { id: 37, run_id: 21, run_attempt: 1, head_sha: sha, name: 'build', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/acme/widgets/actions/runs/21/job/37' },
    ] }
    if (path?.includes('/artifacts?')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub API path: ${path}`)
  })
  const evidence = JSON.parse((await read(`actions/ticket/${ticket.id}/commit/${sha}`) as { text: string }).text)
  expect(evidence).toMatchObject({ work: { kind: 'ticket', id: ticket.id }, sha, satisfied: true,
    checks: [{ name: 'build', run: { id: 21 } }] })
  expect(gh.mock.calls[0]![0]).toEqual(['api', 'repos/acme/widgets/pulls/42'])
  expect(gh.mock.calls.find(([args]) => args[1]?.includes('head_sha='))?.[0][1]).toBe(
    `repos/acme/widgets/actions/runs?head_sha=${sha}&per_page=100&page=1`)
  expect(git).not.toHaveBeenCalled()
})

it.each([
  ['obsolete base on an own PR', true, 42, 'c'],
  ['obsolete base on an adopted PR', false, 42, 'c'],
  ['another PR with the same head and base as the adopted PR', false, 43, 'b'],
] as const)('does not pass a green run for %s', async (_label, own, runPull, runBase) => {
  const ticket = await acceptEvidencePr(own)
  const sha = 'a'.repeat(40), base = 'b'.repeat(40)
  checkouts({ [ticket.execution!.directory]: { sha } })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!,
    config: { ...settings.sources.github!.config, requiredChecks: [{ id: 'build', workflowId: '4' }] } } } })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([, path]) => {
    if (path === 'repos/acme/widgets/pulls/42') return { head: { sha, repo: { full_name: 'acme/widgets' } },
      base: { sha: base }, merge_commit_sha: 'd'.repeat(40) }
    if (path?.includes('head_sha=')) return { total_count: 1, workflow_runs: [
      { id: 21, workflow_id: 4, run_number: 1, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/acme/widgets/actions/runs/21', pull_requests: [{ number: runPull, head: { sha }, base: { sha: runBase.repeat(40) } }] },
    ] }
    if (path?.includes('/jobs?')) return { total_count: 1, jobs: [
      { id: 37, run_id: 21, run_attempt: 1, head_sha: sha, name: 'build', status: 'completed', conclusion: 'success', html_url: null },
    ] }
    if (path?.includes('/artifacts?')) return { total_count: 0, artifacts: [] }
    throw new Error(`Unexpected GitHub API path: ${path}`)
  })
  const evidence = JSON.parse((await read(`actions/ticket/${ticket.id}/commit/${sha}`) as { text: string }).text)
  expect(evidence).toMatchObject({ work: { kind: 'ticket', id: ticket.id }, sha, satisfied: false })
})

it('rejects a stale own PR or a PR whose head comes from another repository', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '42' }, true)
  const sha = 'a'.repeat(40)
  let head = 'b'.repeat(40), repository = 'acme/widgets'
  const gh = vi.spyOn(Commands.prototype, 'gh').mockImplementation(async ([, path]) => {
    if (path === 'repos/acme/widgets/pulls/42') return { head: { sha: head, repo: { full_name: repository } },
      base: { sha: 'c'.repeat(40) }, merge_commit_sha: 'd'.repeat(40) }
    throw new Error(`Actions must not be queried for an unowned PR: ${path}`)
  })
  await expect(read(`actions/ticket/${ticket.id}/commit/${sha}`)).rejects.toThrow('not verified for this ticket')
  head = sha; repository = 'other/widgets'
  await expect(read(`actions/ticket/${ticket.id}/commit/${sha}`)).rejects.toThrow('not verified for this ticket')
  expect(gh.mock.calls.map(([args]) => args[1])).toEqual([
    'repos/acme/widgets/pulls/42', 'repos/acme/widgets/pulls/42',
  ])
})

it('lists in prompts the built-in parts whose text changed since the team overrode them, and the built-in parts in prompts/defaults', async () => {
  const read = (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 8000 })
  expect(await read('prompts')).not.toHaveProperty('default_changed')
  // An override edited from the built-in text of an earlier version.
  importPromptSnapshot({ ...defaultPrompts(), overrides: { 'runtime/dispatch': { text: '## dispatch\nOurs.', base: 'earlier' } } }, 1)
  await h.restart()
  expect(await read('prompts')).toMatchObject({ default_changed: ['runtime/dispatch'] })
  // A text page at a time, which the whole text joins.
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read('prompts/defaults', offset) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  const defaults = JSON.parse(text) as { parts: Record<string, string> }
  expect(defaults.parts).toEqual(Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text])))
})

it('does not expose prompt saving to the main Session tools', () => {
  expect(h.tools.get(h.runtime.masterId)?.has('orchestrator_prompts_save')).toBe(false)
})

it('keeps the main Session\'s resources from an Executor Session, which lists only its own', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  for (const resource of ['tickets', 'triggers', 'threads', 'decisions', 'settings', 'prompts', 'models']) {
    await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('belongs to the main Session')
  }
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ ticket_id: ticket.id })
  type Registered = { description: string; parameters: { properties: { resource: { description: string } } } }
  const registered = h.tools.get(sessionId)!.get('orchestrator_read') as unknown as Registered
  const offered = registered.description + registered.parameters.properties.resource.description
  for (const { name, executor } of RESOURCES) expect(offered.includes(`${name}:`), name).toBe(!!executor)
  expect(offered).not.toMatch(/preview/i)
})

it('reads one Session\'s meter through the Hub resource and the HTTP route from the same persisted cursor, refusing unknown Sessions', async () => {
  const master = h.runtime.masterId, at = Date.parse('2026-11-18T02:00:00.000Z')
  const usage = { inputTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 40, reasoningTokens: 8, totalTokens: 200 }
  h.record(master, [
    { type: 'request/header', time: at, data: { header: { config: { provider: 'p', model: 'm1' } }, reason: 'initial' } },
    { type: 'request/context', time: at, data: { provider: 'p', model: 'm1', contextWindow: 128000 } },
    // The message and its stream report the one settlement; the meter must count the call once.
    { type: 'assistant/message', time: at + 1, data: { turn: 0, step: 0, usage,
      stream: [{ type: 'chunk', time: at + 1, chunk: { type: 'usage', usage } }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } },
  ])
  const view = await read(`session/${master}`)
  expect(view).toMatchObject({ session_id: master, inherited_events: 0, cursor: expect.any(Number),
    context: { provider: 'p', model: 'm1', capacity_tokens: 128000, occupied_tokens: null },
    usage: { input_tokens: 120, cache_read_tokens: 30, cache_write_tokens: 10, output_tokens: 40, reasoning_tokens: 8,
      known_components_total_tokens: 200, reported_total_tokens: 200, counted_calls: 1, total_complete: true, billing_status: 'not-final' } })
  // Both public entries answer from the one reading the meter persisted, so the same call is not counted again.
  const response = await h.api('GET', `sessions/${encodeURIComponent(master)}/meter`)
  expect(response.status).toBe(200)
  expect(response.body).toEqual(view)
  await expect(read('session/no-such-session')).rejects.toThrow('Unknown session')
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: `session/${master}` })).rejects.toThrow('belongs to the main Session')
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: `session/${sessionId}` })).rejects.toThrow('belongs to the main Session')
  // The Hub may read any Session's meter, while a worker can read neither its own nor another one.
  expect(await read(`session/${sessionId}`)).toMatchObject({ session_id: sessionId })
  // The grammar lists the resource to the main Session only; a worker's omits it, and the planner lists no resources at all.
  expect(RESOURCES.find(resource => resource.name === 'session/<id>')?.executor).toBeUndefined()
})

it('keeps Worker retry usage on the same Ticket and supports a project-only inspection role', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = (inputTokens: number, outputTokens: number, totalTokens: number) => ({ type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [], usage: { inputTokens, outputTokens, totalTokens } } })
  h.record(sessionId, [message(3, 1, 4)])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'Build broke after the first attempt.' })
  await h.runTool(h.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticket.id })
  await h.runtime.idle()
  h.record(sessionId, [message(2, 1, 3)])

  // A trusted lifecycle caller can register a read-only inspection without a Ticket or a Plan.
  const inspection = 'scheduled-inspection'
  await h.controller.create({ sessionId: inspection, workspaceId: h.directory })
  h.runtime.projectMeter.bind({ session_id: inspection, role: 'inspection' })
  h.record(inspection, [message(7, 1, 8)])
  expect(await read(`ticket/${ticket.id}/meter`)).toMatchObject({ attributed: { reported_total_tokens: 7, counted_calls: 2 },
    shared: { reported_total_tokens: 8 }, sessions: expect.arrayContaining([
      expect.objectContaining({ session_id: sessionId, roles: ['implementation', 'retry'], own: expect.objectContaining({ reported_total_tokens: 7 }) }),
      expect.objectContaining({ session_id: inspection, roles: ['inspection'], ticket_id: null, plan_id: null }),
    ]) })
  expect(await read('project/meter')).toMatchObject({ total: { reported_total_tokens: 15, counted_calls: 3 } })
})

it('answers every routing tool in one shape: the decision it recorded, why, and the ticket card', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const card = expect.objectContaining({ ticket_id: ticket.id })
  const run = (name: string, args: unknown) => h.runTool(h.runtime.masterId, name, args)
  const route = async (item: Record<string, unknown>) => ((await run('orchestrator_route', { decisions: [item] })).results as unknown[])[0]
  const other = feishu('3', '@bot 顺便看看这个')
  h.runtime.receive(other); await h.runtime.idle()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })).toEqual({ trigger_id: other.id, kind: 'attach',
    reason: expect.any(String), ticket: card })
  const status = await run('orchestrator_ticket_request_status', { ticket_id: ticket.id })
  expect(status).toEqual({ reason: 'The worker is not waiting; nothing was sent', ticket: card })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The build broke.' })
  expect(await run('orchestrator_ticket_retry', { ticket_id: ticket.id })).toEqual({ reason: 'Started a new assignment', ticket: card })
  const chatter = feishu('4', '@bot 谢谢')
  h.runtime.receive(chatter); await h.runtime.idle()
  expect(await route({ kind: 'ignore', trigger_id: chatter.id, reason: 'thanks' })).toEqual({ trigger_id: chatter.id, kind: 'ignore', decision: 'ignore',
    reason: 'thanks' })
  // A stop needs the person's stop message, which the gate judges; the ticket keeps the reason given.
  await expect(run('orchestrator_route', { decisions: [{ kind: 'stop', ticket_id: ticket.id, reason: 'Not needed after all' }] })).rejects.toThrow()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  const request = feishu('5', '@bot 不用修了')
  h.runtime.receive(request); await h.runtime.idle()
  const stopped = await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id, reason: 'Not needed after all' }) as { ticket: { state: string } }
  const ended = expect.objectContaining({ by: 'human', reason: 'Not needed after all' })
  expect(stopped).toEqual({ trigger_id: request.id, kind: 'stop', decision: 'stop', reason: 'Not needed after all',
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'stopped', ended }) })
  expect(TICKET_STATES).toContain(stopped.ticket.state)
})

it('routes several triggers in one call, in order, and answers a refused or failed item without undoing the others', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('2', '@bot 谢谢'), request = feishu('3', '@bot 另一个问题'), other = feishu('4', '@bot 顺便看看这个'), more = feishu('6', '@bot 还有这个')
  for (const trigger of [thanks, request, other, more]) h.runtime.receive(trigger)
  await h.runtime.idle()
  // One attach fails unexpectedly, as a busy database would.
  const attach = h.runtime.engine.attach.bind(h.runtime.engine)
  vi.spyOn(h.runtime.engine, 'attach').mockImplementation((ticketId, triggerId, note) => {
    if (triggerId === more.id) throw new Error('database is locked')
    return attach(ticketId, triggerId, note)
  })
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    // A stop without its ticket is refused, alone.
    { kind: 'stop', trigger_id: request.id },
    { kind: 'accept', trigger_id: request.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'attach', trigger_id: other.id, ticket_id: 'no-such-ticket' },
    { kind: 'attach', trigger_id: more.id, ticket_id: ticket.id },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: request.id, kind: 'stop', refused: 'stop needs ticket_id' },
    expect.objectContaining({ trigger_id: request.id, kind: 'accept', decision: 'accept', ticket: expect.objectContaining({ title: 'Other' }) }),
    { trigger_id: other.id, kind: 'attach', refused: 'Unknown ticket' },
    // An unexpected failure recorded nothing, which the item may be sent again for.
    { trigger_id: more.id, kind: 'attach', refused: 'Not recorded: database is locked; retry this item' },
  ])
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
})

it('refuses alone an item that lacks a field its kind needs or breaks a field\'s limit, naming the field, and ignores unused fields', async () => {
  const triggers = ['2', '3', '4', '5', '6'].map(id => feishu(id, `@bot 请求 ${id}`))
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  const [a, b, c, d, e] = triggers.map(trigger => trigger.id) as [string, string, string, string, string]
  const accept = { kind: 'accept', title: 'Fix', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: a },
    { ...accept, trigger_id: b, worktree_name: 'one-two-three-four-five' },
    { ...accept, trigger_id: c, worktree_name: 'fix-c', note: words(NOTE_WORDS + 1) },
    { ...accept, trigger_id: d, worktree_name: 'fix-d', title: '' },
    // Fields of another kind, null or not, are left unread.
    { kind: 'ignore', trigger_id: e, reason: 'chat', ticket_id: null, title: null, note: null },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: a, kind: 'accept', refused: 'accept needs worktree_name' },
    { trigger_id: b, kind: 'accept', refused: expect.stringMatching(/^worktree_name: /) },
    { trigger_id: c, kind: 'accept', refused: expect.stringMatching(new RegExp(`^note: .*${NOTE_WORDS} words`)) },
    { trigger_id: d, kind: 'accept', refused: 'accept needs title' },
    { trigger_id: e, kind: 'ignore', decision: 'ignore', reason: 'chat' },
  ])
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('decides a candidate\'s batch with its card\'s trigger: a second accept keeps the first, and no other decision contradicts it', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  h.runtime.receive(first); h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accept = { kind: 'accept', worktree_name: 'retitle', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: first.id, title: 'Retitle' },
    { ...accept, trigger_id: second.id, title: 'Another title' },
    { kind: 'ignore', trigger_id: second.id, reason: 'chat' },
  ] }) as { results: { ticket?: { ticket_id: string } }[] }
  const ticketId = results[0]!.ticket!.ticket_id
  expect(results).toEqual([
    expect.objectContaining({ trigger_id: first.id, decision: 'accept' }),
    expect.objectContaining({ trigger_id: second.id, decision: 'accept', reason: `Already accepted as ${ticketId}; title and acknowledgement unchanged` }),
    { trigger_id: second.id, kind: 'ignore', refused: `Decided in this call with ${first.id}, whose Decision took its batch` },
  ])
  expect(h.runtime.store.tickets.get(ticketId)!.title).toBe('Retitle')
})

it('states each routing field\'s limit in its description, which the schema leaves to the item\'s check', () => {
  type Schema = { parameters: { properties: { decisions: { items: { properties: Record<string, { description?: string }> } } } } }
  const fields = (h.tools.get(h.runtime.masterId)!.get('orchestrator_route') as unknown as Schema).parameters.properties.decisions.items.properties
  const limits: Record<string, string[]> = { title: ['200 characters'], worktree_name: ['kebab-case', '32 characters'],
    acknowledgement: [`${IM_WORDS} words`], note: [`${NOTE_WORDS} words`, 'Never add implementation instructions'], reason: ['500 characters'] }
  for (const [field, phrases] of Object.entries(limits)) for (const phrase of phrases) expect(fields[field]!.description, field).toContain(phrase)
})

it('stops one follow-up for each ticket it reached, in one call', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const two = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  // The second ticket follows the first's thread too, so a person's stop there reaches both.
  h.runtime.engine.bindThread(two.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  const stop = feishu('7', '都先停一下', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(stop); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'stop', trigger_id: stop.id, ticket_id: one.ticket.id }, { kind: 'stop', trigger_id: stop.id, ticket_id: two.ticket.id }] }) as
    { results: Record<string, unknown>[] }
  expect(results.map(result => result.decision)).toEqual(['stop', 'stop'])
  expect([one, two].map(item => h.runtime.store.tickets.get(item.ticket.id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
})

it('ignores a proactive candidate from its card beside other decisions, marked so, and leaves accepting one to an assessment', async () => {
  const chat = feishu('2', '中午吃什么', { mentions: [] }), thanks = feishu('3', '@bot 谢谢'), proposal = feishu('4', '把标题改短一点', { mentions: [] })
  for (const trigger of [chat, thanks, proposal]) h.runtime.receive(trigger)
  await h.runtime.pump(); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    { kind: 'accept', trigger_id: proposal.id, title: 'Shorter title', worktree_name: 'short-title', acknowledgement: '收到。' },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: chat.id, kind: 'ignore', decision: 'ignore', reason: 'Ignored from its card, without a rule assessment; Lunch chat.' },
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: proposal.id, kind: 'accept', refused: expect.stringContaining('assess proactive candidates with orchestrator_eval') },
  ])
})

it('returns where a reply stands: sent, or dropped when its conversation can no longer receive it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  const reply = (text: string) => h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text })
  expect(await reply('修好了。')).toEqual({ status: 'sent' })
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await reply('修好了，请看 PR。')).toEqual({ status: 'dropped' })
})

it('records a worker take-up without an acknowledgement and still relays its report to the Hub', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const followup = feishu('2', '还有这个', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(followup); await h.runtime.idle()
  // The accept acknowledgement already went out; the follow-up is the worker's to take up internally.
  vi.mocked(Commands.prototype.lark).mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id }))
    .toEqual({ trigger_id: followup.id, taken_up: true, reused: false })
  expect(h.runtime.store.receipts.get(key('ack', followup.id))).toBeUndefined()
  expect(h.runtime.store.replyStatus(key('ack', followup.id))).toBeUndefined()
  expect(h.runtime.store.triggers.disposition(followup.id)!.acked).toEqual([ticket.id])
  // The Hub's accept acknowledgement keeps its receipt and is not refreshed by the worker's take-up.
  expect(h.runtime.store.replyStatus(key('ack', trigger.id))).toBe('sent')
  expect(Commands.prototype.lark).not.toHaveBeenCalled()
  // A second take-up records nothing new and sends nothing.
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id }))
    .toEqual({ trigger_id: followup.id, taken_up: true, reused: true })
  expect(h.runtime.store.triggers.disposition(followup.id)!.acked).toEqual([ticket.id])
  expect(h.runtime.store.receipts.get(key('ack', followup.id))).toBeUndefined()
  // A person's message on a thread this ticket does not follow is not its work to take up.
  const stranger = feishu('3', '这个问题无关', { mentions: [], root_id: undefined })
  h.runtime.receive(stranger); await h.runtime.idle()
  await expect(h.runTool(sessionId, 'orchestrator_ack', { trigger_id: stranger.id })).rejects.toThrow('does not belong')
  expect(h.runtime.store.receipts.get(key('ack', stranger.id))).toBeUndefined()
  // Its report still reaches the Hub, while nothing reaches the person from the worker's tools.
  h.deliveries.mockClear()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Needs a decision.' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toEqual([expect.objectContaining({ kind: 'worker_report', state: 'blocked',
    ticket: expect.objectContaining({ ticket_id: ticket.id }) })])
  expect(h.runtime.store.receipts.get(key('ack', followup.id))).toBeUndefined()
})

it('checks an acknowledgement against the IM word limit, not a character count', async () => {
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accept = (acknowledgement: string) => h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement })
  await expect(accept(words(IM_WORDS + 1))).rejects.toThrow(`at most ${IM_WORDS} words`)
  expect(await accept(words(IM_WORDS))).toMatchObject({ decision: 'accept', ticket: { title: 'Fix' } })
})

it('saves a settings block by name, a Source\'s block with the Source\'s id', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const github = { config: h.runtime.store.settings().sources.github!.config, revision: h.runtime.store.blockRevision('source:github') }
  const off = { enabled: false, config: github.config }
  await expect(save({ block: 'source', value: off, revision: github.revision })).rejects.toThrow('source names the Source')
  await expect(save({ block: 'source:github', value: off, revision: github.revision })).rejects.toThrow()
  expect(await save({ block: 'source', source: 'github', value: off, revision: github.revision })).toMatchObject({ saved: true })
  expect(h.runtime.store.settings().sources.github?.enabled).toBe(false)
  expect(await save({ block: 'pause', value: { paused: true }, revision: 0 })).toEqual({ paused: true })
})

it('does not expose prompt preview or saving as main Session tools', () => {
  expect(h.tools.get(h.runtime.masterId)?.has('orchestrator_prompts_save')).toBe(false)
})

it('releases the tools it registered for a Session once its agent is disposed, and leaves the other Sessions\' tools', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const worker = `worker-${ticket.id}`
  expect(h.tools.get(worker)!.size).toBeGreaterThan(0)
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect([h.tools.get(worker)!.size, h.tools.get(h.runtime.masterId)!.size > 0]).toEqual([0, true])
  // Releasing again, as at shutdown, finds nothing left of it.
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect(h.tools.get(worker)!.size).toBe(0)
})

it('reads a thread by the key cards show: its label, tickets, latest decisions and triggers, newest first, also for its own worker', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const key = `feishu:${CHAT}:om_1`
  const threads = await read('threads') as { items: { thread: string; label: string; read: string }[] }
  expect(threads.items[0]).toMatchObject({ thread: key, label: '@bot 修一下回归', read: `thread/${key}` })
  const thread = await read(`thread/${key}`)
  expect(thread).toMatchObject({ thread: key, label: '@bot 修一下回归', tickets: [expect.objectContaining({ ticket_id: ticket.id })],
    decisions: [expect.objectContaining({ kind: 'accept', ticket_id: ticket.id })], items: [expect.objectContaining({ trigger_id: trigger.id, read: `trigger/${trigger.id}` })],
    next_offset: null })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `thread/${key}` })).toMatchObject({ thread: key })
  const elsewhere = feishu('5', '@bot 别的事', { chat_id: 'oc_other' })
  h.runtime.store.triggers.save(elsewhere)
  h.runtime.store.threads.save({ key: `feishu:oc_other:om_5`, ref: { source: 'feishu', id: 'oc_other:om_5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: 'thread/feishu:oc_other:om_5' })).rejects.toThrow('Unknown or inaccessible thread')
})

it('reads a ticket with the ids it is tied to, its reports by assignment, and its assignments and inputs a page at a time, each by the name its line gives or by its id', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  // Build pagination around the persisted live assignment rather than replacing its fenced writer.
  const at = (n: number) => `2026-10-05T00:${String(n).padStart(2, '0')}:00.000Z`
  const report = (n: number) => ({ state: 'progress' as const, summary: `Report ${n}: ${'checked the config and the build. '.repeat(46)}`.slice(0, 1500), at: at(n) })
  const earlierAssignments = [1, 2, 3, 4, 5, 6].map(n => ({ id: `a${n}`, state: 'ended' as const,
    report: report(n), createdAt: at(n) }))
  const inputs = Array.from({ length: 24 }, (_, n) => n === 23 ? { id: 'text:long', kind: 'text' as const, text: `Note: ${'check the margin on mobile as well. '.repeat(4)}`, at: at(n) }
    : n % 2 ? { id: `text:${n}`, kind: 'text' as const, text: `Note ${n}: check the margin.`, at: at(n) }
    : { id: `trigger:${n}`, kind: 'trigger' as const, triggerId: `trigger-${n}`, at: at(n) })
  const current = h.runtime.store.tickets.get(ticket.id)!
  const latest = current.assignments.at(-1)!
  h.runtime.store.tickets.save({ ...current, assignments: [...earlierAssignments, ...current.assignments.slice(0, -1),
    { ...latest, report: report(7) }], inputs: [...current.inputs, ...inputs] })
  type Page = { items: { read?: string; report: { read: string } }[]; next_resource?: string; next_offset?: number }
  const details = await read(`ticket/${ticket.id}`) as { inputs: Page; assignments: Page }
  expect(details).toMatchObject({ trigger_id: ticket.origin.triggerId, decision_id: ticket.decisionId, threads: [{ thread: `feishu:${CHAT}:om_1` }],
    inputs: { next_resource: `ticket/${ticket.id}/inputs`, next_offset: 10 }, assignments: { next_resource: `ticket/${ticket.id}/assignments`, next_offset: 3 } })
  expect([details.inputs.items.length, details.assignments.items.length]).toEqual([10, 3])
  // The earlier assignments read on, so a worker reaches every report it continues from.
  const earlier = await read(details.assignments.next_resource!, { offset: details.assignments.next_offset! }) as Page
  expect([earlier.items.map(item => (item as { id?: string }).id), earlier.next_offset]).toEqual([['a4', 'a3', 'a2'], 6])
  expect(await read(details.assignments.next_resource!, { offset: 6 })).toEqual({ next_offset: null,
    items: [expect.objectContaining({ id: 'a1', report: expect.objectContaining({ read: `ticket/${ticket.id}/report/a1` }) })] })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/report/a1` })).toMatchObject({ text: report(1).summary })
  expect(JSON.stringify(details).length).toBeLessThan(3000)
  const page = await read(details.inputs.items[0]!.read!) as { text: string }
  expect(page.text).toContain('check the margin on mobile as well.')
  // An Input also reads by the id it has on the ticket.
  expect(await read(`ticket/${ticket.id}/input/text:long`)).toMatchObject({ text: page.text })
  expect(await read(`ticket/${ticket.id}/inputs`, { offset: 20 })).toMatchObject({ items: expect.objectContaining({ length: 4 }), next_offset: null })
  expect(await read(details.assignments.items[0]!.report.read)).toMatchObject({ text: report(7).summary.slice(0, 4000) })
  vi.mocked(h.controller.inspect).mockResolvedValueOnce({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text: `I fixed the margin. ${'Details. '.repeat(20)}` }] } } }] } as never)
  const transcript = JSON.parse((await read(`ticket/${ticket.id}/transcript`) as { text: string }).text) as { preview: string; read: string }
  expect(transcript).toMatchObject({ preview: expect.stringMatching(/^I fixed the margin\./), read: `ticket/${ticket.id}/message/0` })
  expect(transcript.preview.length).toBeLessThanOrEqual(80)
})

it('reads a trigger once with the message it replies to and the messages around it on its thread, without the CI runs', async () => {
  const at = (minute: number) => `2026-10-06T00:0${minute}:00.000Z`
  const message = (id: string, minute: number, overrides: Record<string, unknown> = {}) => ({ ...feishu(id, `message ${id}`, { root_id: 'om_root', ...overrides }), at: at(minute) })
  const ci = (id: string, minute: number) => ({ ...message(id, minute), source: 'github', human: false, text: '{"check":"build"}', meta: { ci: true } })
  const asked = message('asked', 1), replying = message('reply', 3, { parent_id: 'om_asked' })
  for (const item of [message('root', 0, { root_id: undefined }), asked, ci('ci-1', 2), replying, ci('ci-2', 4), message('later', 5)]) h.runtime.store.triggers.save(item)
  const page = await read(`trigger/${replying.id}`)
  expect(page).toMatchObject({ trigger_id: replying.id, replied_to: { trigger_id: asked.id, read: `trigger/${asked.id}` },
    around: { before: { trigger_id: asked.id }, after: { trigger_id: feishu('later', '').id } }, text: 'message reply' })
  // The page holds the text once, and no pointer to itself.
  expect(page).not.toHaveProperty('preview')
  expect(page).not.toHaveProperty('read')
})

const relaysOf = (kind: string) => h.relays(h.runtime.masterId).filter(item => item.kind === kind)
const notices = () => h.agents.get(h.runtime.masterId)!.inject.mock.calls
  .map(([message]) => JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('')) as Record<string, unknown>)

it('shows a candidate with its thread\'s tickets open first, the tickets it reached, those its text names, and a short next step', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const a = first.ticket
  // Requests on its thread reach its worker, which hands back what is not its own; the main Session then routes them.
  const handBack = async (id: string) => {
    await h.runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: id, reason: 'Another change.' })
    await h.runtime.pump(); await h.runtime.idle()
  }
  const second = feishu('2', '@bot 另一个问题', { root_id: 'om_1' })
  h.runtime.receive(second); await h.runtime.idle()
  await handBack(second.id)
  const b = (await h.route({ kind: 'accept', trigger_id: second.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' })).ticket as
    { ticket_id: string }
  h.runtime.engine.stopTicket(b.ticket_id)
  // A follow-up reaches the live ticket without an Eval; handed back, its candidate shows where it went.
  const more = feishu('3', '@bot 还有按钮', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  await handBack(more.id)
  const followup = relaysOf('candidate').at(-1)!
  expect((followup.related_tickets as { ticket_id: string }[]).map(card => card.ticket_id)).toEqual([a.id, b.ticket_id])
  expect(followup).toMatchObject({ tickets_total: 2, delivered_to: [a.id], thread: `feishu:${CHAT}:om_1` })
  expect(String(followup.next_action).length).toBeLessThanOrEqual(100)
  // A message elsewhere that names a pull request reads the tickets that follow it.
  const thread = { key: 'github:123', ref: { source: 'github', id: '123' }, createdAt: '', subscriptions: [a.id], correlated: [], pending: [], meta: {} }
  h.runtime.store.threads.save(thread)
  h.runtime.receive(feishu('4', '@bot 看看 #123 的进展')); await h.runtime.idle()
  expect(relaysOf('candidate').at(-1)).toMatchObject({ related_tickets: [], tickets_total: 0, referenced_tickets: [{ ticket_id: a.id }] })
})

it('relays a worker\'s report with its ticket card and the start of its summary, and a question with the card alone', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await h.runtime.idle()
  expect(relaysOf('worker_attention').at(-1)).toEqual({ kind: 'worker_attention', state: 'progress', read: `ticket/${ticket.id}/result`,
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'person/answer', attention: expect.objectContaining({ question: 'Desktop too?' }) }) })
  const summary = 'Done. ' + 'Evidence. '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary, human_action: null })
  await h.runtime.idle()
  const report = relaysOf('worker_report').at(-1)!
  expect(report).toMatchObject({ ticket: { ticket_id: ticket.id, title: ticket.title }, trigger_id: trigger.id, state: 'ready', chars: summary.length,
    read: `ticket/${ticket.id}/result` })
  expect(String(report.summary)).toBe(summary.slice(0, 600))
  expect(report.ticket).not.toHaveProperty('preview')
  // The end of the ticket, which the ready report brought, comes with its card.
  expect(notices().at(-1)).toMatchObject({ ticket_ended: { ticket_id: ticket.id, state: 'completed' } })
})

it('tells the main Session of the settings, prompts, requeues and unsubscriptions others made, never of its own', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const evaluation = h.runtime.store.settings().eval
  await h.runtime.settings.save('eval', { ...evaluation, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  await h.runtime.idle()
  expect(notices().at(-1)).toEqual({ settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' })
  const before = notices().length
  await expect(save({ block: 'eval', value: { ...evaluation, mode: 'auto' }, revision: h.runtime.store.blockRevision('eval') }))
    .rejects.toThrow(/Only the operator can change the admission Policy/)
  expect(h.runtime.store.settings().eval.mode).toBe('observe')
  expect(await save({ block: 'eval', value: { ...evaluation, mode: 'observe', timeoutSeconds: evaluation.timeoutSeconds + 1 },
    revision: h.runtime.store.blockRevision('eval') })).not.toHaveProperty('context_delivery')
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('5', '@bot 谢谢')
  h.runtime.receive(thanks); await h.runtime.idle()
  await h.route({ kind: 'ignore', trigger_id: thanks.id, reason: 'thanks' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_trigger_requeue', { trigger_id: thanks.id })).toEqual({ queued: true })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_thread_unsubscribe', { thread: `feishu:${CHAT}:om_1` })).toEqual({ removed: true, thread: `feishu:${CHAT}:om_1` })
  await h.runtime.idle()
  expect(notices().slice(before).filter(notice => !('ticket_ended' in notice))).toEqual([])
})

it('answers a policy sync with the counts and what changed, not the whole list', async () => {
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_policy_sync', { source: 'feishu' })).toEqual({ source: 'feishu', allowed: 2, added: ['Bob'], removed: [] })
})

it('shows an Executor Session no id it cannot read: no Decision, no other ticket, no Trigger its ticket did not reach', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const another = feishu('2', '@bot 再修一个', { root_id: 'om_1' })
  h.runtime.receive(another); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another fix.' })
  const other = await h.acceptedTicket(another)
  const worker = (resource: string) => h.runTool(sessionId, 'orchestrator_read', { resource })
  const thread = await worker(`thread/feishu:${CHAT}:om_1`)
  expect(thread).not.toHaveProperty('tickets')
  expect(thread).not.toHaveProperty('decisions')
  for (const page of [thread, await worker(`ticket/${ticket.id}`), await worker(`trigger/${trigger.id}`)]) {
    const shown = JSON.stringify(page)
    expect(shown).not.toContain(ticket.decisionId)
    expect(shown).not.toContain(other.ticket.id)
  }
  expect(await read(`thread/feishu:${CHAT}:om_1`)).toMatchObject({ tickets: expect.arrayContaining([expect.objectContaining({ ticket_id: other.ticket.id })]),
    decisions: expect.arrayContaining([expect.objectContaining({ decision_id: ticket.decisionId })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ decision_id: ticket.decisionId })
})

it('marks the threads a worker follows for context apart from those a Source bound its ticket to', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '12' }, true)
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' })
  const { threads } = await read(`ticket/${ticket.id}`) as { threads: { thread: string }[] }
  expect(threads).toEqual(expect.arrayContaining([{ thread: `feishu:${CHAT}:om_1` }, { thread: 'github:12', bound: true }, { thread: 'github:9', context: true }]))
  expect(threads).toHaveLength(3)
})

it('gives a worker the other messages of the request its ticket was accepted from, in its first message and on its ticket', async () => {
  // Pause while receiving two messages so they are evaluated as a single batch.
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  await h.runtime.receive(first); await h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: second.id, title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const other = ticket.origin.triggerIds.find(id => id !== ticket.origin.triggerId)!
  expect(ticket.origin.triggerIds).toHaveLength(2)
  const message = h.relays(`worker-${ticket.id}`)[0]!
  expect(message.batch).toEqual([expect.objectContaining({ trigger_id: other, preview: expect.any(String), read: `trigger/${other}` })])
  const page = await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}` })
  expect(page).toMatchObject({ batch: [{ trigger_id: other, read: `trigger/${other}` }] })
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `trigger/${other}` })).toMatchObject({ trigger_id: other })
})
