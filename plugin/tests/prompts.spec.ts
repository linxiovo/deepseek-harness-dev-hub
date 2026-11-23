import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Prompts, builtInBase, builtInParts, composePrompt, defaultPrompts, policySection, promptParts, type PromptConfig } from '../src/app/prompts.ts'
import { USER_ERRORS, UserError } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, policyVersion } from '../src/policy.ts'
import { guides, handoffPolicy, mainAdmissionPolicy, masterPrompt, sharedPrompt, workerPrompt } from '../src/app/context.ts'
import { promptFile } from '../src/app/skill-files.ts'
import type { Variable } from '../src/app/execution-environment.ts'

/** The execution environment outside any ticket, as the runtime passes it once setup has finished. */
const variables = (): Variable[] => [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', value: 'acme/widgets', description: { zh: '仓库', en: 'The repository' }, owner: 'github' }]
const ENVIRONMENT_LINE = '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets": The repository.'
const promptsOf = (store: Store, maxChars = 100000) => new Prompts(store, () => maxChars, variables, () => true)
function withStore(body: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-')); const store = new Store(join(dir, 'db'))
  try { body(store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

// Existing installations import their last saved configuration before staging new versions.
function importPromptVersion(store: Store, config: PromptConfig, revision: number): void {
  if (revision === 1 && !store.get(KV.prompts.version(0)))
    store.set(KV.prompts.version(0), { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() })
  store.set(KV.prompts.version(revision), { revision, previousRevision: revision - 1, savedAt: '', source: 'panel', config })
  store.set(KV.prompts.revision, revision)
}

it('keeps a legacy published revision and its Ticket binding across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-config-'))
  let store = new Store(join(dir, 'db'))
  try {
    const config = { ...defaultPrompts(), scope: 'Finish what was asked.', delivery: '', skills: { release: 'Tag releases on Fridays.' } }
    importPromptVersion(store, config, 1)
    let prompts = promptsOf(store)
    prompts.bindTicket('existing-ticket', 0)
    expect(composePrompt(prompts.effective().config, 'worker')).toContain('## Ticket scope\nFinish what was asked.')
    // An empty team section leaves the prompt; the fixed sections stay.
    expect(promptParts(config, 'worker').map(part => part.name)).not.toContain('delivery')
    expect(store.get('settings-revision')).toBeUndefined()
    store.close(); store = new Store(join(dir, 'db')); prompts = promptsOf(store)
    expect(prompts.current()).toMatchObject({ revision: 1, config })
    expect(prompts.forTicket('existing-ticket').revision).toBe(0)
    expect(prompts.history(0, 1)).toMatchObject({ revisions: [{ revision: 1, state: 'active' }], next_offset: 1 })
    expect(prompts.history(1, 1)).toMatchObject({ revisions: [{ revision: 0, state: 'previous' }], next_offset: null })
    expect(() => prompts.stage(defaultPrompts(), 1, 'not-a-ticket')).toThrow('independent Plan maintenance Ticket')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('assembles every role from fixed sections around the team sections, whatever the configuration says', () => {
  const config = { communication: 'Say little.', scope: '', delivery: 'Attach screenshots.', skills: {} }
  for (const role of ['orchestrator', 'worker'] as const) {
    const names = promptParts(config, role, 'env').map(part => part.name)
    expect(names).toEqual(['runtime/shared', `runtime/${role}`, 'communication', 'delivery', 'runtime/subscriptions', 'runtime/replies', role === 'orchestrator' ? 'runtime/dispatch' : 'runtime/work', ...role === 'orchestrator' ? ['runtime/admission'] : [], 'runtime/handoff', 'runtime/environment'])
    const prompt = composePrompt(config, role)
    for (const fixed of [sharedPrompt, role === 'orchestrator' ? masterPrompt : workerPrompt, guides.subscriptions!, guides.replies!, handoffPolicy(role)]) expect(prompt).toContain(fixed)
    expect(prompt.endsWith(handoffPolicy(role))).toBe(true)
  }
  expect(composePrompt(config, 'orchestrator')).toContain(mainAdmissionPolicy)
  expect(composePrompt(config, 'worker')).not.toContain(mainAdmissionPolicy)
})

it('reads a prompt file whatever its line ends and blank lines, and names a missing or empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-file-'))
  try {
    writeFileSync(join(dir, 'crlf.md'), 'One.\r\nTwo. \r\n \t\r\n\r\nThree.\r\n')
    writeFileSync(join(dir, 'blank.md'), ' \n\t\n')
    expect(promptFile(join(dir, 'crlf'))).toBe('One. Two.\nThree.')
    expect(() => promptFile(join(dir, 'blank'))).toThrow(`Empty packaged file: ${join(dir, 'blank.md')}`)
    expect(() => promptFile(join(dir, 'absent'))).toThrow(`Missing packaged file: ${join(dir, 'absent.md')}`)
    expect(promptFile('team/communication')).toContain('Return to the source conversation to deliver.')
    expect(() => promptFile('../package')).toThrow('escapes prompts directory')
    expect(() => promptFile('team/../../package')).toThrow('escapes prompts directory')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('leaves the UI before-and-after evidence to the delivery requirements, which a team can change', () => {
  const config = { ...defaultPrompts(), delivery: 'Only capture the finished screen.' }
  for (const role of ['orchestrator', 'worker'] as const) expect(composePrompt(config, role)).not.toContain('Before and After visual evidence')
})

it.each(['orchestrator', 'worker'] as const)('ends the %s prompt with the fixed handoff rules and the execution environment, and the main Session\'s with its Policy', role => {
  withStore(store => {
    const prompts = promptsOf(store)
    const preview = prompts.preview(defaultPrompts())
    expect(promptParts(defaultPrompts(), role).at(-1)).toEqual({ name: 'runtime/handoff', kind: 'fixed', key: `runtime/handoff/${role}`,
      text: handoffPolicy(role) })
    expect(preview[role]).toBe(prompts.compose(defaultPrompts(), role))
    expect(preview[role]).toContain(`${handoffPolicy(role)}\n\nExecution environment`)
    if (role === 'worker') expect(preview[role].endsWith(ENVIRONMENT_LINE)).toBe(true)
    // Nothing follows the main Session's Policy section, so a Policy change leaves the rest of its prompt as it was.
    else expect(preview[role].endsWith(`${ENVIRONMENT_LINE}\n\n${policySection(store.settings()).text}`)).toBe(true)
    expect(preview.parts[role].at(-1)!.name).toBe(role === 'orchestrator' ? 'runtime/policy' : 'runtime/environment')
  })
})

it('rejects unknown keys, built-in skill names and oversized configuration before persisting', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    expect(() => prompts.validate({ ...defaultPrompts(), shared: 'x' })).toThrow()
    expect(() => prompts.validate({ communication: '', scope: '' })).toThrow()
    for (const name of ['github', 'feishu', 'doc-tree']) expect(() => prompts.validate({ ...defaultPrompts(), skills: { [name]: 'mine' } })).toThrow('built-in skill')
    expect(() => prompts.validate({ ...defaultPrompts(), skills: { 'Bad Name': 'x' } })).toThrow()
    expect(() => promptsOf(store, 1000).validate(defaultPrompts())).toThrow('exceeds')
    expect(prompts.current().revision).toBe(0)
  })
})

it('lists a ticket\'s execution environment in its prompt, and says setup is incomplete before setup finished', () => {
  withStore(store => {
    const ticket: Variable[] = [{ key: 'DSH_SUPERAGENT_DIR', value: '/srv/work/fix-1', description: { zh: '', en: 'This ticket\'s directory' }, owner: 'executor' }]
    expect(promptsOf(store).compose(defaultPrompts(), 'worker', ticket).endsWith('- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": This ticket\'s directory.')).toBe(true)
    expect(promptParts(defaultPrompts(), 'worker', 'env').at(-1)).toEqual({ name: 'runtime/environment', kind: 'generated', key: 'runtime/environment',
      text: 'env' })
    expect(new Prompts(store, () => 100000, () => undefined, () => false).compose(defaultPrompts(), 'worker')).toContain('dsh-superagent is waiting for setup')
  })
})

it('registers the built-in Source skills, Feishu only with a Feishu bot, before the team skills', () => {
  withStore(store => {
    const config = { ...defaultPrompts(), skills: { release: 'Tag releases.' } }
    const skills = promptsOf(store).skills(config, 'orchestrator')
    expect(skills.map(([name]) => name)).toEqual(['feishu', 'github', 'release'])
    expect(skills[1]![1]).toContain('## CLI usage')
    expect(skills[2]![1]).toBe('Tag releases.')
    expect(new Prompts(store, () => 100000, variables, () => false).skills(config, 'orchestrator').map(([name]) => name)).toEqual(['github', 'release'])
  })
})

it('mounts the bundled Doc Tree skill only for workers, even with an older same-name team skill', () => {
  withStore(store => {
    const prompts = promptsOf(store), config = defaultPrompts()
    const docTree = prompts.skills(config, 'worker').filter(([name]) => name === 'doc-tree')
    expect(docTree).toEqual([['doc-tree', expect.stringMatching(/\S/)]])
    const older = { ...config, skills: { 'doc-tree': 'Old team text.' } }
    expect(prompts.skills(older, 'worker').filter(([name]) => name === 'doc-tree')).toEqual(docTree)
    for (const role of ['orchestrator', 'planner', 'splitter'] as const) {
      expect(prompts.skills(older, role).map(([name]) => name)).not.toContain('doc-tree')
    }
  })
})

it.each(['implement', 'tdd', 'test-scope', 'code-review'])('mounts the bundled %s skill for workers alongside a same-name team skill', name => {
  withStore(store => {
    const prompts = promptsOf(store), config = defaultPrompts()
    const saved = prompts.validate({ ...config, skills: { [name]: 'Team workflow.' } })
    expect(prompts.skills(saved, 'worker')).toEqual(expect.arrayContaining([
      [`worker/${name}`, expect.stringMatching(/\S/)], [name, 'Team workflow.'],
    ]))
    expect(prompts.skills(saved, 'orchestrator')).toContainEqual([name, 'Team workflow.'])
    for (const role of ['orchestrator', 'planner', 'splitter'] as const) {
      expect(prompts.skills(saved, role).map(([key]) => key)).not.toContain(`worker/${name}`)
    }
  })
})

it('registers the code-review prompt part for workers only', () => {
  expect(builtInParts()['skill/worker/code-review']).toMatchObject({ roles: ['worker'], text: expect.stringContaining('orchestrator_review_submit') })
})

it('round-trips a team to-tickets skill without replacing the splitter’s bundled skill', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    const team = 'Document our team ticket workflow.'
    const saved = prompts.validate({ ...defaultPrompts(), skills: { 'to-tickets': team } })
    const preview = prompts.preview(saved)
    expect(preview.skills['to-tickets']).toBe(team)
    expect(preview.skills['splitter/to-tickets']).toBeTruthy()
    expect(prompts.skills(saved, 'splitter')).toEqual([['to-tickets', preview.skills['splitter/to-tickets']]])
  })
})


