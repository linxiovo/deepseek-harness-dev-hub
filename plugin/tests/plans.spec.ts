import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { resolve } from 'node:path'
import { KV } from '../src/kv.ts'
import { startManagedProject, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
let brief: { project: { repository: string; workspace: string }; goal: string; constraints: string[];
  acceptanceScope: string[]; authorization: { scope: string; release: 'not-authorized' } }

function savedProductsBrief(project: typeof brief.project) {
  return { project, goal: 'Let shoppers view their saved products.', constraints: ['Saved products are private.'],
    acceptanceScope: ['A shopper can see their saved products.'],
    authorization: { scope: 'Implement and verify private saved products.', release: 'not-authorized' as const } }
}
const spec = {
  body: 'Provide an authenticated saved-products endpoint and a page for signed-in shoppers.',
  acceptance: [{ statement: 'A shopper can see their saved products.', observable: 'The page lists only their saved products.', delivery: 'cross-end' }],
  testInterfaces: [{ seam: 'Saved-products endpoint and page', kind: 'proposed', note: 'Verify account isolation and render the returned list.' }],
  outOfScope: ['Sharing saved products.'],
}

const maintenanceSpec = {
  ...spec,
  body: 'Preserve the saved-products API during internal database maintenance, without page changes.',
  acceptance: [{ statement: 'The existing saved-products API still works.', observable: 'Existing clients receive the same results.', delivery: 'backend' }],
  testInterfaces: [{ seam: 'Saved-products API', kind: 'existing', note: 'Compare lists before and after maintenance.' }],
}

async function publish(projectBrief = brief, specification = spec) {
  const confirmation = JSON.stringify({ confirmed: true, brief: projectBrief })
  h.sendUserMessage(h.runtime.masterId, confirmation)
  const { id } = await h.runTool(h.runtime.masterId, 'orchestrator_handoff_confirm', { ...projectBrief, confirmation }) as { id: string }
  await h.idlePlanning()
  const { spec: { id: specId } } = await h.runTool(`planner-${id}`, 'orchestrator_spec_publish', { handoffId: id, ...specification }) as { spec: { id: string } }
  const sessionId = `splitter-${id}`
  return { id, specId, sessionId, register: (draft: unknown) => h.runTool(sessionId, 'orchestrator_plan_register', {
    handoffId: id, specId, ...draft as object,
  }) }
}
const read = (resource: string, page = {}) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })
const readExecutorSettings = async (): Promise<{ value: Record<string, unknown>; revision: number }> =>
  JSON.parse(String((await read('settings/executor')).text))
const splitDraft = {
  features: [{ id: 'saved-products', kind: 'cross-end' }],
  nodes: [
    { id: 'saved-api', featureId: 'saved-products', title: 'Private saved-products API', role: 'backend', acceptance: [1],
      demonstration: 'Call the authenticated endpoint with two accounts and compare their lists.', blockedBy: [],
      interfaceContract: { path: 'docs/saved-products-api.md', requirements: 'Document GET, authentication, list schema, errors and contract checks.' } },
    { id: 'saved-page', featureId: 'saved-products', title: 'Saved-products page', role: 'frontend', acceptance: [1],
      demonstration: 'Open the page, inspect the list and verify the empty state.', blockedBy: ['saved-api'] },
  ],
}

const fanInDraft = {
  features: [{ id: 'catalog', kind: 'backend' }, { id: 'accounts', kind: 'backend' }, { id: 'dashboard', kind: 'frontend' }],
  nodes: [
    { id: 'catalog', featureId: 'catalog', title: 'Catalog search', role: 'backend', acceptance: [1],
      demonstration: 'Run a catalog search against seeded data.', blockedBy: [],
      interfaceContract: { path: 'docs/catalog-api.md', requirements: 'Document query inputs and return all substring matches.' } },
    { id: 'accounts', featureId: 'accounts', title: 'Account lookup', role: 'backend', acceptance: [2],
      demonstration: 'Look up a test account and observe the profile.', blockedBy: [],
      interfaceContract: { path: 'docs/accounts-api.md', requirements: 'Document profile fields and lookup errors.' } },
    { id: 'dashboard', featureId: 'dashboard', title: 'Combined dashboard', role: 'frontend', acceptance: [3],
      demonstration: 'Open the dashboard and see search results and profile details.', blockedBy: ['catalog', 'accounts'] },
  ],
}

async function registeredFanIn() {
  const published = await publish({ ...brief, goal: fanInSpec.body }, fanInSpec)
  await h.runtime.idle()
  await published.register(fanInDraft)
  return published
}

describe('plans on the legacy host fixture', () => {
  beforeEach(async () => {
    h = await startRuntime(undefined, { withFeishu: false })
    brief = savedProductsBrief({ repository: 'acme/widgets', workspace: resolve('workspaces/widgets') })
  })
  afterEach(async () => { await h.stop() })
it('automatically delegates a published spec, resumes interrupted splitting, and registers without starting a Worker', async () => {
  const { id, specId, sessionId, register } = await publish()
  await h.runtime.idle()
  const tasks = () => h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === sessionId)
  expect(tasks()).toHaveLength(1)
  expect(JSON.parse(tasks()[0]!.text)).toMatchObject({ handoff_id: id, spec_id: specId, handoff: `handoff/${id}`, spec: `spec/${id}` })
  expect(h.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === h.runtime.masterId && delivery.text.includes('dsh-superagent-to-tickets'))).toBe(false)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_plan_register', { handoffId: id, specId, ...splitDraft })).rejects.toThrow(/not registered/i)
  await expect(h.runTool(sessionId, 'orchestrator_spec_question', { handoffId: id })).rejects.toThrow(/not registered/i)
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `spec/${id}` })).toMatchObject({ id: specId, ...spec })
  expect(h.tools.get(sessionId)?.get('orchestrator_plan_register')).toMatchObject({ parameters: { properties: { nodes: {
    items: { properties: { interfaceContract: { required: ['path', 'requirements'], additionalProperties: false } } },
  } } } })
  await h.restart()
  await h.runtime.idle()
  expect(tasks()).toHaveLength(2)
  expect(tasks()[1]!.id).not.toBe(tasks()[0]!.id)
  expect(tasks()[1]!.mode).toBe('steer')
  await h.runtime.pump()
  expect(tasks()).toHaveLength(2)
  await register(splitDraft)
  await h.restart()
  await h.runtime.idle()
  expect(await read(`plan/${id}`)).toMatchObject({ id, handoffId: id, specId, status: 'registered',
    stats: { backend: { total: 1, delivered: 0 }, frontend: { total: 1, delivered: 0 } },
    nodes: [
      { id: 'saved-api', role: 'backend', blockedBy: [], status: 'waiting-for-slot', interfaceContract: splitDraft.nodes[0]!.interfaceContract },
      { id: 'saved-page', role: 'frontend', blockedBy: ['saved-api'], status: 'blocked' },
    ],
  })
  expect(tasks()).toHaveLength(2)
  expect([...h.agents.keys()].filter(id => id.startsWith('worker-'))).toEqual([])
})

it('preserves both independent predecessors of a fan-in node and supports a separate singleton maintenance plan', async () => {
  const fanIn = await publish({ ...brief, goal: 'Build a dashboard backed by catalog and account lookups.' }, {
    ...spec, body: 'Use separately demonstrable catalog search, account lookup and a dashboard which consumes both.',
    acceptance: [
      { statement: 'Search the catalog.', observable: 'Search returns matching products.', delivery: 'backend' },
      { statement: 'Retrieve the profile.', observable: 'Account lookup returns the profile.', delivery: 'backend' },
      { statement: 'Dashboard displays both.', observable: 'The dashboard shows search and profile.', delivery: 'frontend' },
    ],
  })
  await h.runtime.idle()
  await expect(fanIn.register({ ...fanInDraft, nodes: fanInDraft.nodes.map(node => node.id === 'catalog'
    ? { ...node, interfaceContract: undefined } : node) })).rejects.toThrow(/catalog|interfaceContract/i)
  expect(await read(`plan/${fanIn.id}`)).toMatchObject({ status: 'pending' })
  await fanIn.register(fanInDraft)
  const maintenance = await publish({ ...brief, goal: maintenanceSpec.body }, maintenanceSpec)
  await h.runtime.idle()
  await expect(h.runTool(maintenance.sessionId, 'orchestrator_read', { resource: `spec/${fanIn.id}` })).rejects.toThrow()
  await expect(h.runTool(maintenance.sessionId, 'orchestrator_plan_register', {
    handoffId: fanIn.id, specId: fanIn.specId, ...fanInDraft,
  })).rejects.toThrow(/handoff|session/i)
  await maintenance.register({ features: [{ id: 'maintenance', kind: 'backend' }], nodes: [{
    id: 'maintenance', featureId: 'maintenance', title: 'Saved-products maintenance', role: 'backend', acceptance: [1],
    demonstration: 'Call the current API before and after the migration.', blockedBy: [],
  }] })
  expect(await read(`plan/${fanIn.id}`)).toMatchObject({
    nodes: [
      { id: 'catalog', blockedBy: [], status: 'waiting-for-slot' },
      { id: 'accounts', blockedBy: [], status: 'waiting-for-slot' },
      { id: 'dashboard', blockedBy: ['catalog', 'accounts'], status: 'blocked' },
    ],
    stats: { backend: { total: 2, delivered: 0 }, frontend: { total: 1, delivered: 0 } },
  })
  expect(await read(`plan/${fanIn.id}`, { offset: 1, limit: 1 })).toMatchObject({
    nodes: [{ id: 'accounts' }], next_offset: 2, stats: { backend: { total: 2 }, frontend: { total: 1 } },
  })
  expect(await read(`plan/${maintenance.id}`)).toMatchObject({
    nodes: [{ id: 'maintenance', role: 'backend', blockedBy: [], status: 'waiting-for-slot' }],
    stats: { backend: { total: 1, delivered: 0 }, frontend: { total: 0, delivered: 0 } },
  })
})

it('rejects malformed graphs with locatable errors without replacing the registered plan or dispatching nodes', async () => {
  const { id, sessionId, specId, register } = await publish()
  await h.runtime.idle()
  const backend = splitDraft.nodes[0]!, frontend = splitDraft.nodes[1]!
  const invalid = [
    { nodes: [backend, { ...frontend, id: backend.id }], error: /saved-api|nodes\.1\.id/i },
    { nodes: [backend, { ...frontend, blockedBy: ['does-not-exist'] }], error: /does-not-exist/i },
    { nodes: [{ ...backend, blockedBy: [backend.id] }, frontend], error: /saved-api/i },
    { nodes: [{ ...backend, blockedBy: [frontend.id] }, frontend], error: /cycl.*saved|saved.*cycl/i },
    { nodes: [{ ...backend, role: undefined }, frontend], error: /role/i },
    { nodes: [{ ...backend, interfaceContract: undefined }, frontend], error: /contract/i },
    { nodes: [{ ...backend, interfaceContract: { ...backend.interfaceContract!, path: '../other/contract.md' } }, frontend], error: /path/i },
    { nodes: [backend, { ...frontend, blockedBy: [] }], error: /saved-page|blockedBy/i },
    { nodes: [{ ...backend, interfaceContract: undefined, title: 'API and page in one ticket' }], error: /saved-products|cross-end/i },
    { nodes: [backend, { ...frontend, acceptance: [2] }], error: /acceptance/i },
  ]
  await expect(register({ ...splitDraft, nodes: invalid[0]!.nodes })).rejects.toThrow(invalid[0]!.error)
  await expect(register({ features: [{ id: 'saved-products', kind: 'backend' }], nodes: [{ ...backend,
    title: 'Implement both the API and the page', interfaceContract: undefined,
  }] })).rejects.toThrow(/acceptance.*1.*cross-end/i)
  expect(await read(`plan/${id}`)).toMatchObject({ status: 'pending', specId })
  await expect(h.runTool(sessionId, 'orchestrator_plan_register', {
    handoffId: id, specId: 'wrong-revision', ...splitDraft,
  })).rejects.toThrow(/spec/i)
  await register(splitDraft)
  const registered = await read(`plan/${id}`)
  for (const { nodes, error } of invalid) {
    await expect(register({ ...splitDraft, nodes })).rejects.toThrow(error)
    expect(await read(`plan/${id}`)).toEqual(registered)
  }
  await register(splitDraft)
  expect(await read(`plan/${id}`)).toEqual(registered)
  await h.runtime.idle()
  expect(await read('tickets')).toMatchObject({ items: [] })
  expect([...h.agents.keys()].filter(key => key.startsWith('worker-'))).toEqual([])
})

