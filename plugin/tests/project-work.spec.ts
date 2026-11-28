import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Fiber } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Effects } from '../src/app/effects.ts'
import type { ApiResponse } from '../src/app/api.ts'
import { Handoffs } from '../src/app/handoffs.ts'
import { InstallationError, type CreateProjectResult, type ProjectView } from '../src/app/installation-api.ts'
import { Plans } from '../src/app/plans.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import type { HandoffInput } from '../src/core/handoff.ts'
import { Engine, MemoryRepositories, key, type Outcome, type Trigger } from '../src/core/index.ts'
import type { RuntimeMode } from '../src/deployment.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import * as githubSource from '../src/sources/github.ts'
import { developmentModels, testMachine } from './fixtures/deployment.ts'
import { gitRepository } from './fixtures/git.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const approval = (project: HandoffInput['project']): HandoffInput => {
  const brief = { project, goal: 'Add saved products', constraints: [], acceptanceScope: ['List saved products'],
    authorization: { scope: 'Implement and verify saved products', release: 'not-authorized' as const } }
  return { ...brief, confirmedBy: { sessionId: 'hub', messageId: '1', text: JSON.stringify({ confirmed: true, brief }) } }
}

it('gates bound handoffs before persisting and records only the canonical project', () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'bound-handoff-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const checkout = mkdirSync(join(directory, 'Checkout'), { recursive: true })!
    const otherCheckout = mkdirSync(join(directory, 'other'), { recursive: true })!
    const alias = join(directory, 'alias')
    symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const project = { id: 'registered-widgets', repository: 'Acme/Widgets', workspace: realpathSync.native(checkout) }
    const effects = new Effects(store, new HealthBoard())
    const blocked = new InstallationError(409, 'switching')
    const gate = vi.fn<() => void>().mockImplementationOnce(() => { throw blocked })
    const handoffs = new Handoffs(store, effects, project, gate)
    const approved = approval({ repository: 'acme/widgets', workspace: process.platform === 'win32' ? alias.toUpperCase() : alias })

    expect(() => handoffs.confirm(approved)).toThrow(blocked)
    for (const mismatched of [approval({ ...project, workspace: otherCheckout }), approval({ ...project, repository: 'Acme/Other' })]) {
      expect(() => handoffs.confirm(mismatched)).toThrow(/does not match the bound project/)
    }
    expect(store.keys('handoff')).toEqual([])
    expect(effects.count()).toBe(0)

    const { handoff, reused } = handoffs.confirm(approved)
    expect(reused).toBe(false)
    expect(handoff.project).toEqual(project)
    const canonical = approval({ repository: project.repository, workspace: project.workspace })
    const { confirmedBy, ...canonicalBrief } = canonical
    expect(handoff.id).toBe(key('handoff', project.id, JSON.stringify(canonicalBrief)))
    expect(store.get(KV.handoffs.current(project.id))).toBe(handoff.id)
    expect(store.get(KV.handoffs.project(project.id))).toEqual(project)
    expect(effects.pending('planning', handoff.id)).toBe(true)
    expect(handoffs.confirm(approved)).toEqual({ handoff, reused: true })
    const nextReceipt = { ...confirmedBy, messageId: '2' }
    gate.mockImplementationOnce(() => { throw blocked })
    expect(() => handoffs.confirm({ ...canonical, confirmedBy: nextReceipt })).toThrow(blocked)
    expect(store.get(KV.handoffs.confirmationReceipt(nextReceipt.sessionId, nextReceipt.messageId))).toBeUndefined()
    expect(handoffs.confirm({ ...canonical, confirmedBy: nextReceipt })).toEqual({ handoff, reused: true })

    const planning = handoffs.begin(handoff.id)
    expect(planning.project).toEqual(project)
    const { spec } = handoffs.publish(handoff.id, { body: 'Persist and list saved products',
      acceptance: [{ statement: 'List saved products', observable: 'Previously saved products appear', delivery: 'backend' }],
      testInterfaces: [{ kind: 'existing', seam: 'Product API', note: 'Save and list products' }], outOfScope: [] })
    const plan = new Plans(store, handoffs, effects).register(handoff.id, spec!.id, {
      features: [{ id: 'saved', kind: 'backend' }], nodes: [{ id: 'saved-api', featureId: 'saved', title: 'List saved products',
        role: 'backend', acceptance: [1], demonstration: 'List products after saving', blockedBy: [] }],
    })
    expect(handoffs.get(plan.handoffId)?.project).toEqual(project)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('replays a persisted legacy receipt after restart and a binding change without creating work', () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'recovered-handoff-'))
  const database = join(directory, 'state.sqlite')
  let store = new Store(database)
  try {
    const workspace = mkdirSync(join(directory, 'first'), { recursive: true })!
    const approved = approval({ repository: 'Acme/Widgets', workspace })
    const effects = new Effects(store, new HealthBoard())
    const { handoff } = new Handoffs(store, effects).confirm(approved)
    effects.cancel('planning', handoff.id)
    store.close()
    store = new Store(database)

    const switched = { id: 'second-project', repository: 'Acme/Other', workspace: mkdirSync(join(directory, 'second'), { recursive: true })! }
    const recoveredEffects = new Effects(store, new HealthBoard())
    const gate = vi.fn(() => { throw new InstallationError(409, 'switching') })
    const recovered = new Handoffs(store, recoveredEffects, switched, gate)
    const writes = vi.spyOn(store, 'set')
    expect(recovered.confirm(approved)).toEqual({ handoff, reused: true })
    expect(() => recovered.confirm(approval(switched))).toThrow(/already confirmed a different product brief/)
    expect(() => recovered.confirm({ ...approved, goal: 'A different goal' })).toThrow(/already confirmed a different product brief/)
    expect(writes).not.toHaveBeenCalled()
    expect(gate).not.toHaveBeenCalled()
    expect(recoveredEffects.count()).toBe(0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('namespaces generated Worker Session IDs while preserving legacy IDs and acceptance replay', () => {
  const now = () => '2026-11-19T12:00:00.000Z'
  const thread = { source: 'chat', id: 'same-thread' }
  const event: Trigger = { id: 'same-upstream-event', source: thread.source, threads: [thread], actor: { source: thread.source, id: 'person' },
    human: true, at: now(), text: 'Fix saved products', meta: {} }
  const outcome: Outcome = { kind: 'accept', title: 'Fix saved products', scope: 'Fix saving', reason: 'Requested' }
  const open = (projectId?: string, repo = new MemoryRepositories()) => new Engine({ projectId, repo, now,
    policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60000, revalidate: () => true, admitsInferred: () => false,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
  })
  const accept = (engine: Engine) => { engine.receive(event); return engine.decide(event.id, outcome).ticketId! }

  const legacyRepo = new MemoryRepositories()
  const legacy = accept(open(undefined, legacyRepo))
  expect(legacy).toBe(key('ticket', key('eval', 'chat:same-thread', 'direct', event.id, 'accept', now())))
  const first = accept(open('first-project'))
  const second = accept(open('second-project'))
  expect(new Set([legacy, first, second].map(workerSessionId)).size).toBe(3)
  expect(accept(open('first-project'))).toBe(first)
  expect(accept(open('first-project', legacyRepo))).toBe(legacy)
  expect(legacyRepo.tickets.list().map(ticket => ticket.id)).toEqual([legacy])
})

it('gates Hub actions that start work and still accepts stops from a configured legacy Hub', async () => {
  const host = await startRuntime()
  try {
    const { ticket } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const request = feishu('2', '@bot 顺便看看这个')
    const stop = feishu('3', '@bot 不用修了')
    host.runtime.receive(request)
    host.runtime.receive(stop)
    await host.runtime.idle()
    const blocked = new InstallationError(409, 'switching')
    const gate = vi.spyOn(host.runtime.installation, 'assertNewWork').mockImplementation(() => { throw blocked })
    const run = (name: string, args: unknown) => host.runTool(host.runtime.masterId, `orchestrator_${name}`, args)
    const before = host.runtime.store.triggers.disposition(request.id)
    await expect(run('route', { decisions: [
      { kind: 'accept', trigger_id: request.id, title: 'Fix saving', acknowledgement: 'I’ll fix saving.', worktree_name: 'fix-saving' },
      { kind: 'attach', trigger_id: request.id, ticket_id: ticket.id },
      { kind: 'stop', trigger_id: stop.id, ticket_id: ticket.id, reason: 'Stop saving work' },
    ] })).resolves.toMatchObject({ results: [{ refused: blocked.message }, { refused: blocked.message }, { decision: 'stop' }] })
    expect(gate).toHaveBeenCalledTimes(2)
    await expect(run('ticket_retry', { ticket_id: ticket.id })).rejects.toThrow(blocked)
    await expect(run('trigger_requeue', { trigger_id: request.id })).rejects.toThrow(blocked)
    await expect(run('eval_decide', { trigger_id: request.id, decision: 'accept', title: 'Fix saving', scope: 'Saving', reason: 'Request',
      rule_assessments: [], direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Fix saving' },
    })).rejects.toThrow(blocked)
    expect(host.runtime.store.triggers.disposition(request.id)).toEqual(before)
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
    expect(host.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human' })
  } finally { await host.stop() }
})

async function managedHarness(runtimeMode: RuntimeMode = 'desktop') {
  const host = await startRuntime(undefined, { withFeishu: false })
  // Keep the host's Sessions alive, but give the managed installation a fresh catalog and scoped plugin lifecycle.
  const scope = host.ctx.isolate('orchestrator')
  let mounted: Fiber | undefined
  let watcher: Fiber | undefined
  const unwatch = async () => { await watcher?.dispose(); watcher = undefined }
  const stop = async () => {
    try { await unwatch() }
    finally {
      vi.useRealTimers()
      try { await mounted?.dispose() } finally { await host.stop() }
    }
  }
  try {
    await host.runtime.stop()
    const cli = join(host.directory, 'agent-gh')
    const secondRoot = join(host.directory, 'second')
    mkdirSync(secondRoot)
    const secondGit = gitRepository(secondRoot)
    secondGit.git('remote', 'set-url', 'origin', 'https://github.com/acme/gadgets.git')
    const checkouts = [host.localGit!, secondGit]
    const stateDir = join(host.directory, 'installation')
    const originalSpawn = host.subprocess.spawn.getMockImplementation()!
    host.subprocess.spawn.mockImplementation(spec => {
      const { argv, cwd } = spec
      const endpoint = argv[0] === cli && argv[1] === 'api' && argv[3] === '--hostname' ? argv[2] : undefined
      const output = endpoint === 'user' ? JSON.stringify({ login: 'agent-bot', id: 7 })
        : endpoint === 'repos/acme/widgets' || endpoint === 'repos/acme/gadgets' ? JSON.stringify({ name: endpoint.slice(6), push: true })
        : argv[0] === 'git' && argv[1] === 'config' && argv.includes('--show-origin') && cwd
          ? `file:${workerGitConfig(cwd)}\0${credentialHelper(cli)}\0` : undefined
      if (output === undefined) return originalSpawn(spec)
      const readFrom = () => ({ text: output, nextOffset: output.length, lossy: false })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom }, stderr: { readFrom } } }
    })
    const mount = async () => {
      await unwatch()
      await mounted?.dispose()
      let runtime!: Runtime
      mounted = scope.plugin({ async apply(ctx) {
        const value = runtime = new Runtime(ctx, testMachine({ stateDir, runtimeMode }), vi.fn())
        ctx.effect(() => () => value.stop())
        await value.ready
      } })
      await mounted
      return runtime
    }
    const watchGithub = async () => { watcher = scope.plugin(githubSource); await watcher }
    const create = async (index: 0 | 1, repository: string, allowed: string) => {
      const { repository: workspace, base } = checkouts[index]!
      const response = await host.api('POST', 'projects', { repository, workspace, baseRef: base.ref,
        policy: { sources: { github: { allowed: [{ id: allowed }], admission: { issues: { unlistedAddressed: 'ignore' } } } } } })
      expect(response).toMatchObject({ status: 200, body: { restarting: index === 0, reused: false } })
      return (response.body as unknown as CreateProjectResult).project
    }
    const select = async (project: ProjectView) => {
      expect(await host.api('POST', `projects/${project.id}/select`)).toMatchObject({ status: 200, body: { restarting: true } })
    }
    await mount()
    expect(await host.api('POST', 'onboarding/github/verify', { cli })).toMatchObject({ status: 200, body: { status: 'models-required' } })
    const setup = await host.api('GET', 'settings')
    const { blocks: { executor } } = setup.body as ApiResponse<'GET settings'>
    expect(await host.api('PUT', 'settings/executor', { ...executor, value: { ...executor.value, ...developmentModels } }))
      .toMatchObject({ status: 200, body: { restarting: true } })
    await mount()
    const first = await create(0, 'acme/widgets', 'alice')
    const runtime = await mount()
    const second = await create(1, 'acme/gadgets', 'bob')
    return { host, first, second, runtime, mount, select, watchGithub, stop, restartFiber: () => mounted!.restart() }
  } catch (error) { await stop(); throw error }
}

