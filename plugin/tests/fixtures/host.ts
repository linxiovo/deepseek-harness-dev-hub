/**
 * In-memory DSH host fixture (as in tests/runtime.spec.ts) running a configured Runtime with GitHub and Feishu sources,
 * allowed member Alice (`ou_alice`), listened chat `oc_team`, and `auto` eval mode. Stop it with `stop()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { markAgentLoopRequest, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { Runtime } from '../../src/app/runtime.ts'
import type { Machine } from '../../src/deployment.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import type { ReviewAxis, Trigger } from '../../src/core/index.ts'
import { testMachine } from './deployment.ts'
import { gitEnv, gitRepository } from './git.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** Worker prepare command backed by a real local Git repository unless the test opts out. */
const WORKTREE_PREPARE = 'git -C "$DSH_SUPERAGENT_REPOSITORY" worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_BASE_SHA"'

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type FakeAgent = {
  id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: Mock; inject: Mock<(message: UserMessage) => void>; steer: Mock<(message: UserMessage) => void>; followup: Mock<(message: UserMessage) => void>
  directUserMessage: (text: string) => void
  session?: { id: string }
}
/** A text message, as DSH's job tools and subagents send their notices. */
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
type Delivery = { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }

/**
 * DSH's job registry as the Executor uses it, with DSH's job tools: the jobs a Session can see, their events, a wait and a
 * kill. `run` starts a job a Session owns, `output` has one print, and `end` ends one, as its process does; an end no wait
 * collected reaches its owner, which it wakes when idle, as the job tools deliver it. `released` counts the waits ends
 * released.
 * @param owner - the agent of a Session, which an end reaches.
 */
export function jobRegistry(owner: (sessionId: string) => FakeAgent | undefined = () => undefined) {
  type Job = { id: string; owner: string; status: string; label?: string }
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: { type: string }) => void }>()
  const waits = new Map<string, ((job: Job) => void)[]>()
  let released = 0
  const emit = (job: Job, type: string) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  const end = (id: string, status = 'completed') => {
    const job = jobs.get(id)!
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller)),
    // A wait ends with the job, or fails once its signal aborts, which leaves the job's end uncollected.
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<Job>((resolve, reject) => {
      const wake = (job: Job) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // A killed job ends a moment later, as its process does, also under a test's fake timers.
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, output: (id: string) => { emit(jobs.get(id)!, 'output') }, get released() { return released },
    run: (owner: string, label?: string) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
}

/**
 * DSH's subagents as the Executor uses them. `spawn` starts a child of a Session, an agent while it lives, which a drain of
 * the Session's descendants refuses from then on; `settle` ends one, whose end wakes its idle parent or steers a running one
 * before a wait for the parent's children returns. Releasing or interrupting a child settles it; a drain of descendants
 * injects their ends. The catalog lists every child a Session had.
 */
export function subagentRuntime(agents: Map<string, FakeAgent>) {
  const children = new Map<string, { parent: string; live: boolean; settled: PromiseWithResolvers<void> }>()
  const closed = new Set<string>()
  const settle = (id: string, wake = true) => {
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent), ended = notice(`settled-${id}`, `Subagent ${id} settled`)
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve()
  }
  const service = {
    waitForChildren: vi.fn(async (parent: { id: string }) => {
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    }),
    listChildren: vi.fn(async (id: string) => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId }))),
    drainChildren: vi.fn(async (_parent: { id: string }, ids: readonly string[]) => { for (const id of ids) settle(id) }),
    drainDescendants: vi.fn(async (parents: readonly { id: string }[]) => {
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    }),
    interrupt: vi.fn((id: string) => { settle(id) }),
  }
  const spawn = (parent: string) => {
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, live: true, settled: Promise.withResolvers<void>() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } } } as never)
    return id
  }
  return { service, settle, spawn, live: (id: string) => !!children.get(id)?.live }
}

