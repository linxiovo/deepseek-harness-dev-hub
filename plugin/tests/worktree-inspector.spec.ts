import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { inspectRepository, inspectWorktree, validateWorktreeDestination, WorktreeRejected } from '../src/executor/worktree.ts'
import { gitEnv } from './fixtures/git.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
let directory: string
let repository: string
let worktree: string
let baseSha: string

// Exercise the public inspector against real Git through the worker's command boundary.
let commands: Commands
const repositories: string[] = []
const git = async (...args: string[]): Promise<string> => (await commands.git(args, directory)).trim()
const createRepository = async (name: string): Promise<string> => {
  const path = join(directory, name)
  await git('init', '-q', path)
  repositories.push(path)
  await git('-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'base')
  return path
}
const addWorktree = async (): Promise<void> => {
  await git('-C', repository, 'worktree', 'add', '-q', '-b', 'agent/ticket-1', worktree, baseSha)
}
const target = () => ({
  repository, directory: worktree, branch: 'agent/ticket-1', base: { ref: 'HEAD', sha: baseSha },
  ticket: 'ticket-1', assignment: 'assignment-1', session: 'worker-ticket-1',
})
/**
 * Unregister every linked worktree before deleting the temp root: Git on Windows can briefly retain handles on worktree
 * metadata and directories it just released, which makes the subsequent recursive removal fail with transient EPERM.
 */
const unregisterWorktrees = async (repositoryPath: string): Promise<void> => {
  const main = realpathSync(repositoryPath)
  const listed = await git('-C', repositoryPath, 'worktree', 'list', '--porcelain', '-z').catch(() => '')
  for (const record of listed.split('\0\0')) {
    const heading = record.split('\0')[0] ?? ''
    if (!heading.startsWith('worktree ')) continue
    const path = heading.slice('worktree '.length)
    let canonical: string
    try { canonical = realpathSync(path) } catch { continue /* Its test already deleted this worktree directory. */ }
    if (process.platform === 'win32' ? canonical.toLowerCase() === main.toLowerCase() : canonical === main) continue
    // Worktrees are dirty or carry untracked files by design; force is required, and a failure still leaves directory cleanup below.
    await git('-C', repositoryPath, 'worktree', 'remove', '--force', path).catch(() => {})
  }
}

beforeEach(async () => {
  repositories.length = 0
  directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'worktree-inspector-'))
  commands = new Commands(() => testDeployment(), gitEnv(), new AbortController().signal)
  repository = await createRepository('repository')
  worktree = join(directory, 'ticket-1')
  baseSha = await git('-C', repository, 'rev-parse', 'HEAD')
})
afterEach(async () => {
  for (const repositoryPath of repositories.splice(0)) await unregisterWorktrees(repositoryPath)
  // Windows can hold a directory handle briefly after Git exits; retry only those transient errors and still throw if they persist.
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
})

