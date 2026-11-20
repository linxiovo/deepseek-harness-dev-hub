import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const checker = fileURLToPath(new URL('../scripts/check-imports.mjs', import.meta.url))

function check(source: string, layer: 'core' | 'sources' = 'core', file = 'fixture.ts') {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-imports-'))
  try {
    const src = join(directory, 'src')
    mkdirSync(join(src, 'core'), { recursive: true })
    mkdirSync(join(src, 'sources'))
    const fixture = join(src, layer, file)
    mkdirSync(dirname(fixture), { recursive: true })
    writeFileSync(fixture, source)
    return spawnSync(process.execPath, [checker], { cwd: directory, encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('accepts local imports and the documented hashing exception', () => {
  const result = check("import { createHash } from 'node:crypto'\nimport type { Ticket } from './model.ts'\nexport * from './model.ts'\n")
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('import boundaries: OK')
})

it.each([
  ['node builtin', "import { join } from 'node:path'"],
  ['parent directory', "import { Runtime } from '../app/runtime.ts'"],
  ['normalized escape', "import '../core/../../app/runtime.ts'"],
  ['bare dot prefix', "import '..outside'"],
  ['package', "import { z } from 'zod'"],
  ['type import', "import type { PlatformPath } from 'node:path'"],
  ['re-export', "export * from '../app/runtime.ts'"],
  ['import type expression', "type Path = import('node:path').PlatformPath"],
  ['dynamic import of a builtin', "void import('node:path')"],
  ['dynamic import of the hashing exception', "void import('node:crypto')"],
  ['dynamic import within core', "void import('./model.ts')"],
  ['require', "const path = require('node:path')"],
  ['non-literal dynamic import', 'void import(target)'],
])('rejects %s', (_description, source) => {
  const result = check(source)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('fixture.ts:1:')
  expect(result.stderr).toContain('core import outside boundary:')
})

it('accepts Source imports from outside app, including sibling directories and literal import()', () => {
  const result = check("import type { Trigger } from '../core/model.ts'\nimport '../app-tools/format.ts'\nvoid import('../infra/cli.ts')", 'sources')
  expect(result.status, result.stderr).toBe(0)
})

it.each([
  ['a static import', "import '../app/runtime.ts'"],
  ['a type-only import', "import type { Runtime } from '../app/runtime.ts'"],
  ['a normalized path from a nested directory', "import '../../core/../app/runtime.ts'", 'nested/fixture.ts'],
  ['a re-export', "export * from '../app/runtime.ts'"],
  ['an import type expression', "type Runtime = import('../app/runtime.ts').Runtime"],
  ['a dynamic import', 'void import(`../app/runtime.ts`)'],
  ['an import assignment', "import runtime = require('../app/runtime.ts')"],
  ['a require call', "const runtime = require('../app/runtime.ts')"],
  ['a computed import', 'void import(target)'],
  ['a computed require', 'const runtime = require(target)'],
])('rejects %s in Sources when it crosses or cannot be checked against the app boundary', (_description, source, file = 'fixture.ts') => {
  const result = check(source, 'sources', file)
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/sources[\\/](?:nested[\\/])?fixture\.ts:1:\d+: sources import outside boundary: /)
})
