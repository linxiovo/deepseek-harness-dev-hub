import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { key } from '../src/core/ids.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host

const project = { repository: 'acme/widgets', workspace: resolve('workspaces/widgets') }
const sourceBrief = {
  project,
  goal: 'Let a shopper save a product and find it again later.',
  constraints: ['Saved products are private to the shopper.'],
  acceptanceScope: ['A signed-in shopper can save and unsave a product.', 'The saved-products page shows saved products.'],
  authorization: { scope: 'Implement this feature and verify it before reporting completion.', release: 'authorized' as const }
}
const approvalFor = ({ project, goal, constraints, acceptanceScope, authorization }: typeof sourceBrief) =>
  JSON.stringify({ confirmed: true, brief: { project, goal, constraints, acceptanceScope, authorization } })
const handoff = { ...sourceBrief, confirmation: approvalFor(sourceBrief) }
const confirm = async (brief = handoff) => {
  const confirmation = approvalFor(brief)
  h.sendUserMessage(h.runtime.masterId, confirmation)
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_handoff_confirm', { ...brief, confirmation })
  await h.idlePlanning()
  return result
}
const read = (resource: string) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource })
const plannerFor = (handoffId: string) => `planner-${handoffId}`
const plannerDeliveries = (sessionId: string) => h.deliveries.mock.calls
  .map(([delivery]) => delivery)
  .filter(delivery => delivery.sessionId === sessionId && delivery.mode === 'queue')

