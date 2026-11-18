import { posix } from 'node:path'
import { decodeHTML } from 'entities'
import GithubSlugger from 'github-slugger'
import { Marked, Parser } from 'marked'
import { CliError, type Commands } from '../infra/commands.ts'

export interface DocTreeIssue {
  kind: 'broken-link' | 'invalid-navigation' | 'invalid-declaration' | 'unreachable'
  path: string
  target?: string
  detail?: string
}

interface DocTreeScope {
  root: string | null
  routes: readonly string[]
  leaves: readonly string[]
  documents?: readonly string[]
}

interface DocLink {
  target: string
  navigation: boolean
}

interface TreeEntry {
  mode: string
  oid: string
}

type GitRead = (...args: string[]) => Promise<string>

const fullSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const unsafePathCharacter = /[\u0000-\u001f\u007f\\]/
const maxLinkTargets = 512
export const isMarkdownDocument = (path: string): boolean => /\.(?:md|markdown)$/i.test(path)

function nulRecords(output: string): string[] {
  if (!output) return []
  if (!output.endsWith('\0') || output.includes('\uFFFD')) throw new Error('Invalid NUL-delimited Git output')
  const records = output.slice(0, -1).split('\0')
  if (records.includes('')) throw new Error('Empty record in NUL-delimited Git output')
  return records
}

function declaredPath(path: string): boolean {
  return !unsafePathCharacter.test(path) && !/^[^/]+:/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..')
}

const markdown = new Marked()

function parseDocument(text: string): { links: DocLink[]; anchors: Set<string> } {
  const links: DocLink[] = []
  const anchors = new Set<string>()
  const slugs = new GithubSlugger()
  const parser = new Parser()
  parser.textRenderer.html = () => ''
  for (const block of markdown.lexer(text)) {
    const navigation = block.type === 'table' || block.type === 'list'
    markdown.walkTokens([block], token => {
      if (token.type === 'link' || token.type === 'image') links.push({ target: token.href, navigation: navigation && token.type === 'link' })
      if (token.type === 'heading') {
        if (!token.tokens) throw new Error('Markdown heading could not be parsed for Doc Tree evidence')
        anchors.add(slugs.slug(decodeHTML(parser.parseInline(token.tokens, parser.textRenderer))))
      }
      if (token.type === 'html' && !/^\s*<!--/.test(token.raw)) {
        for (const match of token.raw.matchAll(/<[a-z][\w-]*\b[^<>]*?\s(?:id|name)=(?:"([^"]+)"|'([^']+)')[^<>]*>/gi)) {
          anchors.add(decodeHTML(match[1] ?? match[2]!))
        }
      }
    })
  }
  return { links, anchors }
}