it('keeps direct root background and single-node instructions separate across a restart', async () => {
  const { id, sessionId, register } = await publish()
  await h.runtime.idle()
  await register(splitDraft)
  const registered = await read(`plan/${id}`)
  const background = 'The QA environment already has two shopper accounts.'
  const instruction = 'Use the signed-in account fixture for the page demonstration.'
  const append = (message: string) => h.runTool(h.runtime.masterId, 'orchestrator_plan_context', { message })
  const message = JSON.stringify({ planId: id, target: { kind: 'background' }, text: background })
  await expect(append(message)).rejects.toThrow(/latest direct user message/i)
  h.sendUserMessage(h.runtime.masterId, message)
  await append(message)
  await append(message)
  const graph = await read(`plan/${id}`)
  expect(graph).toEqual({ ...registered, context: [expect.objectContaining({ text: background })] })
  const addressed = JSON.stringify({ planId: id, target: { kind: 'node', nodeId: 'saved-page' }, text: instruction })
  h.sendUserMessage(h.runtime.masterId, addressed)
  await expect(append(message)).rejects.toThrow(/latest direct user message/i)
  await append(addressed)
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: `plan/${id}/node/saved-page` })).rejects.toThrow()
  await h.restart()
  expect(await read(`plan/${id}`)).toEqual(graph)
  expect(await read(`plan/${id}/node/saved-api`)).toMatchObject({ instructions: [] })
  const page = await read(`plan/${id}/node/saved-page`)
  expect(page).toMatchObject({ instructions: [expect.objectContaining({ text: instruction })], blockedBy: ['saved-api'] })
  expect(page).not.toHaveProperty('context')
  expect([...h.agents.keys()].filter(key => key.startsWith('worker-'))).toEqual([])
})


})
const fanInSpec = {
  ...spec,
  body: 'Build independent catalog and account backends followed by a dashboard.',
  acceptance: [
    { statement: 'Search the catalog.', observable: 'Search returns matching products.', delivery: 'backend' as const },
    { statement: 'Retrieve the profile.', observable: 'Account lookup returns the profile.', delivery: 'backend' as const },
    { statement: 'Display both in the dashboard.', observable: 'The dashboard shows both results.', delivery: 'frontend' as const },
  ],
}
const PlanDispatchClaimSchema = z.object({ planId: z.string(), nodeId: z.string(), ticketId: z.string(), assignmentId: z.string(), session: z.string(),
  role: z.enum(['backend', 'frontend']), pendingAction: z.enum(['launch', 'resume']).nullable(), claimedAt: z.string(), startedAt: z.string().optional() }).strict()
const PlanDispatchSchema = z.object({ planId: z.string(), nodeId: z.string(), role: z.enum(['backend', 'frontend']), status: z.string(), reused: z.boolean(),
  claim: PlanDispatchClaimSchema.optional(), waitingOn: z.array(z.string()).optional(), reason: z.string().optional(),
  limits: z.strictObject({ maxWorkers: z.number(), projectTokens: z.number().nullable(), ticketTokens: z.number().nullable(),
    stagnation: z.strictObject({ maxAttemptsWithoutProgress: z.number(), idleSeconds: z.number() }) }),
  attention: z.looseObject({ id: z.string(), status: z.literal('awaiting') }).optional() }).strict()
type PlanDispatch = z.infer<typeof PlanDispatchSchema>
const dispatchPlan = async (planId: string, nodeId: string): Promise<PlanDispatch> => PlanDispatchSchema.parse(
  await h.runTool(h.runtime.masterId, 'orchestrator_plan_dispatch', { planId, nodeId }))


