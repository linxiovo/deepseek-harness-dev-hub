/** Compare and advance one exact GitHub branch without using the primary checkout's refs or Git transport settings. */
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import { CliError, type Commands } from '../infra/commands.ts'
import { credentialHelper, sameDirectory } from '../infra/environment.ts'
import { validateRepositoryIdentity } from './repository-identity.ts'
import { inspectDocuments, type DocTreeScope } from './doc-tree.ts'
import { WorktreeRejected } from './worktree.ts'

/** A configured clone, the deployment's GitHub owner/name, and a full refs/heads/... name. */
export type MainlineTarget = { repository: string; slug: string; ref: string }

const observed = 'refs/dsh/mainline/observed'
const commitId = /^[0-9a-f]{40}$/i
const outputLine = (value: string): string => value.replace(/\r?\n$/, '')

async function git(commands: Pick<Commands, 'git'>, cwd: string, label: string, args: string[]): Promise<string> {
  try { return await commands.git(args, cwd) }
  catch (error) {
    throw gitFailure(label, error)
  }
}

function gitFailure(label: string, error: unknown): Error {
  // Never surface external stderr/argv. A helper, Git, or the remote can emit sensitive diagnostics.
  if (error instanceof Error && error.name === 'AbortError') return new DOMException('The operation was aborted', 'AbortError')
  const exit = error instanceof CliError ? error.exitCode : undefined
  return new CliError(`Cannot ${label}${exit === undefined ? '' : ` (Git exit ${exit})`}`, undefined, exit)
}

interface Scratch {
  git(label: string, args: string[]): Promise<string>
  url: string
  transport: string[]
}

