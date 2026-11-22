/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { ExecutorConfigSchema, worktreePreparationConfig } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('keeps legacy executor settings readable while validating and guarding explicit local repository and base ref', async () => {
  const legacy = ExecutorConfigSchema.parse({ prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"' })
  expect(legacy).not.toHaveProperty('repository')
  expect(legacy).not.toHaveProperty('baseRef')
  expect(worktreePreparationConfig(legacy)).toMatchObject({ ok: false, reason: expect.stringContaining('executor.repository') })
  expect(worktreePreparationConfig(ExecutorConfigSchema.parse({ repository: '/srv/repo' })))
    .toMatchObject({ ok: false, reason: expect.stringContaining('executor.baseRef') })
  expect(() => ExecutorConfigSchema.parse({ repository: 'relative/repo', baseRef: 'refs/heads/main' })).toThrow()
  expect(() => ExecutorConfigSchema.parse({ repository: '/srv/repo\nunsafe', baseRef: 'refs/heads/main' })).toThrow()
  expect(() => ExecutorConfigSchema.parse({ repository: '/srv/repo', baseRef: '--help' })).toThrow()
  expect(() => ExecutorConfigSchema.parse({ repository: '/srv/repo', baseRef: 'main\nunsafe' })).toThrow()
  h = await startRuntime()
  const { settings, store } = h.runtime
  const executor = store.settings().executor
  await settings.save('executor', { ...executor, repository: '/srv/repo', baseRef: 'refs/heads/main' }, store.blockRevision('executor'), 'panel')
  expect(store.settings().executor).toMatchObject({ repository: '/srv/repo', baseRef: 'refs/heads/main' })
  expect(worktreePreparationConfig(store.settings().executor)).toEqual({ ok: true, repository: '/srv/repo', baseRef: 'refs/heads/main' })
  const saved = store.settings().executor
  await expect(settings.save('executor', { ...saved, repository: '/srv/other' }, store.blockRevision('executor'), 'tool'))
    .rejects.toThrow(new UserError('panelOnlyEnvironment'))
  await expect(settings.save('executor', { ...saved, baseRef: 'refs/heads/other' }, store.blockRevision('executor'), 'sync'))
    .rejects.toThrow(new UserError('panelOnlyEnvironment'))
  expect(store.settings().executor).toMatchObject({ repository: '/srv/repo', baseRef: 'refs/heads/main' })
})

it('exposes immutable worktree preparation facts only when the executor supplies an identity', async () => {
  h = await startRuntime()
  const context = { deployment: h.runtime.deployment, sources: h.runtime.sources, settings: h.runtime.store.settings() }
  const ticket = { id: 't-prepare', name: 'prepare', directory: '/srv/work/prepare' }
  const unclaimed = environmentOf({ ...context, ticket })
  expect(unclaimed.map(variable => variable.key)).not.toContain('DSH_SUPERAGENT_BASE_SHA')
  const identity = { repository: '/srv/clone', branch: 'agent/prepare', base: { ref: 'refs/heads/main', sha: 'a'.repeat(40) } }
  const prepared = environmentOf({ ...context, ticket: { ...ticket, identity } })
  expect(Object.fromEntries(prepared.map(variable => [variable.key, variable.value]))).toMatchObject({
    DSH_SUPERAGENT_REPOSITORY: '/srv/clone', DSH_SUPERAGENT_BASE_REF: 'refs/heads/main',
    DSH_SUPERAGENT_BASE_SHA: identity.base.sha, DSH_SUPERAGENT_BRANCH: 'agent/prepare',
  })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const feishu = { ...policy.sources.feishu!, allowed: [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_saved', name: 'Saved' }] }
  await settings.save('policy', { ...policy, sources: { ...policy.sources, feishu } }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ sources: { feishu } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
