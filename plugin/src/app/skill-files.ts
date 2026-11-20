/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { packagePath } from '../infra/paths.ts'
import { readText } from '../infra/prompt-file.ts'
export { promptFile } from '../infra/prompt-file.ts'
function load<Name extends string>(name: Name, prefix = 'dsh-superagent') {
  const { path, text } = readText(packagePath('skills', `${prefix}-${name}`, 'SKILL.md'))
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { shortName: name, name: match[1]!, description: match[2]!, content: match[3]!, path }
}
/** Worker preview keys and runtime names use their own namespace so team skills with the same short names still mount. */
export const workerSkills = {
  'worker/implement': load('implement', 'dsh-worker'),
  'worker/tdd': load('tdd', 'dsh-worker'),
  'worker/test-scope': load('test-scope', 'dsh-worker'),
}

/** Packaged skill definitions by preview key. */
export const bundledSkills = { feishu: load('feishu'), github: load('github'), 'to-spec': load('to-spec'), 'doc-tree': load('doc-tree'), ...workerSkills }

/** Only splitter Sessions register this skill, leaving the team name `to-tickets` available. */
export const splitterSkill = load('to-tickets')

export const isBundledSkill = (name: string): name is keyof typeof bundledSkills => Object.hasOwn(bundledSkills, name)
