/** Read-only Git inspection before a ticket worker is allowed to use a prepared or previously owned worktree. */
import type { Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExecutionClaim, ExecutionIdentity } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { CliError } from '../infra/commands.ts'

export type WorktreeBase = ExecutionIdentity['base']

/** Git identity plus the actual worker Session ID, to persist only after successful inspection. */
export interface WorktreeOwnership extends ExecutionIdentity {
  session: string
  preparation: { state: 'verified' }
}

export interface InspectedWorktree extends WorktreeOwnership { head: string }

/** `fresh` is only for a path observed absent before the prepare command ran; never use it for an existing directory. */
export type WorktreeInspection = {
  repository: string
  directory: string
  branch: string
  base: WorktreeBase
  ticket: string
  assignment: string
  session: string
} & ({ mode: 'fresh'; previous?: never } | { mode: 'reuse'; previous: ExecutionClaim | null | undefined })

export type WorktreeRejectionCode = 'invalid-target' | 'missing-worktree' | 'not-worktree' | 'wrong-repository'
  | 'wrong-branch' | 'wrong-base' | 'missing-ownership' | 'wrong-ownership'

/** A non-destructive refusal suitable for reporting directly as the ticket's preparation failure. */
export class WorktreeRejected extends Error {
  constructor(readonly code: WorktreeRejectionCode, message: string) { super(message); this.name = 'WorktreeRejected' }
}

const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const line = (value: string): string => value.replace(/\r?\n$/, '')
const description = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Resolve an absent candidate through the nearest existing ancestor, including junction/symlink parents. */
async function prospectivePath(path: string, role: string): Promise<{ path: string; ancestor: string }> {
  const absent: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const actual = await realpath(current)
      if (!(await stat(actual)).isDirectory()) throw new WorktreeRejected('invalid-target', `${role} ${path} crosses a non-directory.`)
      return { path: resolve(actual, ...absent.reverse()), ancestor: actual }
    } catch (error) {
      if (error instanceof WorktreeRejected) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(current) }
        catch (entryError) {
          if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new WorktreeRejected('invalid-target', `${role} ${path} cannot be inspected safely: ${description(entryError)}`)
          }
          const parent = dirname(current)
          if (parent !== current) {
            absent.push(basename(current))
            current = parent
            continue
          }
        }
      }
      throw new WorktreeRejected('invalid-target', `${role} ${path} cannot be resolved safely: ${description(error)}`)
    }
  }
}

