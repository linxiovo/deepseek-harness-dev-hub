/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { packagePath } from '../infra/paths.ts'
import { readText } from '../infra/prompt-file.ts'
export { promptFile } from '../infra/prompt-file.ts'
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
