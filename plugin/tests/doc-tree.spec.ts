import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkDocTree } from '../src/executor/doc-tree.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { gitEnv, gitRepository } from './fixtures/git.ts'

let fixture: string | undefined

afterEach(() => {
  if (!fixture) return
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fixture = undefined
})

function setup() {
  fixture = mkdtempSync(join(tmpdir(), 'doc-tree-'))
  const { base, git, repository } = gitRepository(fixture)
  const commands = new Commands(() => { throw new Error('Unexpected deployment lookup') }, gitEnv({
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  }), new AbortController().signal)
  const write = (path: string, content: string): void => {
    const file = join(repository, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const commit = (): string => {
    git('add', '-A')
    git('commit', '-qm', 'candidate')
    return git('rev-parse', 'HEAD')
  }
  return { base: base.sha, commands, commit, git, repository, write }
}

it('checks reference links and GitHub heading anchors in the candidate', async () => {
  const { base, commands, commit, repository, write } = setup()
  write('DOCS.md', '- [Contract][contract]\n\n[contract]: api.md#read--write-1\n')
  write('api.md', '# Read &amp; Write\n\n# Read &amp; Write\n\n[missing][missing]\n\n[missing]: #absent\n')
  const result = await checkDocTree(commands, repository, base, commit(), { root: 'DOCS.md', routes: [], leaves: ['api.md'] })
  expect(result.issues).toEqual([{ kind: 'broken-link', path: 'api.md', target: '#absent' }])
})

it('reports a route that links back to an ancestor as a child', async () => {
  const { base, commands, commit, repository, write } = setup()
  write('DOCS.md', '- [Module](docs/DOCS.md)\n')
  write('docs/DOCS.md', '- [Root](../DOCS.md)\n')
  const result = await checkDocTree(commands, repository, base, commit(), { root: 'DOCS.md', routes: ['docs/DOCS.md'], leaves: [] })
  expect(result.issues).toEqual([{ kind: 'invalid-navigation', path: 'docs/DOCS.md', target: 'DOCS.md', detail: 'Navigation cycle' }])
})

it('reports an undeclared moved document that still exists, not the removed path', async () => {
  const { commands, commit, git, repository, write } = setup()
  write('DOCS.md', '- [Old contract](old.md)\n')
  write('old.md', '# Contract\n')
  const base = commit()
  git('mv', 'old.md', 'new.md')
  write('DOCS.md', '# Docs\n')
  const candidate = commit()
  const scope = { root: 'DOCS.md', routes: [], leaves: [], documents: ['DOCS.md', 'old.md', 'new.md'] }
  await expect(checkDocTree(commands, repository, base, candidate, scope)).resolves.toMatchObject({
    changes: ['DOCS.md', 'new.md', 'old.md'], issues: [expect.objectContaining({ kind: 'invalid-declaration', path: 'new.md' })],
  })
})

it('reports both sides of a move and checks the committed root despite same-path edits', async () => {
  const { base, commands, commit, git, repository, write } = setup()
  git('mv', 'shared.txt', 'moved file.txt')
  write('DOCS.md', '# Committed root\n')
  const candidate = commit()
  write('DOCS.md', '- [Uncommitted broken link](absent.md)\n')
  write('untracked.md', '# Not in the candidate\n')

  await expect(checkDocTree(commands, repository, base, candidate, { root: 'DOCS.md', routes: [], leaves: [] }))
    .resolves.toEqual({ changes: ['DOCS.md', 'moved file.txt', 'shared.txt'], issues: [] })
})

it('follows scoped table and list navigation, without turning prose or leaf links into edges', async () => {
  const { commands, commit, repository, write } = setup()
  write('docs/extra.md', '[Out-of-scope broken link](ignored.md)\n')
  const base = commit()
  write('DOCS.md', [
    '| Module | Relative path |', '| --- | --- |', '| Module | [module](docs/) |',
    '- [source](shared.txt)', '', 'See [orphan](orphan.md).',
    '`[example](fake.md)`', '```md', '- [example](another-fake.md)', '```',
  ].join('\r\n'))
  write('docs/DOCS.md', '- [`Contract`](<API contract.md#request>)\n- [valid sibling outside scope](extra.md)\n- [declared route missing](missing-route.md)\n')
  write('docs/API contract.md', '## Request\n\n- [orphan](../orphan.md)\n\nSee [test](missing-test.ts).\n')
  write('orphan.md', 'See [missing](missing.md).\n')
  write('outside-scope.md', '[Out-of-scope broken link](ignored.md)\n')
  const result = await checkDocTree(commands, repository, base, commit(), {
    root: 'DOCS.md', routes: ['docs/DOCS.md', 'docs/missing-route.md'], leaves: ['docs/API contract.md', 'orphan.md'],
  })

  expect(result.issues).toHaveLength(6)
  expect(result.issues).toEqual(expect.arrayContaining([
    { kind: 'invalid-navigation', path: 'docs/DOCS.md', target: 'missing-route.md' },
    { kind: 'broken-link', path: 'docs/DOCS.md', target: 'missing-route.md' },
    expect.objectContaining({ kind: 'invalid-declaration', path: 'docs/missing-route.md' }),
    { kind: 'broken-link', path: 'docs/API contract.md', target: 'missing-test.ts' },
    { kind: 'broken-link', path: 'orphan.md', target: 'missing.md' },
    { kind: 'unreachable', path: 'orphan.md' },
  ]))
})

it('does not overlook a changed leaf linked by a route but omitted from the declared scope', async () => {
  const { commands, commit, repository, write } = setup()
  write('README.markdown', '- [API](api.markdown)\n')
  write('api.markdown', '# Original API\n')
  const base = commit()
  write('api.markdown', '# New API\n')
  const candidate = commit()
  await expect(checkDocTree(commands, repository, base, candidate, { root: 'README.markdown', routes: [], leaves: [] }))
    .resolves.toMatchObject({ issues: [{ kind: 'invalid-declaration', path: 'api.markdown', target: 'README.markdown', detail: expect.any(String) }] })
})

it('does not accept a null scope when the candidate contains the conventional root', async () => {
  const { base, commands, commit, repository, write } = setup()
  write('DOCS.md', '# Committed root\n')

  const result = await checkDocTree(commands, repository, base, commit(), { root: null, routes: [], leaves: [] })

  expect(result.changes).toEqual(['DOCS.md'])
  expect(result.issues).toEqual([expect.objectContaining({ kind: 'invalid-declaration', path: 'DOCS.md' })])
})

it('rejects a candidate that stops being HEAD while its committed documents are inspected', async () => {
  const { base, commands, commit, repository, write } = setup()
  write('DOCS.md', '# Original\n')
  const candidate = commit()
  const scope = { root: 'DOCS.md', routes: [], leaves: [] }
  let advanced = false
  const movingHead: Pick<Commands, 'git'> = {
    async git(args, cwd) {
      const output = await commands.git(args, cwd)
      if (!advanced && args.includes('cat-file')) {
        advanced = true
        write('DOCS.md', '# New HEAD\n')
        commit()
      }
      return output
    },
  }

  await expect(checkDocTree(movingHead, repository, base, candidate, scope)).rejects.toThrow(/candidate.*HEAD/)
  expect(advanced).toBe(true)
  await expect(checkDocTree(commands, repository, base, candidate, scope)).rejects.toThrow(/candidate.*HEAD/)
})

it('rejects unpinned revisions before invoking Git and rejects a HEAD off the pinned history', async () => {
  const { base, commands, commit, git, repository, write } = setup()
  const scope = { root: null, routes: [], leaves: [] }
  const noGit = { git: async (): Promise<string> => { throw new Error('Git must not run on invalid SHAs') } }
  await expect(checkDocTree(noGit, repository, base, 'HEAD', scope)).rejects.toThrow(/full.*SHAs/)
  await expect(checkDocTree(noGit, repository, `${base}^`, base, scope)).rejects.toThrow(/full.*SHAs/)

  write('tip.txt', 'Pinned branch tip\n')
  const pinned = commit()
  git('checkout', '--detach', base)
  write('other.txt', 'Different line of history\n')
  const candidate = commit()
  await expect(checkDocTree(commands, repository, pinned, candidate, scope)).rejects.toThrow()
  await expect(checkDocTree(commands, repository, base, candidate, scope)).resolves.toEqual({ changes: ['other.txt'], issues: [] })
  const rootless = await checkDocTree(commands, repository, base, candidate, { ...scope, routes: ['index.md'] })
  expect(rootless.issues).toEqual([expect.objectContaining({ kind: 'invalid-declaration', path: 'index.md' })])
})

it('rejects escaping paths and does not follow committed symlinks or submodules', async () => {
  const { base, commands, git, repository, write } = setup()
  write('DOCS.md', [
    '- [Escapes](%2e%2e/outside.md)', '- [Windows escape](..\\outside.md)', '- [Drive](C:/outside.md)', '- [File URI](file:///outside.md)',
    '- [Symlink](symlink.md)', '- [In submodule](modules/child.md)', '- [External](https://example.test/doc)',
  ].join('\n'))
  git('add', 'DOCS.md')
  git('update-index', '--add', '--cacheinfo', `120000,${git('rev-parse', `${base}:shared.txt`)},symlink.md`)
  git('update-index', '--add', '--cacheinfo', `160000,${base},modules`)
  git('commit', '-qm', 'candidate with special entries')
  const candidate = git('rev-parse', 'HEAD')

  const result = await checkDocTree(commands, repository, base, candidate, {
    root: 'DOCS.md', routes: ['../outside.md', 'symlink.md', 'modules'], leaves: [],
  })
  expect(result.changes).toEqual(['DOCS.md', 'modules', 'symlink.md'])
  expect(result.issues.filter(issue => issue.kind === 'invalid-declaration').map(issue => issue.path))
    .toEqual(['../outside.md', 'symlink.md', 'modules'])
  expect(result.issues.filter(issue => issue.kind === 'broken-link').map(issue => issue.target))
    .toEqual(['%2e%2e/outside.md', '..\\outside.md', 'C:/outside.md', 'file:///outside.md', 'symlink.md', 'modules/child.md'])
  expect(result.issues.filter(issue => issue.kind === 'invalid-navigation').map(issue => issue.target)).toEqual(['symlink.md'])
  expect(result.issues).toHaveLength(10)
})

it('does not return a clear result when the command output limit prevents reading a document', async () => {
  const { base, commands, commit, repository, write } = setup()
  write('DOCS.md', `${'text\n'.repeat(3_500_000)}- [Broken at the end](missing.md)\n`)
  const candidate = commit()

  await expect(checkDocTree(commands, repository, base, candidate, { root: 'DOCS.md', routes: [], leaves: [] }))
    .rejects.toThrow(/printed more output than it may/)
})

it('checks complete repositories on older Git but refuses partial clone configuration without a no-fetch guard', async () => {
  const { base, commands, commit, git, repository, write } = setup()
  write('DOCS.md', '# Root\n')
  const candidate = commit()
  const scope = { root: 'DOCS.md', routes: [], leaves: [] }
  const legacyGit: Pick<Commands, 'git'> = {
    async git(args, cwd) {
      if (args.includes('--no-lazy-fetch')) throw new CliError('unknown option: --no-lazy-fetch', undefined, 129)
      return commands.git(args, cwd)
    },
  }

  await expect(checkDocTree(legacyGit, repository, base, candidate, scope))
    .resolves.toEqual({ changes: ['DOCS.md'], issues: [] })
  git('config', 'remote.origin.partialclonefilter', 'blob:none')
  await expect(checkDocTree(legacyGit, repository, base, candidate, scope)).rejects.toThrow(/partial clone/)
})

it('fails an over-budget link check and does not count repeated links as distinct targets', async () => {
  const { base, commands, commit, repository, write } = setup()
  const scope = { root: 'DOCS.md', routes: [], leaves: [] }
  write('DOCS.md', '- [Source](shared.txt)\n'.repeat(513))
  await expect(checkDocTree(commands, repository, base, commit(), scope))
    .resolves.toEqual({ changes: ['DOCS.md'], issues: [] })

  write('DOCS.md', Array.from({ length: 513 }, (_, index) => `- [Target](file-${index}.txt)`).join('\n'))
  const candidate = commit()
  const guardedGit: Pick<Commands, 'git'> = {
    async git(args, cwd) {
      if (args.includes('file-0.txt')) throw new Error('Started resolving an oversized document')
      return commands.git(args, cwd)
    },
  }
  await expect(checkDocTree(guardedGit, repository, base, candidate, scope)).rejects.toThrow(/incomplete.*512.*narrow/i)
})
