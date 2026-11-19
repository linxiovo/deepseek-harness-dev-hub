import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ProjectCatalog, type ProjectSuspension } from '../src/app/projects.ts'
import { Store } from '../src/app/store.ts'
import { key } from '../src/core/ids.ts'
import { KV } from '../src/kv.ts'
import { PolicyConfigSchema } from '../src/policy.ts'

let directory: string
let stateDir: string
let catalog: ProjectCatalog

beforeEach(() => {
  directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'project-catalog-'))
  stateDir = join(directory, 'state')
  catalog = new ProjectCatalog(stateDir)
})

afterEach(() => {
  catalog?.close()
  rmSync(directory, { recursive: true, force: true })
})

function workspace(name: string): string {
  const path = join(directory, name)
  mkdirSync(path, { recursive: true })
  return path
}

function reopen(): void {
  catalog.close()
  catalog = new ProjectCatalog(stateDir)
}

it('persists registration and the first selection together, then retains an explicit selection across restart', () => {
  expect(catalog.list()).toEqual([])
  expect(catalog.selected()).toBeUndefined()
  const initial = { baseRef: 'refs/heads/main', policy: PolicyConfigSchema.parse({}) }
  const first = catalog.register({ repository: 'Owner/First', workspace: workspace('first'), initial })
  reopen()
  expect(catalog.selected()).toEqual(first)
  expect(catalog.get(first.id)?.initial).toEqual(initial)
  expect(first.stateDir).toBe(join(stateDir, 'projects', first.id))

  const second = catalog.register({ repository: 'Owner/Second', workspace: workspace('second') })
  expect(second.stateDir).not.toBe(first.stateDir)
  expect(catalog.selected()).toEqual(first)
  expect(catalog.select(second.id)).toEqual(second)
  expect(() => catalog.select('unknown')).toThrow(/unknown project/i)
  reopen()
  expect(catalog.list()).toEqual([first, second])
  expect(catalog.selected()).toEqual(second)
  expect(catalog.get('unknown')).toBeUndefined()
})

it('remembers one verified CLI reference before project registration and exposes only the public identity', () => {
  expect(catalog.account()).toBeUndefined()
  expect(catalog.publicAccount()).toBeUndefined()
  const identity = { id: 42, login: 'agent', noreply: '42+agent@users.noreply.github.com' }
  const first = { ...identity, cli: join(directory, 'gh-private') }
  catalog.setAccount(first)
  reopen()
  expect(catalog.account()).toEqual(first)
  expect(catalog.publicAccount()).toEqual(identity)

  const project = catalog.register({ repository: 'Owner/First', workspace: workspace('first') })
  const replacement = { ...first, cli: join(directory, 'gh-replacement') }
  catalog.setAccount(replacement)
  reopen()
  expect(catalog.account()).toEqual(replacement)
  expect(catalog.publicAccount()).toEqual(identity)
  expect(catalog.list()).toEqual([project])
  expect(catalog.list()[0]).not.toHaveProperty('cli')
})

it('retains an interrupted run across restart and updates suspension independently per project', () => {
  const first = catalog.register({ repository: 'Owner/First', workspace: workspace('first') })
  const second = catalog.register({ repository: 'Owner/Second', workspace: workspace('second') })
  const interruption: ProjectSuspension = { reason: 'interrupted', at: '2026-11-19T00:00:00.000Z',
    recoverable: { assignments: 3, handoffs: 2, effects: 1 } }
  catalog.setSuspension(first.id, interruption)
  reopen()
  expect(catalog.selected()?.suspension).toEqual(interruption)
  expect(catalog.get(second.id)?.suspension).toBeUndefined()

  const switched: ProjectSuspension = { ...interruption, reason: 'projectSwitched', at: '2026-11-19T00:01:00.000Z' }
  catalog.select(second.id)
  catalog.setSuspension(first.id, switched)
  catalog.setSuspension(second.id, interruption)
  catalog.setSuspension(second.id, null)
  expect(() => catalog.setSuspension('unknown', interruption)).toThrow(/unknown project/i)
  reopen()
  expect(catalog.selected()).toEqual(second)
  expect(catalog.get(first.id)?.suspension).toEqual(switched)
})

it('reuses the canonical binding but never follows a stale or retargeted alias on reload', () => {
  const original = workspace('original')
  const unrelated = workspace('unrelated')
  const alias = join(directory, 'alias')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(original, alias, linkType)

  const first = catalog.register({ repository: ' Owner/First ', workspace: alias })
  expect(first).toMatchObject({ repository: 'Owner/First', workspace: realpathSync.native(original) })
  const second = catalog.register({ repository: 'Owner/Second', workspace: unrelated })
  catalog.select(second.id)
  expect(catalog.register({ repository: 'owner/first', workspace: original })).toEqual(first)
  expect(catalog.register({ repository: 'Owner/First', workspace: alias })).toEqual(first)
  expect(() => catalog.register({ repository: 'Owner/Other', workspace: alias })).toThrow(/workspace overlaps/i)

  unlinkSync(alias)
  reopen()
  expect(catalog.get(first.id)).toEqual(first)
  expect(() => catalog.register({ repository: 'Owner/First', workspace: alias })).toThrow()
  symlinkSync(unrelated, alias, linkType)
  expect(() => catalog.register({ repository: 'Owner/First', workspace: alias })).toThrow(/already registered/i)
  expect(catalog.list()).toEqual([first, second])
  expect(catalog.selected()).toEqual(second)
})