describe('managed project plan pause', () => {
  let managedHost: Host | undefined
  afterEach(async () => { if (managedHost) { await managedHost.stop(); managedHost = undefined } })
  it('reports the same effective limits at startup and after a scoped operator save, not a Hub elevation', async () => {
    const { host, project } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    const get = () => h.api('GET', 'project/run-limits', undefined, project.id)
    const defaults = { maxWorkers: 3, projectTokens: null, ticketTokens: null,
      stagnation: { maxAttemptsWithoutProgress: 3, idleSeconds: 900 } }
    expect(await get()).toMatchObject({ status: 200, body: { scope: 'project', configuration: {
      preset: 'default', defaults, effective: { ...defaults, ticketOverrides: [] },
    } } })
    const panel = await h.api('GET', 'settings', undefined, project.id)
    expect(panel.status).toBe(200)
    const { executor: settings } = z.object({ executor: z.object({ value: z.record(z.string(), z.unknown()), revision: z.number() }) })
      .parse(panel.body.blocks)
    expect(settings).toMatchObject(await readExecutorSettings().then(({ value, revision }) => ({ value, revision })))
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: { ...settings.value,
      runLimits: { ticketOverrides: [{ planId: 'missing-plan', nodeId: 'catalog', tokens: 10 }] },
    } }, project.id)).toMatchObject({ status: 404, body: { code: 'unknownPlan' } })
    const value = { ...settings.value, maxWorkers: 2, runLimits: { projectTokens: 1000, ticketTokens: 400,
      stagnation: { idleSeconds: 45 } } }
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value }, project.id)).toMatchObject({ status: 200 })
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: settings.value }, project.id)).toMatchObject({ status: 409 })
    const after = await get()
    expect(after).toMatchObject({ status: 200, body: { configuration: { defaults, effective: {
      maxWorkers: 2, projectTokens: 1000, ticketTokens: 400, stagnation: { maxAttemptsWithoutProgress: 3, idleSeconds: 45 },
    } } } })
    const saved = await readExecutorSettings()
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_settings_save', {
      block: 'executor', revision: saved.revision, value: { ...saved.value, maxWorkers: 16 },
    })).rejects.toThrow()
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_settings_save', {
      block: 'executor', revision: saved.revision, value: { ...saved.value, runLimits: {} },
    })).rejects.toThrow()
    expect(await read('project/run-limits')).toEqual(after.body)
    expect(await h.api('GET', 'project/run-limits')).toMatchObject({ status: 409, body: { code: 'projectScopeRequired' } })
    expect(await h.api('GET', 'project/run-limits', undefined, 'other-project')).toMatchObject({ status: 409, body: { code: 'staleProject' } })
    await h.restart()
    expect(await get()).toEqual(after)
  })

  it('admits a native reviewer before its first skill call and charges its Worker ticket', async () => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: {
      ...settings.value, runLimits: { ticketTokens: 100, projectTokens: 100 },
    } }, project.id)).toMatchObject({ status: 200 })
    const worker = (await dispatchPlan(id, 'catalog')).claim!
    await h.runtime.idle()
    const reviewer = await h.reviewSubagent(worker.session, 'standards', undefined, true, [], async sessionId => {
      expect(h.tools.get(sessionId)?.has('orchestrator_review_submit')).toBe(false)
      await h.modelRequest(sessionId, 100, async function* (): AsyncGenerator<StreamChunk> {
        for (const resource of ['project/run-limits', `ticket/${worker.ticketId}/run-limits`]) {
          expect(await read(resource)).toMatchObject({ budget: { availableTokens: 0, reservedTokens: 100,
            inFlight: [{ sessionId, ticketId: worker.ticketId, maximumTokens: 100 }] } })
        }
        yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 4, totalTokens: 20 } }
      })
    })
    expect(h.tools.get(reviewer)?.has('orchestrator_review_submit')).toBe(true)
    expect(await read(`ticket/${worker.ticketId}/run-limits`)).toMatchObject({ budget: {
      accountedTokens: 20, reportedCalls: 1, reservedTokens: 0, missing: [],
    }, projectBudget: { accountedTokens: 20, reportedCalls: 1 } })
  })

  it('reserves the last project balance before provider I/O and settles only observed usage', async () => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: {
      ...settings.value, runLimits: { projectTokens: 100 },
    } }, project.id)).toMatchObject({ status: 200 })
    const a = (await dispatchPlan(id, 'catalog')).claim!
    const b = (await dispatchPlan(id, 'accounts')).claim!
    await h.runtime.idle()
    const head = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
    const first = h.modelRequest(a.session, 100, async function* (): AsyncGenerator<StreamChunk> {
      head.resolve()
      await finish.promise
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 5, totalTokens: 65 } }
    })
    let providerCalls = 0
    const later = async function* (): AsyncGenerator<StreamChunk> {
      providerCalls++
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
    }
    await Promise.race([head.promise, first])
    const second = h.modelRequest(b.session, 35, later).then(() => 'completed', () => 'refused')
    try {
      expect(providerCalls).toBe(0)
      expect(await read('project/run-limits')).toMatchObject({ budget: { state: 'reserved', accountedTokens: null,
        reservedTokens: 100, availableTokens: 0, missing: [], inFlight: [{ sessionId: a.session, maximumTokens: 100 }] } })
    } finally {
      finish.resolve()
      await first
    }
    expect(await second).toBe('completed')
    expect(providerCalls).toBe(1)
    expect(await read('project/run-limits')).toMatchObject({ budget: { accountedTokens: 77, availableTokens: 23, reportedCalls: 2 } })
    await expect(h.modelRequest(b.session, 24, later)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT_CONFIGURATION' })
    expect(providerCalls).toBe(1)
  })

  it('cancels a model quota waiter before provider I/O without spending or closing its Ticket', async () => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: {
      ...settings.value, runLimits: { projectTokens: 100 },
    } }, project.id)).toMatchObject({ status: 200 })
    const catalog = (await dispatchPlan(id, 'catalog')).claim!
    const accounts = (await dispatchPlan(id, 'accounts')).claim!
    await h.runtime.idle()

    const holding = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const cancel = new AbortController(), nextSignal = new AbortController()
    const providerFailure = new Error('Provider disconnected after sending usage')
    const holder = h.modelRequest(catalog.session, 100, async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 5, totalTokens: 65 } }
      holding.resolve()
      await release.promise
      throw providerFailure
    }).catch((error: unknown) => error)
    try {
      await Promise.race([holding.promise, holder.then(result => {
        throw new Error('The first provider never reached its settlement gate', { cause: result })
      })])
      const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }
      const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
      const arrivals: string[] = []
      const provider = (session: string) => async function* () { arrivals.push(session); yield usage; yield finish }
      const hub = h.runtime.masterId
      const cancelled = h.modelRequest(accounts.session, 35, provider(accounts.session), cancel.signal).catch((error: unknown) => error)
      const next = h.modelRequest(hub, 35, provider(hub), nextSignal.signal).catch((error: unknown) => error)
      const reserved = await read('project/run-limits')
      expect(reserved).toMatchObject({ budget: { state: 'reserved', availableTokens: 0,
        accountedTokens: null, reportedCalls: 0, missing: [], reservedTokens: 100,
        inFlight: [{ sessionId: catalog.session, maximumTokens: 100 }],
      } })
      cancel.abort()
      // A wait-specific refusal distinguishes this from cancellation before admission was reached.
      expect(await cancelled).toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT', message: expect.stringMatching(/cancelled while waiting for quota/) })
      expect(await read('project/run-limits')).toEqual(reserved)
      expect(arrivals).toEqual([])

      release.resolve()
      expect(await holder).toBe(providerFailure)
      expect(await next).toEqual([usage, finish])
      expect(arrivals).toEqual([hub])
      expect(await read('project/run-limits')).toMatchObject({ budget: { state: 'available', availableTokens: 24,
        accountedTokens: 76, reportedCalls: 2, missing: [], reservedTokens: 0, inFlight: [],
      } })
      expect(await read(`ticket/${accounts.ticketId}/run-limits`)).toMatchObject({ budget: {
        accountedTokens: null, reportedCalls: 0, missing: [], reservedTokens: 0, inFlight: [],
      } })
      expect(await h.api('GET', `attention/summary?planId=${id}`, undefined, project.id)).toMatchObject({ status: 200,
        body: { running: 2, awaitingHuman: 0, actions: [] } })
      expect(await read(`ticket/${accounts.ticketId}`)).not.toHaveProperty('ended')
      const node = await read(`plan/${id}/node/accounts`)
      expect(node).toMatchObject({ status: 'running' })
      expect(node).not.toHaveProperty('delivery')
      await h.idleRelay()
      expect(h.jsonRelays(hub, 'quota-paused')).toEqual([])
    } finally {
      cancel.abort()
      nextSignal.abort()
      release.resolve()
    }
  })

  it.each(['usage-missing', 'exhausted'] as const)('keeps a %s quota pause local and reports it once across restart', async state => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: { ...settings.value, maxWorkers: 1,
      runLimits: { ticketTokens: 40, ticketOverrides: [{ planId: id, nodeId: 'accounts', tokens: 80 }] },
    } }, project.id)).toMatchObject({ status: 200 })
    const a = (await dispatchPlan(id, 'catalog')).claim!
    await h.runtime.idle()
    const reported = state === 'exhausted'
    await h.modelRequest(a.session, 40, async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 34, outputTokens: 6, ...(reported ? { totalTokens: 40 } : {}) } }
    })
    const resource = `ticket/${a.ticketId}/run-limits`
    const get = () => h.api('GET', `tickets/${a.ticketId}/run-limits`, undefined, project.id)
    const paused = await get()
    expect(paused).toMatchObject({ status: 200, body: { scope: 'ticket', ticketId: a.ticketId, budget: { state,
      accountedTokens: reported ? 40 : null, availableTokens: reported ? 0 : null, reservedTokens: 0, inFlight: [],
      missing: reported ? [] : [expect.objectContaining({ sessionId: a.session, calls: 1, interrupted: 0 })],
    }, projectBudget: { state: 'unlimited' } } })
    expect(await read(resource)).toEqual(paused.body)
    await expect(h.runTool(a.session, 'orchestrator_read', { resource })).rejects.toThrow()
    expect(await h.api('POST', `tickets/${a.ticketId}/retry`, undefined, project.id)).toMatchObject({ status: 400, body: { code: 'quotaPaused' } })
    const identity = { ticketId: a.ticketId, assignmentId: a.assignmentId, session: a.session }
    expect(await dispatchPlan(id, 'catalog')).toMatchObject({ status: 'quota-paused', reused: true, claim: identity })
    expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
    await h.idleRelay()
    const notices = () => h.jsonRelays(h.runtime.masterId, 'quota-paused')
    expect(notices()).toEqual([expect.objectContaining({ scope: 'ticket', reason: state, ticketId: a.ticketId,
      planId: id, nodeId: 'catalog', title: 'Catalog search', resource })])

    await h.restart()
    await h.runtime.idle()
    expect(await get()).toEqual(paused)
    expect(await dispatchPlan(id, 'catalog')).toMatchObject({ status: 'quota-paused', reused: true, claim: identity })
    const dispatched = await dispatchPlan(id, 'accounts')
    expect(dispatched.limits).toEqual({ maxWorkers: 1, projectTokens: null, ticketTokens: 80,
      stagnation: { maxAttemptsWithoutProgress: 3, idleSeconds: 900 } })
    const b = dispatched.claim!
    await h.runtime.idle()
    await h.modelRequest(b.session, 80, async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 47, outputTokens: 3, totalTokens: 50 } }
    })
    expect(await read(`ticket/${b.ticketId}/run-limits`)).toMatchObject({ budget: { state: 'available', availableTokens: 30 } })
    expect(await h.api('GET', 'attention/summary', undefined, project.id)).toMatchObject({ status: 200, body: { running: 1 } })
    expect(await read(`plan/${id}/node/catalog`)).not.toHaveProperty('delivery')
    expect(notices()).toHaveLength(1)
  })
  it('resumes the same quota-paused Plan claim after an operator raises its ticket limit', async () => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: { ...settings.value,
      maxWorkers: 1, runLimits: { ticketTokens: 40 },
    } }, project.id)).toMatchObject({ status: 200 })

    const initial = (await dispatchPlan(id, 'catalog')).claim!
    expect(await dispatchPlan(id, 'accounts')).toMatchObject({ status: 'waiting-for-slot', reused: false })
    await h.runtime.idle()
    await h.modelRequest(initial.session, 40, async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 34, outputTokens: 6, totalTokens: 40 } }
    })
    const identity = { ticketId: initial.ticketId, assignmentId: initial.assignmentId, session: initial.session }
    expect(await dispatchPlan(id, 'catalog')).toMatchObject({ status: 'quota-paused', reused: true, claim: identity })
    expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })

    const current = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: current.revision, value: { ...current.value,
      runLimits: { ticketTokens: 80 },
    } }, project.id)).toMatchObject({ status: 200 })
    await h.runtime.idle()

    expect(await dispatchPlan(id, 'catalog')).toMatchObject({ status: 'running', reused: true, claim: identity })
    expect(await dispatchPlan(id, 'accounts')).toMatchObject({ status: 'waiting-for-slot', reused: false })
    expect(await read(`plan/${id}/node/catalog`)).toMatchObject({ status: 'running', claim: identity })
    expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
    // A recovery note can arrive without a second Assignment being sent.
    const assignmentDeliveries = h.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === initial.session
      && delivery.text.startsWith('{') && JSON.parse(delivery.text).ticket_id === initial.ticketId)
    expect(assignmentDeliveries).toHaveLength(1)
    await h.modelRequest(initial.session, 40, async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 18, outputTokens: 2, totalTokens: 20 } }
    })
    expect(await read(`ticket/${initial.ticketId}/run-limits`)).toMatchObject({ budget: { state: 'available',
      limitTokens: 80, accountedTokens: 60, availableTokens: 20 } })
  })

  it('recovers an interrupted provider reservation as missing, never as a free or still-live request', async () => {
    const { host, project, projectBrief } = await startManagedProject({ withFeishu: false })
    managedHost = h = host
    brief = savedProductsBrief(projectBrief)
    const { id } = await registeredFanIn()
    const settings = await readExecutorSettings()
    expect(await h.api('PUT', 'settings/executor', { revision: settings.revision, value: {
      ...settings.value, runLimits: { projectTokens: 64 },
    } }, project.id)).toMatchObject({ status: 200 })
    const a = (await dispatchPlan(id, 'catalog')).claim!
    await h.runtime.idle()
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
    const first = h.modelRequest(a.session, 64, async function* (): AsyncGenerator<StreamChunk> {
      started.resolve()
      await finish.promise
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }
    })
    await Promise.race([started.promise, first])
    try {
      expect(await dispatchPlan(id, 'accounts')).toMatchObject({ status: 'waiting-for-budget', reused: false })
      await h.restart()
      expect(await dispatchPlan(id, 'accounts')).toMatchObject({ status: 'quota-paused', reused: false })
    } finally {
      finish.resolve()
      await first
    }
    expect(await read('project/run-limits')).toMatchObject({ budget: { state: 'usage-missing', accountedTokens: null,
      reservedTokens: 0, inFlight: [], missing: [expect.objectContaining({ sessionId: a.session, calls: 1, interrupted: 1 })] } })
  })

  it('pauses only the Plan ticket with a missing test account and sends one controlled action request', async () => {
  const managed = await startManagedProject({ withFeishu: false, machine: project => ({ credentialChecks: [{ projectId: project.id,
    id: 'test-account', executable: process.execPath, args: ['--fixture-check-test-account'],
    providerUrl: 'https://account.example.test/test-account' }] }) })
  managedHost = managed.host
  h = managed.host
  const project = managed.project
  brief = savedProductsBrief(managed.projectBrief)

  const third = { id: 'export', kind: 'backend' }
  const { id, register } = await publish({ ...brief, goal: fanInSpec.body }, fanInSpec)
  await h.runtime.idle()
  await register({ features: [...fanInDraft.features, third], nodes: [
    ...fanInDraft.nodes.map(node => node.id === 'dashboard' ? { ...node, blockedBy: ['accounts'] } : node),
    { id: third.id, featureId: third.id, title: 'Export catalogue', role: 'backend', acceptance: [1],
      demonstration: 'Export catalogue rows as CSV.', blockedBy: [] },
  ] })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 3 } })
  const a = (await dispatchPlan(id, 'catalog')).claim!, b = (await dispatchPlan(id, 'accounts')).claim!
  const c = (await dispatchPlan(id, 'export')).claim!
  await h.runtime.idle()
  h.deliveries.mockClear()
  await expect(h.runTool(b.session, 'orchestrator_report', { state: 'blocked', summary: 'Blocked', human_action: 'Paste the API key here.' }))
    .rejects.toThrow(/credential blocker/)
  const activeJobs = [a, b, c].map(claim => h.jobs.run(claim.session))
  const reportMissing = () => h.runTool(b.session, 'orchestrator_credential_blocked', { credential_id: 'test-account' })
  const action = await reportMissing()
  expect(await reportMissing()).toEqual(action)
  expect(action).toMatchObject({ providerUrl: 'https://account.example.test/test-account', verifierConfigured: true, occurrence: 0 })
  await h.runtime.idle()
  expect(h.jobs.service.kill.mock.calls.map(([job]) => job)).toEqual([activeJobs[1]])
  const summary = () => h.api('GET', `attention/summary?planId=${id}`, undefined, project.id)
  const expected = { running: 2, awaitingHuman: 1, message: '2 张执行中，1 张待你处理' }
  expect(await summary()).toMatchObject({ status: 200, body: expected })
  expect(await read(`plan/${id}/attention`)).toMatchObject(expected)
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['accounts'] })
  expect(await read(`plan/${id}/node/accounts`)).toMatchObject({ attention: { id: action.id, status: 'awaiting' } })
  const push = () => h.jsonRelays<{ kind: string } & Record<string, unknown>>(h.runtime.masterId, 'human-action')
  expect(push()).toEqual([expect.objectContaining({ kind: 'human-action', ...expected, action: expect.objectContaining({
    ticketId: b.ticketId, title: 'Account lookup', affectedNodes: ['dashboard'], configuration: expect.any(String),
  }) })])
  expect(await h.runTool(a.session, 'orchestrator_report', { state: 'progress', summary: 'Catalogue still running' }))
    .toMatchObject({ notification: 'internal_only' })
  expect(await h.runTool(c.session, 'orchestrator_report', { state: 'progress', summary: 'Export is still running' }))
    .toMatchObject({ notification: 'internal_only' })
  expect(await h.runTool(c.session, 'orchestrator_report', { state: 'failed', summary: 'Transient export retry' }))
    .toMatchObject({ notification: 'internal_only' })
  await expect(h.runTool(b.session, 'orchestrator_report', { state: 'ready', summary: 'Skip configuration' })).rejects.toThrow()
  const workerDeliveries = () => h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === b.session)

  const path = String(action.configuration).replace('/orchestrator/api/', '')
  expect(await h.api('GET', path, undefined, 'unselected-project')).toMatchObject({ status: 409 })
  expect(await h.api('GET', 'attention/summary?planId=unknown', undefined, project.id)).toMatchObject({ status: 404 })
  expect(await h.api('GET', path, undefined, project.id)).toMatchObject({ status: 200, body: { id: action.id, status: 'awaiting' } })
  expect(await h.api('POST', `tickets/${b.ticketId}/retry`, undefined, project.id)).toMatchObject({ status: 400, body: { code: 'credentialBlocked' } })
  expect(await h.api('POST', `${path}/verify`, { verified: true }, project.id)).toMatchObject({ status: 400 })
  h.hooks.credentialCheck = () => false
  const failed = await h.api('POST', `${path}/verify`, {}, project.id)
  expect(failed).toMatchObject({ status: 200, body: { status: 'awaiting', verification: 'failed' } })
  expect(JSON.stringify(failed)).not.toContain('fixture-secret-from-verifier')
  const verificationStarted = Promise.withResolvers<void>()
  const verificationResult = Promise.withResolvers<boolean>()
  h.hooks.credentialCheck = () => {
    verificationStarted.resolve()
    return verificationResult.promise
  }
  const interruptedVerification = h.api('POST', `${path}/verify`, {}, project.id)
  await verificationStarted.promise
  const restart = h.restart()
  verificationResult.resolve(true)
  expect(await interruptedVerification).toMatchObject({ status: 409, body: { code: 'switching' } })
  await restart
  await h.runtime.idle()
  expect(push()).toHaveLength(1)
  expect(await summary()).toMatchObject({ status: 200, body: { awaitingHuman: 1 } })
  expect(workerDeliveries()).toEqual([])
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['accounts'] })

  h.hooks.credentialCheck = () => true
  const verify = () => h.api('POST', `${path}/verify`, {}, project.id)
  expect(await verify()).toMatchObject({ status: 200, body: { status: 'verified', verification: 'passed' } })
  await h.runtime.idle()
  expect(await h.runTool(b.session, 'orchestrator_report', { state: 'progress', summary: 'Validated account works' }))
    .toMatchObject({ notification: 'internal_only' })
  expect(workerDeliveries()).toEqual([expect.objectContaining({ mode: 'queue' })])
  expect(await reportMissing()).toMatchObject({ id: action.id, status: 'verified' })
  expect(await verify()).toMatchObject({ status: 200, body: { status: 'verified' } })
  expect(await summary()).toMatchObject({ status: 200, body: { awaitingHuman: 0 } })
  expect(push()).toHaveLength(1)
  const recurrence = await h.runTool(b.session, 'orchestrator_credential_blocked', { credential_id: 'test-account', occurrence: 1 })
  expect(recurrence).toMatchObject({ status: 'awaiting', occurrence: 1 })
  expect(recurrence.id).not.toBe(action.id)
  expect(await reportMissing()).toMatchObject({ id: action.id, status: 'verified' })
  expect(await dispatchPlan(id, 'accounts')).toMatchObject({ reused: true, attention: { id: recurrence.id },
    claim: { ticketId: b.ticketId, assignmentId: b.assignmentId, session: b.session } })
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['accounts'] })

  const pull = { source: 'github', id: '42' }
  h.runtime.engine.bindThread(b.ticketId, pull, true)
  h.runtime.engine.threadClosed(pull, 'merged', new Date().toISOString())
  expect(await read(`plan/${id}/node/accounts`)).toMatchObject({ attention: { id: recurrence.id, status: 'awaiting' } })
  const repeatedPath = String(recurrence.configuration).replace('/orchestrator/api/', '')
  expect(await h.api('POST', `${repeatedPath}/verify`, {}, project.id)).toMatchObject({ status: 200, body: { status: 'verified' } })
  // A PR lifecycle event is not a receipt from the mainline queue; resume the same Assignment for real verification.
  await h.runtime.idle()
  const resumed = await read(`plan/${id}/node/accounts`)
  expect(resumed).toMatchObject({ status: 'running', claim: { ticketId: b.ticketId, assignmentId: b.assignmentId, session: b.session } })
  expect(resumed).not.toHaveProperty('delivery')
  expect(resumed).not.toHaveProperty('attention')
  expect(workerDeliveries()).toHaveLength(2)
  await h.restart()
  await h.runtime.idle()
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['accounts'] })
})
})
describe('plans on the legacy host fixture after managed scenario', () => {
  beforeEach(async () => {
    h = await startRuntime(undefined, { withFeishu: false })
    brief = savedProductsBrief({ repository: 'acme/widgets', workspace: h.localGit!.repository })
  })
  afterEach(async () => { await h.stop() })

it('counts a forked review once and keeps one Hub call across two active Tickets in shared project usage', async () => {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const catalog = (await dispatchPlan(id, 'catalog')).claim!
  const accounts = (await dispatchPlan(id, 'accounts')).claim!
  await h.runtime.idle()

  const master = h.runtime.masterId
  const at = Date.UTC(2026, 10, 20)
  const context = { type: 'request/context', time: at, data: { provider: 'fixture', model: 'fixture-model', contextWindow: 8192 } }
  const message = (totalTokens: number) => {
    const usage = { inputTokens: totalTokens - 2, outputTokens: 1, cacheReadTokens: 1, totalTokens }
    return { type: 'assistant/message', time: at + 1, data: { turn: 1, step: 1, usage, message: { role: 'assistant', content: [] },
      stream: [{ type: 'chunk', time: at + 1, chunk: { type: 'usage', usage } }] } }
  }
  h.record(catalog.session, [context, message(10)])
  const review = await h.reviewSubagent(catalog.session, 'spec', undefined, true, [context, message(10)])
  h.record(review, [message(6)])
  h.record(accounts.session, [context, { type: 'assistant/attempt', time: at + 2, data: { turn: 1, step: 1, stream: [] } },
    { type: 'turn/end', time: at + 3, data: { turn: 1, reason: 'cancelled' } }])
  h.record(master, [context, message(5)])
  h.record('unowned-fork', [context, message(10), message(100)], 2)

  const expected = { scope: 'project', id: null, attributed: { reported_total_tokens: 16 }, shared: { reported_total_tokens: 5 },
    total: { reported_total_tokens: 21, reported_total_calls: 3, total_complete: false, quality: 'partial' } }
  const project = await h.api('GET', 'project/meter')
  expect(project).toMatchObject({ status: 200, body: expected })
  expect(await read('project/meter')).toEqual(project.body)

  const ticket = await h.api('GET', `tickets/${catalog.ticketId}/meter`)
  expect(ticket).toMatchObject({ status: 200, body: { scope: 'ticket', id: catalog.ticketId,
    attributed: { reported_total_tokens: 16 }, shared: { reported_total_tokens: 5 }, total: { reported_total_tokens: 16 },
    sessions: expect.arrayContaining([
      expect.objectContaining({ session_id: catalog.session, roles: ['implementation'], ticket_id: catalog.ticketId, plan_id: id,
        context: expect.objectContaining({ model: 'fixture-model', capacity_tokens: 8192, source: 'session-events', quality: 'unknown',
          sampled_at: new Date(at + 1).toISOString() }),
        own: expect.objectContaining({ input_tokens: 8, output_tokens: 1, reported_total_tokens: 10 }),
        including_children: expect.objectContaining({ reported_total_tokens: 16 }) }),
      expect.objectContaining({ session_id: review, parent_session_id: catalog.session, roles: expect.arrayContaining(['review']),
        own: expect.objectContaining({ reported_total_tokens: 6 }) }),
    ]),
  } })
  expect(await read(`ticket/${catalog.ticketId}/meter`)).toEqual(ticket.body)
  const plan = await h.api('GET', `plans/${id}/meter`)
  expect(plan).toMatchObject({ status: 200, body: { scope: 'plan', id, attributed: { reported_total_tokens: 16 },
    shared: { reported_total_tokens: 5 }, total: { reported_total_tokens: 16, counted_calls: 2 } } })
  expect(await read(`plan/${id}/meter`)).toEqual(plan.body)

  const cancelled = await h.api('GET', `tickets/${accounts.ticketId}/meter`)
  expect(cancelled).toMatchObject({ status: 200, body: { attributed: { reported_total_tokens: null, quality: 'unknown' },
    total: { input_tokens: null, reported_total_tokens: null,
      missing: [expect.objectContaining({ session_id: accounts.session, reason: 'no-usage', from: expect.any(Number), through: expect.any(Number) })] },
    shared: { reported_total_tokens: 5 } } })
  expect(await h.api('GET', 'plans/unknown/meter')).toMatchObject({ status: 404 })
  expect(await h.api('GET', 'tickets/unknown/meter')).toMatchObject({ status: 404 })
  await expect(h.runTool(catalog.session, 'orchestrator_read', { resource: `ticket/${catalog.ticketId}/meter` })).rejects.toThrow()

  // Reopen with a new Hub identity and the business child unloaded, while all old logs stay durable.
  h.agents.delete(review)
  h.runtime.store.set(KV.runtime.masterId, 'rotated-hub')
  await h.restart()
  expect(h.runtime.masterId).toBe('rotated-hub')
  const after = await h.api('GET', 'project/meter')
  expect(after).toMatchObject({ status: 200, body: { ...expected, sessions: expect.arrayContaining([
    expect.objectContaining({ session_id: master, roles: ['hub'] }),
    expect.objectContaining({ session_id: 'rotated-hub', roles: ['hub'] }),
    expect.objectContaining({ session_id: catalog.session, parent_session_id: master }),
  ]) } })
  expect(await h.api('GET', `sessions/${review}/meter`)).toMatchObject({ status: 200, body: { inherited_events: 2,
    usage: { reported_total_tokens: 6, counted_calls: 1 } } })
})

it.each(['HTTP', 'Hub'] as const)('does not mix physical log generations in a %s meter read', async entry => {
  const { id } = await registeredFanIn()
  const { session, ticketId } = (await dispatchPlan(id, 'catalog')).claim!
  await h.runtime.idle()
  const query = async () => {
    if (entry === 'Hub') return read(`ticket/${ticketId}/meter`)
    const response = await h.api('GET', `tickets/${ticketId}/meter`)
    expect(response.status).toBe(200)
    return response.body
  }
  const message = (inputTokens: number, outputTokens: number, totalTokens: number) => ({ type: 'assistant/message',
    data: { turn: 1, step: 1, usage: { inputTokens, outputTokens, totalTokens }, stream: [], message: { role: 'assistant', content: [] } } })
  h.record(session, [message(8, 2, 10)])
  expect(await query()).toMatchObject({ attributed: { reported_total_tokens: 10, counted_calls: 1 } })

  const opening = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  h.hooks.openingLog = id => {
    if (id !== session) return undefined
    opening.resolve()
    return release.promise
  }
  const pending = query()
  let restore: (() => void) | undefined
  try {
    await Promise.race([opening.promise, pending.then(() => { throw new Error('The meter did not open the Worker log') })])
    restore = h.useStoredLog(session, Date.now(), [message(3, 1, 4)])
    release.resolve()
    expect(await pending).toMatchObject({ attributed: { reported_total_tokens: null, counted_calls: 0 },
      sessions: expect.arrayContaining([expect.objectContaining({ session_id: session, log_status: 'unverified', context: null })]) })
  } finally {
    release.resolve()
    delete h.hooks.openingLog
    restore?.()
  }
  h.record(session, [message(5, 1, 6)])
  expect(await query()).toMatchObject({ attributed: { reported_total_tokens: 16, counted_calls: 2 } })
})

it('claims only frontier nodes, records role/session/action before start, and deduplicates a node claim', async () => {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const prepare = Promise.withResolvers<void>()
  h.hooks.prepare = prepare.promise
  try {
    const [catalog, replay, accounts, dashboard] = await Promise.all([
      dispatchPlan(id, 'catalog'), dispatchPlan(id, 'catalog'), dispatchPlan(id, 'accounts'), dispatchPlan(id, 'dashboard'),
    ] as const)
    const catalogClaim = catalog.claim, accountsClaim = accounts.claim
    if (!catalogClaim || !accountsClaim) throw new Error('Independent frontier nodes must have claims')
    expect(catalog).toMatchObject({ status: 'claimed', reused: false, claim: { role: 'backend', pendingAction: 'launch' } })
    expect(replay).toMatchObject({ status: 'claimed', reused: true, claim: catalogClaim })
    expect(accounts).toMatchObject({ status: 'claimed', reused: false, claim: { role: 'backend', pendingAction: 'launch' } })
    expect(dashboard).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
    expect((await read(`plan/${id}`)).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'catalog', status: 'claimed', claim: catalogClaim }),
      expect.objectContaining({ id: 'accounts', status: 'claimed', claim: accountsClaim }),
      expect.objectContaining({ id: 'dashboard', status: 'blocked', waiting_on: ['catalog', 'accounts'] }),
    ]))
    expect(await read(`ticket/${catalogClaim.ticketId}`)).toMatchObject({ plan: { plan_id: id, node_id: 'catalog', role: 'backend', pending_action: 'launch' } })
    expect(h.agents.has(catalogClaim.session)).toBe(false)
  } finally { prepare.resolve() }
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId.startsWith('worker-'))).toHaveLength(2)
  expect((await read(`plan/${id}`)).nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'catalog', status: 'running', claim: expect.objectContaining({ pendingAction: null }) }),
    expect.objectContaining({ id: 'accounts', status: 'running', claim: expect.objectContaining({ pendingAction: null }) }),
  ]))
})