describe.each([
  { mode: 'with Feishu', withFeishu: true },
  { mode: 'without Feishu', withFeishu: false },
])('$mode', ({ withFeishu }) => {
  beforeEach(async () => {
    h = await startRuntime(undefined, { withFeishu })
    if (!withFeishu) {
      const settings = await read('settings') as { sources: { id: string }[] }
      expect(settings.sources.map(source => source.id)).toEqual(['github'])
    }
  })
  afterEach(async () => { await h.stop() })

  it('stores the confirmed project brief across a Runtime restart and replays it as one planner task', async () => {
    const first = await confirm() as { id: string }
    expect(first.id).toEqual(expect.any(String))
    const plannerId = plannerFor(first.id)
    expect(h.agents.has(plannerId)).toBe(true)
    const tasks = plannerDeliveries(plannerId)
    expect(tasks).toHaveLength(1)
    expect(JSON.parse(tasks[0]!.text)).toMatchObject({
      handoff_id: first.id,
      project,
      goal: handoff.goal,
      constraints: handoff.constraints,
      acceptanceScope: handoff.acceptanceScope,
      authorization: { scope: handoff.authorization.scope, release: 'authorized' },
      confirmedBy: { sessionId: h.runtime.masterId, messageId: expect.any(String), text: handoff.confirmation },
      task: expect.any(String)
    })

    const replay = await confirm() as { id: string }
    expect(replay.id).toBe(first.id)
    await h.restart()
    await h.idlePlanning()
    expect(plannerDeliveries(plannerId)).toEqual(tasks)

    expect(await read(`handoff/${first.id}`)).toMatchObject({
      id: first.id,
      project,
      goal: handoff.goal,
      constraints: handoff.constraints,
      acceptanceScope: handoff.acceptanceScope,
      authorization: { scope: handoff.authorization.scope, release: 'authorized' },
      confirmedBy: { sessionId: h.runtime.masterId, messageId: expect.any(String), text: handoff.confirmation }
    })
    expect([...h.agents.keys()].filter(id => id.startsWith('planner-'))).toEqual([plannerId])
    expect(await read(`handoff/${first.id}`)).not.toHaveProperty('feishu')
  })

  it('lets the planner publish a complete observable specification without another technical confirmation', async () => {
    const { id: handoffId } = await confirm() as { id: string }
    const plannerId = plannerFor(handoffId)
    await h.runTool(plannerId, 'orchestrator_spec_publish', {
      handoffId,
      body: 'A signed-in shopper can save a product from its product page. Saved products are private, and the saved-products page lists them with links back to their product pages.',
      acceptance: [
        { statement: 'A saved product appears on the saved-products page.', observable: 'The product is listed after saving.' },
        { statement: 'Unsaving removes a product from that page.', observable: 'The product is absent after unsaving.' },
        { statement: 'Saved products are private to their owner.', observable: 'Another shopper cannot see the saved product.' }
      ],
      testInterfaces: [{ seam: 'Product page save controls and saved-products page', kind: 'proposed', note: 'Exercise saving and unsaving, then verify the page and account isolation.' }],
      outOfScope: ['Anonymous saved products.', 'Sharing saved-products lists with other shoppers.']
    })

    const spec = await read(`spec/${handoffId}`) as { acceptance: unknown[]; testInterfaces: unknown[]; outOfScope: unknown[] }
    expect(spec.acceptance).toEqual(expect.arrayContaining([expect.objectContaining({ statement: expect.any(String), observable: expect.any(String) })]))
    expect(spec.testInterfaces).toEqual(expect.arrayContaining([expect.objectContaining({ seam: expect.any(String), kind: expect.any(String), note: expect.any(String) })]))
    expect(spec.outOfScope.length).toBeGreaterThan(0)
  })

  it('asks Hub once for a missing product-intent fact, resumes that planner, and publishes after Hub answers', async () => {
    const incomplete = {
      ...handoff,
      goal: 'Let a shopper save a product.',
      constraints: [],
      acceptanceScope: ['A shopper can save products.']
    }
    const { id: handoffId } = await confirm(incomplete) as { id: string }
    const plannerId = plannerFor(handoffId)
    const question = 'Should saved products be private to each shopper or visible to everyone?'

    const asked = await h.runTool(plannerId, 'orchestrator_spec_question', {
      handoffId,
      text: question,
      why: 'The request does not establish whether saved products are personal or shared.',
      affectedAcceptance: ['A shopper can save products.']
    }) as { question: { id: string } }
    expect(asked.question.id).toEqual(expect.any(String))
    await h.idleRelay()
    expect(h.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === h.runtime.masterId && delivery.text.includes(question))).toBe(true)
    await expect(h.runTool(plannerId, 'orchestrator_spec_question', {
      handoffId,
      text: question,
      why: 'The request does not establish whether saved products are personal or shared.',
      affectedAcceptance: ['A shopper can save products.']
    })).rejects.toThrow()
    expect([...h.agents.keys()].filter(id => id.startsWith('planner-'))).toEqual([plannerId])

    await expect(h.runTool(h.runtime.masterId, 'orchestrator_handoff_answer', {
      handoffId,
      questionId: asked.question.id,
      answer: 'Saved products are private to the shopper who saved them.'
    })).rejects.toThrow(/latest direct user message/i)
    expect(plannerDeliveries(plannerId)).toHaveLength(1)

    const answer = 'Saved products are private to the shopper who saved them.'
    h.sendUserMessage(h.runtime.masterId, answer)
    await h.runTool(h.runtime.masterId, 'orchestrator_handoff_answer', {
      handoffId,
      questionId: asked.question.id,
      answer
    })
    await h.idlePlanning()
    expect(h.agents.has(plannerId)).toBe(true)
    expect([...h.agents.keys()].filter(id => id.startsWith('planner-'))).toEqual([plannerId])
    const delivered = plannerDeliveries(plannerId)
    expect(delivered).toHaveLength(2)
    expect(JSON.parse(delivered[1]!.text)).toMatchObject({
      handoff_id: handoffId,
      question: { id: asked.question.id, text: question },
      answer
    })
    await h.runTool(h.runtime.masterId, 'orchestrator_handoff_answer', { handoffId, questionId: asked.question.id, answer })
    await h.idlePlanning()
    expect(plannerDeliveries(plannerId)).toEqual(delivered)

    await h.runTool(plannerId, 'orchestrator_spec_publish', {
      handoffId,
      body: 'A shopper can save products to a private saved-products page and remove them later.',
      acceptance: [
        { statement: 'A saved product appears on the owner’s page.', observable: 'The owner sees the saved product.' },
        { statement: 'Another shopper cannot see it.', observable: 'A different account does not see the saved product.' },
        { statement: 'Unsaving removes it from the owner’s page.', observable: 'The product disappears after unsaving.' }
      ],
      testInterfaces: [{ seam: 'Saved-products page and account isolation', kind: 'proposed', note: 'Save as one account and verify visibility only from that account.' }],
      outOfScope: ['Public saved-product lists.']
    })
    expect(await read(`spec/${handoffId}`)).toMatchObject({ handoffId, acceptance: expect.arrayContaining([expect.objectContaining({ statement: 'Another shopper cannot see it.' })]) })
  })

  it('rejects incomplete specifications, technical or repeated planner questions, and non-planner specification access', async () => {
    const { id: handoffId } = await confirm() as { id: string }
    const plannerId = plannerFor(handoffId)
    await expect(h.runTool(plannerId, 'orchestrator_spec_publish', {
      handoffId,
      body: 'A shopper can save products.',
      acceptance: [{ statement: 'Saved products are visible.', observable: 'A saved product appears in a page.' }],
      testInterfaces: [],
      outOfScope: []
    })).rejects.toThrow()

    await expect(h.runTool(plannerId, 'orchestrator_spec_question', {
      handoffId,
      text: 'Which test framework and JavaScript assertion library should I use?',
      why: 'I need technical direction.',
      affectedAcceptance: ['A signed-in shopper can save and unsave a product.']
    })).rejects.toThrow()
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_spec_publish', {
      handoffId,
      body: 'A shopper can save products.',
      acceptance: [{ statement: 'Saving shows the product on the saved-products page.', observable: 'The product is listed after saving.' }],
      testInterfaces: [{ seam: 'Product page save controls', kind: 'proposed', note: 'Save through the product page.' }],
      outOfScope: ['Sharing lists.']
    })).rejects.toThrow()
  })
  it('rejects technical API, tooling, and layout questions without relaying them to the Hub', async () => {
    const { id: handoffId } = await confirm() as { id: string }
    const plannerId = plannerFor(handoffId)
    const technical = [
      'Should the save API use REST or GraphQL?',
      'Should the saved-products endpoint return JSON or XML?',
      'Should we use Playwright or Cypress for the browser tests?',
      'Should we verify with Selenium or Puppeteer?',
      'Should we host it on AWS or GCP?',
      'Where should the save handler live in the source tree?',
      'What should we name the saved-products module?',
      'Which package manager should the repository use?'
    ]
    for (const text of technical) {
      await expect(h.runTool(plannerId, 'orchestrator_spec_question', {
        handoffId,
        text,
        why: 'The implementation choice is unclear.',
        affectedAcceptance: ['The saved-products page shows saved products.']
      })).rejects.toThrow()
    }
    await h.idleRelay()
    const relayed = h.deliveries.mock.calls.map(([delivery]) => delivery)
      .filter(delivery => delivery.sessionId === h.runtime.masterId)
    expect(relayed.some(delivery => technical.some(text => delivery.text.includes(text)))).toBe(false)
    expect(plannerDeliveries(plannerId)).toHaveLength(1)
    expect(await read(`handoff/${handoffId}`)).not.toHaveProperty('question')
  })
  it('does not let an older direct user message authorize a different project brief', async () => {
    const first = await confirm() as { id: string }
    const unapproved = { ...handoff,
      project: { ...project, workspace: resolve(project.workspace, 'unapproved') },
      goal: 'Share saved products with other shoppers.' }

    await expect(h.runTool(h.runtime.masterId, 'orchestrator_handoff_confirm', unapproved))
      .rejects.toThrow()
    expect(plannerDeliveries(plannerFor(first.id))).toHaveLength(1)
  })
  it('rejects bare assent without a complete approved project brief', async () => {
    const confirmation = 'I confirm'
    h.sendUserMessage(h.runtime.masterId, confirmation)
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_handoff_confirm', { ...handoff, confirmation }))
      .rejects.toThrow()
    await h.idlePlanning()
    expect([...h.agents.keys()].filter(id => id.startsWith('planner-'))).toEqual([])
  })
  it('rejects a Hub tool brief that differs from the directly approved brief', async () => {
    const approved = { project, goal: handoff.goal, constraints: handoff.constraints,
      acceptanceScope: handoff.acceptanceScope, authorization: handoff.authorization }
    const confirmation = approvalFor(approved)
    const unapproved = { ...approved, goal: 'Share saved products with other shoppers.' }
    const projectId = key('handoff-project', project.repository, project.workspace)
    const unapprovedId = key('handoff', projectId, JSON.stringify(unapproved))

    h.sendUserMessage(h.runtime.masterId, confirmation)
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_handoff_confirm', { ...unapproved, confirmation })).rejects.toThrow()
    await h.idlePlanning()
    expect(h.deliveries.mock.calls.map(([delivery]) => delivery)
      .filter(delivery => delivery.sessionId.startsWith('planner-'))).toEqual([])

    await h.restart()
    await h.idlePlanning()
    expect([...h.agents.keys()].filter(id => id.startsWith('planner-'))).toEqual([])
    await expect(read(`handoff/${unapprovedId}`)).rejects.toThrow('Unknown handoff')
  })

})
