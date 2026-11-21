import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { resolve } from 'node:path'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { withFeishu: false }) })
afterEach(async () => { await h.stop() })

const brief = {
  project: { repository: 'acme/widgets', workspace: resolve('workspaces/widgets') },
  goal: 'Let shoppers view their saved products.', constraints: ['Saved products are private.'],
  acceptanceScope: ['A shopper can see their saved products.'],
  authorization: { scope: 'Implement and verify private saved products.', release: 'not-authorized' },
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
      interfaceContract: { path: 'docs/catalog-api.md', requirements: 'Document query inputs and search results.' } },
    { id: 'accounts', featureId: 'accounts', title: 'Account lookup', role: 'backend', acceptance: [2],
      demonstration: 'Look up a test account and observe the profile.', blockedBy: [],
      interfaceContract: { path: 'docs/accounts-api.md', requirements: 'Document profile fields and lookup errors.' } },
    { id: 'dashboard', featureId: 'dashboard', title: 'Combined dashboard', role: 'frontend', acceptance: [3],
      demonstration: 'Open the dashboard and see search results and profile details.', blockedBy: ['catalog', 'accounts'] },
  ],
}

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
  claim: PlanDispatchClaimSchema.optional(), waitingOn: z.array(z.string()).optional(), reason: z.string().optional() }).strict()
type PlanDispatch = z.infer<typeof PlanDispatchSchema>
const dispatchPlan = async (planId: string, nodeId: string): Promise<PlanDispatch> => PlanDispatchSchema.parse(
  await h.runTool(h.runtime.masterId, 'orchestrator_plan_dispatch', { planId, nodeId }))

async function registeredFanIn() {
  const published = await publish({ ...brief, goal: fanInSpec.body }, fanInSpec)
  await h.runtime.idle()
  await published.register(fanInDraft)
  return published
}

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

it('does not unlock a successor from ready alone, but accepts one exact formal delivery receipt', async () => {
  const { id } = await registeredFanIn()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const [catalog, accounts] = await Promise.all([dispatchPlan(id, 'catalog'), dispatchPlan(id, 'accounts')] as const)
  const catalogClaim = catalog.claim, accountsClaim = accounts.claim
  if (!catalogClaim || !accountsClaim) throw new Error('Independent frontier nodes must have claims')
  await h.runtime.idle()
  for (const claim of [catalogClaim, accountsClaim]) {
    await h.runTool(claim.session, 'orchestrator_report', { state: 'ready', summary: 'Worker finished its local implementation.' })
  }
  await h.runtime.idle()
  expect((await read(`plan/${id}/node/dashboard`)).status).toBe('blocked')
  expect((await read(`plan/${id}/node/catalog`)).status).toBe('awaiting-delivery')
  for (const [nodeId, claim] of [['catalog', catalogClaim], ['accounts', accountsClaim]] as const) {
    await h.runTool(h.runtime.masterId, 'orchestrator_plan_deliver', { planId: id, nodeId, receipt: { ticketId: claim.ticketId, assignmentId: claim.assignmentId,
      receiptId: `delivery-${nodeId}`, candidate: `commit-${nodeId}`, verifiedAt: new Date().toISOString() } })
  }
  expect((await read(`plan/${id}/node/dashboard`)).status).toBe('waiting-for-slot')
  expect(await read(`plan/${id}`)).toMatchObject({ nodes: expect.arrayContaining([
    expect.objectContaining({ id: 'catalog', status: 'delivered' }), expect.objectContaining({ id: 'accounts', status: 'delivered' }),
  ]) })
  expect((await read(`plan/${id}`)).frontier).toContain('dashboard')
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
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  const deliveries = h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === beforeClaim.session)
  expect(deliveries).toHaveLength(1)
  expect((await read(`plan/${published.id}/node/saved-api`)).status).toBe('running')
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