function localTarget(from: string, href: string): { path: string; directory: boolean; anchor?: string } | 'unsafe' | undefined {
  const target = decodeHTML(href)
  if (/^file:/i.test(target) || /^[a-z]:/i.test(target)) return 'unsafe'
  if (/^\/\/[^/]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined
  const raw = target.split(/[?#]/, 1)[0]
  const fragment = target.indexOf('#')
  let decoded: string
  let anchor: string | undefined
  try {
    decoded = decodeURIComponent(raw ?? '')
    anchor = fragment < 0 ? undefined : decodeURIComponent(target.slice(fragment + 1)) || undefined
  }
  catch { return 'unsafe' }
  if (!decoded) return anchor ? { path: from, directory: false, anchor } : undefined
  if (unsafePathCharacter.test(decoded) || /^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(decoded)) return 'unsafe'
  const path = posix.join(posix.dirname(from), decoded).replace(/\/$/, '')
  if (path === '..' || path.startsWith('../')) return 'unsafe'
  return { path, directory: decoded.endsWith('/'), anchor }
}

const regularFile = (entry: TreeEntry | undefined): entry is TreeEntry =>
  entry?.mode === '100644' || entry?.mode === '100755'

async function inspectDocuments(git: GitRead, candidate: string, scope: DocTreeScope, changed: ReadonlySet<string>): Promise<DocTreeIssue[]> {
  const { root, routes, leaves } = scope
  const issues: DocTreeIssue[] = []
  const entries = new Map<string, TreeEntry | undefined>()
  const lookup = async (path: string): Promise<TreeEntry | undefined> => {
    if (entries.has(path)) return entries.get(path)
    const records = nulRecords(await git('ls-tree', '--full-tree', '-z', candidate, '--', path))
    let entry: TreeEntry | undefined
    if (records.length) {
      const match = /^(\d{6}) (?:blob|tree|commit) ([0-9a-f]+)\t/.exec(records[0]!)
      const [, mode, oid] = match ?? []
      if (records.length !== 1 || !mode || !oid || oid.length !== candidate.length || records[0]!.slice(match![0].length) !== path) {
        throw new Error(`Unexpected Git tree entry for ${path}`)
      }
      entry = { mode, oid }
    }
    entries.set(path, entry)
    return entry
  }

  if (root === null) {
    if (await lookup('DOCS.md')) issues.push({ kind: 'invalid-declaration', path: 'DOCS.md', detail: 'The candidate has a conventional root; declare its navigation' })
    for (const path of [...routes, ...leaves]) issues.push({ kind: 'invalid-declaration', path, detail: 'Routes and leaves require a root document' })
    return issues
  }

  const declarations = new Map<string, boolean>()
  const declare = (path: string, route: boolean): void => {
    if (!declaredPath(path)) issues.push({ kind: 'invalid-declaration', path, detail: 'Expected a repository-relative POSIX file path' })
    else if (declarations.has(path)) issues.push({ kind: 'invalid-declaration', path, detail: 'Document is declared more than once' })
    else declarations.set(path, route)
  }
  declare(root, true)
  for (const path of routes) declare(path, true)
  for (const path of leaves) declare(path, false)
  for (const path of new Set(scope.documents)) {
    if (!declarations.has(path) && (!declaredPath(path) || await lookup(path))) {
      issues.push({ kind: 'invalid-declaration', path, detail: 'A changed document that remains in the candidate needs a route or leaf declaration' })
    }
  }

  const edges = new Map<string, Set<string>>()
  const parsed = new Map<string, ReturnType<typeof parseDocument>>()
  const readDocument = async (entry: TreeEntry) => {
    const cached = parsed.get(entry.oid)
    if (cached) return cached
    const document = parseDocument(await git('cat-file', 'blob', entry.oid))
    parsed.set(entry.oid, document)
    return document
  }
  const distinctTargets = new Set<string>()
  for (const [path, route] of declarations) {
    const entry = await lookup(path)
    if (!regularFile(entry)) {
      issues.push({ kind: 'invalid-declaration', path, detail: 'Expected a regular file in the candidate' })
      continue
    }
    const children = new Set<string>()
    edges.set(path, children)
    const links = new Map<string, { target: string; resolved: string; directoryOnly: boolean; edge: boolean; anchor?: string }>()
    for (const { target, navigation } of (await readDocument(entry)).links) {
      const local = localTarget(path, target)
      if (!local) continue
      if (local === 'unsafe') { issues.push({ kind: 'broken-link', path, target }); continue }
      const directoryIndex = posix.join(local.path, 'DOCS.md')
      const alias = local.directory && declarations.has(directoryIndex)
      const resolved = alias ? directoryIndex : local.path
      distinctTargets.add(resolved)
      if (distinctTargets.size > maxLinkTargets) {
        throw new Error(`Doc Tree check incomplete: more than ${maxLinkTargets} distinct local targets while reading ${path}. Narrow the document scope or split oversized indexes.`)
      }
      const edge = route && navigation && (resolved !== path || !local.anchor)
      links.set(target, { target, resolved, directoryOnly: local.directory && !alias, edge: edge || !!links.get(target)?.edge, anchor: local.anchor })
    }
    for (const { target, resolved, directoryOnly, edge, anchor } of links.values()) {
      const linked = resolved === '.' ? undefined : await lookup(resolved)
      const directory = resolved === '.' || linked?.mode === '040000'
      const file = regularFile(linked) && !directoryOnly
      if (!file && !directory) {
        issues.push({ kind: 'broken-link', path, target })
      } else if (file && anchor && isMarkdownDocument(resolved) && !(await readDocument(linked)).anchors.has(anchor)) {
        issues.push({ kind: 'broken-link', path, target })
      }
      if (edge && declarations.has(resolved)) {
        if (file) children.add(resolved)
        else issues.push({ kind: 'invalid-navigation', path, target })
      } else if (edge && file && isMarkdownDocument(resolved) && changed.has(resolved)) {
        issues.push({ kind: 'invalid-declaration', path: resolved, target: path, detail: 'A changed navigation target needs a route or leaf declaration' })
      }
    }
  }

  const visited = new Set<string>(), visiting = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visiting.add(path)
    for (const child of edges.get(path) ?? []) {
      if (visiting.has(child)) issues.push({ kind: 'invalid-navigation', path, target: child, detail: 'Navigation cycle' })
      else visit(child)
    }
    visiting.delete(path)
    visited.add(path)
  }
  visit(root)
  for (const path of edges.keys()) if (!visited.has(path)) issues.push({ kind: 'unreachable', path })
  for (const path of edges.keys()) visit(path)
  return issues
}

/** Checks the declared navigation and local link targets in the exact candidate snapshot. */
export async function checkDocTree(
  commands: Pick<Commands, 'git'>, worktree: string, base: string, candidate: string,
  scope: DocTreeScope, signal?: AbortSignal,
): Promise<{ changes: string[]; issues: DocTreeIssue[] }> {
  if (!fullSha.test(candidate) || !fullSha.test(base)) throw new Error('Doc Tree requires full base and candidate commit SHAs')
  base = base.toLowerCase()
  candidate = candidate.toLowerCase()
  const objectOptions = ['--no-replace-objects', '--literal-pathspecs']
  let options = ['--no-lazy-fetch', ...objectOptions]
  const git = async (...args: string[]): Promise<string> => {
    signal?.throwIfAborted()
    const output = await commands.git([...options, ...args], worktree)
    signal?.throwIfAborted()
    return output
  }
  const assertHead = async (): Promise<void> => {
    if ((await git('rev-parse', '--verify', 'HEAD^{commit}')).trim() !== candidate) {
      throw new Error('Doc Tree candidate is no longer the worktree HEAD')
    }
  }

  try { await assertHead() }
  catch (error) {
    if (!(error instanceof CliError) || ![1, 129].includes(error.exitCode ?? 0) || !error.message.startsWith('unknown option: --no-lazy-fetch')) throw error
    options = objectOptions
    let partial = true
    try {
      await git('config', '--includes', '--name-only', '--get-regexp', '^(extensions[.]partialclone|remote[.].*[.](promisor|partialclonefilter))$')
    } catch (failure) {
      if (!(failure instanceof CliError) || failure.exitCode !== 1) throw failure
      partial = false
    }
    if (partial) throw new Error('Doc Tree cannot inspect a partial clone on this Git version; use a complete clone or upgrade Git')
    await assertHead()
  }
  if ((await git('rev-parse', '--verify', `${base}^{commit}`)).trim() !== base) throw new Error('Doc Tree base is not a pinned commit')
  await git('merge-base', '--is-ancestor', base, candidate)
  const changes = nulRecords(await git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-relative', base, candidate, '--')).sort()
  const issues = await inspectDocuments(git, candidate, scope, new Set(changes))
  await assertHead()
  return { changes, issues }
}
