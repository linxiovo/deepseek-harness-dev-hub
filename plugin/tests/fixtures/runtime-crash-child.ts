/** Child process for runtime-crash.spec.ts. Real Runtime, SQLite and Git; deterministic DSH and GitHub boundaries. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../../src/app/runtime.ts'
import type { StateView, TicketPageView } from '../../src/app/http.ts'
import type { CreateProjectResult, RuntimeView } from '../../src/app/installation-api.ts'
import { workerSessionId } from '../../src/executor/dsh.ts'
import { Commands } from '../../src/infra/commands.ts'
import { githubKind } from '../../src/sources/github.ts'
import { commentTrigger } from '../../src/sources/github-trigger.ts'
import { testMachine } from './deployment.ts'
import { gitEnv, gitRepository } from './git.ts'

export type CrashPoint = 'switch' | 'dispatch' | 'merge'
export type Evidence = {
  mount: RuntimeView
  state: StateView
  pid: number
  target?: CreateProjectResult['project']
  ticket?: TicketPageView
}
export type Observation = { kind: 'delivery'; session: string; message: string }
  | { kind: 'merge' | 'pull-read'; number: number }

const [point, phase, root] = process.argv.slice(2) as [CrashPoint, 'crash' | 'recover', string]
const stateDir = join(root, 'installation')
const cli = join(root, 'fixture-gh')
const journal = join(root, 'observations.jsonl')
const prFile = join(root, 'pull.json')
const repository = 'acme/widgets', other = 'acme/gadgets', number = 42
const waiting = Promise.withResolvers<never>().promise
const mergeCommitted = Promise.withResolvers<void>()
const record = (event: Observation) => appendFileSync(journal, `${JSON.stringify(event)}\n`)

// The remote accepts the merge even while the response to the worker is blocked. Reads after restart see its committed state.
const github = async (args: readonly string[]): Promise<string> => {
  const [command, endpoint] = args
  if (command === 'pr' && endpoint === 'merge' && args[2] === String(number)) {
    record({ kind: 'merge', number }) // Count attempts, not just successful state changes.
    const pull = JSON.parse(readFileSync(prFile, 'utf8'))
    assert.equal(pull.state, 'open', 'The worker attempted to merge an already merged PR')
    writeFileSync(prFile, JSON.stringify({ ...pull, state: 'closed', merged: true, merged_at: new Date().toISOString() }))
    assert.equal(phase, 'crash')
    mergeCommitted.resolve()
    return waiting
  }
  assert.equal(command, 'api', `Unexpected GitHub call: ${args.join(' ')}`)
  if (endpoint === 'user') return '{"login":"agent-bot","id":7}'
  for (const slug of [repository, other]) {
    if (endpoint === `repos/${slug}`) return JSON.stringify({ name: slug, push: true })
  }
  if (endpoint === `repos/${repository}/issues/1/comments`) return args.includes('POST') ? '{"id":2}' : '[[]]'
  if (endpoint?.startsWith(`repos/${repository}/pulls?state=all&head=`)) return existsSync(prFile) ? '[{"number":42}]' : '[]'
  if (endpoint === `repos/${repository}/pulls/${number}`) {
    record({ kind: 'pull-read', number })
    return readFileSync(prFile, 'utf8')
  }
  throw new Error(`Unexpected GitHub call: ${args.join(' ')}`)
}
const run = Commands.prototype.run
Commands.prototype.run = function (program, args, cwd) {
  if (program === cli) return github(args)
  assert.equal(program, 'git', `Unexpected executable: ${program}`)
  return run.call(this, program, args, cwd)
}

// Use local Git for DSH's subprocess probes too. Only the GitHub CLI is substituted.
const subprocess = { spawn({ argv, cwd, env }: { argv: string[]; cwd: string; env?: Record<string, string> }) {
  const [program, ...args] = argv
  let stdout = '', stderr = ''
  const done = (async () => {
    if (program === cli) stdout = await github(args)
    else {
      assert.equal(program, 'git', `Unexpected worker executable: ${program}`)
      try { stdout = execFileSync(program, args, { cwd, env: gitEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (failure) {
        const error = failure as { status: number | null; stderr: string }
        stderr = error.stderr
        return { exitCode: error.status, signal: null }
      }
    }
    return { exitCode: 0, signal: null }
  })()
  return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
} }

type Tool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type Event = { seq: number; time: number; type: 'user/message'; data: UserMessage }
type SessionLog = { cwd: string; events: Event[] }
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
type Agent = {
  id: string; ctx: Context; session: { id: string; header: { cwd: string }; snapshotEvents: () => Event[] }
  inbox: { nextStep: UserMessage[]; nextTurn: UserMessage[]; remove: () => boolean }; readonly status: string
  followup(message: UserMessage): void; steer(message: UserMessage): void; inject(): void; cancel(): void; whenIdle(): Promise<void>
}
interface Host {
  runtime: Runtime
  dispatchUnconfirmed: Promise<void>
  api<T>(method: string, route: string, body?: unknown): Promise<T>
  idle(): Promise<void>
  tool<T>(id: string, name: string, args: unknown): Promise<T>
}

function mount(onRestart: () => void = () => {}): Host {
  const ctx = new Context()
  const agents = new Map<string, Agent>()
  const tools = new Map<string, Map<string, Tool>>()
  const logPath = (id: string) => join(root, `session-${id}.json`)
  const readLog = (id: string): SessionLog => JSON.parse(readFileSync(logPath(id), 'utf8'))
  const noOp = () => {}
  const dispatchUnconfirmed = Promise.withResolvers<void>()
  let workerDelivered = false
  let unexpectedReplay: Promise<string> | undefined
  function load(id: string) {
    const log = readLog(id)
    const session = { id, header: { cwd: log.cwd }, snapshotEvents: () => log.events }
    const sessionTools = new Map<string, Tool>()
    tools.set(id, sessionTools)
    const agentCtx = new Context()
    agentCtx.reflect.provide('tools', {
      register(tool: Tool) { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) },
      get: noOp, guard: () => noOp, restrict: () => noOp,
    })
    agentCtx.reflect.provide('skills', { register: () => noOp })
    agentCtx.reflect.provide('systemPrompt', { section: () => noOp })
    const inbox = { nextStep: [], nextTurn: [], remove: () => false }
    let status = 'idle'
    const deliver = (message: UserMessage) => {
      record({ kind: 'delivery', session: id, message: message.id })
      const event = { seq: log.events.length, time: Date.now(), type: 'user/message' as const, data: message }
      log.events.push(event)
      writeFileSync(logPath(id), JSON.stringify(log))
      ctx.emit('session/event', session as never, event as never)
      if (!id.startsWith('worker-')) return
      workerDelivered = true
      status = 'running'
      // A worker awakened after losing its CLI response would try the unresolved operation again. Do not dedupe this in the fake.
      if (point === 'merge' && phase === 'recover') {
        unexpectedReplay = runtime.commands.run(cli, ['pr', 'merge', String(number)])
        void unexpectedReplay.catch(() => {}) // Re-throw after draining the runtime, with the attempt still counted.
      }
    }
    return { id, ctx: agentCtx, session, inbox, get status() { return status },
      followup: deliver, steer: deliver, inject: noOp, cancel: () => { status = 'idle' }, whenIdle: async () => {} }
  }
  let http!: HttpHandler
  const services = {
    agents: Object.assign(agents, { list: () => [...agents.values()] }),
    sessionController: {
      async create({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
        assert(!existsSync(logPath(sessionId)), `Session ${sessionId} already exists`)
        writeFileSync(logPath(sessionId), JSON.stringify({ cwd: workspaceId, events: [] }))
      },
      async resolveAgent(id: string) {
        if (!agents.has(id) && existsSync(logPath(id))) agents.set(id, load(id))
        const agent = agents.get(id)
        return agent ? { agent } : { error: { code: 'session/not-found' } }
      },
      rename: async () => {}, selectModel: async () => {},
    },
    sessionPersistence: {
      async flush() {
        if (point === 'dispatch' && phase === 'crash' && workerDelivered) {
          dispatchUnconfirmed.resolve()
          await waiting
        }
      },
      async open(id: string) {
        const log = readLog(id)
        return { read: async (offset: number, count: number) => ({ events: log.events.slice(offset, offset + count) }),
          [Symbol.asyncDispose]: async () => {} }
      },
    },
    llm: { resolveCallConfig: async (value: unknown) => value },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: noOp }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return noOp } },
  }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const runtime = new Runtime(ctx, testMachine({ stateDir, runtimeMode: 'headless' }), onRestart)
  runtime.sources.register(githubKind)
  async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
    let status = 0, text = ''
    await http({ method, url: `/orchestrator/api/${route}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    assert.equal(status, 200, `${method} ${route}: ${text}`)
    return JSON.parse(text) as T
  }
  return {
    runtime, api, dispatchUnconfirmed: dispatchUnconfirmed.promise,
    async idle() { await runtime.idle(); await unexpectedReplay },
    async tool<T>(id: string, name: string, args: unknown): Promise<T> {
      const tool = tools.get(id)?.get(name)
      assert(tool, `No ${name} tool in Session ${id}`)
      return await tool.execute(args, { signal: runtime.lifetime }) as T
    },
  }
}

async function snapshot(host: Host, ticketId?: string): Promise<Evidence> {
  return { mount: await host.api('GET', 'runtime'), state: await host.api('GET', 'state'), pid: process.pid,
    ...(ticketId ? { ticket: await host.api<TicketPageView>('GET', `tickets/${ticketId}`) } : {}) }
}
function send(evidence: Evidence) {
  const sent = Promise.withResolvers<void>()
  process.send!(evidence, error => error ? sent.reject(error) : sent.resolve())
  return sent.promise
}

async function crash(): Promise<Evidence> {
  writeFileSync(cli, 'Fixture executable reference; only local Git can run\n', { mode: 0o755 })
  const firstGit = gitRepository(root)
  const bootstrap = mount()
  await bootstrap.runtime.ready
  const verified = await bootstrap.api<{ status: string }>('POST', 'onboarding/github/verify', { cli })
  assert.equal(verified.status, 'ready', JSON.stringify(verified))
  const create = (host: Host, slug: string, workspace: string) => host.api<CreateProjectResult>('POST', 'projects', {
    repository: slug, workspace, baseRef: firstGit.base.ref, policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
  })
  const first = await create(bootstrap, repository, firstGit.repository)
  await bootstrap.runtime.stop()
  const remount = Promise.withResolvers<void>()
  const host = mount(remount.resolve) // The test owns the restart callback; leave the old mount alive at the barrier.
  await host.runtime.ready
  assert.equal((await host.api<RuntimeView>('GET', 'runtime')).status, 'ready', JSON.stringify(await host.api('GET', 'state')))
  assert.equal(host.runtime.masterId, first.project.hubSessionId)
  if (point === 'switch') {
    const secondRoot = join(root, 'second')
    mkdirSync(secondRoot)
    const secondGit = gitRepository(secondRoot)
    secondGit.git('remote', 'set-url', 'origin', `https://github.com/${other}.git`)
    const { project: target } = await create(host, other, secondGit.repository)
    const selected = await host.api<CreateProjectResult>('POST', `projects/${target.id}/select`)
    assert.equal(selected.restarting, true)
    await remount.promise
    return { ...await snapshot(host), target }
  }
  const trigger = commentTrigger({ id: 1, body: '@agent-bot please fix saving', user: { login: 'alice' },
    html_url: `https://github.com/${repository}/issues/1#issuecomment-1`, created_at: new Date().toISOString() },
  { number: 1, isPr: false }, 'conversation', 'agent-bot')!
  host.runtime.receive(trigger)
  await host.idle()
  const { results: [decision] } = await host.tool<{ results: [{ ticket?: { ticket_id: string }; refused?: string }] }>(host.runtime.masterId,
    'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id, title: 'Fix saving',
      worktree_name: 'fix-saving', acknowledgement: 'I will fix saving.' }] })
  assert(decision.ticket, JSON.stringify(decision))
  const id = decision.ticket.ticket_id
  if (point === 'dispatch') {
    // Once DSH persisted the delivery, hold its flush response before assignmentStarted. No timing race with the killer.
    await host.dispatchUnconfirmed
    return snapshot(host, id)
  }
  await host.idle()
  const { ticket } = await snapshot(host, id)
  assert(ticket?.execution?.branch && ticket.execution.worktree && ticket.execution.base?.sha)
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ticket.execution.worktree, env: gitEnv(), encoding: 'utf8' }).trim()
  writeFileSync(prFile, JSON.stringify({ state: 'open', html_url: `https://github.com/${repository}/pull/${number}`,
    user: { login: 'agent-bot' }, head: { ref: ticket.execution.branch, sha, repo: { full_name: repository } } }))
  const session = workerSessionId(id)
  const report = await host.tool<{ reported: boolean }>(session, 'orchestrator_report', { state: 'progress', summary: 'Merge the approved PR', pr_number: number })
  assert.equal(report.reported, true)
  await host.idle()
  // Drop the response at the CLI boundary: the old Runtime cannot observe the merge or write its receipt.
  const response = host.runtime.commands.run(cli, ['pr', 'merge', String(number)])
  await Promise.race([mergeCommitted.promise, response.then(() => { throw new Error('The merge response escaped the barrier') })])
  return snapshot(host, id)
}

// Parent death must not leave either process behind.
let finished = false
process.on('disconnect', () => { if (!finished) process.exit(1) })
if (phase === 'crash') {
  const evidence = await crash()
  await send(evidence)
  await waiting
} else {
  const host = mount()
  await host.runtime.ready
  await host.idle()
  const evidence = await snapshot(host, process.argv[5])
  await host.runtime.stop()
  await send(evidence)
  finished = true
  process.disconnect!()
}
