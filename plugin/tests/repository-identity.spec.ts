import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateRepositoryIdentity } from '../src/executor/repository-identity.ts'
import { WorktreeRejected } from '../src/executor/worktree.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv, gitRepository, type GitRepository } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
let directory: string
let clone: GitRepository
let commands: Commands

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'repository-identity-'))
  clone = gitRepository(directory)
  commands = new Commands(() => testDeployment(), gitEnv({
    GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  }), new AbortController().signal)
})
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Inspect actual Git's local remote config through the same command boundary the Executor uses. */
describe('repository identity', () => {
  it('accepts the fixture clone for acme/widgets without changing its config or HEAD', async () => {
    const config = readFileSync(join(clone.repository, '.git', 'config'), 'utf8')
    const head = clone.git('rev-parse', 'HEAD')
    expect(clone.git('config', '--local', '--get', 'remote.origin.url')).toBe('git@github.com:acme/widgets.git')

    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets')).resolves.toBeUndefined()

    expect(readFileSync(join(clone.repository, '.git', 'config'), 'utf8')).toBe(config)
    expect(clone.git('rev-parse', 'HEAD')).toBe(head)
  })

  it.each([
    ['HTTPS with suffix', 'https://github.com/acme/widgets.git'],
    ['HTTPS with case differences', 'https://GITHUB.COM/AcMe/WidGets'],
    ['scp-style SSH', 'git@github.com:acme/widgets.git'],
    ['SSH URL', 'ssh://git@github.com/acme/widgets.git'],
    ['Git transport', 'git://github.com/acme/widgets.git'],
  ])('accepts %s for the exact GitHub repository', async (_description, url) => {
    clone.git('remote', 'set-url', 'origin', url)
    await expect(validateRepositoryIdentity(commands, clone.repository, 'ACME/Widgets')).resolves.toBeUndefined()
    expect(clone.git('config', '--local', '--get', 'remote.origin.url')).toBe(url)
  })

  it('refuses a valid GitHub origin for the wrong repository', async () => {
    clone.git('remote', 'set-url', 'origin', 'https://github.com/acme/other.git')
    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets'))
      .rejects.toMatchObject({ code: 'wrong-repository', message: expect.stringMatching(/does not match/) })
    expect(clone.git('config', '--local', '--get', 'remote.origin.url')).toBe('https://github.com/acme/other.git')
  })

  it('refuses a valid GitHub origin for the wrong owner', async () => {
    clone.git('remote', 'set-url', 'origin', 'git@github.com:other/widgets.git')
    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets'))
      .rejects.toBeInstanceOf(WorktreeRejected)
  })

  it('refuses a clone without an origin remote', async () => {
    clone.git('remote', 'remove', 'origin')
    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets'))
      .rejects.toMatchObject({ code: 'wrong-repository', message: expect.stringMatching(/no origin URL/) })
    expect(clone.git('remote')).toBe('')
  })

  it('refuses ambiguous origin URLs even when both identify the target', async () => {
    clone.git('config', '--local', '--add', 'remote.origin.url', 'https://github.com/acme/widgets.git')
    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets'))
      .rejects.toMatchObject({ code: 'wrong-repository', message: expect.stringMatching(/exactly one/) })
    expect(clone.git('config', '--local', '--get-all', 'remote.origin.url').split(/\r?\n/)).toEqual([
      'git@github.com:acme/widgets.git', 'https://github.com/acme/widgets.git',
    ])
  })

  it.each([
    'https://github.com.evil.invalid/acme/widgets.git',
    'http://github.com/acme/widgets.git',
    'https://github.com/acme/widgets/extra.git',
    'https://github.com/acme/widgets.git?query=1',
    'ssh://other@github.com/acme/widgets.git',
    'file:///tmp/acme/widgets.git',
  ])('refuses unsupported or disguised origin %s', async url => {
    clone.git('remote', 'set-url', 'origin', url)
    await expect(validateRepositoryIdentity(commands, clone.repository, 'acme/widgets'))
      .rejects.toMatchObject({ code: 'wrong-repository', message: expect.stringMatching(/direct github\.com/) })
    expect(clone.git('config', '--local', '--get', 'remote.origin.url')).toBe(url)
  })
})