async function publishSpec(host: Host, runtime: Runtime, { id: projectId, repository, workspace }: ProjectView, feature: string) {
  const { confirmedBy: _, ...base } = approval({ repository, workspace })
  const goal = `Show ${feature} to signed-in shoppers`
  const brief = { ...base, goal, acceptanceScope: [goal] }
  const confirmation = JSON.stringify({ confirmed: true, brief })
  host.sendUserMessage(runtime.masterId, confirmation)
  const { id } = await host.runTool(runtime.masterId, 'orchestrator_handoff_confirm', { ...brief, confirmation }) as { id: string }
  await runtime.effects.idle('planning')
  const planner = `planner-${id}`
  expect(host.relays(planner)).toEqual([expect.objectContaining({ handoff_id: id, project: { id: projectId, repository, workspace }, goal })])
  const { spec: { id: specId } } = await host.runTool(planner, 'orchestrator_spec_publish', {
    handoffId: id, body: goal, acceptance: [{ statement: goal, observable: `The shopper's ${feature} appear`, delivery: 'cross-end' }],
    testInterfaces: [{ kind: 'proposed', seam: 'Dashboard and its API', note: `Show only the current account's ${feature}` }], outOfScope: [],
  }) as { spec: { id: string } }
  await runtime.idle()
  const splitter = `splitter-${id}`
  expect(host.relays(splitter)).toEqual([expect.objectContaining({ handoff_id: id, spec_id: specId })])
  for (const sessionId of [runtime.masterId, planner, splitter]) {
    expect(host.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId, workspaceId: workspace }))
  }
  const draft = { features: [{ id: 'dashboard', kind: 'cross-end' }], nodes: [
    { id: 'api', featureId: 'dashboard', role: 'backend', title: `${feature} API`, acceptance: [1], blockedBy: [],
      demonstration: `Request ${feature} with an authorized session`,
      interfaceContract: { path: 'docs/dashboard-api.md', requirements: `Describe the ${feature} response and authentication` } },
    { id: 'page', featureId: 'dashboard', role: 'frontend', title: `${feature} dashboard`, acceptance: [1], blockedBy: ['api'],
      demonstration: `Open the page and review ${feature}` },
  ] }
  return { id, planner, splitter, registration: { handoffId: id, specId, ...draft } }
}

