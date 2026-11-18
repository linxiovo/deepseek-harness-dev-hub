/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { packagePath } from '../infra/paths.ts'
/**
 * Reads a text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
function readText(path: string): { path: string; text: string } {
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load<Name extends string>(name: Name) {
  const { path, text } = readText(packagePath('skills', `dsh-superagent-${name}`, 'SKILL.md'))
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { shortName: name, name: match[1]!, description: match[2]!, content: match[3]!, path }
}
/** Packaged skills whose short names are reserved in team configuration. */
export const bundledSkills = { feishu: load('feishu'), github: load('github'), 'to-spec': load('to-spec'), 'doc-tree': load('doc-tree') }

/** Only splitter Sessions register this skill, leaving the team name `to-tickets` available. */
export const splitterSkill = load('to-tickets')

export const isBundledSkill = (name: string): name is keyof typeof bundledSkills => Object.hasOwn(bundledSkills, name)
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
/**
 * Loads a prompt file (`prompts/<name>.md` for relative names, or an explicit absolute `.md` path without extension).
 * Relative names must remain inside `prompts/`. Source `.md` files are written one sentence per line for readable
 * diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
export function promptFile(name: string): string {
  const paragraphs = readText(promptPath(name)).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
