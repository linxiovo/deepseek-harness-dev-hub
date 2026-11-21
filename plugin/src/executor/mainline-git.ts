/** Compare and advance one exact GitHub branch without using the primary checkout's refs or Git transport settings. */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CliError, type Commands } from '../infra/commands.ts'
import { credentialHelper, sameDirectory } from '../infra/environment.ts'
import { validateRepositoryIdentity } from './repository-identity.ts'
import { WorktreeRejected } from './worktree.ts'

/** A configured clone, the deployment's GitHub owner/name, and a full refs/heads/... name. */
export type MainlineTarget = { repository: string; slug: string; ref: string }

const observed = 'refs/dsh/mainline/observed'
const commitId = /^[0-9a-f]{40}$/i
const outputLine = (value: string): string => value.replace(/\r?\n$/, '')

async function git(commands: Commands, cwd: string, label: string, args: string[]): Promise<string> {
  try { return await commands.git(args, cwd) }
  catch (error) {
    // Never surface external stderr/argv. A helper, Git, or the remote can emit sensitive diagnostics.
    if (error instanceof Error && error.name === 'AbortError') throw new DOMException('The operation was aborted', 'AbortError')
    const exit = error instanceof CliError ? error.exitCode : undefined
    throw new CliError(`Cannot ${label}${exit === undefined ? '' : ` (Git exit ${exit})`}`, undefined, exit)
  }
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

/** Fetch the configured GitHub branch into an isolated ref and shared object database; return its full commit ID. */
export function readMainline(commands: Commands, target: MainlineTarget): Promise<string> {
  return inScratch(commands, target, async scratch => {
    await scratch.git('fetch the authoritative mainline branch', [...scratch.transport, 'fetch', '--no-tags', '--no-recurse-submodules',
      '--no-auto-maintenance', '--no-write-fetch-head', '--', scratch.url, `${target.ref}:${observed}`])
    const id = outputLine(await scratch.git('resolve the fetched mainline branch', ['rev-parse', '--verify', observed]))
    await requireCommit(scratch, id)
    return id
  })
}

/** Prove commit ancestry from complete local objects; false means a proven non-ancestor, while every Git error rejects. */
export function precedes(commands: Commands, target: MainlineTarget, ancestor: string, descendant: string): Promise<boolean> {
  return inScratch(commands, target, scratch => contains(scratch, ancestor, descendant))
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