it('leaves the other frontier node waiting when the last worker slot is already claimed', async () => {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const prepare = Promise.withResolvers<void>()
  h.hooks.prepare = prepare.promise
  try {
    const [first, second] = await Promise.all([dispatchPlan(id, 'catalog'), dispatchPlan(id, 'accounts')] as const)
    expect(first).toMatchObject({ status: 'claimed' })
    expect(second).toMatchObject({ status: 'waiting-for-slot', reused: false })
    expect((await read(`plan/${id}`)).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'catalog', status: 'claimed' }),
      expect.objectContaining({ id: 'accounts', status: 'waiting-for-slot' }),
    ]))
  } finally { prepare.resolve() }
  await h.runtime.idle()
})

async function dispatchedFanIn() {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const [catalog, accounts] = await Promise.all([dispatchPlan(id, 'catalog'), dispatchPlan(id, 'accounts')] as const)
  const catalogClaim = catalog.claim, accountsClaim = accounts.claim
  if (!catalogClaim || !accountsClaim) throw new Error('Independent frontier nodes must have claims')
  await h.runtime.idle()
  return { id, catalogClaim, accountsClaim }
}

it('keeps Worker requests internal until the Hub confirms a product question for the right criterion', async () => {
  const { id, catalogClaim, accountsClaim } = await dispatchedFanIn()
  h.deliveries.mockClear()
  await h.runTool(catalogClaim.session, 'orchestrator_report', {
    state: 'failed', summary: 'The catalog check returned 500', human_action: 'Please fix the failing check.',
  })
  await h.runtime.idle()
  expect(h.jsonRelays(h.runtime.masterId, 'human-action')).toEqual([])
  expect(await read(`plan/${id}/node/catalog`)).toMatchObject({ recovery: { attempts: 1 } })
  expect(await read(`plan/${id}/attention`)).toMatchObject({ awaitingHuman: 0 })
  const report = await h.runTool(accountsClaim.session, 'orchestrator_report', {
    state: 'blocked', summary: 'Need the product decision', human_action: 'Should the profile support password login?',
  }) as { question_proposal: { id: string } }
  await h.runtime.idle()
  expect(h.jsonRelays(h.runtime.masterId, 'human-action')).toEqual([])
  expect(await read(`plan/${id}/attention`)).toMatchObject({ awaitingHuman: 0 })
  const master = h.runtime.masterId
  const question = { ticket_id: accountsClaim.ticketId, question_id: report.question_proposal.id, criterion: 2 }
  const ask = (args: typeof question, session = master) => h.runTool(session, 'orchestrator_plan_question', args)
  await expect(ask(question, accountsClaim.session)).rejects.toThrow(/not registered/i)
  await expect(ask({ ...question, criterion: 1 })).rejects.toThrow(/criterion/i)
  expect(await ask(question)).toMatchObject({ question_id: question.question_id, reused: false })
  expect(await ask(question)).toMatchObject({ question_id: question.question_id, reused: true })
  await h.runtime.idle()
  expect(h.jsonRelays(master, 'human-action')).toEqual([expect.objectContaining({
    ticket: expect.objectContaining({ attention: expect.objectContaining({ id: question.question_id }) }),
  })])
  const args = { ticket_id: accountsClaim.ticketId, question_id: question.question_id, answer: 'Use sign-in links only.' }
  await expect(h.runTool(master, 'orchestrator_plan_answer', args)).rejects.toThrow()
  const wrongTicket = { ...args, ticket_id: catalogClaim.ticketId }
  h.sendUserMessage(master, JSON.stringify(wrongTicket))
  await expect(h.runTool(master, 'orchestrator_plan_answer', wrongTicket)).rejects.toThrow()
  h.sendUserMessage(master, JSON.stringify(args))
  expect(await h.runTool(master, 'orchestrator_plan_answer', args)).toMatchObject({ ticket_id: accountsClaim.ticketId, question_id: question.question_id })
  await expect(h.runTool(master, 'orchestrator_plan_answer', args)).rejects.toThrow()
  await expect(ask(question)).rejects.toThrow(/question/i)
  await h.runtime.idle()
  const delivered = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.text === args.answer)
  expect(delivered).toEqual([expect.objectContaining({ sessionId: accountsClaim.session })])
  expect(await read(`plan/${id}/attention`)).toMatchObject({ awaitingHuman: 0 })
})