describe('Git worktree inspection', () => {
  it('identifies the canonical clone and common directory, not an arbitrary directory', async () => {
    expect(await inspectRepository(commands, repository)).toEqual({
      repository: realpathSync(repository), commonDir: realpathSync(join(repository, '.git')),
    })
    await expect(inspectRepository(commands, directory)).rejects.toThrow()
    const repositoryAlias = join(directory, 'repository-alias')
    symlinkSync(repository, repositoryAlias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await inspectRepository(commands, repositoryAlias)).toEqual({
      repository: realpathSync(repository), commonDir: realpathSync(join(repository, '.git')),
    })
    await addWorktree()
    await expect(inspectRepository(commands, worktree)).rejects.toMatchObject({ code: 'wrong-repository' })
  })

  it('accepts a correctly based worktree without changing its branch, HEAD, Git metadata, or files', async () => {
    await addWorktree()
    const marker = join(worktree, 'keep.txt')
    writeFileSync(marker, 'owned by the ticket\n')
    const gitfile = readFileSync(join(worktree, '.git'), 'utf8')
    const status = await git('-C', worktree, 'status', '--porcelain=v1')

    const found = await inspectWorktree(commands, { ...target(), mode: 'fresh' })

    expect(found).toMatchObject({
      repository: realpathSync(repository), commonDir: realpathSync(join(repository, '.git')),
      worktree: realpathSync(worktree), branch: 'agent/ticket-1',
      base: { ref: 'HEAD', sha: baseSha }, head: baseSha, preparation: { state: 'verified' },
    })
    expect(readFileSync(marker, 'utf8')).toBe('owned by the ticket\n')
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(gitfile)
    expect(await git('-C', worktree, 'status', '--porcelain=v1')).toBe(status)
    expect(await git('-C', worktree, 'rev-parse', 'HEAD')).toBe(baseSha)
    expect(await git('-C', worktree, 'branch', '--show-current')).toBe('agent/ticket-1')
  })

  it('rejects a preexisting ordinary directory without changing its contents', async () => {
    mkdirSync(worktree)
    const marker = join(worktree, 'someone-else.txt')
    writeFileSync(marker, 'do not replace\n')
    const rejection = await inspectWorktree(commands, { ...target(), mode: 'fresh' }).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(WorktreeRejected)
    expect(rejection).toMatchObject({ code: 'not-worktree' })
    expect(readFileSync(marker, 'utf8')).toBe('do not replace\n')
  })

  it('rejects a linked worktree belonging to a different repository', async () => {
    const foreign = await createRepository('foreign')
    await git('-C', foreign, 'worktree', 'add', '-q', '-b', 'agent/ticket-1', worktree, 'HEAD')
    const marker = join(worktree, 'foreign.txt')
    writeFileSync(marker, 'foreign work\n')
    await expect(inspectWorktree(commands, { ...target(), mode: 'fresh' }))
      .rejects.toMatchObject({ code: 'wrong-repository' })
    expect(readFileSync(marker, 'utf8')).toBe('foreign work\n')
  })

  it('rejects a worktree on another branch even when it has the expected HEAD', async () => {
    await addWorktree()
    await expect(inspectWorktree(commands, { ...target(), branch: 'agent/ticket-2', mode: 'fresh' }))
      .rejects.toMatchObject({ code: 'wrong-branch' })
    expect(await git('-C', worktree, 'branch', '--show-current')).toBe('agent/ticket-1')
  })

  it('rejects a worktree whose HEAD is not the pinned base', async () => {
    await addWorktree()
    await git('-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'next base')
    const nextSha = await git('-C', repository, 'rev-parse', 'HEAD')
    await expect(inspectWorktree(commands, { ...target(), base: { ref: 'HEAD', sha: nextSha }, mode: 'fresh' }))
      .rejects.toMatchObject({ code: 'wrong-base' })
    expect(await git('-C', worktree, 'rev-parse', 'HEAD')).toBe(baseSha)
  })

  it('rejects a symlink alias rather than treating it as an independently owned worktree', async () => {
    await addWorktree()
    const alias = join(directory, 'ticket-alias')
    symlinkSync(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(inspectWorktree(commands, { ...target(), directory: alias, mode: 'fresh' }))
      .rejects.toMatchObject({ code: 'not-worktree' })
    expect(realpathSync(alias)).toBe(realpathSync(worktree))
    expect(await git('-C', worktree, 'rev-parse', 'HEAD')).toBe(baseSha)
  })

  it('requires verified ownership for reuse and accepts an owned descendant without changing it', async () => {
    await addWorktree()
    await expect(inspectWorktree(commands, { ...target(), mode: 'reuse', previous: undefined }))
      .rejects.toMatchObject({ code: 'missing-ownership' })
    const found = await inspectWorktree(commands, { ...target(), mode: 'fresh' })
    const previous = { ...found, ticket: 'ticket-1', assignment: 'assignment-1', generation: 1, verified: true }
    await git('-C', worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'ticket progress')
    const head = await git('-C', worktree, 'rev-parse', 'HEAD')
    const reused = await inspectWorktree(commands, { ...target(), mode: 'reuse', previous })
    expect(reused).toMatchObject({ worktree: realpathSync(worktree), base: { ref: 'HEAD', sha: baseSha }, head,
      preparation: { state: 'verified' } })
    expect(await git('-C', worktree, 'rev-parse', 'HEAD')).toBe(head)
    await expect(inspectWorktree(commands, { ...target(), mode: 'reuse', previous: { ...previous, verified: false } }))
      .rejects.toMatchObject({ code: 'missing-ownership' })
  })

  it('does not reuse a verified claim for a different ticket or pinned base', async () => {
    await addWorktree()
    const found = await inspectWorktree(commands, { ...target(), mode: 'fresh' })
    const previous = { ...found, ticket: 'ticket-1', assignment: 'assignment-1', generation: 1, verified: true }
    await expect(inspectWorktree(commands, { ...target(), ticket: 'ticket-2', mode: 'reuse', previous }))
      .rejects.toMatchObject({ code: 'wrong-ownership' })
    await git('-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'another base')
    const nextSha = await git('-C', repository, 'rev-parse', 'HEAD')
    await expect(inspectWorktree(commands, { ...target(), base: { ref: 'HEAD', sha: nextSha }, mode: 'reuse',
      previous: { ...previous, base: { ref: 'HEAD', sha: nextSha } } }))
      .rejects.toMatchObject({ code: 'wrong-base' })
  })
})

describe('Git worktree destination isolation', () => {
  it('rejects the primary checkout itself and absent descendants without creating them', async () => {
    const nested = join(repository, 'new-worktrees', 'ticket-1')
    await expect(validateWorktreeDestination(commands, repository, repository))
      .rejects.toMatchObject({ code: 'invalid-target' })
    await expect(validateWorktreeDestination(commands, repository, nested))
      .rejects.toMatchObject({ code: 'invalid-target' })
    expect(() => realpathSync(join(repository, 'new-worktrees'))).toThrow()
    expect(await git('-C', repository, 'rev-parse', 'HEAD')).toBe(baseSha)
  })

  it('rejects a registered foreign ticket worktree and its descendants, preserving files', async () => {
    await addWorktree()
    const marker = join(worktree, 'other-ticket.txt')
    writeFileSync(marker, 'belongs to another ticket\n')
    const nested = join(worktree, 'new-worktrees', 'ticket-2')
    await expect(validateWorktreeDestination(commands, repository, worktree))
      .rejects.toMatchObject({ code: 'invalid-target' })
    await expect(validateWorktreeDestination(commands, repository, nested))
      .rejects.toMatchObject({ code: 'invalid-target' })
    expect(readFileSync(marker, 'utf8')).toBe('belongs to another ticket\n')
    expect(() => realpathSync(join(worktree, 'new-worktrees'))).toThrow()
    expect(await git('-C', worktree, 'rev-parse', 'HEAD')).toBe(baseSha)
  })

  it('rejects symlink or junction roots pointing into either checkout, preserving existing directories', async () => {
    await addWorktree()
    for (const [checkout, name] of [[repository, 'main-alias'], [worktree, 'ticket-alias']] as const) {
      const alias = join(directory, name)
      symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const marker = join(checkout, `${name}.txt`)
      writeFileSync(marker, 'keep existing contents\n')
      await expect(validateWorktreeDestination(commands, repository, join(alias, 'ticket-2')))
        .rejects.toMatchObject({ code: 'invalid-target' })
      await expect(validateWorktreeDestination(commands, repository, alias))
        .rejects.toMatchObject({ code: 'invalid-target' })
      expect(readFileSync(marker, 'utf8')).toBe('keep existing contents\n')
      expect(realpathSync(alias)).toBe(realpathSync(checkout))
    }
  })

  it('rejects a linked worktree of an unrelated repository, including through a junction alias', async () => {
    const foreign = await createRepository('foreign')
    const foreignWorktree = join(directory, 'foreign-ticket')
    await git('-C', foreign, 'worktree', 'add', '-q', '-b', 'agent/foreign', foreignWorktree, 'HEAD')
    const nested = join(foreignWorktree, 'existing-parent')
    mkdirSync(nested)
    const marker = join(nested, 'owned.txt')
    writeFileSync(marker, 'foreign work stays untouched\n')
    await expect(validateWorktreeDestination(commands, repository, join(nested, 'next-ticket')))
      .rejects.toMatchObject({ code: 'invalid-target' })
    const alias = join(directory, 'foreign-alias')
    symlinkSync(foreignWorktree, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateWorktreeDestination(commands, repository, join(alias, 'next-ticket')))
      .rejects.toMatchObject({ code: 'invalid-target' })
    expect(readFileSync(marker, 'utf8')).toBe('foreign work stays untouched\n')
    expect(() => realpathSync(join(nested, 'next-ticket'))).toThrow()
  })

  it('allows a normal non-Git work root when real Commands.git cannot find a checkout', async () => {
    const root = join(directory, 'work')
    mkdirSync(root)
    await expect(commands.git(['rev-parse', '--show-toplevel'], root)).rejects.toThrow()
    const destination = join(root, 'ticket-2')
    await expect(validateWorktreeDestination(commands, repository, destination)).resolves.toBeUndefined()
    expect(() => realpathSync(destination)).toThrow()
  })

  it('fails closed on a damaged foreign Git marker instead of treating the checkout as an ordinary directory', async () => {
    const root = join(directory, 'damaged')
    mkdirSync(root)
    const marker = join(root, '.git')
    writeFileSync(marker, 'gitdir: inaccessible\n')
    await expect(validateWorktreeDestination(commands, repository, join(root, 'ticket-2')))
      .rejects.toMatchObject({ code: 'invalid-target' })
    expect(readFileSync(marker, 'utf8')).toBe('gitdir: inaccessible\n')
  })

  it('accepts an absent sibling destination outside every registered checkout without creating directories', async () => {
    await addWorktree()
    const siblingRoot = join(directory, 'repository-other')
    mkdirSync(siblingRoot)
    const marker = join(siblingRoot, 'keep.txt')
    writeFileSync(marker, 'keep sibling contents\n')
    const sibling = join(siblingRoot, 'fresh')
    await expect(validateWorktreeDestination(commands, repository, sibling)).resolves.toBeUndefined()
    expect(() => realpathSync(sibling)).toThrow()
    expect(readFileSync(marker, 'utf8')).toBe('keep sibling contents\n')
    expect(await git('-C', worktree, 'branch', '--show-current')).toBe('agent/ticket-1')
  })
})