it('keeps confirmed handoffs, specifications and Plan DAGs isolated across managed Hub remounts', async () => {
  const { host, first, second, runtime, mount, select, stop } = await managedHarness()
  try {
    const read = (project: ProjectView, resource: string) => host.runTool(project.hubSessionId, 'orchestrator_read', { resource })
    const readWork = async (project: ProjectView, id: string) => Promise.all(['handoff', 'spec', 'plan'].map(kind => read(project, `${kind}/${id}`)))
    const a = await publishSpec(host, runtime, first, 'saved products')
    await host.runTool(a.splitter, 'orchestrator_plan_register', a.registration)
    const savedA = await readWork(first, a.id)
    expect(savedA[0]).toMatchObject({ project: { id: first.id }, confirmedBy: { sessionId: first.hubSessionId } })
    expect(savedA[2]).toMatchObject({ status: 'registered', nodes: [
      { id: 'api', title: 'saved products API', blockedBy: [] }, { id: 'page', title: 'saved products dashboard', blockedBy: ['api'] },
    ] })
    const oldPlanner = await host.ctx.sessionController.resolveAgent(a.planner as SessionId)
    if ('error' in oldPlanner) throw new Error('Expected project A’s planner to remain loaded in Harness')
    const oldPrompt = vi.spyOn(oldPlanner.agent.ctx.systemPrompt, 'section')
    const oldSkills = vi.spyOn(oldPlanner.agent.ctx.skills, 'register')
    vi.mocked(oldPlanner.agent.ctx.tools.guard).mockClear()
    const oldDeliveries = host.relays(a.planner)

    await select(second)
    const runtimeB = await mount()
    expect(runtimeB.masterId).toBe(second.hubSessionId)
    for (const kind of ['handoff', 'spec', 'plan']) await expect(read(second, `${kind}/${a.id}`)).rejects.toThrow(/unknown/i)
    expect(vi.mocked(oldPlanner.agent.ctx.tools.guard)).toHaveBeenCalledTimes(1)
    expect(oldPrompt).not.toHaveBeenCalled()
    expect(oldSkills).not.toHaveBeenCalled()
    await expect(host.runTool(a.planner, 'orchestrator_read', { resource: `handoff/${a.id}` })).rejects.toThrow(/not registered/)
    host.record(a.planner, [{ type: 'llm/retry', data: {
      retryId: 'foreign-budget-wait', turn: 1, step: 2, provider: 'provider-a', mode: 'always', retry: 1, policyKey: 'opaque', delayMs: 10_000,
      failure: { code: 'INVALID_REQUEST', message: 'Budget has been exceeded! Current cost: 100, Max budget: 99' },
    } }])
    expect(await host.api('GET', 'state')).toMatchObject({ status: 200,
      body: { projectId: second.id, health: { models: { state: 'ready' } } } })
    const { confirmedBy: _, ...wrong } = approval({ repository: first.repository, workspace: first.workspace })
    const confirmation = JSON.stringify({ confirmed: true, brief: wrong })
    host.sendUserMessage(second.hubSessionId, confirmation)
    await expect(host.runTool(second.hubSessionId, 'orchestrator_handoff_confirm', { ...wrong, confirmation })).rejects.toThrow(/does not match the bound project/)

    const b = await publishSpec(host, runtimeB, second, 'stock alerts')
    await expect(host.runTool(b.splitter, 'orchestrator_plan_register', a.registration)).rejects.toThrow(/handoff|session/i)
    await host.runTool(b.splitter, 'orchestrator_plan_register', b.registration)
    const savedB = await readWork(second, b.id)
    expect(savedB[0]).toMatchObject({ project: { id: second.id }, confirmedBy: { sessionId: second.hubSessionId } })
    expect(savedB[2]).toMatchObject({ status: 'registered', nodes: [
      { id: 'api', title: 'stock alerts API', blockedBy: [] }, { id: 'page', title: 'stock alerts dashboard', blockedBy: ['api'] },
    ] })

    await select(first)
    await mount()
    expect(await readWork(first, a.id)).toEqual(savedA)
    for (const kind of ['handoff', 'spec', 'plan']) await expect(read(first, `${kind}/${b.id}`)).rejects.toThrow(/unknown/i)
    expect(host.relays(a.planner)).toEqual(oldDeliveries)
    await select(second)
    await mount()
    expect(await readWork(second, b.id)).toEqual(savedB)
  } finally { await stop() }
})