const receiptFor = (nodeId: string, claim: Pick<z.infer<typeof PlanDispatchClaimSchema>, 'ticketId' | 'assignmentId'>) => ({
  ticketId: claim.ticketId, assignmentId: claim.assignmentId, receiptId: `delivery-${nodeId}`,
  base: '1'.repeat(40), generation: 1, candidate: '2'.repeat(40), integration: '3'.repeat(40), actual: '3'.repeat(40), verifiedAt: '2026-11-17T11:00:47Z',
})

it('rejects formal delivery from Hub and Worker tools and keeps receipt-looking reports blocked after restart', async () => {
  const { id, catalogClaim, accountsClaim } = await dispatchedFanIn()
  for (const [nodeId, claim] of [['catalog', catalogClaim], ['accounts', accountsClaim]] as const) {
    const args = { planId: id, nodeId, receipt: receiptFor(nodeId, claim) }
    await expect(h.runTool(claim.session, 'orchestrator_plan_deliver', args)).rejects.toThrow(/is not registered/)
    await h.runTool(claim.session, 'orchestrator_report', { state: 'ready', summary: JSON.stringify(args) })
  }
  await h.runtime.idle()
  for (const claim of [catalogClaim, accountsClaim]) expect(await read(`ticket/${claim.ticketId}`)).not.toHaveProperty('ended')
  expect(await read(`plan/${id}/node/catalog`)).toMatchObject({ status: 'awaiting-delivery' })
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_plan_deliver', {
    planId: id, nodeId: 'catalog', receipt: receiptFor('catalog', catalogClaim),
  })).rejects.toThrow(/is not registered/)
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })

  await h.restart()
  await h.runtime.idle()
  expect(await read(`plan/${id}`)).toMatchObject({ frontier: [], nodes: expect.arrayContaining([
    expect.objectContaining({ id: 'catalog', status: 'awaiting-delivery' }),
    expect.objectContaining({ id: 'accounts', status: 'awaiting-delivery' }),
  ]) })
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
  // Model an old executor that persisted a successful close without the Plan transaction. There is
  // deliberately no public tool for producing this state today. Recovery must not infer a receipt.
  const legacy = h.runtime.store.tickets.get(catalogClaim.ticketId)!
  const at = new Date().toISOString()
  legacy.ended = { by: 'executor', outcome: 'completed', at }
  const assignment = legacy.assignments.at(-1)!
  assignment.state = 'ended'; assignment.endedAt = at
  h.runtime.store.tickets.save(legacy)
  await h.restart()
  await h.runtime.idle()
  expect(await read(`ticket/${catalogClaim.ticketId}`)).toMatchObject({ state: 'completed', ended: { by: 'executor' } })
  expect(await read(`plan/${id}/node/catalog`)).not.toHaveProperty('delivery')
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
})

it('does not deliver a failed, stopped or dropped predecessor', async () => {
  const { id, catalogClaim, accountsClaim } = await dispatchedFanIn()
  const blocked = async () => {
    for (const node of ['catalog', 'accounts']) expect(await read(`plan/${id}/node/${node}`)).not.toHaveProperty('delivery')
    expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
  }
  await h.runTool(catalogClaim.session, 'orchestrator_report', { state: 'failed', summary: 'The catalog lookup failed.' })
  await h.runtime.idle()
  expect(await read(`ticket/${catalogClaim.ticketId}`)).toMatchObject({ state: 'person/failed' })
  await blocked()

  expect(await h.api('POST', `tickets/${catalogClaim.ticketId}/stop`, {})).toMatchObject({ status: 200, body: { stopped: true } })
  await h.runTool(accountsClaim.session, 'orchestrator_report', { state: 'dropped', summary: 'Cancelled before delivery.' })
  await h.runtime.idle()
  expect(await read(`ticket/${catalogClaim.ticketId}`)).toMatchObject({ state: 'stopped', ended: { by: 'human' } })
  expect(await read(`ticket/${accountsClaim.ticketId}`)).toMatchObject({ state: 'dropped', ended: { by: 'executor' } })
  await blocked()
})

it('replays a durable claim after restart without creating a second Worker delivery', async () => {
  const published = await publish()
  await h.runtime.idle()
  await published.register(splitDraft)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true, executor: { ...settings.executor, maxWorkers: 1 } })
  const before = h.runtime.planDispatcher.dispatch(published.id, 'saved-api')
  const beforeClaim = before.claim
  if (!beforeClaim) throw new Error('A dispatched node must have a durable claim')
  expect(before).toMatchObject({ status: 'claimed', claim: { pendingAction: 'launch' } })
  await h.restart()
  expect((await read(`plan/${published.id}/node/saved-api`)).claim).toEqual(beforeClaim)
  expect(await read(`plan/${published.id}/node/saved-page`)).toMatchObject({ status: 'blocked', waiting_on: ['saved-api'] })
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  const deliveries = h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === beforeClaim.session)
  expect(deliveries).toHaveLength(1)
  expect((await read(`plan/${published.id}/node/saved-api`)).status).toBe('running')
  expect(await dispatchPlan(published.id, 'saved-page')).toMatchObject({ status: 'blocked', waitingOn: ['saved-api'] })
})

it('does not meter a preallocated Worker ID before its verified Session is handed off', async () => {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true })
  const claim = h.runtime.planDispatcher.dispatch(id, 'catalog').claim!
  await h.controller.create({ sessionId: claim.session, workspaceId: h.directory })
  h.record(claim.session, [{ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] },
    stream: [], usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 } } }])
  const meter = `ticket/${claim.ticketId}/meter`
  const expected = { attributed: { counted_calls: 0, reported_total_tokens: null, quality: 'unknown' },
    sessions: expect.arrayContaining([expect.objectContaining({ session_id: claim.session, context: null })]) }
  expect(await read(meter)).toMatchObject(expected)
  await h.restart()
  expect(await read(meter)).toMatchObject(expected)
})

