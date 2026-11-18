/** Real Git worktrees observed through Runtime dispatch, ticket resources, and management HTTP. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands } from '../src/infra/commands.ts'
import { inspectWorktree } from '../src/executor/worktree.ts'
import { verifyDirectory } from '../src/infra/environment.ts'
import { waitUntil } from './fixtures/async.ts'
import { gitEnv, gitRepository, type GitRepository } from './fixtures/git.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const GitBaseSchema = z.object({ ref: z.string(), sha: z.string() })
/** Public execution facts: Git identity is published only after real verification, so it is absent on a rejected first attempt. */
const ExecutionSchema = z.object({
  repository: z.string().optional(), worktree: z.string().optional(), branch: z.string().optional(),
  base: GitBaseSchema.optional(), session: z.string().optional(),
  active_writer: z.object({ assignment: z.string(), session: z.string() }).nullable().optional(),
  preparation: z.object({ state: z.string(), reason: z.string().optional() }),
})
/** Only a successful preparation has all verified facts; parsing with this schema fails instead of reading a missing fact as undefined. */
const VerifiedExecutionSchema = ExecutionSchema.extend({
  repository: z.string(), worktree: z.string(), branch: z.string(), base: GitBaseSchema, session: z.string(),
  preparation: z.object({ state: z.literal('verified'), reason: z.string().optional() }),
})
const TicketViewSchema = z.object({ id: z.string(), sessionId: z.string(), execution: ExecutionSchema,
  assignments: z.array(z.object({ id: z.string() })) })
const ticketId = (result: Record<string, unknown>): string => z.object({ ticket: z.object({ ticket_id: z.string() }) }).parse(result).ticket.ticket_id

let h: Host
let repository: GitRepository
const prepare = 'git -C "$DSH_SUPERAGENT_REPOSITORY" worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_BASE_SHA"'

/** Run only this fixture's Git subprocesses for real; the host's unrelated CLI stubs remain unchanged. */
function enableRealGit(): void {
  const simulated = h.subprocess.spawn.getMockImplementation()!
  h.subprocess.spawn.mockImplementation(spec => {
    // The host fixture types only argv; Runtime supplies cwd and environment at this subprocess boundary.
    const call = spec as { argv: readonly string[]; cwd?: string; env?: Record<string, string> }
    if (call.argv[0] !== 'git' && call.argv[0] !== 'sh') return simulated(spec)
    let stdout = '', stderr = ''
    const reader = (text: () => string) => ({ readFrom: () => ({ text: text(), nextOffset: text().length, lossy: false }) })
    const done = Promise.resolve().then(() => {
      if (call.argv[0] === 'sh') expect(call.argv).toEqual(['sh', '-c', prepare])
      const args = call.argv[0] === 'sh'
        ? ['-C', repository.repository, 'worktree', 'add', '-b', `agent/${call.env?.DSH_SUPERAGENT_NAME}`, call.env?.DSH_SUPERAGENT_DIR ?? '', call.env?.DSH_SUPERAGENT_BASE_SHA ?? '']
        : [...call.argv.slice(1)]
      try {
        stdout = execFileSync('git', args, { cwd: call.cwd, env: gitEnv(call.env), encoding: 'utf8' })
        return { exitCode: 0, signal: null }
      } catch (error) {
        const failure = error && typeof error === 'object' ? error : {}
        stderr = 'stderr' in failure ? String(failure.stderr) : String(error)
        return { exitCode: 'status' in failure && typeof failure.status === 'number' ? failure.status : 1, signal: null }
      }
    })
    return { done, collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) } }
  })
  vi.mocked(Commands.prototype.git).mockImplementation(async (args, cwd) => {
    try { return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }) }
    catch (error) {
      const failure = error as { stderr?: string; status?: number }
      throw new CliError(String(failure.stderr ?? error).trim(), undefined, failure.status)
    }
  })
  const simulatedRun = vi.mocked(Commands.prototype.run).getMockImplementation()!
  vi.mocked(Commands.prototype.run).mockImplementation(async (program, args, cwd) => program === 'git'
    ? execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }) : simulatedRun(program, args, cwd))
}

