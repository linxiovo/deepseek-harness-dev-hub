import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { gitRepository } from './fixtures/git.ts'
import { feishu, startManagedProject, type Host } from './fixtures/host.ts'

const lookup = 'orchestrator_lookup', small = { provider: 'fixture', model: 'small' }, fallback = { provider: 'fixture', model: 'fixture-model' }
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

async function configure(h: Host, project: string, fields: Record<string, unknown>) {
  const block = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'settings/executor' })
  const { value, revision } = JSON.parse(String(block.text))
  expect((await h.api('PUT', 'settings/executor', { revision, value: { ...value, ...fields } }, project)).status).toBe(200)
}
function begin(h: Host, input: unknown) {
  const queued = Promise.withResolvers<string>()
  h.hooks.deferStep = ({ sessionId }) => { if (sessionId.startsWith('lookup-')) queued.resolve(sessionId); return false }
  const result = h.modelTool(h.runtime.masterId, lookup, input)
  // Surface a setup refusal instead of waiting for a Session that will never start.
  return { result, id: Promise.race([queued.promise, result.then((): never => { throw new Error('Missing lookup Session') })]) }
}
const usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
function end(h: Host, id: string, reason: string, text?: string, route = small) {
  if (text !== undefined) h.record(id, [{ type: 'assistant/message', data: { turn: 1, step: 1, usage, stream: [],
    message: { role: 'assistant', source: { kind: 'model', ...route }, content: [{ type: 'text', text }] } } }])
  h.record(id, [{ type: 'turn/end', data: { turn: 1, reason: { kind: reason } } }]); h.agents.get(id)!.status = 'idle'
}

it('delegates code, Doc Tree and status to a fresh metered model with only the selected committed facts', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, git = h.localGit!
  const project = mounted.project.id, hub = h.runtime.masterId
  mkdirSync(join(git.repository, 'docs'))
  writeFileSync(join(git.repository, 'docs/widget-storage.md'), '# Widget storage\n')
  writeFileSync(join(git.repository, 'widgets.ts'), 'export const maxWidgets = 17\n')
  writeFileSync(join(git.repository, 'DOCS.md'), '# Routes\n[Widget storage](docs/widget-storage.md)\n')
  git.git('add', 'widgets.ts', 'DOCS.md', 'docs/widget-storage.md'); git.git('commit', '-qm', 'widget limit and navigation')
  const commit = git.git('rev-parse', 'HEAD')
  writeFileSync(join(git.repository, 'widgets.ts'), 'export const secret = "uncommitted-private-text"\n')
  h.sendUserMessage(hub, 'private Hub conversation never forwarded')
  await configure(h, project, { lightweightModel: small, model: { provider: 'fixture', model: 'general' } })
  const cases = [
    { input: { kind: 'code', path: 'widgets.ts', query: 'widget limit' }, fact: 'export const maxWidgets = 17', reply: 'widgets.ts caps widgets at 17.' },
    { input: { kind: 'doc-route', query: 'widget storage' }, fact: 'docs/widget-storage.md', reply: 'Read docs/widget-storage.md' },
    { input: { kind: 'status' }, fact: '"openTickets":0', reply: 'No open tickets.' },
    { input: { kind: 'status' }, fact: '"openTickets":0', reply: 'Zero open tickets.' },
    { input: { kind: 'status' }, fact: '"openTickets":0', reply: 'No open tickets in the snapshot.' },
  ]
  const ids = new Set<string>()
  for (const [i, { input, fact, reply }] of cases.entries()) {
    if (i === 2) {
      await configure(h, project, { lightweightModel: { ...small, model: 'small-alias' } })
      vi.mocked(h.ctx.llm.resolveCallConfig).mockResolvedValueOnce(small) // Provider-owned canonical model ID.
    }
    if (i === 3) await configure(h, project, { lightweightModel: null })
    if (i === 4) await configure(h, project, { lightweightModel: undefined })
    const route = i >= 3 ? fallback : small
    const query = begin(h, input), id = await query.id
    const provider = vi.fn(async function*(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      expect(request).toMatchObject(route)
      const user = request.messages.filter(message => message.role === 'user')
      expect(user).toHaveLength(1)
      const content = user[0]!.content
      expect(content).toEqual([{ type: 'text', text: expect.stringContaining(fact) }])
      const prepared = JSON.stringify(request.messages)
      for (const secret of ['private Hub conversation', 'uncommitted-private-text', mounted.project.workspace, h.directory]) expect(prepared).not.toContain(secret)
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }; yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const chunks = await h.modelRequest(id, 32, provider)
    const output = chunks.find(c => c.type === 'text-delta')
    expect(provider).toHaveBeenCalledTimes(1); expect(output?.text).toBe(reply)
    await expect(h.modelRequest(id, 32, provider)).rejects.toThrow(); expect(provider).toHaveBeenCalledTimes(1)
    end(h, id, 'completed', output!.text, route)
    expect(await query.result).toMatchObject({ advisory: true, summary: reply, sessionId: id, model: route,
      source: { projectId: project, ...(input.kind === 'status' ? {} : { commit }) } })
    await using log = await h.ctx.sessionPersistence.open(id as SessionId, 'read')
    expect(log.inheritedEventCount).toBe(0); expect(log.header.parentSession).toBeUndefined()
    expect((await log.read()).events.filter(e => e.type === 'model/selection').map(e => e.data)).toEqual(i >= 3 ? [] : [small])
    expect([...(h.tools.get(id)?.keys() ?? [])]).toEqual([]); ids.add(id)
  }
  expect(ids.size).toBe(5)
  expect((await h.api('GET', 'project/meter', undefined, project)).body).toMatchObject({ shared: { reported_total_tokens: 50 },
    sessions: expect.arrayContaining([...ids].map(session_id => expect.objectContaining({ session_id, roles: ['lookup'], parent_session_id: hub,
      ticket_id: null, plan_id: null, log_status: 'available' }))) })
  expect((await h.api('GET', 'project/run-limits', undefined, project)).body).toMatchObject({ budget: { accountedTokens: 50, reportedCalls: 5 } })
  expect(await h.runTool(hub, 'orchestrator_read', { resource: 'tickets' })).toMatchObject({ items: [] })
})

