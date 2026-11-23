import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advanceMainline, inspectRulesChange, precedes, readMainline, RULES_MANIFEST, type MainlineTarget } from '../src/executor/mainline-git.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv, gitRepository, type GitRepository } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
const slug = 'acme/widgets'
const canonicalUrl = `https://github.com/${slug}.git`
const main = 'refs/heads/main'
let directory: string
let clone: GitRepository
let remote: string
let target: MainlineTarget
let gitFor: (cwd: string, ...args: string[]) => string
let transfers: string[]
let losePushReply: boolean

function commands(repository = slug): Commands {
  return new Commands(() => testDeployment({ repository }), gitEnv({
    GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'never',
  }), new AbortController().signal)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mainline-git-test-'))
  clone = gitRepository(directory)
  remote = join(directory, 'remote.git')
  target = { repository: clone.repository, slug, ref: main }
  transfers = []
  losePushReply = false
  const env = gitEnv({ GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
  delete env.GIT_CONFIG_COUNT
  delete env.GIT_CONFIG_PARAMETERS
  gitFor = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  gitFor(directory, 'init', '-q', '--bare', remote)
  gitFor(clone.repository, 'push', '-q', remote, `${clone.base.sha}:${main}`)
  const url = pathToFileURL(remote).href
  const realGit = Commands.prototype.git
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async function (this: Commands, args, cwd) {
    const operation = args.find(arg => arg === 'fetch' || arg === 'push')
    if (!operation) return realGit.call(this, args, cwd)
    // The only test substitution is the transport at the subprocess seam. Real Git serves the refs,
    // transfers objects, proves ancestry, and enforces the lease. Unrecognized URLs never hit a network.
    transfers.push(operation)
    expect(args).toContain(canonicalUrl)
    const output = await realGit.call(this, ['-c', 'protocol.file.allow=always', ...args.map(arg => arg === canonicalUrl ? url : arg)], cwd)
    if (operation === 'push' && losePushReply) throw new DOMException('Lost receive-pack reply', 'AbortError')
    return output
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Make commits in a separate clone so the main checkout starts without these objects. */
function upstreamCommit(parent: string): string {
  const source = join(directory, 'upstream')
  gitFor(directory, 'clone', '-q', '--no-checkout', remote, source)
  gitFor(source, 'switch', '--detach', parent)
  gitFor(source, '-c', 'user.name=Remote Test', '-c', 'user.email=remote@example.test', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'upstream change', '--allow-empty')
  const tip = gitFor(source, 'rev-parse', 'HEAD')
  gitFor(source, 'push', '-q', remote, `${tip}:${main}`)
  return tip
}

describe('mainline Git', () => {
  it('fetches the current remote tip and its commit without writing any clone refs or checkout state', async () => {
    const tip = upstreamCommit(clone.base.sha)
    // Make both the local branch and the remote-tracking branch stale.
    clone.git('update-ref', 'refs/remotes/origin/main', clone.base.sha)
    const refs = clone.git('show-ref')
    const status = clone.git('status', '--porcelain')
    const originalFetchHead = Buffer.from('do not change the primary FETCH_HEAD\n')
    // Establish FETCH_HEAD through Git, then remember its exact contents.
    gitFor(clone.repository, 'fetch', '-q', remote, clone.base.sha)
    const fetchHead = readFileSync(join(clone.repository, '.git', 'FETCH_HEAD'))
    expect(fetchHead).not.toEqual(originalFetchHead)
    expect(clone.git('cat-file', '--batch-check', '--batch-all-objects')).not.toContain(tip)

    await expect(readMainline(commands(), target)).resolves.toBe(tip)
    expect(clone.git('cat-file', '-t', tip)).toBe('commit')
    expect(clone.git('show-ref')).toBe(refs)
    expect(clone.git('symbolic-ref', 'HEAD')).toBe(main)
    expect(clone.git('status', '--porcelain')).toBe(status)
    expect(readFileSync(join(clone.repository, '.git', 'FETCH_HEAD'))).toEqual(fetchHead)
  })

  it('pushes only the candidate to the requested remote branch, ignoring pushurl and URL rewrites', async () => {
    const wrong = join(directory, 'wrong.git')
    gitFor(directory, 'init', '-q', '--bare', wrong)
    clone.git('config', 'remote.origin.pushurl', pathToFileURL(wrong).href)
    clone.git('config', `url.${pathToFileURL(wrong).href}.insteadOf`, pathToFileURL(remote).href)
    gitFor(directory, 'config', '--global', `url.${pathToFileURL(wrong).href}.pushInsteadOf`, pathToFileURL(remote).href)
    clone.git('switch', '-qc', 'candidate')
    clone.git('commit', '-qm', 'candidate', '--allow-empty')
    const candidate = clone.git('rev-parse', 'HEAD')
    clone.git('tag', '-a', 'candidate-tag', '-m', 'do not push')
    const refs = clone.git('show-ref')
    const authorize = vi.fn(() => expect(transfers).toEqual([]))

    await expect(advanceMainline(commands(), target, clone.base.sha, candidate, authorize)).resolves.toBe('advanced')
    expect(authorize).toHaveBeenCalledOnce()
    expect(transfers).toEqual(['push'])
    expect(gitFor(remote, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(`${candidate} ${main}`)
    expect(gitFor(wrong, 'for-each-ref')).toBe('')
    expect(clone.git('show-ref')).toBe(refs)
    // Git skips the lease check on an already-present destination. This is not a successful queue write.
    await expect(advanceMainline(commands(), target, clone.base.sha, candidate)).resolves.toBe('unchanged')
  })

  it('rejects a stale lease even when the candidate fast-forwards the newly moved tip', async () => {
    expect(await readMainline(commands(), target)).toBe(clone.base.sha)
    const moved = upstreamCommit(clone.base.sha)
    expect(await readMainline(commands(), target)).toBe(moved)
    clone.git('switch', '-qc', 'candidate', moved)
    clone.git('commit', '-qm', 'candidate above moved tip', '--allow-empty')
    const candidate = clone.git('rev-parse', 'HEAD')

    await expect(advanceMainline(commands(), target, clone.base.sha, candidate)).rejects.toThrow(/expected base/)
    expect(gitFor(remote, 'rev-parse', main)).toBe(moved)
    expect(transfers).toEqual(['fetch', 'fetch', 'push'])
  })

  it('refuses wrong repositories, missing objects, denied authorization and divergent candidates without touching refs', async () => {
    clone.git('switch', '-qc', 'other-base')
    clone.git('commit', '-qm', 'other base', '--allow-empty')
    const otherBase = clone.git('rev-parse', 'HEAD')
    clone.git('switch', '-qc', 'candidate', clone.base.sha)
    clone.git('commit', '-qm', 'divergent candidate', '--allow-empty')
    const candidate = clone.git('rev-parse', 'HEAD')
    gitFor(clone.repository, 'push', '-q', remote, `${otherBase}:${main}`)
    const refs = clone.git('show-ref')

    await expect(precedes(commands(), target, otherBase, candidate)).resolves.toBe(false)
    await expect(precedes(commands(), target, 'f'.repeat(40), candidate)).rejects.toThrow(/commit object/)
    await expect(advanceMainline(commands(), target, otherBase, candidate)).rejects.toThrow(/strictly descend/)
    await expect(advanceMainline(commands(), target, clone.base.sha, candidate, () => { throw new Error('no longer authorized') }))
      .rejects.toThrow('no longer authorized')
    await expect(advanceMainline(commands('acme/other'), target, clone.base.sha, candidate)).rejects.toMatchObject({ code: 'wrong-repository' })
    clone.git('remote', 'set-url', 'origin', 'https://github.com/acme/other.git')
    await expect(advanceMainline(commands(), target, clone.base.sha, candidate)).rejects.toMatchObject({ code: 'wrong-repository' })
    expect(transfers).toEqual([])
    expect(gitFor(remote, 'rev-parse', main)).toBe(otherBase)
    expect(clone.git('show-ref')).toBe(refs)
  })

  it('recovers after a lost push reply by observing the exact candidate before any retry', async () => {
    clone.git('switch', '-qc', 'candidate')
    clone.git('commit', '-qm', 'candidate', '--allow-empty')
    const candidate = clone.git('rev-parse', 'HEAD')
    losePushReply = true
    await expect(advanceMainline(commands(), target, clone.base.sha, candidate)).rejects.toMatchObject({ name: 'AbortError' })
    expect(transfers).toEqual(['push'])
    const restarted = commands()
    const tip = await readMainline(restarted, target)
    expect(tip).toBe(candidate)
    await expect(precedes(restarted, target, clone.base.sha, tip)).resolves.toBe(true)
    expect(transfers).toEqual(['push', 'fetch'])

    // Even if a caller skips reconciliation, Git's up-to-date reply is not a successful CAS.
    losePushReply = false
    await expect(advanceMainline(restarted, target, clone.base.sha, candidate)).resolves.toBe('unchanged')
    expect(gitFor(remote, 'rev-parse', main)).toBe(candidate)
  })
})

describe('rules Git snapshot', () => {
  let checkout: string
  let manifest: string
  const config = { disabledSkills: ['文档'] }
  const text = `${JSON.stringify(config)}\n`

  beforeEach(() => {
    checkout = join(directory, 'rules')
    clone.worktree(checkout, 'rules-candidate')
    manifest = join(checkout, RULES_MANIFEST)
    mkdirSync(join(checkout, '.dsh-superagent'))
  })

  function commitFiles(...paths: string[]): string {
    if (paths.length) gitFor(checkout, 'add', '--', ...paths)
    gitFor(checkout, 'commit', '-qm', 'candidate rules')
    return gitFor(checkout, 'rev-parse', 'HEAD')
  }

  it('recovers the exact committed blob even when the worktree, index, HEAD and replacement refs have changed', async () => {
    const base = clone.base.sha
    writeFileSync(manifest, text)
    gitFor(checkout, 'add', '--', RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, base, 1024)).resolves.toEqual({ kind: 'unchanged' })

    const pinned = commitFiles(RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, pinned, Buffer.byteLength(text))).resolves.toEqual({ kind: 'changed', config })
    writeFileSync(manifest, '{"disabledSkills":[]}')
    const moved = commitFiles(RULES_MANIFEST)
    gitFor(checkout, 'replace', pinned, moved)
    writeFileSync(manifest, 'not JSON')
    gitFor(checkout, 'add', '--', RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, pinned, 1024)).resolves.toEqual({ kind: 'changed', config })
  })

  it('distinguishes unrelated changes from mixed changes, even inside the rules directory', async () => {
    const base = clone.base.sha
    writeFileSync(join(checkout, 'shared.txt'), 'unrelated change')
    const unrelated = commitFiles('shared.txt')
    await expect(inspectRulesChange(commands(), checkout, base, unrelated, 1024)).resolves.toEqual({ kind: 'unchanged' })

    writeFileSync(manifest, 'not JSON')
    writeFileSync(join(checkout, '.dsh-superagent', 'other source.ts'), 'export {}')
    const mixed = commitFiles(RULES_MANIFEST, '.dsh-superagent/other source.ts')
    await expect(inspectRulesChange(commands(), checkout, base, mixed, 1024)).resolves.toEqual({ kind: 'not-isolated' })
    await expect(inspectRulesChange(commands(), checkout, unrelated, mixed, 1024)).resolves.toEqual({ kind: 'not-isolated' })
  })

  it('rejects deletion and distinguishes a rules directory from an isolated file change', async () => {
    writeFileSync(manifest, text)
    const base = commitFiles(RULES_MANIFEST)
    gitFor(checkout, 'rm', '--', RULES_MANIFEST)
    const deleted = commitFiles()
    await expect(inspectRulesChange(commands(), checkout, base, deleted, 1024)).resolves.toEqual({ kind: 'invalid' })

    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, 'nested.json'), text)
    const directoryInstead = commitFiles(`${RULES_MANIFEST}/nested.json`)
    await expect(inspectRulesChange(commands(), checkout, base, directoryInstead, 1024)).resolves.toEqual({ kind: 'not-isolated' })
  })

  it('rejects symlink and gitlink entries without following or checking them out', async () => {
    const base = clone.base.sha
    writeFileSync(manifest, text)
    const blob = gitFor(checkout, 'hash-object', '-w', '--', RULES_MANIFEST)
    // Stage actual commit modes on Windows as well as POSIX, without requiring filesystem symlink privileges.
    for (const [mode, oid] of [['120000', blob], ['160000', base]]) {
      gitFor(checkout, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${RULES_MANIFEST}`)
      const candidate = commitFiles()
      await expect(inspectRulesChange(commands(), checkout, base, candidate, 1024)).resolves.toEqual({ kind: 'invalid' })
    }
  })

  it('rejects an oversized blob, malformed JSON, and malformed UTF-8', async () => {
    const base = clone.base.sha
    writeFileSync(manifest, text)
    const oversized = commitFiles(RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, oversized, Buffer.byteLength(text) - 1)).resolves.toEqual({ kind: 'invalid' })

    writeFileSync(manifest, '{"disabledSkills":[}')
    const malformed = commitFiles(RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, malformed, 1024)).resolves.toEqual({ kind: 'invalid' })

    writeFileSync(manifest, Buffer.from([0x22, 0xff, 0x22]))
    const invalidUtf8 = commitFiles(RULES_MANIFEST)
    await expect(inspectRulesChange(commands(), checkout, base, invalidUtf8, 1024)).resolves.toEqual({ kind: 'invalid' })
  })

  it('rejects refs, other object types, and missing commits with sanitized diagnostics', async () => {
    const base = clone.base.sha
    const tree = gitFor(checkout, 'rev-parse', `${base}^{tree}`)
    for (const candidate of ['HEAD', base.slice(0, 12), tree]) {
      await expect(inspectRulesChange(commands(), checkout, base, candidate, 1024)).rejects.toThrow('full commit object IDs')
    }
    await expect(inspectRulesChange(commands(), checkout, base, 'f'.repeat(base.length), 1024))
      .rejects.toThrow(/^Cannot read a rules commit object(?: \(Git exit \d+\))?$/)
  })
})
