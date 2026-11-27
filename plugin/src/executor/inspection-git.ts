import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { ProjectRef } from '../core/handoff.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { physicalPath } from '../infra/paths.ts'
import { validateRepositoryIdentity } from './repository-identity.ts'

const maxObjectBytes = 1024 * 1024
const textPageSize = 8_000
const directoryPageSize = 100
const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const unsafeSegment = /^(?:\.git$|git~[0-9]+$|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?: *\.|$))/i

export type InspectionPage = { kind: 'file'; path: string; text: string; nextOffset: number | null }
  | { kind: 'directory'; path: string; entries: string[]; nextOffset: number | null }

type InspectionCheckout = Pick<ProjectRef, 'workspace' | 'repository'>

/** Accept exact, portable repository-relative paths, not filesystem aliases or pathspec syntax. */
export function validInspectionPath(path: string): boolean {
  return !/[\\:<>"|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(path) && path.split('/').every(segment =>
    segment.length > 0 && !/[. ]$/.test(segment) && !unsafeSegment.test(segment))
}

async function rejectMetadata(path: string, message: string): Promise<void> {
  try { await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Cannot verify the inspection checkout metadata.')
  }
  throw new Error(message)
}

async function checkoutGit(commands: Commands, { workspace, repository }: InspectionCheckout) {
  const gitDir = join(workspace, '.git')
  const objects = join(gitDir, 'objects')
  const info = join(objects, 'info')
  const pack = join(objects, 'pack')
  // Pin Git discovery to the registered physical primary checkout, not a symlink, gitfile, or parent repo.
  try {
    if (!isAbsolute(workspace) || relative(workspace, await physicalPath(workspace)) !== ''
      || !(await lstat(gitDir)).isDirectory() || !(await lstat(objects)).isDirectory()) throw new Error()
    for (const directory of [info, pack]) {
      const stat = await lstat(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      if (stat && !stat.isDirectory()) throw new Error()
    }
  } catch { throw new Error('Inspection requires the physical root of a primary Git checkout.') }
  await rejectMetadata(join(gitDir, 'commondir'), 'Inspection requires an independent primary Git checkout.')
  await rejectMetadata(join(info, 'alternates'), 'Inspection cannot read a checkout with an alternate object store.')

  const isolated = commands.withIsolatedGit({
    LC_ALL: 'C', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_NAMESPACE: undefined, GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
  })
  const options = [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, '--no-pager', '--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never']
  let lazyFetchOption = ['--no-lazy-fetch']
  // On Windows an executable in the spawn cwd can shadow Git from PATH.
  const cwd = dirname(process.execPath)
  const invoke = (...args: string[]): Promise<string> => isolated.git([...lazyFetchOption, ...options, ...args], cwd)
  const git = async (action: string, ...args: string[]): Promise<string> => {
    try { return await invoke(...args) }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const exit = error instanceof CliError ? error.exitCode : undefined
      throw new CliError(`Cannot ${action} for inspection${exit === undefined ? '.' : ` (Git exit ${exit}).`}`, undefined, exit)
    }
  }
  const identify = ['rev-parse', '--show-object-format', '--show-toplevel']
  let output: string
  try { output = await invoke(...identify) }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (!(error instanceof CliError) || ![1, 129].includes(error.exitCode ?? 0) || !error.message.startsWith('unknown option: --no-lazy-fetch')) {
      throw new Error('Cannot identify the physical inspection checkout.')
    }
    // Older Git cannot turn off lazy fetch; refuse promisor repositories before looking up an object.
    lazyFetchOption = []
    try {
      await git('check promisor configuration', 'config', '--includes', '--name-only', '--get-regexp',
        '^(extensions[.]partialclone|remote[.].*[.](promisor|partialclonefilter))$')
      throw new Error('Inspection requires local Git objects; this Git version cannot disable lazy fetching.')
    } catch (failure) {
      if (!(failure instanceof CliError) || failure.exitCode !== 1) throw failure
    }
    output = await git('identify the physical checkout', ...identify)
  }
  const [format, top, extra] = output.replace(/\r?\n$/, '').split(/\r?\n/)
  if ((format !== 'sha1' && format !== 'sha256') || !top || extra !== undefined || !isAbsolute(top) || relative(workspace, top) !== '') {
    throw new Error('Git does not identify the authorized inspection checkout.')
  }
  await validateRepositoryIdentity({ git: args => git('verify the project origin', ...args) }, workspace, repository)
  return { git, format, oidLength: format === 'sha1' ? 40 : 64 }
}

/** Pin the configured base and verify the scoped object exists without loading its contents. */
export async function inspectionCommit(commands: Commands, checkout: InspectionCheckout, baseRef: string, scope: string): Promise<string> {
  if (!baseRef || baseRef.startsWith('-') || /[\s\p{Cc}]/u.test(baseRef) || baseRef.includes(':')) {
    throw new Error('Invalid inspection base reference.')
  }
  if (!validInspectionPath(scope)) throw new Error('Invalid inspection scope.')
  const { git, oidLength } = await checkoutGit(commands, checkout)
  const oid = (await git('resolve the base reference', 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)).trim()
  if (oid.length !== oidLength || !fullOid.test(oid)) throw new Error('Git did not return an inspection commit ID.')
  await inspectionObject(git, oidLength, oid, scope)
  return oid
}