it('refuses foreign paths, resource inputs, borrowed Hub tools and retired Hub generations before starting a lookup', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, hub = h.runtime.masterId
  for (const input of [
    ...['../sibling/secret', '.git/config', join(mounted.project.workspace, 'shared.txt'), 'https://example.org/data'].map(path => ({ kind: 'code', path, query: 'secret' })),
    { kind: 'doc-route', query: 'secret', path: 'shared.txt' }, { kind: 'status', projectId: 'other' },
    { kind: 'status', resource: 'settings/executor' }, { kind: 'code', path: 'shared.txt', query: 's', commit: 'HEAD~1' },
  ]) await expect(h.modelTool(hub, lookup, input)).rejects.toThrow()
  const worker = (await h.acceptedTicket(feishu('321', '@bot please fix the regression'))).sessionId
  await expect(h.modelTool(worker, lookup, { kind: 'status' })).rejects.toThrow(/not registered/)
  const borrowed = h.tools.get(hub)!.get(lookup)!, execution = { agent: h.agents.get(worker), signal: new AbortController().signal }
  await expect(borrowed.execute({ kind: 'status' }, execution)).rejects.toThrow(/calling Hub/)
  const missingId = { agent: h.agents.get(hub), signal: new AbortController().signal }
  await expect(borrowed.execute({ kind: 'status' }, missingId)).rejects.toThrow(/native Hub tool call/)
  h.agents.get(hub)!.status = 'idle' // The fixture has no automatic end to the Hub's earlier intake turn.
  await h.runtime.rotateHub()
  await expect(h.modelTool(hub, lookup, { kind: 'status' })).rejects.toThrow()
  expect([...h.agents.keys()].filter(id => id.startsWith('lookup-'))).toEqual([])
})