it('replans a repeatedly failing Plan check without loosening its successor gate', async () => {
  const { id, catalogClaim } = await dispatchedFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    runLimits: { stagnation: { maxAttemptsWithoutProgress: 2, idleSeconds: 3600 } } } })
  for (const attempt of [1, 2]) {
    await h.runTool(catalogClaim.session, 'orchestrator_report', {
      state: 'failed', summary: `Catalog contract check failed on attempt ${attempt}: expected a 200 response`,
    })
  }
  await h.runtime.pump()
  await h.runtime.idle()
  expect(await read(`plan/${id}/node/catalog`)).toMatchObject({
    recovery: { status: 'diagnose', failureId: expect.any(String) },
  })
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'] })
  expect(h.jsonRelays(h.runtime.masterId, 'human-action')).toEqual([])
  const { recovery: { failureId } } = await read(`plan/${id}/node/catalog`) as { recovery: { failureId: string } }
  const replan = (change: unknown, extra = {}) => h.runTool(h.runtime.masterId, 'orchestrator_plan_replan', {
    planId: id, nodeId: 'catalog', revision: 1, failureId, reason: 'Keep the account profile contract ahead of the dashboard', change, ...extra,
  })
  const dependencies = (nodeId: string, blockedBy: string[]) => ({ kind: 'dependencies', updates: [{ nodeId, blockedBy }] })
  await expect(replan(dependencies('dashboard', ['accounts']))).rejects.toThrow(/undelivered dependency/)
  await expect(replan(dependencies('dashboard', ['catalog', 'accounts', 'unknown']))).rejects.toThrow(/unknown node/i)
  await expect(replan(dependencies('dashboard', ['catalog', 'accounts', 'dashboard']))).rejects.toThrow(/itself/)
  await expect(replan(dependencies('dashboard', ['catalog', 'accounts']), { authorization: { release: 'authorized' } })).rejects.toThrow()
  await expect(replan({ kind: 'split', nodeId: 'dashboard', groups: [[3], [1]] })).rejects.toThrow(/unknown|repeated/i)
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 1 })

  const retry = () => h.runTool(h.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: catalogClaim.ticketId })
  await expect(retry()).rejects.toThrow(/stagnation policy/)
  expect(await read(`ticket/${catalogClaim.ticketId}/report/${catalogClaim.assignmentId}`)).toMatchObject({ text: expect.stringContaining('failed') })
})

it('replans by replacing the Assignment but requires the failed check to actually pass again', async () => {
  const required = [{ id: 'catalog-contract', workflowId: '23' }]
  const setRequiredChecks = (checks: typeof required) => {
    const current = h.runtime.store.settings(), github = current.sources.github!
    h.runtime.store.saveSettings({ ...current, sources: { ...current.sources, github: { ...github, config: { ...github.config, requiredChecks: checks } } } })
  }
  setRequiredChecks(required)
  const { id, catalogClaim: claim } = await dispatchedFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    runLimits: { stagnation: { maxAttemptsWithoutProgress: 1, idleSeconds: 3600 } } } })
  const { directory } = await read(`ticket/${claim.ticketId}`)
  const candidate = h.localGit!.git('-C', String(directory), 'rev-parse', 'HEAD')
  const recordCheck = (command: string, status: 'passed' | 'failed', observed: string, worker = claim.session) =>
    h.runTool(worker, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'Exercise the catalog API contract', red: null,
      checks: [{ directory: '.', command, status, observed }] })
  const check = 'pnpm test catalog-contract'
  await recordCheck(check, 'failed', 'Expected HTTP 200; first run received 500.')
  await h.runTool(claim.session, 'orchestrator_report', { state: 'failed', summary: 'The catalog contract failed.' })
  await h.runtime.pump()
  await h.runtime.idle()
  expect(await read(`plan/${id}/node/catalog/recovery`)).toMatchObject({ status: 'diagnose', attempts: 1 })
  await recordCheck(check, 'failed', 'Expected HTTP 200; diagnostic run received 503.')
  await h.runtime.pump()
  await h.runtime.idle()
  const assignments = () => read(`ticket/${claim.ticketId}/assignments`)
  expect(await assignments()).toMatchObject({ items: [
    { id: expect.not.stringMatching(claim.assignmentId), state: 'running' },
    { id: claim.assignmentId, state: 'ended', report: { state: 'failed' } },
  ] })
  expect((await read(`ticket/${claim.ticketId}`)).directory).toBe(directory)
  await h.restart()
  await h.runtime.idle()
  expect((await assignments()).items).toHaveLength(2)
  const hubPrompt = h.runtime.sessions.prompt.bind(h.runtime.sessions)
  const held = vi.spyOn(h.runtime.sessions, 'prompt').mockImplementation(async (...args) => {
    if (args[2].includes('"kind":"plan-replan-review"')) throw new Error('Hub unavailable before receipt')
    return hubPrompt(...args)
  })
  const recovery = () => read(`plan/${id}/node/catalog/recovery`)
  const notices = () => h.jsonRelays(h.runtime.masterId, 'plan-replan-review')
  await recordCheck(check, 'failed', 'Expected HTTP 200; replacement run received 502.')
  await h.runtime.pump()
  await h.runtime.idle()
  const first = await recovery()
  expect(first).toMatchObject({ status: 'stalled' })
  expect(notices()).toHaveLength(0)
  const newest = 'Expected HTTP 200; a later run received 504.'
  await recordCheck(check, 'failed', newest)
  const latest = await recovery()
  expect(latest.failureId).not.toBe(first.failureId)
  await recordCheck(check, 'failed', newest)
  expect(await recovery()).toMatchObject({ failureId: latest.failureId, attempts: latest.attempts })
  await h.restart()
  held.mockRestore()
  await vi.waitFor(() => expect(notices()).toEqual([expect.objectContaining({
    failure: `plan/${id}/node/catalog/recovery/${latest.failureId}`,
  })]), { timeout: 20_000 })
  expect(await read(`plan/${id}/node/catalog/recovery/${first.failureId}`)).toMatchObject({ id: first.failureId })
  expect(h.jsonRelays(h.runtime.masterId, 'human-action')).toEqual([])
  const original = await read(`plan/${id}/node/catalog/recovery`)
  // Replaying the Hub notification does not wait for the Worker to reclaim its verified worktree.
  await h.runtime.effects.idle('delivery')
  expect(await read(`ticket/${claim.ticketId}`)).toMatchObject({ execution: {
    preparation: { state: 'verified' }, active_writer: { assignment: original.assignmentId, session: claim.session },
  } })
  setRequiredChecks([])
  const repaired = await h.runTool(h.runtime.masterId, 'orchestrator_plan_replan', {
    planId: id, nodeId: 'catalog', revision: 1, failureId: original.failureId, reason: 'Isolate the repeated catalog contract failure', change: { kind: 'repair' },
  }) as { replacements: { catalog: [string] } }
  const [repairNode] = repaired.replacements.catalog
  expect(await read(`ticket/${claim.ticketId}`)).toMatchObject({ ended: { by: 'replan' } })
  await vi.waitFor(async () => {
    expect(await read(`plan/${id}/node/${repairNode}`)).toMatchObject({ status: 'waiting-for-slot' })
  }, { timeout: 20_000 })
  // The automatic escalation was exercised above. Keep the repair's evidence reads stable while checking which observations count.
  const afterRepair = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...afterRepair, executor: { ...afterRepair.executor,
    runLimits: { ...afterRepair.executor.runLimits, stagnation: { maxAttemptsWithoutProgress: 100, idleSeconds: 3600 } },
  } })
  const repairDispatch = await dispatchPlan(id, repairNode)
  expect(repairDispatch).toMatchObject({ status: 'claimed', claim: expect.anything() })
  const replacement = repairDispatch.claim!
  await h.runtime.idle()
  expect(await dispatchPlan(id, 'dashboard')).toMatchObject({ status: 'blocked', waitingOn: [repairNode, 'accounts'] })
  expect(await h.runTool(replacement.session, 'orchestrator_read', { resource: `ticket/${replacement.ticketId}/plan-scope` }))
    .toMatchObject({ repair: { ticketId: claim.ticketId, failureId: original.failureId }, inheritedChecks: expect.arrayContaining([
      expect.objectContaining({ directory: '.', command: check }),
    ]) })
  const delivery = () => read(`ticket/${replacement.ticketId}/delivery-check`)
  expect(JSON.parse(String((await delivery()).text))).toMatchObject({ ci: { required } })
  await recordCheck('pnpm test unrelated', 'failed', 'The independent check failed on its first run.', replacement.session)
  await recordCheck('pnpm test unrelated', 'passed', 'The unrelated check passed.', replacement.session)
  expect(await delivery()).toMatchObject({ ready: false, missing: expect.arrayContaining(['failed_checks_require_recheck']) })
  expect(await read(`plan/${id}/node/${repairNode}/recovery`)).toMatchObject({ attempts: 1 })
  await recordCheck(check, 'failed', 'Expected HTTP 200, but received 500.', replacement.session)
  await recordCheck(check, 'passed', 'The diagnostic check received HTTP 200.', replacement.session)
  expect((await delivery()).missing).toContain('failed_checks_require_recheck')
  await recordCheck(check, 'failed', 'Expected HTTP 200, but received 500.', replacement.session)
  expect((await delivery()).missing).toContain('failed_checks_require_recheck')
}, 60_000)

it('requires both pinned reviewers to verify a failed check survived a green rerun', async () => {
  const { id } = await registeredFanIn()
  const claim = (await dispatchPlan(id, 'catalog')).claim!
  await h.runtime.idle()
  const { directory } = await read(`ticket/${claim.ticketId}`)
  const work = String(directory), fixture = 'catalog-contract.test.cjs'
  const git = (...args: string[]) => h.localGit!.git('-C', work, ...args)
  const commit = (title: string) => { git('add', '-A'); git('commit', '-m', title); return git('rev-parse', 'HEAD') }
  const run = () => spawnSync(process.execPath, ['--test'], { cwd: work, encoding: 'utf8', timeout: 10_000 })
  const status = resolve(work, 'catalog-status.txt'), testFile = resolve(work, fixture)
  const source = "require('node:test')('catalog returns 200', () => require('node:assert/strict').equal(require('node:fs').readFileSync('catalog-status.txt', 'utf8'), '200'))\n"
  writeFileSync(testFile, source)
  writeFileSync(status, '500')
  const red = commit('记录失败的目录契约检查')
  const record = (candidate: string, status: 'failed' | 'passed', observed: string, reference?: string) =>
    h.runTool(claim.session, 'orchestrator_test_evidence', { candidate, scope: 'focused', reason: 'Catalog status contract', red: null,
      checks: [{ directory: '.', command: 'node --test', status, observed }], ...(reference ? { reference } : {}) })
  const failed = run()
  expect(failed.stdout).toContain("'500' !== '200'")
  expect(failed.status).toBe(1)
  await record(red, 'failed', 'catalog returns 200: received 500')
  const resource = `ticket/${claim.ticketId}/failed-checks`
  const delivery = () => read(`ticket/${claim.ticketId}/delivery-check`)
  const missing = 'failed_checks_require_recheck'
  const review = async (axis: 'standards' | 'spec', candidate: string, retained = false) => {
    const reviewer = await h.reviewSubagent(claim.session, axis)
    const { items } = await h.runTool(reviewer, 'orchestrator_read', { resource }) as unknown as {
      items: { failure: { id: string }; rerun: { id: string } | null }[]
    }
    const input = { candidate, axis, conclusion: 'passed', blockers: [], summary: 'Checked the committed catalog test and rerun.', basis: [fixture],
      ...(retained ? { retainedChecks: items.map(({ failure, rerun }) => ({ failure: failure.id, rerun: rerun!.id,
        originalPath: fixture, currentPath: fixture, rationale: 'The same catalog assertion runs under node --test and now observes 200.' })) } : {}) }
    return () => h.runTool(reviewer, 'orchestrator_review_submit', input)
  }

  unlinkSync(testFile)
  const shortcut = commit('移除有失败的检查')
  const empty = run()
  expect(empty.status).toBe(0)
  expect(empty.stdout).not.toContain('catalog returns 200')
  await record(shortcut, 'passed', 'node --test exited 0 with no catalog assertion')
  await (await review('standards', shortcut))()
  await (await review('spec', shortcut))()
  await expect((await review('standards', shortcut, true))()).rejects.toThrow()
  expect((await delivery()).missing).toContain(missing)

  writeFileSync(testFile, source)
  writeFileSync(status, '200')
  const fixed = commit('恢复并修正目录契约检查')
  const passed = run()
  expect(passed.status).toBe(0)
  expect(passed.stdout).toContain('catalog returns 200')
  const oldReceipt = 'run/catalog-before-later-failure'
  await record(fixed, 'passed', 'catalog returns 200: passed', oldReceipt)
  await record(fixed, 'passed', 'catalog returns 200: passed')
  const originalStandards = await review('standards', fixed, true)
  await originalStandards()
  expect((await delivery()).missing).toContain(missing)
  await (await review('spec', fixed, true))()
  expect((await delivery()).missing).not.toContain(missing)
  await record(fixed, 'failed', 'catalog status returned 502 on a later run')
  expect((await delivery()).missing).toContain(missing)
  await record(fixed, 'passed', 'The earlier catalog run succeeded with 200', oldReceipt)
  expect(await read(resource)).toMatchObject({ items: expect.arrayContaining([
    expect.objectContaining({ failure: expect.objectContaining({ observed: 'catalog status returned 502 on a later run' }), rerun: null }),
  ]) })
  expect(run().status).toBe(0)
  await record(fixed, 'passed', 'catalog returns 200: passed')
  await expect(originalStandards()).rejects.toThrow(/current matching rerun/)
  await (await review('standards', fixed, true))()
  expect((await delivery()).missing).toContain(missing)
  await (await review('spec', fixed, true))()
  expect((await delivery()).missing).not.toContain(missing)
}, 60_000)