it('rejects invalid input and overlapping workspaces without changing the catalog', () => {
  const parent = workspace('checkouts')
  const first = catalog.register({ repository: 'Owner/First', workspace: workspace(join('checkouts', 'first')) })
  expect(() => catalog.register({ repository: 'Owner/Parent', workspace: parent })).toThrow(/workspace overlaps/i)
  expect(() => catalog.register({ repository: 'Owner/Nested', workspace: workspace(join('checkouts', 'first', 'nested')) }))
    .toThrow(/workspace overlaps/i)
  expect(() => catalog.register({ repository: 'Owner/First', workspace: workspace('elsewhere') })).toThrow(/already registered/i)
  expect(() => catalog.register({ repository: 'Owner/Relative', workspace: 'relative' })).toThrow(/absolute directory/i)
  expect(() => catalog.register({ repository: 'https://github.com/Owner/First', workspace: parent })).toThrow(/owner\/name/i)
  expect(() => catalog.register({ repository: 'Owner/..', workspace: parent })).toThrow(/owner\/name/i)
  const file = join(directory, 'workspaces.txt')
  writeFileSync(file, '')
  expect(() => catalog.register({ repository: 'Owner/File', workspace: file })).toThrow(/must be a directory/i)

  const sibling = catalog.register({ repository: 'Owner/Sibling', workspace: workspace(join('checkouts', 'first-extra')) })
  expect(catalog.list()).toEqual([first, sibling])
  expect(catalog.selected()).toEqual(first)
})

it.runIf(process.platform === 'win32')('rejects a Windows workspace path relative to the current drive root', () => {
  const path = workspace('root-relative')
  expect(() => catalog.register({ repository: 'Owner/Relative', workspace: path.slice(2) })).toThrow(/absolute directory/i)
  expect(catalog.list()).toEqual([])
})

it('binds legacy storage only on explicit adoption and does not copy its Store into managed projects', () => {
  const legacyDatabase = join(stateDir, 'orchestrator.sqlite')
  const legacyStore = new Store(legacyDatabase)
  try { legacyStore.set(KV.runtime.masterId, 'legacy-hub') } finally { legacyStore.close() }
  reopen()
  expect(catalog.list()).toEqual([])

  const binding = { repository: 'Owner/Legacy', workspace: workspace('legacy') }
  const legacy = catalog.register({ ...binding, legacyStorage: true })
  expect(legacy).toEqual({ ...binding, id: key('handoff-project', binding.repository, binding.workspace), stateDir })
  expect(catalog.register({ ...binding, legacyStorage: true })).toEqual(legacy)
  expect(() => catalog.register(binding)).toThrow(/already registered/i)
  expect(() => catalog.register({ repository: 'Owner/Other', workspace: workspace('other'), legacyStorage: true })).toThrow(/legacy storage/i)

  const managed = catalog.register({ repository: 'Owner/Managed', workspace: workspace('managed') })
  const managedDatabase = join(managed.stateDir, 'orchestrator.sqlite')
  expect(existsSync(managedDatabase)).toBe(false)
  reopen()
  const adopted = new Store(join(catalog.selected()!.stateDir, 'orchestrator.sqlite'))
  const isolated = new Store(managedDatabase)
  try {
    expect(adopted.get(KV.runtime.masterId)).toBe('legacy-hub')
    expect(isolated.get(KV.runtime.masterId)).toBeUndefined()
  } finally {
    isolated.close()
    adopted.close()
  }
})

it('reuses an identical initialization after restart and rejects changes to the original seed', () => {
  const binding = { repository: 'Owner/First', workspace: workspace('first') }
  const policy = PolicyConfigSchema.parse({ rules: [], sources: { github: { allowed: [{ id: '1' }] } } })
  const initial = { baseRef: 'main', policy }
  const project = catalog.register({ ...binding, initial })
  reopen()
  expect(catalog.register({ ...binding, initial: { policy: { sources: policy.sources, rules: policy.rules }, baseRef: 'main' } })).toEqual(project)
  expect(() => catalog.register({ ...binding, initial: { ...initial, baseRef: 'other' } })).toThrow(/initialization/i)
  expect(() => catalog.register({ ...binding, initial: { ...initial, policy: PolicyConfigSchema.parse({}) } })).toThrow(/initialization/i)
  expect(() => catalog.register(binding)).toThrow(/initialization/i)
  expect(() => catalog.register({ repository: 'Owner/Legacy', workspace: workspace('legacy'), legacyStorage: true, initial }))
    .toThrow(/legacy project cannot have initial settings/i)
  expect(catalog.list()).toEqual([project])
})