/** Seed the database before opening; opt out of real Git or Feishu for unconfigured-executor and source tests. */
export async function startRuntime(seed?: (store: Store) => void, options: { withFeishu?: boolean; realGit?: boolean; separateCheckout?: boolean } = {}) {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'orchestrator-host-'))
  // Keep the default fixture clone separate from tests that create their own repository under `directory`.
  const gitRoot = options.separateCheckout ? mkdtempSync(join(realpathSync.native(tmpdir()), 'orchestrator-checkout-')) : join(directory, 'fixture-git')
  if (options.realGit !== false && !options.separateCheckout) mkdirSync(gitRoot)
  const localGit = options?.realGit === false ? undefined : gitRepository(gitRoot)
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => {
    if (args[1] === 'user') return { login: 'agent-bot' }
    if (args[1]?.includes('/pulls?state=all&head=')) return []
    return repository
  })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  const git = vi.spyOn(Commands.prototype, 'git')
  if (localGit) git.mockImplementation(async (args, cwd) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }))
  else git.mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    [`${AGENT} api user --hostname github.com`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --hostname github.com --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  /** A prepare command (`sh -c`) waits for this while it is set. */
  const hooks: { prepare?: Promise<void>; openingLog?: (sessionId: string) => Promise<void> | undefined;
    credentialCheck?: () => boolean | Promise<boolean> } = {}
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[]; cwd?: string; env?: Record<string, string> }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: () => string) => ({ readFrom: () => { const value = text(); return { text: value, nextOffset: value.length, lossy: false } } })
    const exited = { exitCode: 0, signal: null }
    if (argv[0] === process.execPath && argv[1] === '--fixture-check-test-account') {
      const done = Promise.resolve(hooks.credentialCheck?.()).then(ok => ({ ...exited, exitCode: ok ? 0 : 1 }))
      return { done, collected: { stdout: reader(() => ''), stderr: reader(() => 'fixture-secret-from-verifier') } }
    }
    if (localGit && argv[0] === 'sh') {
      let stderr = ''
      const done = Promise.resolve().then(async () => {
        if (hooks.prepare) await hooks.prepare
        if (argv[1] !== '-c' || argv[2] !== WORKTREE_PREPARE) {
          stderr = 'Unexpected worker prepare command'
          return { exitCode: 1, signal: null }
        }
        try {
          execFileSync('git', ['-C', spec.env?.DSH_SUPERAGENT_REPOSITORY ?? '', 'worktree', 'add', '-b',
            `agent/${spec.env?.DSH_SUPERAGENT_NAME ?? ''}`, spec.env?.DSH_SUPERAGENT_DIR ?? '',
            spec.env?.DSH_SUPERAGENT_BASE_SHA ?? ''], { cwd: spec.cwd, env: gitEnv(spec.env), encoding: 'utf8' })
          return exited
        } catch (error) {
          const failure = error && typeof error === 'object' ? error : {}
          stderr = 'stderr' in failure ? String(failure.stderr) : String(error)
          return { exitCode: 'status' in failure && typeof failure.status === 'number' ? failure.status : 1, signal: null }
        }
      })
      return { done, collected: { stdout: reader(() => ''), stderr: reader(() => stderr) } }
    }
    const done = argv[0] === 'sh' && hooks.prepare ? hooks.prepare.then(() => exited) : Promise.resolve(exited)
    return { done, collected: { stdout: reader(() => answers[argv.join(' ')] ?? ''), stderr: reader(() => '') } }
  }) }
  const agents = new Map<string, FakeAgent>()
  /** One durable entry of a Session's log; controller-made messages carry no `time`, as their creation time is not an event. */
  type StoredEvent = { seq: number; time?: number; type: string; data: unknown }
  const sessionHistory = new Map<string, StoredEvent[]>()
  const sessionHeaders = new Map<string, SessionHeader>()
  /** Fork-inherited prefix lengths, which a real persistence backend stores beside the log. */
  const inheritedEvents = new Map<string, number>()
  const modelContexts = new Map<string, { provider: string; model: string; contextWindow: number }>()
  const initiator = new AsyncLocalStorage<FakeAgent>()
  let directMessageSequence = 0
  // DSH's agents service lists the Sessions still loaded; Sessions install reads it after a service restart.
  Object.assign(agents, { list: () => [...agents.values()], currentInitiator: () => initiator.getStore() })
  /** Each Session's next step, which takes the messages that wait for one. */
  const steps = new Map<string, () => void>(), claims = new Map<string, () => void>()
  let reviewChildSequence = 0
  const tools = new Map<string, Map<string, RegisteredTool>>()
  const toolLimits = new Map<string, Set<string>>()
  const deliveries = vi.fn<(request: Delivery) => void>()
  let http!: HttpHandler
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: vi.fn(async ({ sessionId, workspaceId, agentPreset }: { sessionId: string; workspaceId: string; agentPreset?: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      const register = (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // A pending message taken out, as DSH's inbox does by its id.
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      // A step claims each message once, all that wait for a step and, as a turn starts, the next queued one, and takes them into
      // the Session's history, unless it is `cut` off before, as a cancel in its pre-step does; DSH says each.
      const taken = new Set<string>()
      let turn = 0
      const take = (starts: boolean, cut = false) => {
        const agent = agents.get(sessionId)!
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
          if (!cut) {
            const event = { seq: sessionEvents.length, time: Date.now(), type: 'user/message', data: message }
            sessionEvents.push(event)
            ctx.emit('session/event', session as never, event as never)
          }
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        // A message wakes an idle agent: its turn starts at once, and DSH says so, and its first step takes what waits.
        const agent = agents.get(sessionId)!
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' } as never)
        turn++
        take(true)
      })
      const sessionEvents = sessionHistory.get(sessionId) ?? []
      sessionHistory.set(sessionId, sessionEvents)
      const header: SessionHeader = { id: sessionId as SessionId, version: 4, createdAt: 0, isSeeded: false, cwd: workspaceId, agentPreset }
      sessionHeaders.set(sessionId, header)
      const session = { id: sessionId, header, inheritedEventCount: 0, snapshotEvents: () => sessionEvents,
        requestHeader: () => undefined, requestContext: () => modelContexts.get(sessionId), append: vi.fn() }
      let status = 'idle'
      const idle: (() => void)[] = []
      // A cancel drops the inbox unless kept, and the turn it stops ends a moment later, which DSH says.
      const cancel = vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)!
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' } as never)
        })
      })
      const directUserMessage = (text: string) => {
        const message = { id: `direct-user-${++directMessageSequence}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as UserMessage
        const event = { seq: sessionEvents.length, time: Date.now(), type: 'user/message', data: message }
        sessionEvents.push(event)
        ctx.emit('session/event', session as never, event as never)
      }
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: vi.fn(), session, cancel,
        directUserMessage,
        get status() { return status }, set status(next: string) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        // Once its turn ended, as DSH's does.
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }) } as never)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  // A real backend knows only created Sessions and keeps the fork cut beside the log; the meter must see the same answers.
  const persistence = { flush: vi.fn(async () => {}), stat: vi.fn(async (sessionId: string) => {
    const header = sessionHeaders.get(sessionId)
    return header ? { header, revision: 'fixture' } : undefined
  }), open: vi.fn(async (sessionId: string) => {
    const opening = hooks.openingLog?.(sessionId)
    if (opening) await opening
    const id = sessionId as SessionId
    const events = sessionHistory.get(sessionId)
    if (!events) throw new SessionPersistenceNotFoundError(id)
    const inherited = inheritedEvents.get(sessionId) ?? 0
    return {
      id, access: 'read' as const, inheritedEventCount: inherited,
      header: sessionHeaders.get(sessionId) ?? { id, version: 4, createdAt: 0, isSeeded: inherited > 0 },
      read: async (offset = 0, count = 512) => ({ eventState: 'detached' as const, events: events.slice(offset, offset + count) }),
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }
  }) }
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }
  const jobs = jobRegistry(id => agents.get(id))
  const subagents = subagentRuntime(agents)
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  let ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } },
    ...(options.withFeishu === false ? {} : { feishu: { enabled: true, config: { cli: BOT } } }) }
  const initial = seeded.settings()
  seeded.saveSettings(SettingsSchema.parse({ ...initial, sources, ...(localGit ? { executor: { ...initial.executor,
    repository: localGit.repository, baseRef: localGit.base.ref, prepare: WORKTREE_PREPARE } } : {}) }))
  seed?.(seeded)
  seeded.close()
  let runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  if (options.withFeishu !== false) runtime.sources.register(feishuKind)
  runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { github: { allowed: [{ id: 'alice' }] },
      ...(options.withFeishu === false ? {} : { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT } }) } },
    sources: { ...sources,
      ...(options.withFeishu === false ? {} : { feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } }) } })
  deliveries.mockClear()

  let machineOverrides: Partial<Machine> = {}
  async function restart(overrides?: Partial<Machine>) {
    if (overrides) machineOverrides = overrides
    await runtime.stop()
    agents.clear()
    tools.clear()
    ctx = new Context()
    for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
    runtime = new Runtime(ctx, testMachine({ stateDir: directory, ...machineOverrides }), vi.fn())
    await runtime.ready
    if (options.withFeishu !== false) runtime.sources.register(feishuKind)
    runtime.sources.register(githubKind)
    return runtime
  }

  /** Legacy JSON-only projection retained for existing fixture consumers. */
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  /** Parse only JSON object relays of the requested kind; plain text, malformed JSON and other kinds are ignored. */
  const jsonRelays = <T extends { kind: string }>(sessionId: string, kind: T['kind']): T[] => {
    const matches: T[] = []
    for (const [call] of deliveries.mock.calls) {
      if (call.sessionId !== sessionId) continue
      let value: unknown
      try { value = JSON.parse(call.text) } catch { continue }
      if (value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value && value.kind === kind) matches.push(value as T)
    }
    return matches
  }
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  }
  /** Create a real Cordis Agent boundary for a Worker descendant; authorization still runs through Sessions and DSH tools. */
  async function reviewSubagent(parentId: string, axis: ReviewAxis, childId = `review-${++reviewChildSequence}`, loadReviewSkill = true,
    inherited: readonly Omit<StoredEvent, 'seq'>[] = [], beforeSkill?: (childId: string) => Promise<void>) {
    const parent = agents.get(parentId)
    if (!parent) throw new Error(`Session ${parentId} does not exist`)
    const childHost = new Context(), sessionTools = new Map<string, RegisteredTool>()
    await childHost.plugin(scope => { scope.provide('skills', { register: () => () => {} } as never) })
    // DSH creates native children in an agent-loop scope without injecting skills into it.
    const agentCtx = childHost.plugin(() => {}).ctx
    tools.set(childId, sessionTools)
    agentCtx.reflect.provide('tools', { register: (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) },
      get: (name: string) => name, restrict: vi.fn(({ allow }: { allow: string[] }) => { toolLimits.set(childId, new Set(allow)); return () => {} }),
      guard: vi.fn(() => () => {}) })
    agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
    const parentSession = parent.session as unknown as { header?: { cwd?: string } } | undefined
    const ticket = runtime.store.tickets.get(parentId.slice('worker-'.length))!
    const base = ticket.execution!.base!.sha, generation = ticket.assignments.at(-1)!.writer!.generation
    const candidate = localGit!.git('-C', ticket.execution!.directory, 'rev-parse', 'HEAD')
    const assignment = JSON.stringify({ axis, base, candidate, generation })
    record(childId, inherited, inherited.length)
    const header: SessionHeader = { id: childId as SessionId, version: 4, createdAt: 0, isSeeded: inherited.length > 0,
      cwd: parentSession?.header?.cwd ?? '', parentSession: parentId as SessionId, origin: 'subagent' }
    sessionHeaders.set(childId, header)
    const session = { id: childId, header, inheritedEventCount: inherited.length,
      snapshotEvents: () => sessionHistory.get(childId)!, requestHeader: () => undefined, requestContext: () => modelContexts.get(childId) }
    const agent = { ...parent, id: childId, ctx: agentCtx, session, status: 'idle' } as never
    agents.set(childId, agent)
    await ctx.serial('agent/created', { agent, source: 'startup' } as never)
    record(childId, [
      { type: 'subagent/descriptor', data: { version: 3, mode: 'one-shot', provider: 'fixture' } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `DSH_REVIEW_ASSIGNMENT: ${assignment}` }] } },
    ])
    await beforeSkill?.(childId)
    record(childId, [
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'review-skill', name: 'skill', arguments: JSON.stringify({ name: 'dsh-worker-code-review' }) } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'review-skill', isError: !loadReviewSkill, content: [] } } },
    ])
    return childId
  }
  const sendUserMessage = (sessionId: string, text: string) => {
    const agent = agents.get(sessionId)
    if (!agent) throw new Error(`Session ${sessionId} does not exist`)
    agent.directUserMessage(text)
  }
  /**
   * Appends durable events to a Session's log, as DSH does at a turn's checkpoint, and announces them as the live Session does.
   * `inherited` sets the fork prefix stored beside the log, which the meter must not count as the child's own calls.
   */
  const record = (sessionId: string, events: readonly (Omit<StoredEvent, 'seq'> & { seq?: number })[], inherited?: number) => {
    if (inherited !== undefined) inheritedEvents.set(sessionId, inherited)
    const log = sessionHistory.get(sessionId) ?? []
    sessionHistory.set(sessionId, log)
    const session = agents.get(sessionId)?.session
    for (const event of events) {
      const stored = { ...event, seq: event.seq ?? log.length, time: event.time ?? Date.now() } as StoredEvent
      log.push(stored)
      if (session) ctx.emit('session/event', session as never, stored as never)
    }
  }
  /** Switch only the backend's stored log generation; a loaded Agent still describes its original Session. */
  const useStoredLog = (sessionId: string, createdAt: number, events: readonly Omit<StoredEvent, 'seq'>[]) => {
    const header = sessionHeaders.get(sessionId), history = sessionHistory.get(sessionId)
    if (!header || !history) throw new Error(`Missing stored Session ${sessionId}`)
    sessionHeaders.set(sessionId, { ...header, createdAt })
    sessionHistory.set(sessionId, events.map((event, seq) => ({ ...event, seq, time: event.time ?? createdAt + seq + 1 })))
    return () => { sessionHeaders.set(sessionId, header); sessionHistory.set(sessionId, history) }
  }
  const idlePlanning = () => runtime.effects.idle('planning')
  const idleRelay = () => runtime.effects.idle('relay')
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  async function api(method: string, path: string, json?: unknown, projectId?: string) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1',
      ...(json !== undefined && { 'content-type': 'application/json' }),
      ...(projectId && { 'x-orchestrator-project-id': projectId }) }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() {
    await runtime.stop()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
    if (options.separateCheckout) rmSync(gitRoot, { recursive: true, force: true })
  }
  /** Execute the host's public streaming waterfall, replacing only provider I/O. */
  function modelRequest(sessionId: string, contextWindow: number, providerCall: () => AsyncIterable<StreamChunk>, signal?: AbortSignal) {
    const model = { provider: 'fixture', model: 'fixture-model' }
    modelContexts.set(sessionId, { ...model, contextWindow })
    const request = Object.freeze({ ...model, sessionId: sessionId as SessionId, messages: [], ...(signal ? { signal } : {}) }) satisfies GenerateOptions
    const stream = async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.waterfall(ctx.llm, 'llm/stream', markAgentLoopRequest(request), providerCall)) chunks.push(chunk)
      return chunks
    }
    const agent = agents.get(sessionId)
    return agent ? initiator.run(agent, stream) : stream()
  }
  /** The Session's model takes its next step, which takes the messages steered in since its last. */
  const step = (sessionId: string) => { steps.get(sessionId)!() }
  /** A step of the worker claims what waits for it, and is cut off before the Session took it. */
  const claim = (sessionId: string) => { claims.get(sessionId)!() }
  return { get runtime() { return runtime }, get ctx() { return ctx }, get toolLimits() { return toolLimits }, restart, idlePlanning, idleRelay, directory, localGit, agents, tools, deliveries, relays, jsonRelays, candidates, runTool, sendUserMessage, record, route, acceptedTicket, api, controller, subprocess, hooks, resolveDefault, stop,
    jobs, subagents, reviewSubagent, useStoredLog, step, claim, modelRequest }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>
interface ManagedProject {
  host: Host
  /** Project projection accepted directly as the `project` field of a handoff brief. */
  projectBrief: { repository: string; workspace: string }
  project: { id: string; repository: string; workspace: string; hubSessionId: string }
}

/** Start an isolated managed project by registering a real checkout through HTTP, then mounting its selected project. */
export async function startManagedProject(options: { withFeishu?: boolean; machine?: Partial<Machine>
  | ((project: ManagedProject['project']) => Partial<Machine>) } = {}): Promise<ManagedProject> {
  const host = await startRuntime(undefined, { withFeishu: options.withFeishu, separateCheckout: true })
  try {
    const checkout = host.localGit!, repository = 'acme/widgets'
    const registration = await host.api('POST', 'projects', { repository, workspace: checkout.repository, baseRef: checkout.base.ref })
    const registered = registration.body.project
    if (registration.status !== 200 || registration.body.restarting !== true || !registered || typeof registered !== 'object'
      || !('id' in registered) || typeof registered.id !== 'string' || !registered.id
      || !('repository' in registered) || registered.repository !== repository
      || !('workspace' in registered) || registered.workspace !== checkout.repository
      || !('hubSessionId' in registered) || typeof registered.hubSessionId !== 'string') {
      throw new Error(`Managed project registration failed (${registration.status}): ${JSON.stringify(registration.body)}`)
    }
    const project = { id: registered.id, repository, workspace: registered.workspace, hubSessionId: registered.hubSessionId }
    await host.restart(typeof options.machine === 'function' ? options.machine(project) : options.machine)
    const projects = await host.api('GET', 'projects')
    if (projects.status !== 200 || projects.body.activeProjectId !== project.id) {
      throw new Error(`Managed project ${project.id} was not selected after restart: ${JSON.stringify(projects.body)}`)
    }
    return { host, project, projectBrief: { repository, workspace: project.workspace } }
  } catch (error) {
    await host.stop()
    throw error
  }
}