async function reviewRequirement(proposalId: string, status: 'within-handoff' | 'outside-handoff' | 'uncertain' = 'within-handoff',
  reason = 'Only the behavior inside the approved checkout scope changes.') {
  await h.runtime.effects.idle('requirementScopeReview')
  const reviewer = `requirement-scope-${proposalId}`
  const args = { status, reason }, name = 'orchestrator_plan_scope_review'
  const agent = h.agents.get(reviewer), tool = h.tools.get(reviewer)?.get(name)
  if (!agent || !tool) throw new Error('The independent scope review was not dispatched')
  const callId = `scope-call-${proposalId}`
  h.record(reviewer, [{ type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }])
  const execution = { agent, callId, rootCallId: callId, signal: new AbortController().signal, concludeTurn: () => { agent.status = 'idle' } }
  await tool.execute(args, execution)
  const { scopeReview } = await read(`plan-requirement/${proposalId}`)
  const verdict = z.object({ status: z.literal(status), reviewId: z.uuid(), reviewerSessionId: z.literal(reviewer) }).parse(scopeReview)
  return verdict.reviewId
}

it('previews a product replan before applying an exact, durable direct approval', async () => {
  const { id, catalogClaim, accountsClaim } = await dispatchedFanIn()
  const hub = h.runtime.masterId
  const requirements = (args: unknown, session = hub) => h.runTool(session, 'orchestrator_plan_requirements', args)
  const changed = { criterion: 1, statement: 'Search matches product prefixes.', observable: 'The catalog API excludes non-prefix matches.' }
  const request = { intent: 'change-plan-requirements', planId: id, authorizedScope: brief.authorization.scope, changes: [changed] }
  const send = (value: unknown) => h.sendUserMessage(hub, JSON.stringify(value))
  type Proposal = { proposalId: string; requestMessageId: string; affected: { nodeId: string; replacementId: string }[] }
  const preview = () => requirements({ mode: 'preview' }) as unknown as Promise<Proposal>
  const approval = (p: Proposal, scopeReviewId: string, scopeDecision = 'within-handoff') => ({ approved: true, proposalId: p.proposalId,
    requestMessageId: p.requestMessageId, scopeReviewId, scopeDecision })
  const apply = ({ proposalId }: Proposal) => requirements({ mode: 'apply', proposalId })
  h.sendUserMessage(hub, 'Please investigate the failing test.')
  h.record(hub, [{ type: 'user/message', data: { role: 'user', source: { kind: 'tool-jobs', form: 'notice' },
    content: [{ type: 'text', text: JSON.stringify(request) }] } }])
  await expect(preview()).rejects.toThrow(/product change|JSON/i)
  send({ ...request, changes: [] })
  expect(await preview()).toMatchObject({ status: 'needs-target' })
  send({ ...request, authorizedScope: 'Deploy changed code to production' })
  await expect(preview()).rejects.toThrow(/new handoff/i)
  await expect(requirements({ mode: 'preview' }, catalogClaim.session)).rejects.toThrow(/not registered/)
  send(request)
  const stale = await preview()
  const staleReview = await reviewRequirement(stale.proposalId)
  const catalogCommand = 'pnpm test catalog'
  const statusFailure = 'The catalog check still returns 500.', resultsFailure = 'Search results include products from another tenant.'
  const check = (status: 'passed' | 'failed', observed: string, command = catalogCommand) => ({ directory: '.', command, status, observed })
  const record = (session: string, reference: string, checks: ReturnType<typeof check>[]) => h.runTool(session, 'orchestrator_test_evidence', {
    candidate: h.localGit!.base.sha, scope: 'focused', reason: 'Catalog request check', red: null, reference, checks,
  })
  const oldGreen = 'run/catalog-before-regression', redRun = 'run/catalog-regression'
  const mixed = await record(catalogClaim.session, oldGreen, [check('passed', 'Catalog status 200.'),
    check('failed', 'Catalog seed cannot load.', 'pnpm test catalog-seed')])
  const failed = await record(catalogClaim.session, redRun, [check('failed', statusFailure), check('failed', resultsFailure)])
  await record(catalogClaim.session, oldGreen, [check('passed', 'The earlier request succeeded.')])
  const retained = [
    { command: 'pnpm test catalog-seed', read: mixed.read, observed: 'Catalog seed cannot load.' },
    { command: catalogCommand, read: failed.read, observed: statusFailure },
    { command: catalogCommand, read: failed.read, observed: resultsFailure },
  ]
  const outstanding = retained.map(failure => ({ failure, rerun: null }))
  expect(await read(`ticket/${catalogClaim.ticketId}/failed-checks`)).toMatchObject({ items: outstanding })
  send(approval(stale, staleReview))
  await expect(apply(stale)).rejects.toThrow(/evidence|in-flight state/i)
  const deliveriesBeforePreview = h.deliveries.mock.calls.length
  const lostReceipt = vi.fn(() => {
    if (!h.deliveries.mock.calls.slice(deliveriesBeforePreview).some(([delivery]) => delivery.sessionId.startsWith('requirement-scope-'))) return
    delete h.hooks.flushSessionLog
    throw new Error('Interrupted after the native task was recorded, before the effect receipt')
  })
  h.hooks.flushSessionLog = lostReceipt
  send(request)
  const proposal = await preview()
  expect(proposal).toMatchObject({ status: 'preview', invalidated: [{ criterion: 1,
    after: { statement: changed.statement, observable: changed.observable } }], affected: [
    { nodeId: 'catalog', impact: 'direct', tickets: [{ ticketId: catalogClaim.ticketId, evidence: expect.arrayContaining([
      expect.objectContaining({ kind: 'tests', status: 'failed', read: failed.read }),
    ]) }] },
    { nodeId: 'dashboard', impact: 'transitive', revalidate: { criteria: [3] } },
  ] })
  const { proposalId } = proposal
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 1, goal: fanInSpec.body })
  await expect(apply(proposal)).rejects.toThrow()
  const reviewer = `requirement-scope-${proposalId}`
  const tasks = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === reviewer).map(([call]) => call)
  await h.runtime.effects.idle('requirementScopeReview')
  expect(tasks()).toHaveLength(1)
  expect(lostReceipt.mock.results.some(result => result.type === 'throw')).toBe(true)
  expect(h.runtime.effects.pending('requirementScopeReview', proposalId)).toBe(true)
  expect(JSON.parse(tasks()[0]!.text)).toEqual({ proposalId, planId: id, expectedRevision: 1, currentGoal: fanInSpec.body,
    desiredGoal: fanInSpec.body, changedCriteria: [{ criterion: 1,
      before: { statement: fanInSpec.acceptance[0]!.statement, observable: fanInSpec.acceptance[0]!.observable },
      after: { statement: changed.statement, observable: changed.observable } }],
    originalHandoff: { goal: fanInSpec.body, authorization: brief.authorization, constraints: brief.constraints,
      acceptanceScope: brief.acceptanceScope, outOfScope: fanInSpec.outOfScope } })
  const originalReviewer = h.agents.get(reviewer)!, reviewerTools = h.tools.get(reviewer)!
  const nativeSession = originalReviewer.session as { id: string; header: { createdAt: number } }
  const impostor = { ...originalReviewer, session: { ...nativeSession, header: { ...nativeSession.header, createdAt: nativeSession.header.createdAt + 1 } } }
  let restoreOriginal = false
  const impostorSeen = Promise.withResolvers<void>()
  h.controller.resolveAgent.mockImplementation(async id => {
    if (id === reviewer) {
      h.agents.set(id, restoreOriginal ? originalReviewer : impostor)
      h.tools.set(id, reviewerTools)
      if (!restoreOriginal) impostorSeen.resolve()
    }
    return h.resolveDefault(id)
  })
  await h.restart()
  await impostorSeen.promise
  await h.runtime.effects.idle('requirementScopeReview')
  await expect(h.runTool(reviewer, 'orchestrator_plan_scope_review', { status: 'within-handoff', reason: 'Same ID, different instance.' }))
    .rejects.toThrow(/not registered/i)
  restoreOriginal = true
  await vi.waitFor(() => expect(h.tools.get(reviewer)?.has('orchestrator_plan_scope_review')).toBe(true), { timeout: 20_000 })
  await h.runtime.effects.idle('requirementScopeReview')
  h.controller.resolveAgent.mockImplementation(h.resolveDefault)
  expect(await preview()).toMatchObject({ status: 'preview', proposalId, requestMessageId: proposal.requestMessageId,
    scopeReview: { status: 'pending' } })
  expect(await read(`plan-requirement/${proposalId}`)).toMatchObject({ status: 'preview', affected: proposal.affected })
  send({ approved: true, proposalId })
  await expect(apply(proposal)).rejects.toThrow()
  send(approval(proposal, staleReview))
  await expect(apply(proposal)).rejects.toThrow(/scope review/i)
  const scopeReviewId = await reviewRequirement(proposalId)
  expect(h.runtime.effects.pending('requirementScopeReview', proposalId)).toBe(false)
  expect(tasks()).toHaveLength(1)
  send(approval(proposal, scopeReviewId, 'new-handoff'))
  await expect(apply(proposal)).rejects.toThrow(/new handoff/i)
  h.record(hub, [{ type: 'user/message', data: { role: 'user', source: { kind: 'tool-jobs', form: 'notice' },
    content: [{ type: 'text', text: JSON.stringify(approval(proposal, scopeReviewId)) }] } }])
  await expect(apply(proposal)).rejects.toThrow(/new handoff/i)
  send(approval(proposal, staleReview))
  await expect(apply(proposal)).rejects.toThrow(/scope review/i)
  send(approval(proposal, scopeReviewId))
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, runLimits: {
    ticketOverrides: [{ planId: id, nodeId: 'catalog', tokens: 0 }],
  } } })
  await expect(apply(proposal)).rejects.toThrow(/quota-paused.*exhausted/)
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 1 })
  expect(await read(`ticket/${catalogClaim.ticketId}`)).not.toHaveProperty('ended')
  h.runtime.store.saveSettings(settings)

  // Crash boundary: the revision and stop intent commit; the old host never drains its writer.
  vi.spyOn(h.runtime.executor, 'stop').mockImplementationOnce(() => {})
  vi.spyOn(h.runtime.executor, 'shutdown').mockResolvedValueOnce(undefined)
  const owners = new Map([catalogClaim.session, accountsClaim.session].map(id => [id, h.agents.get(id)!]))
  expect(owners.get(catalogClaim.session)).toBeDefined()
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    const worker = owners.get(id)
    if (worker && !h.agents.has(id)) h.agents.set(id, worker)
    return h.resolveDefault(id)
  })
  const job = h.jobs.run(catalogClaim.session), stopStarted = Promise.withResolvers<string>()
  h.jobs.service.kill.mockImplementationOnce(jobId => { stopStarted.resolve(jobId); return 'requested' })
  expect(await apply(proposal)).toMatchObject({ status: 'applied', revision: 2 })
  expect(await apply(proposal)).toMatchObject({ revision: 2 })
  send(approval(stale, staleReview))
  await expect(apply(stale)).rejects.toThrow(/revision changed/)
  const newCatalog = proposal.affected.find(node => node.nodeId === 'catalog')!.replacementId
  const newDashboard = proposal.affected.find(node => node.nodeId === 'dashboard')!.replacementId
  expect(await dispatchPlan(id, newCatalog)).toMatchObject({ status: 'blocked', waitingOn: ['catalog'] })
  await h.restart()
  try {
    expect(await stopStarted.promise).toBe(job)
    expect(await dispatchPlan(id, newCatalog)).toMatchObject({ status: 'blocked', waitingOn: ['catalog'] })
  } finally { h.jobs.end(job, 'killed') }
  await h.runtime.idle()
  expect(await read(`plan/${id}/node/catalog`)).toMatchObject({ status: 'superseded', superseded: { replacements: [newCatalog] } })
  await expect(dispatchPlan(id, 'catalog')).rejects.toThrow(/unknown Plan node/i)
  expect(await read(`ticket/${catalogClaim.ticketId}/plan-scope`)).toMatchObject({ goal: fanInSpec.body,
    acceptance: [{ id: '1', text: expect.stringContaining(fanInSpec.acceptance[0]!.statement) }] })
  expect(await dispatchPlan(id, newDashboard)).toMatchObject({ status: 'blocked', waitingOn: [newCatalog, 'accounts'] })
  expect(await dispatchPlan(id, 'accounts')).toMatchObject({ reused: true, claim: { ticketId: accountsClaim.ticketId,
    assignmentId: accountsClaim.assignmentId, session: accountsClaim.session, pendingAction: null } })
  expect(await read(`ticket/${accountsClaim.ticketId}/plan-scope`)).toMatchObject({ goal: fanInSpec.body })
  const replacement = (await dispatchPlan(id, newCatalog)).claim!
  await h.runtime.idle()
  expect(await h.runTool(replacement.session, 'orchestrator_read', { resource: `ticket/${replacement.ticketId}/plan-scope` }))
    .toMatchObject({ goal: fanInSpec.body, authorizedScope: brief.authorization.scope, acceptanceScope: brief.acceptanceScope,
      outOfScope: fanInSpec.outOfScope, acceptance: [{ id: '1', text: expect.stringContaining(changed.observable) }],
      interfaceContract: { path: 'docs/catalog-api.md', previousRequirements: 'Document query inputs and return all substring matches.' },
      inheritedChecks: retained })
  expect((await read(`ticket/${replacement.ticketId}/assignment`)).text).not.toContain('return all substring matches')
  for (const reference of [oldGreen, redRun]) {
    await record(replacement.session, reference, [check('passed', 'Stale receipt reported as the current catalog check.')])
    expect(await read(`ticket/${replacement.ticketId}/failed-checks`)).toMatchObject({ items: outstanding })
  }
  expect((await read(`ticket/${replacement.ticketId}/delivery-check`)).missing).toContain('failed_checks_require_recheck')
  expect(await read(`plan/${id}/meter`)).toMatchObject({ sessions: expect.arrayContaining([
    expect.objectContaining({ ticket_id: catalogClaim.ticketId, plan_id: id }),
    expect.objectContaining({ ticket_id: replacement.ticketId, plan_id: id }),
  ]) })
  expect(await read(`ticket/${replacement.ticketId}/delivery-check`)).toMatchObject({ ready: false })
}, 60_000)

