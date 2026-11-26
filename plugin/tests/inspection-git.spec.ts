import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectionCommit, readInspectionPath, validInspectionPath } from '../src/executor/inspection-git.ts'
import { Commands } from '../src/infra/commands.ts'
import { gitRepository } from './fixtures/git.ts'

let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fixture = undefined
})

function setup() {
  fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'inspection-git-')))
  const { base, git, repository } = gitRepository(fixture)
  const commands = new Commands(() => { throw new Error('Unexpected deployment lookup') }, {
    GIT_DIR: join(fixture, 'wrong-git-directory'),
    GIT_OBJECT_DIRECTORY: join(fixture, 'wrong-object-directory'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: fixture,
  }, new AbortController().signal)
  git('config', 'core.autocrlf', 'false')
  const write = (path: string, content: string | Buffer): void => {
    const file = join(repository, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const commit = (): string => {
    git('add', '-A')
    git('commit', '-qm', 'snapshot')
    return git('rev-parse', 'HEAD')
  }
  const checkout = { workspace: repository, repository: 'acme/widgets' }
  const pin = (scope: string) => inspectionCommit(commands, checkout, base.ref, scope)
  const read = (sha: string, scope: string, path: string, offset = 0) =>
    readInspectionPath(commands, checkout, sha, scope, path, offset)
  return { base, commands, checkout, git, repository, write, commit, pin, read }
}

it('reads only the pinned snapshot despite branch, index, and checkout changes', async () => {
  const { checkout, commands, git, repository, write, commit, pin, read } = setup()
  const path = 'module/[x].txt'
  const text = ' first\r\n😀\r\n\n'
  write('.gitattributes', 'module/* -text filter=inspection-test\n')
  write(path, text)
  write('module/x.txt', 'not the literal path\n')
  write('module/--help & file', 'literal option-like name\n')
  write('module/nested/child', 'not a direct child\n')
  const old = commit()
  const sha = await pin('module')
  expect(sha).toBe(old)
  write(path, 'new main\n')
  const head = commit()
  git('replace', old, head)
  write(path, 'index edit\n')
  git('add', '--', path)
  write(path, 'working copy only\n')
  write('module/untracked', 'not in the snapshot\n')
  const dirty = git('status', '--porcelain=v1')
  git('config', 'filter.inspection-test.smudge', 'false')
  git('config', 'filter.inspection-test.required', 'true')

  await expect(read(sha, 'module', 'module')).resolves.toEqual({
    kind: 'directory', path: 'module', entries: ['module/--help & file', path, 'module/nested', 'module/x.txt'], nextOffset: null,
  })
  await expect(read(sha, 'module', path)).resolves.toEqual({ kind: 'file', path, text, nextOffset: null })
  await expect(read(sha, 'module', 'module/--help & file')).resolves.toMatchObject({ text: 'literal option-like name\n' })
  await expect(read(sha, 'module', path, 10)).resolves.toMatchObject({ text: '\r\n\n', nextOffset: null })
  await expect(read(sha, 'module', 'module/untracked')).rejects.toThrow(/not found/i)
  await expect(readInspectionPath(commands, { ...checkout, workspace: join(repository, 'module') }, sha, 'module', path, 0)).rejects.toThrow(/checkout/i)
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(git('show', `:${path}`)).toBe('index edit')
  expect(git('config', '--get', 'filter.inspection-test.required')).toBe('true')
  git('config', 'filter.inspection-test.required', 'false')
  expect(git('status', '--porcelain=v1')).toBe(dirty)
  expect(readFileSync(join(repository, path), 'utf8')).toBe('working copy only\n')
})

it('refuses traversal, similarly named paths, symlinks and gitlinks without reading their targets', async () => {
  const { base, checkout, commands, git, write, commit, pin, read } = setup()
  write('module/public', '../private')
  write('module2/also-private', 'sibling secret')
  write('private/secret', 'outside secret')
  const sha = commit()
  git('update-index', '--add', '--cacheinfo', `120000,${git('rev-parse', `${sha}:module/public`)},module/link`)
  git('update-index', '--add', '--cacheinfo', `160000,${base.sha},module/vendor`)
  git('commit', '-qm', 'special tree entries')
  const pinned = await pin('module')

  for (const path of ['', '.', '../private/secret', '/private/secret', 'module/../private/secret', 'module/.GiT/config',
    'module/.. /private/secret', 'module\\public', 'module/public:secret', 'C:private/secret', 'module/\npublic',
    'module/COM1.txt', 'module/GIT~1/config']) {
    expect(validInspectionPath(path)).toBe(false)
    await expect(read(pinned, 'module', path)).rejects.toThrow(/path/i)
  }
  await expect(read(pinned, '', 'module/public')).rejects.toThrow(/scope/i)
  await expect(read(pinned, 'module', 'module2/also-private')).rejects.toThrow(/scope/i)
  await expect(read(pinned, 'module/public', 'module')).rejects.toThrow(/scope/i)
  await expect(pin('module/public')).resolves.toBe(pinned)
  await expect(pin('module/missing')).rejects.toThrow(/not found/i)
  await expect(pin('module/link')).rejects.toThrow(/regular file or directory/i)
  await expect(pin('module/vendor')).rejects.toThrow(/regular file or directory/i)
  await expect(read(pinned, 'module', 'module/link')).rejects.toThrow(/regular file or directory/i)
  await expect(read(pinned, 'module', 'module/link/secret')).rejects.toThrow(/not found/i)
  await expect(read(pinned, 'module', 'module/vendor')).rejects.toThrow(/regular file or directory/i)
  await expect(read('HEAD', 'module', 'module/public')).rejects.toThrow(/commit/i)
  await expect(inspectionCommit(commands, checkout, '--help', 'module')).rejects.toThrow(/ref/i)
  expect(validInspectionPath('module/-literal[1] & file')).toBe(true)
})

it('pages text and directories and explicitly fails when a blob cannot be read as bounded text', async () => {
  const { write, commit, pin, read } = setup()
  const body = `${'a'.repeat(7_999)}😀\r\n${'b'.repeat(8_010)}�\n`
  write('module/body', body)
  write('module/empty', '')
  write('module/binary', Buffer.from([65, 0, 10]))
  write('module/invalid-utf8', Buffer.from([0xa0]))
  write('module/oversize', 'x'.repeat(1024 * 1024 + 1))
  for (let i = 0; i < 101; i++) write(`pages/child-${String(i).padStart(3, '0')}`, '')
  const sha = commit()

  let text = ''
  let offset: number | null = 0
  do {
    const page = await read(sha, 'module', 'module/body', offset)
    if (page.kind !== 'file') throw new Error('Expected text page')
    text += page.text
    expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/)
    if (page.nextOffset !== null) expect(page.nextOffset).toBe(text.length)
    offset = page.nextOffset
  } while (offset !== null)
  expect(text).toBe(body)
  await expect(read(sha, 'module', 'module/empty')).resolves.toMatchObject({ text: '', nextOffset: null })
  await expect(read(sha, 'module', 'module/body', -1)).rejects.toThrow(/offset/i)
  await expect(read(sha, 'module', 'module/body', 8_000)).rejects.toThrow(/offset/i)
  await expect(read(sha, 'module', 'module/empty', 1)).rejects.toThrow(/offset/i)
  await expect(pin('module/binary')).resolves.toBe(sha)
  await expect(read(sha, 'module', 'module/binary')).rejects.toThrow(/binary/i)
  await expect(read(sha, 'module', 'module/invalid-utf8')).rejects.toThrow(/UTF-8/i)
  await expect(read(sha, 'module', 'module/oversize')).rejects.toThrow(/too large/i)

  await expect(read(sha, 'pages', 'pages')).resolves.toMatchObject({
    kind: 'directory', entries: expect.arrayContaining(['pages/child-000', 'pages/child-099']), nextOffset: 100,
  })
  await expect(read(sha, 'pages', 'pages', 100)).resolves.toEqual({
    kind: 'directory', path: 'pages', entries: ['pages/child-100'], nextOffset: null,
  })
  await expect(read(sha, 'pages', 'pages', 102)).rejects.toThrow(/offset/i)
})

it('fails explicitly when a tracked object is absent from the local object database', async () => {
  const { base, git, repository, pin, read } = setup()
  const oid = git('rev-parse', `${base.sha}:shared.txt`)
  rmSync(join(repository, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
  await expect(pin('shared.txt')).rejects.toThrow(/scoped object type/i)
  await expect(read(base.sha, 'shared.txt', 'shared.txt')).rejects.toThrow(/scoped object type/i)
})

it('rejects a checkout configured to consult an external object store', async () => {
  const { base, repository, pin, read } = setup()
  writeFileSync(join(repository, '.git', 'objects', 'info', 'alternates'), `${join(dirname(repository), 'other', 'objects')}\n`)
  await expect(pin('shared.txt')).rejects.toThrow(/alternate object/i)
  await expect(read(base.sha, 'shared.txt', 'shared.txt')).rejects.toThrow(/alternate object/i)
})

it('refuses a substituted checkout symlink', async () => {
  const { checkout, commands, base, repository } = setup()
  const alias = join(dirname(repository), 'other-checkout')
  symlinkSync(repository, alias, 'junction')
  await expect(inspectionCommit(commands, { ...checkout, workspace: alias }, base.ref, 'shared.txt')).rejects.toThrow(/physical root/i)
})

it('refuses a checkout whose local origin changed, even for an already pinned blob', async () => {
  const { git, pin, read } = setup()
  const sha = await pin('shared.txt')
  git('remote', 'set-url', 'origin', 'git@github.com:acme/other.git')
  await expect(pin('shared.txt')).rejects.toThrow(/origin does not match/i)
  await expect(read(sha, 'shared.txt', 'shared.txt')).rejects.toThrow(/origin does not match/i)
})