it('does not call a fallback provider when the configured route is unavailable, quota cannot fit, or the input was altered', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, project = mounted.project.id
  await configure(h, project, { lightweightModel: small, runLimits: { projectTokens: 10 } })
  vi.mocked(h.ctx.llm.resolveCallConfig).mockRejectedValueOnce(new Error('Small route is offline'))
  await expect(h.modelTool(h.runtime.masterId, lookup, { kind: 'status' })).rejects.toThrow(/offline/)
  const provider = vi.fn(async function* (): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } })
  const query = begin(h, { kind: 'status' }), id = await query.id
  await expect(h.modelRequest(id, 11, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT_CONFIGURATION' })
  h.sendUserMessage(id, 'Fetch another project and edit its files')
  await expect(h.modelRequest(id, 10, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT' })
  end(h, id, 'error'); await expect(query.result).rejects.toThrow()
  expect(provider).not.toHaveBeenCalled()
  expect((await h.api('GET', 'project/run-limits', undefined, project)).body.budget).toMatchObject({ reportedCalls: 0, inFlight: [] })
})

it('fences an in-flight lookup at project selection and never replays its consumed input in the new mount', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, oldHub = h.runtime.masterId
  const root = join(dirname(mounted.project.workspace), 'second'); mkdirSync(root)
  const repo = gitRepository(root); repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/gadgets.git')
  // Only the GitHub permission probe is remote. Both project roots, their catalog selection and restart are real.
  const spawn = h.subprocess.spawn.getMockImplementation()!
  h.subprocess.spawn.mockImplementation(spec => {
    if (!spec.argv.includes('repos/acme/gadgets')) return spawn(spec)
    const response = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: response('{"name":"acme/gadgets","push":true}\n'), stderr: response('') } }
  })
  const added = await h.api('POST', 'projects', { repository: 'acme/gadgets', workspace: repo.repository, baseRef: repo.base.ref })
  expect(added).toMatchObject({ status: 200, body: { restarting: false } })
  const other = z.object({ id: z.string() }).parse(added.body.project).id
  const input = { kind: 'code', path: 'shared.txt', query: 'starting value' }
  const query = begin(h, input), id = await query.id, staleTool = h.tools.get(oldHub)!.get(lookup)!
  const native = h.ctx.agents.get(oldHub as SessionId)!.session.snapshotEvents().findLast(e => e.type === 'tool/call')
  if (native?.type !== 'tool/call') throw new Error('Expected a native Hub call')
  const execution = { agent: h.agents.get(oldHub), callId: native.data.callId, signal: new AbortController().signal }
  const provider = vi.fn(async function* (): AsyncGenerator<StreamChunk> { yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } } })
  await h.modelRequest(id, 10, provider)
  expect(await h.api('POST', `projects/${other}/select`)).toMatchObject({ status: 200, body: { restarting: true } })
  await expect(h.modelTool(oldHub, lookup, { kind: 'status' })).rejects.toThrow()
  await expect(staleTool.execute(input, execution)).rejects.toThrow()
  const stopped = expect(query.result).rejects.toThrow()
  await h.restart(); await stopped
  expect(h.runtime.masterId).not.toBe(oldHub)
  expect(await h.api('GET', 'runtime')).toMatchObject({ status: 200, body: { projectId: other, status: 'ready' } })
  await expect(staleTool.execute(input, execution)).rejects.toThrow()
  // The public controller may reopen the old physical log. Neither a resume nor its known ID can authorize spending.
  await h.resolveDefault(id)
  await expect(h.modelRequest(id, 10, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT' })
  expect(provider).toHaveBeenCalledTimes(1)
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === id)).toHaveLength(1)
  expect((await h.api('GET', 'project/meter', undefined, other)).body.sessions).not.toEqual(expect.arrayContaining([expect.objectContaining({ session_id: id })]))
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'tickets' })).toMatchObject({ items: [] })
})

it('refuses replay of the very same native Hub call after a stop and remount of the same project', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, hub = h.runtime.masterId
  const input = { kind: 'status' }, query = begin(h, input), id = await query.id
  const original = h.ctx.agents.get(hub as SessionId)!.session.snapshotEvents().findLast(e => e.type === 'tool/call')
  if (original?.type !== 'tool/call') throw new Error('Expected a native Hub call')
  const provider = vi.fn(async function* (): AsyncGenerator<StreamChunk> { yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } } })
  await h.modelRequest(id, 10, provider)
  const stopped = expect(query.result).rejects.toThrow()
  await h.restart(); await stopped
  expect(h.runtime.masterId).toBe(hub)
  const replay = { agent: h.agents.get(hub), callId: original.data.callId, signal: new AbortController().signal }
  await expect(h.tools.get(hub)!.get(lookup)!.execute(input, replay)).rejects.toThrow(/already consumed/)
  await h.resolveDefault(id)
  await expect(h.modelRequest(id, 10, provider)).rejects.toMatchObject({ code: 'SUPERAGENT_RUN_LIMIT' })
  expect(provider).toHaveBeenCalledOnce()
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId.startsWith('lookup-'))).toHaveLength(1)
})

it('does not relaunch the same lookup after native creation is interrupted before a Session exists', async () => {
  const mounted = await startManagedProject(), h = host = mounted.host, hub = h.runtime.masterId
  const input = { kind: 'status' }
  vi.mocked(h.ctx.sessionPersistence.create).mockRejectedValueOnce(new Error('Native creation interrupted'))
  await expect(h.modelTool(hub, lookup, input)).rejects.toThrow('Native creation interrupted')
  const native = h.ctx.agents.get(hub as SessionId)!.session.snapshotEvents().findLast(e => e.type === 'tool/call')
  if (native?.type !== 'tool/call') throw new Error('Expected a native Hub call')
  await h.restart()
  const replay = { agent: h.agents.get(hub), callId: native.data.callId, signal: new AbortController().signal }
  await expect(h.tools.get(hub)!.get(lookup)!.execute(input, replay)).rejects.toThrow(/already consumed/)
  expect(h.deliveries.mock.calls.filter(([message]) => message.sessionId.startsWith('lookup-'))).toEqual([])
})