const treeRecord = /([0-7]{6}) (blob|tree|commit) ([a-f0-9]+)\t([^\0]*)\0/y

function readTreeRecord(output: string, start: number, oidLength: number) {
  treeRecord.lastIndex = start
  const match = treeRecord.exec(output)
  if (!match || match[3]!.length !== oidLength || !match[4]) throw new Error('Invalid Git tree output for inspection.')
  return { mode: match[1]!, type: match[2]!, oid: match[3]!, name: match[4], end: treeRecord.lastIndex }
}

async function inspectionObject(git: (action: string, ...args: string[]) => Promise<string>, oidLength: number, commit: string, path: string) {
  const matched = await git('find the scoped path', 'ls-tree', '--full-tree', '-z', `--abbrev=${oidLength}`, commit, '--', path)
  if (!matched) throw new Error('Inspection path not found in the pinned commit.')
  const { mode, type, oid, name, end } = readTreeRecord(matched, 0, oidLength)
  if (end !== matched.length || name !== path) throw new Error('Git did not return the exact inspection path.')
  if (!(mode === '040000' && type === 'tree') && !((mode === '100644' || mode === '100755') && type === 'blob')) {
    throw new Error('Inspection path is not a regular file or directory.')
  }
  if ((await git('check the scoped object type', 'cat-file', '-t', oid)).trim() !== type) throw new Error('Invalid inspection object type.')
  return { oid, type }
}

/** Read one bounded page of an authorized object without consulting the worktree or following links. */
export async function readInspectionPath(commands: Commands, checkout: InspectionCheckout, commit: string, scope: string,
  path: string, offset: number): Promise<InspectionPage> {
  if (!validInspectionPath(scope)) throw new Error('Invalid inspection scope.')
  if (!validInspectionPath(path)) throw new Error('Invalid inspection path.')
  if (path !== scope && !path.startsWith(`${scope}/`)) throw new Error('Path is outside the authorized inspection scope.')
  if (!fullOid.test(commit)) throw new Error('Inspection requires a full commit ID.')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid inspection offset.')

  const { git, format, oidLength } = await checkoutGit(commands, checkout)
  if (commit.length !== oidLength || (await git('read the pinned commit type', 'cat-file', '-t', commit)).trim() !== 'commit') {
    throw new Error('Inspection requires a pinned Git commit.')
  }
  const { oid, type } = await inspectionObject(git, oidLength, commit, path)
  const directory = type === 'tree'
  const printedSize = (await git('measure the scoped object', 'cat-file', '-s', oid)).trim()
  if (!/^\d+$/.test(printedSize)) throw new Error('Git did not return the inspection object size.')
  const size = Number(printedSize)
  if (size > maxObjectBytes) throw new Error('Inspection object is too large to read.')

  if (directory) {
    const output = await git('list the scoped directory', 'ls-tree', '--full-tree', '-z', `--abbrev=${oidLength}`, oid)
    const entries: string[] = []
    let index = 0, count = 0, bytes = 0
    while (index < output.length) {
      const entry = readTreeRecord(output, index, oidLength)
      if (entry.name.includes('/') || entry.name.includes('\uFFFD') || !validInspectionPath(entry.name)) {
        throw new Error('Inspection directory contains an unreadable path.')
      }
      bytes += (entry.mode === '040000' ? 5 : 6) + 2 + Buffer.byteLength(entry.name) + oidLength / 2
      if (count >= offset && entries.length < directoryPageSize) entries.push(`${path}/${entry.name}`)
      count++
      index = entry.end
    }
    if (bytes !== size) throw new Error('Incomplete Git directory output for inspection.')
    if (offset > count) throw new Error('Inspection offset is outside the directory.')
    return { kind: 'directory', path, entries, nextOffset: offset + entries.length < count ? offset + entries.length : null }
  }

  const text = await git('read the scoped blob', 'cat-file', 'blob', oid)
  // Commands decodes UTF-8 lossily; a real replacement character round-trips to the same object ID.
  if (text.includes('\uFFFD') && createHash(format).update(`blob ${size}\0`).update(text).digest('hex') !== oid) {
    throw new Error('Inspection blob is not valid UTF-8 text.')
  }
  if (Buffer.byteLength(text) !== size) throw new Error('Incomplete Git blob output for inspection.')
  if (/[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('Inspection blob is binary, not text.')
  if (offset > text.length || /[\uDC00-\uDFFF]/.test(text.charAt(offset))) throw new Error('Invalid inspection text offset.')
  let next = Math.min(offset + textPageSize, text.length)
  if (/[\uDC00-\uDFFF]/.test(text.charAt(next))) next--
  return { kind: 'file', path, text: text.slice(offset, next), nextOffset: next < text.length ? next : null }
}
