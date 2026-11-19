import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Repo-relative and Markdown paths compare with `/`, whichever separator this platform reports. */
const slash = (path: string): string => path.split(sep).join('/')
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/
const entries = ['DOCS.md', 'README.md', 'SETUP.md']
function indexedLinks(markdown: string, heading: string, row: RegExp): Set<string> {
  const lines = markdown.split(/\r?\n/)
  const start = lines.indexOf(`## ${heading}`)
  if (start < 0) return new Set()
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line))
  const targets = lines.slice(start + 1, end < 0 ? undefined : end).filter(line => row.test(line))
    .flatMap(line => [...line.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!.replaceAll('\\', '/')))
  return new Set(targets)
}
function markdownLinks(file: string): string[] {
  const targets: string[] = []
  for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!.split('#')[0]!
    if (target && !/^[a-z]+:/.test(target)) targets.push(target)
  }
  return targets
}
function collectFiles(root: string, directory: string, match?: RegExp): string[] {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && (!match || match.test(entry.name)))
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
}
/**
 * Extract table paths from the first column under `## <heading>` in a Markdown document.
 * Bare filenames inherit the directory of the preceding path in the same cell.
 */
function listedIn(docFile: string, heading: string): string[] {
  const lines = readFileSync(docFile, 'utf8').split(/\r?\n/)
  const start = lines.indexOf(`## ${heading}`)
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two rows are the header and its separator.
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return posix.join(directory, name!)
      directory = posix.dirname(name!)
      return name!
    }).map(slash)
  })
}
function inspectDocumentation(pluginRoot: string, repoRoot = resolve(pluginRoot, '..')) {
  const docs = join(pluginRoot, 'docs')
  const numbered = readdirSync(docs).filter(name => NUMBERED.test(name)).sort()
  const forwardLinks = numbered.flatMap(name => markdownLinks(join(docs, name)).flatMap(target => {
    const linked = resolve(docs, target)
    if (!linked.endsWith('.md')) return []
    const number = NUMBERED.exec(basename(linked))?.[1]
    if (dirname(linked) === docs && number !== undefined && number < name.slice(0, 3)) return []
    const guidance = dirname(linked) === docs && number !== undefined
      ? `links from ${name} may only point to earlier docs < ${name.slice(0, 3)}; reference ${basename(linked)} in inline code instead of a Markdown link`
      : 'numbered docs may link only to earlier numbered docs in plugin/docs/; reference other Markdown files in inline code'
    return [`${name} → ${target} (${guidance})`]
  }))
  const rootDocs = join(repoRoot, 'DOCS.md')
  const localLinkFiles = [
    rootDocs,
    ...entries.map(name => join(pluginRoot, name)),
    ...numbered.map(name => join(docs, name)),
  ]
  const brokenLinks = localLinkFiles.flatMap(file => {
    const label = relative(repoRoot, file).split(sep).join('/')
    return markdownLinks(file)
      .filter(target => !existsSync(resolve(dirname(file), target)))
      .map(target => `${label} → ${target}`)
  })
  const conflictFiles = [
    rootDocs,
    ...entries.map(name => join(pluginRoot, name)),
    ...readdirSync(docs).filter(name => name.endsWith('.md')).map(name => join(docs, name)),
  ]
  const conflictMarkers = conflictFiles
    .filter(file => /^(<{7}|>{7}) /m.test(readFileSync(file, 'utf8')))
    .map(file => relative(repoRoot, file).split(sep).join('/'))
  const architecture = join(docs, '007-architecture.md')
  const modules = listedIn(architecture, 'Modules')
  const tests = listedIn(architecture, 'Tests')
  const boundaries = join(docs, '010-session-boundaries.md')
  const boundaryPaths = existsSync(boundaries) ? listedIn(boundaries, 'Code and tests') : []
  const staleBoundaryPaths = boundaryPaths.filter(entry => {
    const target = entry.startsWith('plugin/') ? join(repoRoot, entry) : join(pluginRoot, entry)
    return statSync(target, { throwIfNoEntry: false })?.isFile() !== true
  })
  return {
    numbered,
    forwardLinks,
    brokenLinks,
    conflictMarkers,
    missingModules: collectFiles(pluginRoot, 'src').filter(path => !modules.includes(path)),
    staleModules: modules.filter(path => !existsSync(join(pluginRoot, path))),
    missingTests: collectFiles(pluginRoot, 'tests', /\.spec\.tsx?$/).filter(path => !tests.includes(path)),
    staleTests: tests.filter(path => !existsSync(join(pluginRoot, path))),
    staleBoundaryPaths,
  }
}