async function inScratch<T>(commands: Commands, target: MainlineTarget, act: (scratch: Scratch) => Promise<T>): Promise<T> {
  const { repository: slug, github } = commands.deployment
  if (slug.toLowerCase() !== target.slug.toLowerCase() || !/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(slug) || /\/\.{1,2}$/.test(slug)) {
    throw new WorktreeRejected('wrong-repository', 'Mainline target must match the configured GitHub repository.')
  }
  if (!isAbsolute(target.repository)) throw new WorktreeRejected('wrong-repository', 'Mainline target requires an absolute checkout path.')
  if (!target.ref.startsWith('refs/heads/') || target.ref.length === 'refs/heads/'.length) throw new Error('Mainline target must be a full refs/heads/... branch.')

  const directory = await mkdtemp(join(tmpdir(), 'dsh-mainline-'))
  try {
    await writeFile(join(directory, 'global.config'), '')
    const isolated = commands.withIsolatedGit({
      GIT_CONFIG_GLOBAL: join(directory, 'global.config'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      HOME: directory,
    })
    const inspect = (label: string, args: string[]): Promise<string> => git(isolated, target.repository, label, args)
    await validateRepositoryIdentity({ git: (args, cwd) => git(isolated, cwd, 'inspect repository origin', args) }, target.repository, slug)
    const root = outputLine(await inspect('identify the mainline checkout', ['rev-parse', '--show-toplevel']))
    if (!sameDirectory(root, target.repository)) throw new WorktreeRejected('wrong-repository', 'Mainline target must be the checkout root.')
    const format = outputLine(await inspect('identify the repository object format', ['rev-parse', '--show-object-format']))
    if (format !== 'sha1') throw new Error('Mainline requires a GitHub SHA-1 object database.')
    const objects = outputLine(await inspect('locate the mainline object database', ['rev-parse', '--path-format=absolute', '--git-path', 'objects']))
    if (!isAbsolute(objects)) throw new Error('Mainline object database must have an absolute path.')
    if (outputLine(await inspect('inspect repository history completeness', ['rev-parse', '--is-shallow-repository'])) !== 'false') {
      throw new Error('Cannot prove mainline ancestry in a shallow repository.')
    }
    const grafts = outputLine(await inspect('locate repository graft settings', ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']))
    try {
      await access(grafts)
      throw new Error('Cannot prove mainline ancestry when repository grafts are configured.')
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot prove')) throw error
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }

    // Copy neither config nor refs. Only objects are shared: fetch stores the observed commit in the clone,
    // while its temporary ref, config, HEAD, and any shallow state remain isolated from the checkout.
    await git(isolated, directory, 'initialize isolated mainline Git', ['init', '--bare', '--template=', '--object-format=sha1'])
    const scratch = isolated.withIsolatedGit({ GIT_OBJECT_DIRECTORY: objects })
    const run = (label: string, args: string[]): Promise<string> => git(scratch, directory, label, args)
    await run('validate the mainline branch', ['check-ref-format', target.ref])
    // Keep Git's HOME empty (including .netrc). Only the configured gh helper gets the original HOME.
    const helper = `!if test "\${DSH_MAINLINE_GH_HOME+x}"; then HOME="$DSH_MAINLINE_GH_HOME"; export HOME; else unset HOME; fi; ${credentialHelper(github.cli).slice(1)}`
    return await act({ git: run, url: `https://github.com/${slug}.git`, transport: [
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
      '-c', `credential.https://github.com.helper=${helper}`,
    ] })
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

export const RULES_MANIFEST = '.dsh-superagent/rules.json'

type RulesChange = { kind: 'unchanged' } | { kind: 'not-isolated' } | { kind: 'invalid' } | { kind: 'changed'; config: unknown }

/** Inspect only the immutable Git trees named by base and candidate, never files or filters from the checkout. */
export async function inspectRulesChange(commands: Pick<Commands, 'git'>, directory: string, base: string, candidate: string,
  maxBytes: number): Promise<RulesChange> {
  const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
  if (!fullOid.test(base) || !fullOid.test(candidate)) throw new Error('Rules inspection requires full commit object IDs.')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Rules inspection requires a non-negative byte limit.')
  let options = ['--no-pager', '--no-replace-objects', '--no-lazy-fetch']
  const run = (label: string, ...args: string[]): Promise<string> => git(commands, directory, label, [...options, ...args])
  const readFormat = ['rev-parse', '--show-object-format']
  let format: string
  try { format = outputLine(await commands.git([...options, ...readFormat], directory)) }
  catch (error) {
    if (!(error instanceof CliError) || ![1, 129].includes(error.exitCode ?? 0) || !error.message.startsWith('unknown option: --no-lazy-fetch')) {
      throw gitFailure('identify the rules repository object format', error)
    }
    // Older supported Git cannot disable lazy fetch. Reject promisor configuration before reading any objects.
    options = options.filter(option => option !== '--no-lazy-fetch')
    try {
      await run('inspect Git promisor configuration', 'config', '--includes', '--name-only', '--get-regexp',
        '^(extensions[.]partialclone|remote[.].*[.](promisor|partialclonefilter))$')
      throw new Error('Rules inspection requires a complete clone on this Git version.')
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode !== 1) throw error
    }
    format = outputLine(await run('identify the rules repository object format', ...readFormat))
  }
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unexpected Git object format for rules inspection.')
  const oidLength = format === 'sha1' ? 40 : 64
  base = base.toLowerCase()
  candidate = candidate.toLowerCase()
  for (const id of new Set([base, candidate])) {
    if (id.length !== oidLength || outputLine(await run('read a rules commit object', 'cat-file', '-t', id)) !== 'commit') {
      throw new Error('Rules inspection requires full commit object IDs.')
    }
  }

  const parent = posix.dirname(RULES_MANIFEST)
  const name = posix.basename(RULES_MANIFEST)
  const entry = async (treeish: string, path: string): Promise<{ mode: string; oid: string } | undefined> => {
    const output = await run('read a rules tree entry', '--literal-pathspecs', 'ls-tree', '--full-tree', '-z', `--abbrev=${oidLength}`, treeish, '--', path)
    if (!output) return undefined
    const match = /^([0-7]{6}) (?:blob|tree|commit) ([0-9a-f]+)\t/.exec(output)
    if (!match || match[2]!.length !== oidLength || output.slice(match[0].length) !== `${path}\0`) {
      throw new Error('Unexpected Git tree entry for rules inspection.')
    }
    return { mode: match[1]!, oid: match[2]! }
  }
  const beforeDir = await entry(base, parent)
  const afterDir = base === candidate ? beforeDir : await entry(candidate, parent)
  if (beforeDir?.mode === afterDir?.mode && beforeDir?.oid === afterDir?.oid) return { kind: 'unchanged' }
  const beforeTree = beforeDir?.mode === '040000' ? beforeDir.oid : undefined
  const afterTree = afterDir?.mode === '040000' ? afterDir.oid : undefined
  const before = beforeTree ? await entry(beforeTree, name) : undefined
  const after = afterTree ? await entry(afterTree, name) : undefined
  if (before?.mode === after?.mode && before?.oid === after?.oid) return { kind: 'unchanged' }

  // Compare one level at a time: any changed sibling tree counts, including an empty tree.
  // No path filter can hide a sibling, and Git's capture limit rejects oversized output rather than truncating it.
  if ((beforeDir && !beforeTree) || (afterDir && !afterTree)) return { kind: 'not-isolated' }
  const emptyTree = createHash(format).update('tree 0\0').digest('hex')
  const diffPaths = (left: string, right: string): Promise<string> => run('compare rule snapshots', 'diff-tree',
    '--no-commit-id', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
    '--no-relative', '-O/dev/null', left, right, '--')
  for (const [left, right, allowed] of [[base, candidate, parent], [beforeTree ?? emptyTree, afterTree ?? emptyTree, name]] as const) {
    const paths = await diffPaths(left, right)
    if (!paths || !paths.endsWith('\0')) throw new Error('Unexpected Git path output for rules inspection.')
    const record = `${allowed}\0`
    if (paths !== record && paths !== record + record) return { kind: 'not-isolated' }
  }
  if (before?.mode === '040000' || after?.mode === '040000') {
    const nested = await diffPaths(before?.mode === '040000' ? before.oid : emptyTree, after?.mode === '040000' ? after.oid : emptyTree)
    if (nested && !nested.endsWith('\0')) throw new Error('Unexpected Git path output for rules inspection.')
    if (nested) return { kind: 'not-isolated' }
  }
  if (after?.mode !== '100644' && after?.mode !== '100755') return { kind: 'invalid' }

  if (outputLine(await run('read the rules object type', 'cat-file', '-t', after.oid)) !== 'blob') {
    throw new Error('Unexpected Git object type for candidate rules.')
  }
  const sizeOutput = outputLine(await run('read the rules blob size', 'cat-file', '-s', after.oid))
  if (!/^[0-9]+$/.test(sizeOutput)) throw new Error('Unexpected Git blob size for candidate rules.')
  const size = Number(sizeOutput)
  if (size > maxBytes) return { kind: 'invalid' }
  const text = await run('read the rules blob', 'cat-file', 'blob', after.oid)
  const decodedSize = Buffer.byteLength(text, 'utf8')
  if (decodedSize < size) throw new Error('Incomplete Git blob output for candidate rules.')
  // Commands decodes UTF-8 lossily. Distinguish invalid input from a genuine replacement character.
  if (text.includes('\uFFFD') && createHash(format).update(`blob ${size}\0`).update(text).digest('hex') !== after.oid) return { kind: 'invalid' }
  if (decodedSize !== size) throw new Error('Incomplete Git blob output for candidate rules.')
  try { return { kind: 'changed', config: JSON.parse(text) as unknown } }
  catch { return { kind: 'invalid' } }
}

async function requireCommit(scratch: Scratch, id: string): Promise<void> {
  if (!commitId.test(id) || outputLine(await scratch.git('read a mainline commit object', ['cat-file', '-t', id])) !== 'commit') {
    throw new Error('Mainline requires full commit object IDs.')
  }
}

async function contains(scratch: Scratch, ancestor: string, descendant: string): Promise<boolean> {
  await requireCommit(scratch, ancestor)
  await requireCommit(scratch, descendant)
  try {
    await scratch.git('prove mainline ancestry', ['-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 1) return false
    throw error
  }
}

async function fetchMainline(scratch: Scratch, target: MainlineTarget): Promise<string> {
  await scratch.git('fetch the authoritative mainline branch', [...scratch.transport, 'fetch', '--no-tags', '--no-recurse-submodules',
    '--no-auto-maintenance', '--no-write-fetch-head', '--', scratch.url, `${target.ref}:${observed}`])
  const id = outputLine(await scratch.git('resolve the fetched mainline branch', ['rev-parse', '--verify', observed]))
  await requireCommit(scratch, id)
  return id
}

/** Fetch the configured GitHub branch into an isolated ref and shared object database; return its full commit ID. */
export function readMainline(commands: Commands, target: MainlineTarget): Promise<string> {
  return inScratch(commands, target, scratch => fetchMainline(scratch, target))
}

/** Sample the authoritative target and prove every formal integration against that same commit. */
export function readPlanIntegrationTarget(commands: Commands, target: MainlineTarget, integrations: readonly string[]):
Promise<{ sha: string; includesIntegrations: boolean }> {
  return inScratch(commands, target, async scratch => {
    const sha = await fetchMainline(scratch, target)
    for (const integration of integrations) {
      if (!await contains(scratch, integration, sha)) return { sha, includesIntegrations: false }
    }
    return { sha, includesIntegrations: true }
  })
}

/** Prove commit ancestry from complete local objects; false means a proven non-ancestor, while every Git error rejects. */
export function precedes(commands: Commands, target: MainlineTarget, ancestor: string, descendant: string): Promise<boolean> {
  return inScratch(commands, target, scratch => contains(scratch, ancestor, descendant))
}

export type DeliveryTargetResult = 'passed' | 'mainline_verification' | 'mainline_docs' | 'mainline_candidate_changed'

/** Verify that a later target still contains the reviewed change and its scoped Doc Tree. */
export function verifyDeliveryOnTarget(commands: Commands, target: MainlineTarget, base: string, integration: string, actual: string,
  scope: DocTreeScope): Promise<DeliveryTargetResult> {
  return inScratch(commands, target, async scratch => {
    if (!await contains(scratch, integration, actual)) return 'mainline_verification'
    const paths = ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']
    const afterIntegration = await scratch.git('compare delivered and observed trees', [...paths, integration, actual, '--'])
    if (!afterIntegration) return 'passed'
    const changed = new Set(afterIntegration.split('\0'))
    if ((scope.root !== null && changed.has(scope.root)) || scope.routes.some(path => changed.has(path)) ||
        scope.leaves.some(path => changed.has(path)) || scope.documents?.some(path => changed.has(path))) return 'mainline_docs'
    const issues = await inspectDocuments((...args) => scratch.git('check delivered Doc Tree links', ['--literal-pathspecs', ...args]), actual, scope, changed)
    if (issues.length) return 'mainline_docs'
    const duringIntegration = await scratch.git('identify reviewed changes', [...paths, base, integration, '--'])
    return duringIntegration.split('\0').some(path => path && changed.has(path)) ? 'mainline_candidate_changed' : 'passed'
  })
}

/** Create a reproducible intent-specific commit with the exact reviewed tree and candidate as its only parent. */
export function prepareMainline(commands: Commands, target: MainlineTarget, candidate: string, intent: string, queuedAt: string): Promise<string> {
  const dated = commands.withIsolatedGit({ GIT_AUTHOR_DATE: queuedAt, GIT_COMMITTER_DATE: queuedAt })
  return inScratch(dated, target, async scratch => {
    await requireCommit(scratch, candidate)
    return outputLine(await scratch.git('create the queue integration commit', ['-c', 'user.name=dsh-superagent',
      '-c', 'user.email=dsh-superagent@users.noreply.github.com', '-c', 'commit.gpgSign=false',
      'commit-tree', `${candidate}^{tree}`, '-p', candidate, '-m', `Mainline queue intent ${intent}`]))
  })
}

/** Make one exact-lease fast-forward push after the final authorization; never retry here. */
export function advanceMainline(commands: Commands, target: MainlineTarget, base: string, candidate: string,
  authorize?: () => void | Promise<void>): Promise<'advanced' | 'unchanged'> {
  return inScratch(commands, target, async scratch => {
    if (base.toLowerCase() === candidate.toLowerCase() || !await contains(scratch, base, candidate)) {
      throw new Error('Mainline candidate must strictly descend from the expected base.')
    }
    const args = [...scratch.transport, 'push', '--porcelain', `--force-with-lease=${target.ref}:${base}`,
      '--', scratch.url, `${candidate}:${target.ref}`]
    await authorize?.()
    const result = await scratch.git('advance mainline with the expected base; re-read its tip before retrying', args)
    // Git's up-to-date response skips its lease check. Do not report a CAS in that case.
    const updates = result.split(/\r?\n/).filter(line => line.includes('\t')).map(line => line.split('\t'))
    if (updates.length === 1 && updates[0]?.[0] === '=' && updates[0][1] === `${candidate}:${target.ref}`) return 'unchanged'
    if (updates.length !== 1 || updates[0]?.length !== 3 || updates[0][0] !== ' '
      || updates[0][1]?.startsWith(`${candidate}:`) !== true || updates[0][1]?.split(':').at(-1) !== target.ref) {
      throw new Error('Git did not report a mainline fast-forward; re-read its tip before retrying.')
    }
    return 'advanced'
  })
}