it.each(['outside-handoff', 'uncertain'] as const)('blocks a product change after a %s scope review', async status => {
  const { id, register } = await publish()
  await h.runtime.idle()
  await register(splitDraft)
  const hub = h.runtime.masterId
  const send = (value: unknown) => h.sendUserMessage(hub, JSON.stringify(value))
  send({ intent: 'change-plan-requirements', planId: id, authorizedScope: brief.authorization.scope,
    changes: [{ criterion: 1, statement: 'Visitors can read other shoppers’ saved products.', observable: 'A guest can open any account’s list.' }] })
  const { proposalId, requestMessageId } = await h.runTool(hub, 'orchestrator_plan_requirements', { mode: 'preview' }) as { proposalId: string; requestMessageId: string }
  await expect(h.runTool(hub, 'orchestrator_plan_scope_review', { status: 'within-handoff', reason: 'Override the exclusion.' }))
    .rejects.toThrow(/not registered/i)
  await h.runtime.effects.idle('requirementScopeReview')
  const reviewer = `requirement-scope-${proposalId}`
  expect([...h.tools.get(reviewer)!.keys()]).toEqual(['orchestrator_plan_scope_review'])
  await expect(h.runTool(reviewer, 'orchestrator_plan_scope_review', { status: 'within-handoff', reason: 'Fabricate a review result.' })).rejects.toThrow()
  const scopeReviewId = await reviewRequirement(proposalId, status, status === 'outside-handoff'
    ? 'The original scope excludes sharing private saved products.' : 'Can each visitor read only their own list?')
  send({ approved: true, proposalId, requestMessageId, scopeReviewId, scopeDecision: 'within-handoff' })
  await expect(h.runTool(hub, 'orchestrator_plan_requirements', { mode: 'apply', proposalId }))
    .rejects.toThrow(status === 'outside-handoff' ? /outside the original Handoff/i : /could not determine/i)
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 1 })
  expect(await read(`plan-requirement/${proposalId}`)).toMatchObject({ status: 'preview', scopeReview: { status } })
}, 30_000)

it('refuses a product replan while the affected writer launch has yet to be confirmed', async () => {
  const { id } = await registeredFanIn()
  const prepare = Promise.withResolvers<void>()
  h.hooks.prepare = prepare.promise
  try {
    const { claim } = await dispatchPlan(id, 'catalog')
    expect(claim).toBeDefined()
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(claim!.ticketId)?.assignments.at(-1)?.writer?.state).toBe('preparing'), {
      timeout: 20_000,
    })
    const hub = h.runtime.masterId
    h.sendUserMessage(hub, JSON.stringify({ intent: 'change-plan-requirements', planId: id,
      authorizedScope: brief.authorization.scope, goal: 'Offer prefix search and account details.',
      changes: [{ criterion: 1, statement: 'Search by prefix.', observable: 'Search results share the requested prefix.' }],
    }))
    const { proposalId, requestMessageId, affected } = await h.runTool(hub, 'orchestrator_plan_requirements', { mode: 'preview' })
    expect(affected).toEqual([
      expect.objectContaining({ nodeId: 'catalog', impact: 'direct' }),
      expect.objectContaining({ nodeId: 'accounts', impact: 'direct', status: 'unclaimed' }),
      expect.objectContaining({ nodeId: 'dashboard', impact: 'direct' }),
    ])
    const scopeReviewId = await reviewRequirement(String(proposalId))
    h.sendUserMessage(hub, JSON.stringify({ approved: true, proposalId, requestMessageId, scopeReviewId, scopeDecision: 'within-handoff' }))
    await expect(h.runTool(hub, 'orchestrator_plan_requirements', { mode: 'apply', proposalId })).rejects.toThrow(/unconfirmed Worker launch/)
    expect(await read(`plan/${id}`)).toMatchObject({ revision: 1 })
    expect(await read(`ticket/${claim!.ticketId}`)).not.toHaveProperty('ended')
  } finally { prepare.resolve() }
  await h.runtime.idle()
}, 60_000)

it('replans pending slices under their original obligations and refuses the same work after quota exhaustion', async () => {
  const specification = { ...fanInSpec, acceptance: [...fanInSpec.acceptance,
    { statement: 'Show a catalogue empty state.', observable: 'The dashboard displays that no rows match.', delivery: 'frontend' as const }] }
  const { id, register } = await publish({ ...brief, goal: specification.body }, specification)
  await h.runtime.idle()
  await register({ features: [...fanInDraft.features, { id: 'summary', kind: 'frontend' }], nodes: [
    ...fanInDraft.nodes.map(node => node.id === 'dashboard' ? { ...node, acceptance: [3, 4] } : node),
    { id: 'summary', featureId: 'summary', title: 'Read the dashboard totals', role: 'frontend', acceptance: [3],
      demonstration: 'Read the totals that the dashboard displays.', blockedBy: ['dashboard'] },
  ] })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, runLimits: {
    stagnation: { maxAttemptsWithoutProgress: 1 }, ticketOverrides: [{ planId: id, nodeId: 'catalog', tokens: 40 },
      { planId: id, nodeId: 'dashboard', tokens: 20 }],
  } } })
  const claim = (await dispatchPlan(id, 'catalog')).claim!
  await h.runtime.idle()
  await h.runTool(claim.session, 'orchestrator_report', { state: 'failed', summary: 'Catalog contract check failed.' })
  await h.runtime.pump()
  await h.runtime.idle()
  const { recovery: { failureId } } = await read(`plan/${id}/node/catalog`) as { recovery: { failureId: string } }
  const replan = (revision: number, change: unknown) => h.runTool(h.runtime.masterId, 'orchestrator_plan_replan', {
    planId: id, nodeId: 'catalog', revision, failureId, reason: 'Separate the empty-state check from the dashboard integration', change,
  })
  const funded = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...funded, executor: { ...funded.executor, runLimits: {
    ...funded.executor.runLimits, ticketOverrides: [{ planId: id, nodeId: 'catalog', tokens: 40 }, { planId: id, nodeId: 'dashboard', tokens: 0 }],
  } } })
  await expect(replan(1, { kind: 'split', nodeId: 'dashboard', groups: [[3], [4]] })).rejects.toThrow(/dashboard.*exhausted/)
  await expect(replan(1, { kind: 'dependencies', updates: [{ nodeId: 'dashboard', blockedBy: ['catalog', 'accounts', 'summary'] }] }))
    .rejects.toThrow(/dashboard.*exhausted/)
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 1 })
  expect(await read(`plan/${id}/node/catalog/recovery/${failureId}`)).toMatchObject({ id: failureId })
  h.runtime.store.saveSettings(funded)
  await expect(replan(1, { kind: 'dependencies', updates: [{ nodeId: 'dashboard', blockedBy: ['catalog', 'accounts', 'summary'] }] }))
    .rejects.toThrow(/cycle/i)
  await expect(replan(1, { kind: 'merge', nodeIds: ['dashboard', 'summary'] })).rejects.toThrow(/different budget pools/i)
  const split = await replan(1, { kind: 'split', nodeId: 'dashboard', groups: [[3], [4]] }) as { replacements: { dashboard: string[] } }
  const children = split.replacements.dashboard
  expect(await read(`plan/${id}/revision/2`)).toMatchObject({ revision: 2, cause: { failureId, scope: ['dashboard', 'summary'] },
    nodes: expect.arrayContaining(children.map((child, i) => expect.objectContaining({ id: child, acceptance: [3 + i], blockedBy: ['catalog', 'accounts'] }))) })
  expect(await dispatchPlan(id, 'summary')).toMatchObject({ status: 'blocked', waitingOn: children })
  const merged = await replan(2, { kind: 'merge', nodeIds: children }) as { replacements: Record<string, string[]> }
  const combined = merged.replacements[children[0]!]![0]!
  expect(await dispatchPlan(id, combined)).toMatchObject({ status: 'blocked', waitingOn: ['catalog', 'accounts'], limits: { ticketTokens: 20 } })

  await h.modelRequest(claim.session, 40, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 34, outputTokens: 6, totalTokens: 40 } }
  })
  await h.idleRelay()
  await expect(replan(3, { kind: 'split', nodeId: combined, groups: [[3], [4]] })).rejects.toThrow(/available run authorization/i)
  expect(await read(`plan/${id}`)).toMatchObject({ revision: 3 })
  expect(await read(`plan/${id}/node/catalog`)).toMatchObject({ recovery: { status: 'quota-paused', failureId, canReplan: false } })
  expect(await dispatchPlan(id, 'accounts')).toMatchObject({ status: 'claimed' })
  await h.restart()
  await h.runtime.idle()
  expect(h.jsonRelays(h.runtime.masterId, 'quota-paused')).toHaveLength(1)
  expect(await read(`plan/${id}/revision/1`)).toMatchObject({ revision: 1, nodes: expect.arrayContaining([
    expect.objectContaining({ id: 'dashboard', acceptance: [3, 4] }),
  ]) })
})
})
