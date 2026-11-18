import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolve } from 'node:path'
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
