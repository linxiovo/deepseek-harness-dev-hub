import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const checker = fileURLToPath(new URL('../scripts/check-core-imports.mjs', import.meta.url))

function check(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-core-imports-'))
  try {
    writeFileSync(join(directory, 'fixture.ts'), source)
    return spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('accepts local imports and the documented hashing exception', () => {
  const result = check("import { createHash } from 'node:crypto'\nimport type { Ticket } from './model.ts'\nexport * from './model.ts'\n")
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('core imports: OK')
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