describe('overrides of built-in parts', () => {
  const settings = () => SettingsSchema.parse({})
  const config = (overrides: PromptConfig['overrides']) => ({ ...defaultPrompts(), overrides })
  it('compose in place of the built-in texts, for the roles that read each, the handoff per role and the Source skills', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/shared': { text: 'Shared, the team way.' }, 'runtime/dispatch': { text: '## dispatch\nRoute well.' },
        'runtime/handoff/worker': { text: 'Hand off as a worker.' }, 'skill/github': { text: 'GitHub, the team way.' } }))
      const main = prompts.compose(edited, 'orchestrator'), worker = prompts.compose(edited, 'worker')
      for (const prompt of [main, worker]) expect(prompt.startsWith('Shared, the team way.\n\n')).toBe(true)
      expect(main).toContain('## dispatch\nRoute well.')
      expect(main).not.toContain(guides.dispatch)
      expect(worker).toContain('Hand off as a worker.')
      expect(main).toContain(handoffPolicy('orchestrator'))
      expect(prompts.skills(edited)).toContainEqual(['github', 'GitHub, the team way.'])
      // The parts say what they are edited by.
      expect(promptParts(edited, 'worker').find(part => part.name === 'runtime/handoff')).toMatchObject({ key: 'runtime/handoff/worker',
        text: 'Hand off as a worker.' })
    })
  })
  it('fill the templates of the generated parts with the data, which stays generated', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/environment': { text: 'Where you work:\n{variables}\nAsk nobody for more.' },
        'runtime/policy': { text: '## Policy\nRules of {version} in {mode} mode:\n{rules}' },
        'runtime/policy/none': { text: '## Policy\n{version}, {mode}: nothing to accept.' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`Where you work:\n${ENVIRONMENT_LINE}\nAsk nobody for more.`)).toBe(true)
      const policy = policySection(settings(), edited)
      expect(policy).toEqual({ key: 'runtime/policy', text: `## Policy\nRules of ${policyVersion(settings())} in ${settings().eval.mode} mode:\n`
        + settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n') })
      const none = SettingsSchema.parse({ policy: { rules: [] } })
      expect(policySection(none, edited)).toEqual({ key: 'runtime/policy/none', text: `## Policy\n${policyVersion(none)}, ${none.eval.mode}: nothing to accept.` })
      // A rule's text that names a placeholder is not filled again.
      const named = SettingsSchema.parse({ policy: { rules: [{ id: 'x', name: 'X', enabled: true, instruction: 'Keep {mode} and $& as written.' }] } })
      expect(policySection(named, edited).text.endsWith('- X (x): Keep {mode} and $& as written.')).toBe(true)
    })
  })
  it('refuses an unknown part and a template that drops a placeholder, and drops an override equal to the built-in text', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      expect(() => prompts.validate(config({ 'runtime/nothing': { text: 'x' } }))).toThrow(new UserError('unknownPromptPart', { part: 'runtime/nothing' }))
      expect(() => prompts.validate(config({ 'runtime/policy': { text: '## Policy\n{version} {mode}' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/policy', placeholders: '{rules}' }))
      expect(() => prompts.validate(config({ 'runtime/environment': { text: 'Where you work.' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/environment', placeholders: '{variables}' }))
      // Back to the built-in text: the part follows the built-in text again, so a later upgrade updates it.
      expect(prompts.validate(config({ 'runtime/shared': { text: sharedPrompt } }))).not.toHaveProperty('overrides')
      // The whole configuration, overrides included, stays within the limit.
      expect(() => promptsOf(store, 5000).validate(config({ 'runtime/shared': { text: 'x'.repeat(5000) } }))).toThrow(UserError)
    })
  })
  it('records the built-in text an override was edited from, and lists the overrides whose built-in text changed since', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      // An override edited from today's built-in text has nothing to show.
      const saved = prompts.validate(config({ 'runtime/dispatch': { text: '## dispatch\nRoute well.' } }))
      expect(saved.overrides!['runtime/dispatch']!.base).toBe(builtInBase(`## dispatch\n${guides.dispatch}`))
      expect(prompts.defaultChanged(saved)).toEqual([])
      // One edited from a built-in text an earlier version shipped, which this installation kept when it was saved.
      const earlier = '## replies\nAn earlier built-in text.'
      store.set(KV.prompts.builtIn(builtInBase(earlier)), earlier)
      const upgraded = prompts.validate(config({ ...saved.overrides, 'runtime/replies': { text: 'Our replies.', base: builtInBase(earlier) },
        'runtime/work': { text: 'Our work.', base: 'unknown' } }))
      expect(prompts.defaultChanged(upgraded)).toEqual([{ part: 'runtime/replies', base: builtInBase(earlier), previous: earlier },
        { part: 'runtime/work', base: 'unknown' }])
      // Kept as it was: an upgrade never replaces the team's text.
      expect(prompts.compose(upgraded, 'worker')).toContain('Our replies.')
    })
  })
  it('reads a configuration saved before overrides existed unchanged', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const saved = { ...defaultPrompts(), communication: 'Ours.' }
      importPromptVersion(store, saved, 1)
      expect(prompts.current().config).toEqual(saved)
      expect(prompts.compose(prompts.current().config, 'orchestrator')).toBe(prompts.compose({ ...saved, overrides: {} }, 'orchestrator'))
    })
  })
  it('drops an override of a part a later version no longer has, which the saved version holds, and lists it as removed', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const config = { ...defaultPrompts(), overrides: { 'runtime/retired': { text: 'Old.', base: 'b' } } }
      // Only a part the saved version holds goes quietly; one a client makes up is refused.
      expect(() => prompts.validate(config)).toThrow(new UserError('unknownPromptPart', { part: 'runtime/retired' }))
      store.set(KV.prompts.version(1), { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config }); store.set(KV.prompts.revision, 1)
      expect(prompts.defaultChanged(config)).toEqual([{ part: 'runtime/retired', base: 'b', removed: true }])
      expect(prompts.validate(config)).toEqual(defaultPrompts())
      expect(USER_ERRORS.unknownPromptPart[0]).toBe('refused')
    })
  })
  it('keeps the base of the saved override of a part when a save omits it, and shows a re-based override as a change', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const first = prompts.validate(config({ 'runtime/shared': { text: 'Ours.', base: 'earlier' } }))
      importPromptVersion(store, first, 1)
      const second = prompts.validate(config({ 'runtime/shared': { text: 'Ours, edited.' } }))
      expect(second.overrides!['runtime/shared']).toEqual({ text: 'Ours, edited.', base: 'earlier' })
      importPromptVersion(store, second, 2)
      const rebased = prompts.validate(config({ 'runtime/shared': { text: 'Ours, edited.', base: builtInBase(sharedPrompt) } }))
      importPromptVersion(store, rebased, 3)
      expect(prompts.history().revisions[0]?.changed).toEqual(['runtime/shared'])
    })
  })
  it('refuses a part an object\'s prototype names, and empty text, and fills no placeholder a prototype names', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      for (const part of ['constructor', 'toString']) {
        expect(() => prompts.validate(config(JSON.parse(`{"${part}": { "text": "x" }}`)))).toThrow(new UserError('unknownPromptPart', { part }))
      }
      // The parser drops a __proto__ key, which sets no prototype.
      expect(prompts.validate(config(JSON.parse('{"__proto__": { "text": "x" }}')))).toEqual(defaultPrompts())
      expect(() => prompts.validate(config({ 'runtime/shared': { text: ' \n ' } }))).toThrow(new UserError('promptPartEmpty', { part: 'runtime/shared' }))
      const edited = prompts.validate(config({ 'runtime/environment': { text: '{constructor} {toString}\n{variables}' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`{constructor} {toString}\n${ENVIRONMENT_LINE}`)).toBe(true)
    })
  })
  it('keeps the environment heading as it was, naming the prepare command', () => {
    expect(composePrompt(defaultPrompts(), 'worker', 'x')).not.toContain('The prepare command')
    withStore(store => {
      expect(promptsOf(store).compose(defaultPrompts(), 'worker')).toContain('an empty value means that part is not configured here). '
        + `The prepare command of a ticket directory reads the same variables:\n${ENVIRONMENT_LINE}`)
    })
  })
})