describe('documentation', () => {
  const real = inspectDocumentation(ROOT)
  it('numbers documents consecutively from 000', () => {
    expect(real.numbered.map(name => name.slice(0, 3)),
      'Numbered docs in plugin/docs/ must be consecutive starting at 000 (NNN-kebab-case.md); rename or renumber the gap/duplicate.')
      .toEqual(real.numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('lists every numbered document in DOCS.md and links README.md to that index', () => {
    const targets = indexedLinks(readFileSync(join(ROOT, 'DOCS.md'), 'utf8'), '随包文档', /^\| /)
    expect(real.numbered.filter(name => !targets.has(`docs/${name}`)), 'DOCS.md').toEqual([])
    const readmeIndex = indexedLinks(readFileSync(join(ROOT, 'README.md'), 'utf8'), 'Documentation', /\S/)
    expect(readmeIndex.has('DOCS.md')).toBe(true)
    expect([...readmeIndex].filter(path => /^docs\/\d{3}-/.test(path))).toEqual([])
  })
  it('ignores introduction links and prose outside the index rows', () => {
    const readme = '[000](docs/000-philosophy.md)\r\n## Documentation\r\n- [001](docs/001-domain.md)'
    const docs = '## 随包文档\r\n[000](docs/000-philosophy.md)\r\n| Entry | [001](docs/001-domain.md) |'
    expect([...indexedLinks(readme, 'Documentation', /^[-*+] /)]).toEqual(['docs/001-domain.md'])
    expect([...indexedLinks(docs, '随包文档', /^\| /)]).toEqual(['docs/001-domain.md'])
  })
  it('links numbered documents only to earlier numbered documents', () => {
    expect(real.forwardLinks,
      'Numbered docs must build strictly on earlier numbered docs; replace forward or non-numbered .md links with inline code paths (e.g. `plugin/docs/010-session-boundaries.md`).')
      .toEqual([])
  })
  it('resolves every local link', () => {
    expect(real.brokenLinks,
      'Fix broken local Markdown links (paths resolve relative to the linking file; checked root DOCS.md, plugin/DOCS.md, README.md, SETUP.md, and plugin/docs/*.md):')
      .toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(real.conflictMarkers, 'Resolve merge conflict markers (<<<<<<< or >>>>>>>) in the listed documents:').toEqual([])
  })
  it('lists every module of src in the module table of 007 Architecture, and only files that exist', () => {
    expect(real.missingModules, 'Add missing src/ files to the ## Modules table in plugin/docs/007-architecture.md:').toEqual([])
    expect(real.staleModules, 'Remove or update nonexistent paths in the ## Modules table of plugin/docs/007-architecture.md:').toEqual([])
  })
  it('lists every test in the test table of 007 Architecture, and only files that exist', () => {
    expect(real.missingTests, 'Add missing tests/*.spec.ts(x) files to the ## Tests table in plugin/docs/007-architecture.md:').toEqual([])
    expect(real.staleTests, 'Remove or update nonexistent paths in the ## Tests table of plugin/docs/007-architecture.md:').toEqual([])
  })
  it('lists only existing explicit file paths in the Code and tests table of 010 Session boundaries', () => {
    expect(real.staleBoundaryPaths,
      'Remove or update nonexistent explicit file paths in the ## Code and tests table of plugin/docs/010-session-boundaries.md:')
      .toEqual([])
  })
  it('catches broken links and conflict markers in root DOCS.md and plugin/DOCS.md, missing explicit paths in 010, and guides authors on forward links', () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'docs-check-'))
    try {
      const tempPlugin = join(tempRepo, 'plugin')
      mkdirSync(join(tempPlugin, 'docs'), { recursive: true })
      mkdirSync(join(tempPlugin, 'src'), { recursive: true })
      mkdirSync(join(tempPlugin, 'tests'), { recursive: true })
      writeFileSync(join(tempRepo, 'DOCS.md'), '| p | d | [broken](plugin/missing.md) |\n<<<<<<< HEAD\n')
      writeFileSync(join(tempPlugin, 'DOCS.md'), '| d | s | [broken](docs/missing.md) |\n>>>>>>> branch\n')
      writeFileSync(join(tempPlugin, 'README.md'), '# README\n')
      writeFileSync(join(tempPlugin, 'SETUP.md'), '# SETUP\n')
      writeFileSync(join(tempPlugin, 'docs', '000-intro.md'), 'See [later](001-boundaries.md).\n')
      writeFileSync(join(tempPlugin, 'docs', '001-boundaries.md'), '# 001\n')
      writeFileSync(join(tempPlugin, 'docs', '007-architecture.md'), '## Modules\n\n| Path | Role |\n| --- | --- |\n\n## Tests\n\n| Test | Covers |\n| --- | --- |\n')
      writeFileSync(join(tempPlugin, 'docs', '010-session-boundaries.md'),
        '## Code and tests\n\n| Entry | Role |\n| --- | --- |\n| `plugin/tests/does-not-exist.spec.ts` | Missing |\n| `plugin/docs/001-boundaries.md` | Exists |\n')
      const checked = inspectDocumentation(tempPlugin, tempRepo)
      expect(checked.brokenLinks).toEqual(['DOCS.md → plugin/missing.md', 'plugin/DOCS.md → docs/missing.md'])
      expect(checked.conflictMarkers).toEqual(['DOCS.md', 'plugin/DOCS.md'])
      expect(checked.staleBoundaryPaths).toEqual(['plugin/tests/does-not-exist.spec.ts'])
      expect(checked.forwardLinks).toEqual([expect.stringMatching(/000-intro\.md → 001-boundaries\.md.*inline code/i)])
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })
})