it('keeps Worker model admission closed through a real Cordis Fiber restart', async () => {
  const { host, first, runtime, restartFiber, stop } = await managedHarness()
  try {
    const plan = await publishSpec(host, runtime, first, 'saved products')
    await host.runTool(plan.splitter, 'orchestrator_plan_register', plan.registration)
    const result = await host.runTool(runtime.masterId, 'orchestrator_plan_dispatch', { planId: plan.id, nodeId: 'api' })
    const claim = result.claim
    if (!claim || typeof claim !== 'object' || !('session' in claim) || typeof claim.session !== 'string') throw new Error('Missing Worker claim')
    const id = claim.session
    await runtime.idle()
    const provider = vi.fn(async function* (_request: GenerateOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const flushing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    vi.mocked(host.ctx.sessionPersistence.flush).mockImplementationOnce(() => { flushing.resolve(); return release.promise })
    const restart = restartFiber()
    try {
      await Promise.race([flushing.promise, restart.then(() => { throw new Error('Fiber restarted before the expected log flush') })])
      // Dispatch from the surviving host, not from the child Fiber that is already unloading.
      host.agents.get(id)!.inbox.nextTurn.push(freezeMessage({ role: 'user', source: { kind: 'user' }, id: MessageId('during-fiber-restart'),
        content: [{ type: 'text', text: 'Continue' }] }))
      expect(await host.nativeStep(id, { starts: true })).toBe(false)
      await expect(host.modelRequest(id, 10, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT' })
      expect(provider).not.toHaveBeenCalled()
    } finally { release.resolve(); await restart }
    expect(await host.api('GET', 'runtime')).toMatchObject({ status: 200, body: { projectId: first.id, status: 'ready' } })
  } finally { await stop() }
})

it('polls authorized GitHub events on the headless timer and exposes only the mounted project to clients', async () => {
  const { host, first, second, runtime: a, mount, select, watchGithub, stop } = await managedHarness('headless')
  try {
    vi.mocked(Commands.prototype.gh).mockRestore()
    const polls: string[] = []
    const notification = (repository: string, issue: number) => ({ repository: { full_name: repository },
      subject: { url: `https://api.github.com/repos/${repository}/issues/${issue}` } })
    const github = vi.mocked(Commands.prototype.run).mockImplementation(async (_program, args) => {
      const path = args[1]?.split('?')[0]
      if (path === 'repos/acme/widgets/notifications' || path === 'repos/acme/gadgets/notifications') {
        const repository = path === 'repos/acme/widgets/notifications' ? first.repository : second.repository
        polls.push(repository)
        const notices = repository === first.repository
          ? [notification(first.repository, 42), notification(second.repository, 99)]
          : polls.filter(repo => repo === second.repository).length === 1
            ? [notification(second.repository, 42), notification(first.repository, 99)]
            : [notification(second.repository, 43), notification(second.repository, 44)]
        return `HTTP/2 200 OK\r\n\r\n${JSON.stringify(notices)}`
      }
      if (path?.endsWith('/comments')) return '[[]]'
      const issue = /^repos\/(acme\/(?:widgets|gadgets))\/issues\/(42|43|44)$/.exec(path ?? '')
      if (!issue) throw new Error(`Unexpected GitHub read: ${path}`)
      const [, repository, number] = issue
      return JSON.stringify({ number: Number(number), id: Number(number), title: `${repository} report ${number}`, state: 'open',
        created_at: new Date(Date.now() + 1000).toISOString(), body: '@agent-bot please fix the regression',
        html_url: `https://github.com/${repository}/issues/${number}`, user: { login: repository === first.repository || number === '44' ? 'alice' : 'bob' } })
    })
    const watchReady = () => vi.waitFor(async () => {
      expect(await host.api('GET', 'state')).toMatchObject({ status: 200, body: { health: { github: { state: 'ready' } } } })
    })
    const thread = (number: number) => host.api('GET', `threads/${encodeURIComponent(`github:${number}`)}`)
    const candidates = (project: ProjectView) => host.relays(project.hubSessionId).filter(item => item.kind === 'candidate')
    await watchGithub()
    await watchReady()
    await a.idle()
    expect(await thread(42)).toMatchObject({ status: 200, body: { timeline: [{ url: 'https://github.com/acme/widgets/issues/42' }] } })
    expect(candidates(first)).toMatchObject([{ trigger_id: key('github-issue', '42'), strength: 'explicit' }])

    await select(second)
    const b = await mount()
    expect(await host.api('GET', 'runtime')).toMatchObject({ status: 200, body: { mode: 'headless', status: 'ready', projectId: second.id } })
    expect(await thread(42)).toMatchObject({ status: 404 })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await watchGithub()
    await watchReady()
    await b.idle()
    expect(polls).toEqual([first.repository, second.repository])
    expect(await thread(42)).toMatchObject({ status: 200, body: { timeline: [{ url: 'https://github.com/acme/gadgets/issues/42' }] } })
    expect(await thread(43)).toMatchObject({ status: 404 })

    await vi.advanceTimersByTimeAsync(60_000)
    await b.idle()
    expect(polls).toEqual([first.repository, second.repository, second.repository])
    expect(await thread(43)).toMatchObject({ status: 200, body: { timeline: [{ url: 'https://github.com/acme/gadgets/issues/43' }] } })
    expect(await thread(44)).toMatchObject({ status: 200, body: { timeline: [{ disposition: { decision: {
      reason: [expect.objectContaining({ code: 'not_a_member' })],
    } } }] } })
    expect(candidates(second)).toMatchObject([
      { trigger_id: key('github-issue', '42'), strength: 'explicit' }, { trigger_id: key('github-issue', '43'), strength: 'explicit' },
    ])
    expect(candidates(first)).toHaveLength(1)
    expect(github.mock.calls.some(([, args]) => args[1]?.endsWith('/issues/99'))).toBe(false)
  } finally { await stop() }
})
