import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { packagePath } from './paths.ts'

export function readText(path: string): { path: string; text: string } {
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}

function promptPath(name: string): string {
  const file = `${name}.md`
  if (isAbsolute(name)) return resolve(file)
  if (sep === '\\' && /^[a-zA-Z]:/.test(name)) throw new Error(`Prompt path escapes prompts directory: ${name}`)
  const root = resolve(packagePath('prompts'))
  const path = resolve(root, file)
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Prompt path escapes prompts directory: ${name}`)
  }
  return path
}

/** Load a packaged prompt, normalizing wrapped lines within each paragraph. */
export function promptFile(name: string): string {
  const paragraphs = readText(promptPath(name)).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