async function detail(ticketId: string) {
  const response = await h.api('GET', `tickets/${ticketId}`)
  expect(response.status).toBe(200)
  return TicketViewSchema.parse(response.body)
}

/** Accept a candidate with launch held so the test can arrange a directory before preparation. */
async function queued(seed: string) {
  const trigger = feishu(seed, `@bot fix worktree ${seed}`)
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.runtime.settings.pause(true, 'panel')
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${seed}`, worktree_name: `fix-${seed === '1' ? 'one' : 'two'}`, acknowledgement: 'Accepted.' })
  await h.runtime.idle()
  const id = ticketId(result)
  return { id, directory: h.runtime.store.tickets.get(id)!.execution!.directory, sessionId: `worker-${id}` }
}

beforeEach(async () => {
  h = await startRuntime()
  repository = gitRepository(h.directory)
  enableRealGit()
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, repository: repository.repository, baseRef: 'HEAD', prepare },
    h.runtime.store.blockRevision('executor'), 'panel')
})
afterEach(async () => { await h.stop() })
vi.setConfig({ testTimeout: 30_000 })

it('binds two accepted tickets to separate real worktrees, Sessions, branches and pinned bases through both read surfaces', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const two = await h.acceptedTicket(feishu('2', '@bot fix two'))
  for (const item of [one, two]) {
    const view = await detail(item.ticket.id)
    const execution = VerifiedExecutionSchema.parse(view.execution)
    expect(view.sessionId).toBe(item.sessionId)
    expect(execution).toMatchObject({ repository: realpathSync(repository.repository), worktree: realpathSync(item.ticket.execution!.directory),
      branch: `agent/${item.ticket.execution!.name}`, base: { ref: 'HEAD', sha: repository.base.sha }, session: item.sessionId,
      active_writer: { assignment: view.assignments[0]!.id, session: item.sessionId }, preparation: { state: 'verified' } })
    expect(execution.preparation.reason).toBeUndefined()
    expect(repository.git('-C', execution.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(execution.branch)
    expect(repository.git('-C', execution.worktree, 'rev-parse', 'HEAD')).toBe(repository.base.sha)
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${item.ticket.id}` }))
      .toMatchObject({ execution })
  }
  writeFileSync(join(one.ticket.execution!.directory, 'shared.txt'), 'ticket one only\n')
  expect(readFileSync(join(one.ticket.execution!.directory, 'shared.txt'), 'utf8')).toBe('ticket one only\n')
  expect(readFileSync(join(two.ticket.execution!.directory, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('creates independent sibling worktrees with built-in prepare after destination checks', async () => {
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, prepare: '' },
    h.runtime.store.blockRevision('executor'), 'panel')
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const two = await h.acceptedTicket(feishu('2', '@bot fix two'))
  const first = VerifiedExecutionSchema.parse((await detail(one.ticket.id)).execution)
  const second = VerifiedExecutionSchema.parse((await detail(two.ticket.id)).execution)
  expect(dirname(first.worktree)).toBe(dirname(second.worktree))
  expect(first.worktree).not.toBe(second.worktree)
  expect(first.active_writer).toMatchObject({ session: one.sessionId })
  expect(second.active_writer).toMatchObject({ session: two.sessionId })
  expect(readFileSync(join(first.worktree, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(second.worktree, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('rejects a configured clone from another GitHub repository before preparing a ticket', async () => {
  const ticket = await queued('1')
  const foreignRoot = join(h.directory, 'foreign')
  mkdirSync(foreignRoot)
  const foreign = gitRepository(foreignRoot)
  foreign.git('remote', 'set-url', 'origin', 'git@github.com:someone-else/another-project.git')
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, repository: foreign.repository },
    h.runtime.store.blockRevision('executor'), 'panel')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const view = await detail(ticket.id)
  expect(view.execution.preparation).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/origin|repository|github/i) })
  expect(view.execution.active_writer).toBeNull()
  expect(h.agents.has(ticket.sessionId)).toBe(false)
  expect(existsSync(ticket.directory)).toBe(false)
  expect(readFileSync(join(foreign.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('rejects a ticket root nested in the main checkout without creating parent directories', async () => {
  const root = join(repository.repository, 'nested-root')
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, directory: root },
    h.runtime.store.blockRevision('executor'), 'panel')
  const ticket = await queued('1')
  expect(existsSync(root)).toBe(false)
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const view = await detail(ticket.id)
  expect(view.execution.preparation).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/inside|checkout|worktree/i) })
  expect(view.execution.active_writer).toBeNull()
  expect(h.agents.has(ticket.sessionId)).toBe(false)
  expect(existsSync(root)).toBe(false)
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('rejects a ticket root nested in another ticket worktree without touching its writer', async () => {
  const owner = await h.acceptedTicket(feishu('1', '@bot fix owner'))
  const ownerDirectory = owner.ticket.execution!.directory
  writeFileSync(join(ownerDirectory, 'shared.txt'), 'owner work\n')
  const root = join(ownerDirectory, 'nested-root')
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, directory: root },
    h.runtime.store.blockRevision('executor'), 'panel')
  const ticket = await queued('2')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const view = await detail(ticket.id)
  expect(view.execution.preparation).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/inside|checkout|worktree/i) })
  expect(view.execution.active_writer).toBeNull()
  expect(h.agents.has(ticket.sessionId)).toBe(false)
  expect(existsSync(root)).toBe(false)
  expect((await detail(owner.ticket.id)).execution.active_writer).toMatchObject({ session: owner.sessionId })
  expect(readFileSync(join(ownerDirectory, 'shared.txt'), 'utf8')).toBe('owner work\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('refuses a pre-existing ordinary directory without erasing its files or starting a worker', async () => {
  const ticket = await queued('1')
  mkdirSync(ticket.directory, { recursive: true })
  writeFileSync(join(ticket.directory, 'keep.txt'), 'not a worktree\n')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const view = await detail(ticket.id)
  expect(view.execution.preparation.state).toBe('rejected')
  expect(view.execution.preparation.reason).toMatch(/directory|worktree/i)
  expect(view.execution.active_writer).toBeNull()
  expect(h.agents.has(ticket.sessionId)).toBe(false)
  expect(readFileSync(join(ticket.directory, 'keep.txt'), 'utf8')).toBe('not a worktree\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('refuses another ticket’s worktree even through an alias, preserving its contents and writer', async () => {
  const owner = await h.acceptedTicket(feishu('1', '@bot fix owner'))
  const ticket = await queued('2')
  writeFileSync(join(owner.ticket.execution!.directory, 'shared.txt'), 'owner change\n')
  mkdirSync(dirname(ticket.directory), { recursive: true })
  symlinkSync(owner.ticket.execution!.directory, ticket.directory, process.platform === 'win32' ? 'junction' : 'dir')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  expect(realpathSync(ticket.directory)).toBe(realpathSync(owner.ticket.execution!.directory))
  const rejected = (await detail(ticket.id)).execution
  expect(rejected.preparation.state).toBe('rejected')
  expect(rejected.preparation.reason).toMatch(/ticket|owned|claim|worktree/i)
  expect(rejected).not.toHaveProperty('active_writer')
  expect((await detail(owner.ticket.id)).execution.active_writer).toMatchObject({ session: owner.sessionId })
  expect(readFileSync(join(owner.ticket.execution!.directory, 'shared.txt'), 'utf8')).toBe('owner change\n')
  expect(h.agents.has(ticket.sessionId)).toBe(false)
})

it('refuses a pre-existing worktree at the configured base without verified ownership, preserving its files', async () => {
  const ticket = await queued('1')
  repository.git('commit', '-q', '--allow-empty', '-m', 'new main base')
  const changed = repository.git('rev-parse', 'HEAD')
  expect(changed).not.toBe(repository.base.sha)
  const branch = `agent/${h.runtime.store.tickets.get(ticket.id)!.execution!.name}`
  repository.worktree(ticket.directory, branch, changed)
  writeFileSync(join(ticket.directory, 'keep.txt'), 'wrong base tree\n')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const view = await detail(ticket.id)
  // No inspection ever verified this worktree, so the public record carries no Git identity; the tree itself must stay untouched.
  expect(view.execution.preparation.state).toBe('rejected')
  expect(view.execution.preparation.reason).toMatch(/ownership|directory/i)
  expect(view.execution.active_writer).toBeNull()
  expect(h.agents.has(ticket.sessionId)).toBe(false)
  expect(repository.git('-C', ticket.directory, 'rev-parse', 'HEAD')).toBe(changed)
  expect(readFileSync(join(ticket.directory, 'keep.txt'), 'utf8')).toBe('wrong base tree\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('keeps one writer when another queued launch claims the same canonical worktree through an alias', async () => {
  const owner = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const contender = await queued('2')
  mkdirSync(dirname(contender.directory), { recursive: true })
  symlinkSync(owner.ticket.execution!.directory, contender.directory, process.platform === 'win32' ? 'junction' : 'dir')
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  const ownerView = await detail(owner.ticket.id)
  const execution = VerifiedExecutionSchema.parse(ownerView.execution)
  expect(execution).toMatchObject({ worktree: realpathSync(owner.ticket.execution!.directory), branch: `agent/${owner.ticket.execution!.name}`,
    base: { ref: 'HEAD', sha: repository.base.sha }, session: owner.sessionId,
    active_writer: { assignment: ownerView.assignments.at(-1)!.id, session: owner.sessionId } })
  const rejected = (await detail(contender.id)).execution
  expect(rejected.preparation.state).toBe('rejected')
  expect(rejected.preparation).toMatchObject({ reason: expect.stringMatching(/ticket|owned|claim|worktree|branch/i) })
  expect(rejected).not.toHaveProperty('active_writer')
  expect(h.agents.has(owner.sessionId)).toBe(true)
  expect(h.agents.has(contender.sessionId)).toBe(false)
  expect(realpathSync(contender.directory)).toBe(realpathSync(owner.ticket.execution!.directory))
  expect(repository.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
})

it('keeps one active writer when two accepted tickets concurrently claim the same directory', async () => {
  const other = await h.acceptedTicket(feishu('0', '@bot fix unrelated ticket'))
  const otherWorktree = other.ticket.execution!.directory
  writeFileSync(join(otherWorktree, 'shared.txt'), 'other ticket only\n')
  const triggers = [feishu('1', '@bot fix one'), feishu('2', '@bot fix two')]
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  await h.runtime.settings.pause(true, 'panel')
  // Acceptance uses unique ID-suffixed paths; collide only pending, unverified allocations before either Session starts.
  const worktree = join(realpathSync(h.directory), 'contested-worktree')
  const tickets = []
  for (const [index, trigger] of triggers.entries()) {
    const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${index + 1}`,
      worktree_name: `claim-${index + 1}`, acknowledgement: 'Accepted.' })
    const id = ticketId(accepted)
    const ticket = h.runtime.store.tickets.get(id)!
    expect(ticket.execution!.ownership).toBeUndefined()
    expect(ticket.assignments[0]!.state).toBe('pending')
    expect(h.agents.has(`worker-${id}`)).toBe(false)
    h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, directory: worktree } })
    tickets.push({ id, assignment: ticket.assignments[0]!.id, directory: ticket.execution!.directory,
      branch: `agent/${ticket.execution!.name}`, sessionId: `worker-${id}` })
  }
  await h.runtime.idle()
  const identity = { repository: realpathSync(repository.repository), commonDir: realpathSync(join(repository.repository, '.git')),
    worktree, base: { ref: 'HEAD', sha: repository.base.sha } }
  const barrier = Promise.withResolvers<void>()
  const attempts = tickets.map(async ticket => {
    await barrier.promise
    return h.runtime.engine.reserveExecution(ticket.id, ticket.assignment, { ...identity, branch: ticket.branch })
  })
  expect(tickets.every(ticket => h.runtime.store.tickets.get(ticket.id)!.execution!.ownership === undefined
    && h.runtime.store.tickets.get(ticket.id)!.execution!.directory === worktree)).toBe(true)
  expect(existsSync(worktree)).toBe(false)
  barrier.resolve()
  const results = await Promise.all(attempts)
  expect(results.filter(result => result.ok)).toHaveLength(1)
  const winnerIndex = results.findIndex(result => result.ok)
  const winner = tickets[winnerIndex]!, loser = tickets[1 - winnerIndex]!
  const granted = results[winnerIndex]!
  if (!granted.ok) throw new Error('No ticket obtained the worktree claim')
  expect(granted.value).toMatchObject({ ...identity, branch: winner.branch, ticket: winner.id, assignment: winner.assignment,
    verified: false })
  expect(results[1 - winnerIndex]).toMatchObject({ ok: false, reason: expect.stringMatching(/worktree|directory|owned|claim/i) })
  expect((await detail(winner.id)).execution).toMatchObject({ preparation: { state: 'reserved' }, active_writer: null })
  const rejected = (await detail(loser.id)).execution
  expect(rejected).toMatchObject({ preparation: { state: 'rejected', reason: expect.stringMatching(/worktree|directory|owned|claim/i) } })
  expect(rejected).not.toHaveProperty('active_writer')
  expect(rejected.worktree).toBeUndefined()
  expect(h.runtime.store.tickets.get(winner.id)!.assignments[0]!.writer).toMatchObject({ state: 'preparing',
    generation: granted.value.generation })
  expect(h.runtime.store.tickets.get(loser.id)!.execution!.ownership).toBeUndefined()
  expect(h.runtime.store.tickets.get(loser.id)!.assignments[0]!.writer).toBeUndefined()
  // Only the winning claim may prepare: inspect the real Git worktree and its worker config before granting a writer.
  repository.worktree(worktree, winner.branch, repository.base.sha)
  const inspected = await inspectWorktree(h.runtime.commands, { repository: granted.value.repository, directory: worktree,
    branch: winner.branch, base: granted.value.base, ticket: winner.id, assignment: winner.assignment,
    session: winner.sessionId, mode: 'fresh' })
  await verifyDirectory(worktree, h.ctx.subprocess, h.runtime.lifetime)
  expect(h.runtime.engine.recordExecutionVerified(granted.value, inspected)).toMatchObject({ ok: true })
  expect(h.runtime.engine.acquireExecutionWriter(granted.value, winner.sessionId)).toBe(true)
  expect(h.runtime.engine.acquireExecutionWriter({ ...granted.value, ticket: loser.id, assignment: loser.assignment,
    branch: loser.branch }, loser.sessionId)).toBe(false)
  const writer = VerifiedExecutionSchema.parse((await detail(winner.id)).execution)
  expect(writer).toMatchObject({ repository: identity.repository, worktree, branch: winner.branch, base: identity.base,
    session: winner.sessionId, active_writer: { assignment: winner.assignment, session: winner.sessionId } })
  const stillRejected = (await detail(loser.id)).execution
  expect(stillRejected.preparation.state).toBe('rejected')
  expect(stillRejected).not.toHaveProperty('active_writer')
  expect(readFileSync(join(worktree, 'shared.txt'), 'utf8')).toBe('baseline\n')
  for (const ticket of tickets) {
    expect(existsSync(ticket.directory)).toBe(false)
    expect(h.agents.has(ticket.sessionId)).toBe(false)
  }
  expect(repository.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3)
  expect((await detail(other.ticket.id)).execution.active_writer).toMatchObject({ session: other.sessionId })
  expect(readFileSync(join(otherWorktree, 'shared.txt'), 'utf8')).toBe('other ticket only\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('holds a retry until the previous Session stops, then reuses its owned tree after a worker commit', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const directory = one.ticket.execution!.directory
  repository.git('-C', directory, 'commit', '-q', '--allow-empty', '-m', 'worker progress')
  const progressed = repository.git('-C', directory, 'rev-parse', 'HEAD')
  const worker = h.agents.get(one.sessionId)
  if (!worker) throw new Error(`Worker ${one.sessionId} did not start`)
  const cancel = worker.cancel.getMockImplementation()
  // Keep the old turn running and swallow its cancel: DSH has not reported the old Session as idle yet.
  worker.status = 'running'
  worker.cancel.mockImplementation(() => { /* no idle report until this test releases it */ })
  let released = false
  try {
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'provider offline' })
    expect(await h.api('POST', `tickets/${one.ticket.id}/retry`)).toMatchObject({ status: 200, body: { retried: true } })
    await waitUntil(() => worker.cancel.mock.calls.length > 0)
    const waiting = await detail(one.ticket.id)
    expect(waiting.execution.session).toBe(one.sessionId)
    expect(waiting.execution.active_writer).toMatchObject({ assignment: one.ticket.assignments[0]!.id, session: one.sessionId })
    expect(h.relays(one.sessionId).filter(item => item.assignment === 2)).toEqual([])
    worker.status = 'idle'
    h.ctx.emit('agent/status', { agent: worker, status: 'idle' } as never)
    released = true
    await h.runtime.idle()
    // The new writer is granted before its prompt, so this waits for the release, re-verification and grant.
    await waitUntil(() => h.relays(one.sessionId).some(item => item.assignment === 2))
    const resumed = await detail(one.ticket.id)
    const execution = VerifiedExecutionSchema.parse(resumed.execution)
    expect(execution).toMatchObject({ worktree: realpathSync(directory), base: { ref: 'HEAD', sha: repository.base.sha },
      session: one.sessionId, active_writer: { assignment: resumed.assignments.at(-1)!.id, session: one.sessionId },
      preparation: { state: 'verified' } })
    expect(execution.preparation.reason).toBeUndefined()
    expect(repository.git('-C', directory, 'rev-parse', 'HEAD')).toBe(progressed)
    expect(h.relays(one.sessionId).filter(item => item.assignment === 2)).toHaveLength(1)
    expect(existsSync(join(directory, 'shared.txt'))).toBe(true)
  } finally {
    // An assertion before the manual idle must not leave the mock holding teardown's whenIdle() forever.
    if (cancel) worker.cancel.mockImplementation(cancel)
    if (!released) {
      worker.status = 'idle'
      h.ctx.emit('agent/status', { agent: worker, status: 'idle' } as never)
    }
  }
})

it('rejects retry after the configured clone switches to another GitHub repository', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const directory = one.ticket.execution!.directory
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  const worker = h.agents.get(one.sessionId)!
  worker.status = 'idle'
  h.ctx.emit('agent/status', { agent: worker, status: 'idle' } as never)
  await h.runtime.idle()
  const foreignRoot = join(h.directory, 'foreign')
  mkdirSync(foreignRoot)
  const foreign = gitRepository(foreignRoot)
  foreign.git('remote', 'set-url', 'origin', 'git@github.com:someone-else/another-project.git')
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, repository: foreign.repository },
    h.runtime.store.blockRevision('executor'), 'panel')
  expect(await h.api('POST', `tickets/${one.ticket.id}/retry`)).toMatchObject({ status: 200, body: { retried: true } })
  await h.runtime.idle()
  const view = await detail(one.ticket.id)
  expect(view.execution.preparation).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/origin|repository|github/i) })
  expect(view.execution.active_writer).toBeNull()
  expect(h.relays(one.sessionId).filter(item => item.assignment === 2)).toEqual([])
  expect(h.agents.get(one.sessionId)).toBe(worker)
  expect(readFileSync(join(directory, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(foreign.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('rejects retry when a previously verified clone changes its origin', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const directory = one.ticket.execution!.directory
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  const worker = h.agents.get(one.sessionId)!
  worker.status = 'idle'
  h.ctx.emit('agent/status', { agent: worker, status: 'idle' } as never)
  await h.runtime.idle()
  repository.git('remote', 'set-url', 'origin', 'https://github.com/acme/another-project.git')
  expect(await h.api('POST', `tickets/${one.ticket.id}/retry`)).toMatchObject({ status: 200, body: { retried: true } })
  await h.runtime.idle()
  const view = await detail(one.ticket.id)
  expect(view.execution.preparation).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/origin|repository|github/i) })
  expect(view.execution.active_writer).toBeNull()
  expect(h.relays(one.sessionId).filter(item => item.assignment === 2)).toEqual([])
  expect(h.agents.get(one.sessionId)).toBe(worker)
  expect(readFileSync(join(directory, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('refuses retrying a released ticket into a different ticket’s tree, without harming either tree', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  const two = await h.acceptedTicket(feishu('2', '@bot fix two'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  const old = h.agents.get(one.sessionId)!
  old.status = 'idle'
  h.ctx.emit('agent/status', { agent: old, status: 'idle' } as never)
  await h.runtime.idle()
  expect((await detail(one.ticket.id)).execution).toMatchObject({ session: one.sessionId, active_writer: null })
  const original = one.ticket.execution!.directory
  const moved = join(h.directory, 'moved-first')
  repository.git('worktree', 'move', original, moved)
  writeFileSync(join(two.ticket.execution!.directory, 'shared.txt'), 'ticket two only\n')
  symlinkSync(two.ticket.execution!.directory, original, process.platform === 'win32' ? 'junction' : 'dir')
  const response = await h.api('POST', `tickets/${one.ticket.id}/retry`)
  await h.runtime.idle()
  expect(response.status).toBe(200)
  const view = await detail(one.ticket.id)
  expect(view.execution.preparation.state).toBe('rejected')
  expect(view.execution.preparation.reason).toMatch(/ticket|owned|claim|branch|worktree/i)
  expect(view.execution.active_writer).toBeNull()
  expect((await detail(two.ticket.id)).execution).toMatchObject({ session: two.sessionId, active_writer: { session: two.sessionId } })
  expect(readFileSync(join(two.ticket.execution!.directory, 'shared.txt'), 'utf8')).toBe('ticket two only\n')
  expect(readFileSync(join(moved, 'shared.txt'), 'utf8')).toBe('baseline\n')
})

it('refuses retrying an owned branch that no longer descends from its pinned base', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot fix one'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  const worker = h.agents.get(one.sessionId)!
  worker.status = 'idle'
  h.ctx.emit('agent/status', { agent: worker, status: 'idle' } as never)
  await h.runtime.idle()
  expect((await detail(one.ticket.id)).execution).toMatchObject({ session: one.sessionId, active_writer: null })
  const directory = one.ticket.execution!.directory
  const tree = repository.git('rev-parse', 'HEAD^{tree}')
  const unrelated = repository.git('commit-tree', tree, '-m', 'unrelated root')
  repository.git('update-ref', `refs/heads/agent/${one.ticket.execution!.name}`, unrelated)
  expect(repository.git('-C', directory, 'rev-parse', 'HEAD')).toBe(unrelated)
  const response = await h.api('POST', `tickets/${one.ticket.id}/retry`)
  await h.runtime.idle()
  expect(response.status).toBe(200)
  const view = await detail(one.ticket.id)
  expect(view.execution.preparation.state).toBe('rejected')
  expect(view.execution.preparation.reason).toMatch(/base|ancestor|commit|sha/i)
  expect(view.execution).toMatchObject({ session: one.sessionId, base: { ref: 'HEAD', sha: repository.base.sha }, active_writer: null })
  expect(readFileSync(join(directory, 'shared.txt'), 'utf8')).toBe('baseline\n')
  expect(readFileSync(join(repository.repository, 'shared.txt'), 'utf8')).toBe('baseline\n')
})