/** A Git checkout may be above an existing target ancestor; even a damaged or unreadable marker forbids nesting. */
async function hasGitMarker(ancestor: string, directory: string): Promise<boolean> {
  let current = ancestor
  for (;;) {
    try { await lstat(resolve(current, '.git')); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorktreeRejected('invalid-target', `Ticket destination ${directory} cannot inspect Git metadata at ${current}: ${description(error)}`)
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

const within = (candidate: string, checkout: string): boolean => {
  const remainder = relative(checkout, candidate)
  return !remainder || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
}

async function canonical(directory: string, role: string, code: WorktreeRejectionCode): Promise<string> {
  try {
    const path = await realpath(directory)
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory')
    return path
  } catch (error) { throw new WorktreeRejected(code, `${role} ${directory} is unavailable: ${description(error)}`) }
}

async function gitPath(commands: Pick<Commands, 'git'>, cwd: string, option: '--git-dir' | '--git-common-dir', role: string): Promise<string> {
  let path: string
  try { path = line(await commands.git(['rev-parse', option], cwd)) }
  catch (error) { throw new WorktreeRejected('not-worktree', `${role} ${cwd} is not a Git worktree: ${description(error)}`) }
  if (!path) throw new WorktreeRejected('not-worktree', `${role} ${cwd} has no Git ${option.slice(2)}`)
  return canonical(resolve(cwd, path), `${role} Git ${option.slice(2)}`, 'not-worktree')
}

async function root(commands: Pick<Commands, 'git'>, cwd: string, role: string): Promise<string> {
  let path: string
  try { path = line(await commands.git(['rev-parse', '--show-toplevel'], cwd)) }
  catch (error) { throw new WorktreeRejected('not-worktree', `${role} ${cwd} has no Git working tree: ${description(error)}`) }
  return canonical(resolve(cwd, path), `${role} Git root`, 'not-worktree')
}
export interface InspectedRepository { repository: string; commonDir: string }

/** Resolve the configured main checkout before reserving a directory; this does not touch the ticket path. */
export async function inspectRepository(commands: Pick<Commands, 'git'>, repository: string): Promise<InspectedRepository> {
  if (!isAbsolute(repository)) throw new WorktreeRejected('invalid-target', `Configured repository path ${repository} must be absolute.`)
  const main = await canonical(repository, 'Configured repository', 'wrong-repository')
  const [mainRoot, mainGit, commonDir] = await Promise.all([
    root(commands, main, 'Configured repository'), gitPath(commands, main, '--git-dir', 'Configured repository'),
    gitPath(commands, main, '--git-common-dir', 'Configured repository'),
  ])
  if (!samePath(mainRoot, main) || !samePath(mainGit, commonDir)) {
    throw new WorktreeRejected('wrong-repository', `Configured repository ${repository} must name its main Git worktree, not a subdirectory or another linked worktree.`)
  }
  return { repository: main, commonDir }
}

/** Git's -z porcelain format has NUL-terminated attributes and an empty attribute between records. */
function listedWorktrees(output: string): { path: string; head?: string; branch?: string }[] {
  return output.split('\0\0').flatMap(record => {
    const attrs = record.split('\0')
    const first = attrs[0]
    if (!first?.startsWith('worktree ')) return []
    return [{ path: first.slice('worktree '.length),
      head: attrs.find(attr => attr.startsWith('HEAD '))?.slice('HEAD '.length),
      branch: attrs.find(attr => attr.startsWith('branch '))?.slice('branch '.length) }]
  })
}

/** Refuse a new worktree within the primary checkout or any of its registered linked worktrees; never create a path. */
export async function validateWorktreeDestination(commands: Pick<Commands, 'git'>, repository: string, directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new WorktreeRejected('invalid-target', `Ticket destination ${directory} must be absolute.`)
  const { repository: main } = await inspectRepository(commands, repository)
  const [target, configuredRoot, listed] = await Promise.all([
    prospectivePath(directory, 'Ticket destination'), prospectivePath(dirname(directory), 'Configured worktree root'),
    commands.git(['worktree', 'list', '--porcelain', '-z'], main),
  ])
  const checkouts = [main, ...await Promise.all(listedWorktrees(listed).map(async item => (await prospectivePath(
    isAbsolute(item.path) ? item.path : resolve(main, item.path), 'Registered worktree')).path))]
  for (const candidate of [target, configuredRoot]) {
    if (checkouts.some(checkout => within(candidate.path, checkout))) {
      throw new WorktreeRejected('invalid-target', `Ticket destination ${directory} is inside the primary checkout or a registered worktree of ${repository}; refusing to prepare it.`)
    }
    // Git reports ordinary non-repositories differently across runtimes; probe actual metadata, not Git's error text.
    if (await hasGitMarker(candidate.ancestor, directory)) {
      throw new WorktreeRejected('invalid-target', `Ticket destination ${directory} is inside another Git checkout or has damaged Git metadata; refusing to prepare it.`)
    }
  }
}

function owned(previous: ExecutionClaim | null | undefined, input: WorktreeInspection, repository: string, commonDir: string, worktree: string): void {
  if (!previous || previous.verified !== true || !previous.repository || !previous.commonDir
      || !previous.worktree || !previous.base?.ref || !previous.base.sha) {
    throw new WorktreeRejected('missing-ownership', `Existing worktree ${worktree} has no previously verified ticket ownership; refusing to reuse it.`)
  }
  if (previous.ticket !== input.ticket || previous.assignment !== input.assignment
      || !samePath(previous.repository, repository) || !samePath(previous.commonDir, commonDir)
      || !samePath(previous.worktree, worktree) || previous.branch !== input.branch
      || previous.base.ref !== input.base.ref || previous.base.sha.toLowerCase() !== input.base.sha.toLowerCase()) {
    throw new WorktreeRejected('wrong-ownership', `Existing worktree ${worktree} is not claimed by this ticket and assignment for this repository, branch and pinned base; refusing to reuse it.`)
  }
}

/**
 * Inspect, but never create, repair, remove or change, a ticket worktree. The caller must reserve its directory/claim before
 * preparing, pass `fresh` only after creating a previously absent path, and pass persisted successful ownership for retries.
 * This verifies identity, not the worker's idle status: the caller must release a prior writer only once it has stopped.
 * Git is run through Commands so the installed worker Git environment and abort signal apply.
 */
export async function inspectWorktree(commands: Pick<Commands, 'git'>, input: WorktreeInspection): Promise<InspectedWorktree> {
  const { repository, directory, branch, base, session } = input
  if (!isAbsolute(repository) || !isAbsolute(directory) || !branch || branch.startsWith('refs/') || !base?.ref
      || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(base?.sha ?? '') || !input.ticket || !input.assignment || !session) {
    throw new WorktreeRejected('invalid-target', 'Worktree inspection requires absolute repository and ticket paths, a branch, pinned full base SHA, base ref, ticket, assignment and worker session ID.')
  }
  if (input.mode === 'reuse' && (!input.previous || input.previous.verified !== true)) {
    throw new WorktreeRejected('missing-ownership', `Existing directory ${directory} has no completed, verified ticket ownership; refusing to reuse it.`)
  }
  let entry: Stats
  try { entry = await lstat(directory) }
  catch (error) { throw new WorktreeRejected('missing-worktree', `Ticket directory ${directory} does not exist: ${description(error)}`) }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new WorktreeRejected('not-worktree', `Ticket directory ${directory} is not a real directory; refusing to follow a symlink or use a file.`)
  }
  const [{ repository: main, commonDir }, worktree] = await Promise.all([
    inspectRepository(commands, repository), canonical(directory, 'Ticket directory', 'not-worktree'),
  ])
  const [workRoot, workGit, workCommon] = await Promise.all([
    root(commands, worktree, 'Ticket directory'), gitPath(commands, worktree, '--git-dir', 'Ticket directory'),
    gitPath(commands, worktree, '--git-common-dir', 'Ticket directory'),
  ])
  if (!samePath(workRoot, worktree) || samePath(workGit, workCommon)) {
    throw new WorktreeRejected('not-worktree', `Ticket directory ${directory} is not the root of a secondary Git worktree; ordinary folders and primary checkouts cannot be reused.`)
  }
  if (!samePath(workCommon, commonDir)) {
    throw new WorktreeRejected('wrong-repository', `Ticket directory ${directory} is attached to another repository, not ${repository}.`)
  }
  if (input.mode === 'reuse') owned(input.previous, input, main, commonDir, worktree)

  const list = listedWorktrees(await commands.git(['worktree', 'list', '--porcelain', '-z'], main))
  const matches = await Promise.all(list.map(async item => {
    const path = isAbsolute(item.path) ? item.path : resolve(main, item.path)
    const actual = await realpath(path).catch(() => path)
    return samePath(actual, worktree) ? item : undefined
  }))
  const listed = matches.find(item => !!item)
  if (!listed) {
    throw new WorktreeRejected('not-worktree', `Ticket directory ${directory} is not registered as a secondary worktree of ${repository}.`)
  }
  const expectedBranch = `refs/heads/${branch}`
  const [actualBranch, head] = await Promise.all([
    commands.git(['symbolic-ref', '--quiet', 'HEAD'], worktree).then(line, (error: unknown) => {
      if (error instanceof CliError && error.exitCode === 1) return '(detached HEAD)'
      throw error
    }),
    commands.git(['rev-parse', '--verify', 'HEAD^{commit}'], worktree).then(line),
  ])
  if (actualBranch !== expectedBranch || listed.branch !== expectedBranch) {
    throw new WorktreeRejected('wrong-branch', `Ticket worktree ${directory} is on ${actualBranch}, expected ${expectedBranch}; refusing to use another ticket's branch.`)
  }
  if (listed.head !== head) {
    throw new WorktreeRejected('not-worktree', `Ticket worktree ${directory} changed HEAD while it was inspected; retry only after the other writer stops.`)
  }
  const sha = base.sha.toLowerCase()
  if (input.mode === 'fresh' && head.toLowerCase() !== sha) {
    throw new WorktreeRejected('wrong-base', `Ticket worktree ${directory} starts at ${head}, not the pinned ${base.ref} base ${sha}.`)
  }
  if (input.mode === 'reuse' && head.toLowerCase() !== sha) {
    try { await commands.git(['merge-base', '--is-ancestor', sha, head], worktree) }
    catch (error) {
      if (error instanceof CliError && error.exitCode === 1) {
        throw new WorktreeRejected('wrong-base', `Ticket worktree ${directory} no longer descends from its pinned ${base.ref} base ${sha}.`)
      }
      throw error
    }
  }
  return { repository: main, commonDir, worktree, branch, base: { ref: base.ref, sha }, session,
    preparation: { state: 'verified' }, head }
}
