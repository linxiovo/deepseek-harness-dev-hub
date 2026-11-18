/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync, realpath } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Match the Store's native realpath, including expansion of Windows 8.3 path components. */
export const physicalPath = promisify(realpath.native)

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
