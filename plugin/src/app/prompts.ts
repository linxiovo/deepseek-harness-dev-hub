/** Manages versioned role prompts, behavioral policies, and operational skills independently of access settings. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { UserError, key } from '../core/index.ts'
import { PolicyConfigSchema, policyVersion, type Settings } from '../policy.ts'
import { masterPrompt, workerPrompt, sharedPrompt, guides, mainAdmissionPolicy, handoffPolicy, teamDefaults, sourceSkills, cliNotes } from './context.ts'
import { environmentLines, type Variable } from './execution-environment.ts'
import { bundledSkills, isBundledSkill, promptFile, splitterSkill, workerSkills } from './skill-files.ts'
import type { Store } from './store.ts'
import { Versions } from './versions.ts'
import { KV } from '../kv.ts'

/** Prompt sections the team writes; the built-in parts follow dsh-superagent's text until the team overrides them. */
export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type TeamSection = typeof TEAM_SECTIONS[number]
/** Markdown headings for each team section; fixed prompt sections refer to them by these exact names. */
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
/** Prefix prepended to skill names when registering them in DSH Sessions. */
export const SKILL_PREFIX = 'dsh-superagent-'
const SkillNameSchema = z.string().regex(SKILL_NAME).refine(name => !isBundledSkill(name), 'This name belongs to a built-in skill')
/** A preview key outside the team skill name grammar, independent of the splitter's runtime skill name. */
export const SPLITTER_SKILL_KEY = `splitter/${splitterSkill.shortName}` as const
const SPLITTER_SKILL_PART = `skill/${SPLITTER_SKILL_KEY}` as const
/** The built-in parts a team may override, by key: all roles' parts, bundled skills, and generated templates. */
const PART_KEYS = ['runtime/shared', 'runtime/orchestrator', 'runtime/worker', 'runtime/planner', 'runtime/splitter', 'runtime/subscriptions', 'runtime/replies',
  'runtime/dispatch', 'runtime/work', 'runtime/admission', 'runtime/handoff/orchestrator', 'runtime/handoff/worker', 'runtime/environment',
  'runtime/policy', 'runtime/policy/none', 'skill/feishu', 'skill/github', 'skill/to-spec', 'skill/doc-tree',
  'skill/worker/implement', 'skill/worker/tdd', 'skill/worker/test-scope', 'skill/worker/code-review', SPLITTER_SKILL_PART] as const
export type PartKey = typeof PART_KEYS[number]
/** A team's text for a built-in part, and `base`, the key of the built-in text it was edited from. */
const OverrideSchema = z.object({ text: z.string(),
  base: z.string().optional().describe('Key of the built-in text it was edited from; copy as read, or omit.') }).strict()
/**
 * A configuration, whose overrides may name a part a later version no longer has, which `Prompts.validate` drops when the
 * saved version holds it and refuses otherwise.
 */
export const PromptConfigSchema = z.object({ communication: z.string(), scope: z.string(), delivery: z.string(),
  skills: z.record(SkillNameSchema, z.string()), disabledSkills: z.array(SkillNameSchema).optional(),
  admissionRules: PolicyConfigSchema.shape.rules.unwrap().optional(),
  overrides: z.record(z.string(), OverrideSchema).optional()
    .describe('Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.') }).strict()
export type PromptConfig = z.infer<typeof PromptConfigSchema>
export interface PromptVersion { revision: number; previousRevision: number | null; savedAt: string; source: string; config: PromptConfig;
  maintenanceTicketId?: string
  published?: { receiptId: string; candidate: string; at: string }
  /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
  legacy?: { config: unknown } }
export type PromptVersionState = 'active' | 'previous' | 'pending' | 'stale'
export const defaultPrompts = (): PromptConfig => ({ ...teamDefaults, skills: {} })

const ENVIRONMENT_HEADING = 'Execution environment (from this installation\'s settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:'
const POLICY_HEAD = '## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.'
export type Role = 'orchestrator' | 'worker' | 'planner' | 'splitter'
/** A built-in part a team may override: the roles that read it, its text, and the placeholders a template's override keeps. */
interface BuiltInPart { roles: readonly Role[]; text: string; placeholders?: readonly string[] }
const BOTH: readonly Role[] = ['orchestrator', 'worker'], MAIN: readonly Role[] = ['orchestrator'], WORKER: readonly Role[] = ['worker'], PLANNER: readonly Role[] = ['planner']
const SPLITTER: readonly Role[] = ['splitter']
let parts: Readonly<Record<PartKey, BuiltInPart>> | undefined
/**
 * The built-in role prompts, bundled skills, and generated templates, by the key an override names them by.
 * Built on first use, as the texts it reads are imported in a cycle.
 */
export const builtInParts = (): Readonly<Record<PartKey, BuiltInPart>> => parts ??= {
  'runtime/shared': { roles: BOTH, text: sharedPrompt }, 'runtime/orchestrator': { roles: MAIN, text: masterPrompt },
  'runtime/worker': { roles: WORKER, text: workerPrompt }, 'runtime/planner': { roles: PLANNER, text: promptFile('planner') },
  'runtime/splitter': { roles: SPLITTER, text: promptFile('splitter') },
  'runtime/subscriptions': { roles: BOTH, text: `## subscriptions\n${guides.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## replies\n${guides.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## dispatch\n${guides.dispatch}` }, 'runtime/work': { roles: WORKER, text: `## work\n${guides.work}` },
  'runtime/admission': { roles: MAIN, text: mainAdmissionPolicy },
  'runtime/handoff/orchestrator': { roles: MAIN, text: handoffPolicy('orchestrator') },
  'runtime/handoff/worker': { roles: WORKER, text: handoffPolicy('worker') },
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEADING}\n{variables}`, placeholders: ['{variables}'] },
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD} The enabled rules, by name and id:\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD} No rule is enabled: a proactive candidate can only be ignored.`,
    placeholders: ['{version}', '{mode}'] },
  'skill/feishu': { roles: BOTH, text: `${sourceSkills.feishu}\n\n## CLI usage\n${cliNotes}` },
  'skill/github': { roles: BOTH, text: `${sourceSkills.github}\n\n## CLI usage\n${cliNotes}` },
  'skill/to-spec': { roles: PLANNER, text: bundledSkills['to-spec'].content },
  'skill/doc-tree': { roles: WORKER, text: bundledSkills['doc-tree'].content },
  'skill/worker/implement': { roles: WORKER, text: workerSkills['worker/implement'].content },
  'skill/worker/tdd': { roles: WORKER, text: workerSkills['worker/tdd'].content },
  'skill/worker/test-scope': { roles: WORKER, text: workerSkills['worker/test-scope'].content },
  'skill/worker/code-review': { roles: WORKER, text: workerSkills['worker/code-review'].content },
  [SPLITTER_SKILL_PART]: { roles: SPLITTER, text: splitterSkill.content },
}
/** The key of a built-in text, which an override's `base` records. */
export const builtInBase = (text: string): string => key('prompt-built-in', text)
/** The built-in part a key names, if any; a name an object's prototype has names none. */
export const builtInPart = (part: string): BuiltInPart | undefined =>
  Object.hasOwn(builtInParts(), part) ? builtInParts()[part as PartKey] : undefined
/** The text of a built-in part: the team's override, else the built-in one. */
const builtIn = (config: PromptConfig, part: PartKey): string =>
  (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part]!.text : undefined) ?? builtInParts()[part].text
/** Fill a template's placeholders in one pass, so text filled in is not read for placeholders again. */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match)
/** The execution environment part: its template with the variables, or, while setup waits, that it waits. */
export function environmentSection(config: PromptConfig, variables: Variable[] | undefined): string {
  return variables ? fill(builtIn(config, 'runtime/environment'), { variables: environmentLines(variables) })
    : 'Execution environment: dsh-superagent is waiting for setup; the management panel names what is missing.'
}
/**
 * The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every enabled
 * rule, as the settings hold them, each on one line, so a line of an instruction reads as no rule or heading of its own; the
 * settings bound each instruction (`LIMITS.ruleInstruction`). `key` names the template it was filled from.
 */
export function policySection(settings: Settings, config: PromptConfig = defaultPrompts()): { key: string; text: string } {
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ')
  const rules = settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`)
  const part = rules.length ? 'runtime/policy' : 'runtime/policy/none'
  return { key: part, text: fill(builtIn(config, part), { version: policyVersion(settings), mode: settings.eval.mode, rules: rules.join('\n') }) }
}
/**
 * Assemble a role's system prompt sections in order from fixed templates, team sections, the generated execution environment
 * and, last, the main Session's generated Policy section, which nothing follows, and whose change leaves the rest unchanged.
 */
export function promptParts(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }) {
  // A built-in part names the key its text is overridden by, which for the handoff names the role.
  const fixed = (name: string, part = name) => ({ name, kind: 'fixed' as const, key: part, text: builtIn(config, part as PartKey) })
  const team = (name: TeamSection) => ({ name, kind: 'team' as const, heading: `## ${TEAM_HEADINGS[name]}`,
    text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : '' })
  // The handoff roles receive isolated instructions, without ticket policy, project environment or Source communications.
  if (role === 'planner' || role === 'splitter') return [fixed(`runtime/${role}`)]
  return [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(team),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed('runtime/handoff', `runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated' as const, key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated' as const, ...policy }] : [],
  ].filter(part => part.text)
}
export function composePrompt(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }): string {
  return promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')
}
/** Renders a skill by its preview key, including role-scoped packaged skills. */
export function composeSkill(config: PromptConfig, name: string): string {
  if (name === SPLITTER_SKILL_KEY) return builtIn(config, SPLITTER_SKILL_PART)
  return isBundledSkill(name) ? builtIn(config, `skill/${name}`) : config.skills[name] ?? ''
}

/** An override whose built-in text changed since its `base`, with that text when kept, or whose part this version no longer has. */
export interface DefaultChange { part: string; base?: string; previous?: string; removed?: true }
/**
 * Indicates an optimistic concurrency conflict when saving a prompt configuration against a stale base revision.
 * Thrown by `Prompts.stage` and translated into an HTTP 409 response by the management routes.
 */
export class PromptConflict extends Error {
  constructor(message: string, readonly code: 'promptRevisionChanged' | 'promptProposalRefused' = 'promptRevisionChanged') { super(message) }
}
/** JSON byte budget for the management request and its committed manifest. */
export const promptByteLimit = (maxChars: number): number => 4 * maxChars + 4096
/**
 * Stores numbered prompt configurations in `Store` via `Versions` and composes role system prompts and skills with the execution environment.
 * Sessions use frozen snapshots; management stages a proposal and the formal delivery transaction publishes it.
 */
export class Prompts {
  private readonly versions: Versions<PromptVersion>
  constructor(private readonly store: Store, private readonly maxChars: () => number, private readonly environment: () => Variable[] | undefined,
    private readonly feishu: () => boolean) {
    this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version)
    this.store.atomic(() => this.snapshot(this.current().revision))
  }
  /** A role's prompt; the main Session's Policy section follows the settings as they are now, at each model request. */
  compose(config: PromptConfig, role: Role, variables?: Variable[]): string {
    if (role === 'planner' || role === 'splitter') return composePrompt(config, role)
    return composePrompt(config, role, environmentSection(config, variables ?? this.environment()), role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
  }
  /** Isolate unattended workflow skills; preserve Source and team skills for the Hub and workers. */
  skills(config: PromptConfig, role: Role = 'worker'): [string, string][] {
    if (role === 'planner') return [['to-spec', composeSkill(config, 'to-spec')]]
    if (role === 'splitter') return [[splitterSkill.shortName, composeSkill(config, SPLITTER_SKILL_KEY)]]
    const names = [...this.feishu() ? ['feishu'] : [], 'github', ...role === 'worker' ? ['doc-tree', ...Object.keys(workerSkills)] : []]
    return names.map((name): [string, string] => [name, composeSkill(config, name)])
      .concat(Object.entries(config.skills).filter(([name]) => !isBundledSkill(name) && !config.disabledSkills?.includes(name)))
  }
  current(): PromptVersion {
    return this.version(this.store.get(KV.prompts.active) ?? this.versions.revision())
  }
  /** Editable configuration without defaults resolved during publication. */
  version(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0
      ? { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() } : undefined)
    if (!version) throw new UserError('unknownPromptRevision', { revision: String(revision) })
    return version
  }
  state(revision: number): PromptVersionState {
    const version = this.version(revision)
    if (revision === this.current().revision) return 'active'
    if (version.published || !version.maintenanceTicketId) return 'previous'
    const ticket = this.store.tickets.get(version.maintenanceTicketId)
    return ticket && !ticket.ended && version.previousRevision === this.current().revision
      && this.proposal(ticket.id) === revision ? 'pending' : 'stale'
  }
  /** Published configuration, with the packaged defaults resolved at publication. */
  effective(): PromptVersion {
    const { revision } = this.current()
    const snapshot = this.store.get(KV.prompts.snapshot(revision))
    if (!snapshot) throw new Error(`Effective rule revision ${revision} has no snapshot`)
    return snapshot
  }
  boundRevision(ticketId: string): number | undefined { return this.store.get(KV.prompts.ticket(ticketId)) }
  forTicket(ticketId: string): PromptVersion {
    const revision = this.boundRevision(ticketId)
    const snapshot = revision === undefined ? undefined : this.store.get(KV.prompts.snapshot(revision))
    if (!snapshot) throw new Error(`Ticket ${ticketId} has no stored rule binding`)
    return snapshot
  }
  /** Persist before launch; retries, recovery and rechecks never replace an existing binding. */
  bindTicket(ticketId: string, legacyRevision?: number): void {
    if (this.boundRevision(ticketId) !== undefined) return
    this.store.atomic(() => {
      const revision = legacyRevision ?? this.current().revision
      this.snapshot(revision)
      this.store.set(KV.prompts.ticket(ticketId), revision)
    })
  }
  private snapshot(revision: number): PromptVersion {
    const stored = this.store.get(KV.prompts.snapshot(revision))
    if (stored) return stored
    const version = this.version(revision)
    const overrides = Object.fromEntries(PART_KEYS.map(part => [part, { text: builtIn(version.config, part) }]))
    const snapshot = { ...version, config: { ...version.config, overrides } }
    if (revision === 0 && !this.versions.get(0)) this.versions.keep(version)
    this.store.set(KV.prompts.snapshot(revision), snapshot)
    return snapshot
  }
  proposal(ticketId: string): number | undefined { return this.store.get(KV.prompts.proposal(ticketId)) }
  matches(revision: number, value: unknown): boolean {
    try { return isDeepStrictEqual(this.version(revision).config, this.validate(value)) } catch { return false }
  }
  /** Called inside the same transaction as formal closure, before it marks the Ticket ended. */
  publish(ticketId: string, revision: number, receipt: { receiptId: string; candidate: string; verifiedAt: string }): void {
    const version = this.version(revision)
    if (this.proposal(ticketId) !== revision || version.maintenanceTicketId !== ticketId || this.state(revision) !== 'pending')
      throw new PromptConflict('The shared rule proposal changed before delivery')
    this.versions.keep({ ...version, published: { receiptId: receipt.receiptId, candidate: receipt.candidate, at: receipt.verifiedAt } })
    this.snapshot(revision)
    this.store.set(KV.prompts.active, revision)
  }
  /**
   * Parse a configuration: an override names a built-in part, holds text and keeps its template's placeholders, and records the
   * built-in text it was edited from: the saved override's unless it names one, else the current one. It goes once its text is
   * the built-in text again, and so does one of a part this version no longer has, which the saved version holds.
   */
  validate(value: unknown): PromptConfig {
    const { overrides, disabledSkills, ...config } = PromptConfigSchema.parse(value)
    if (disabledSkills?.some(name => !Object.hasOwn(config.skills, name)))
      throw new UserError('unknownCustomSkill')
    const saved = this.current().config.overrides ?? {}
    const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
      const part = builtInPart(name)
      if (!part && Object.hasOwn(saved, name)) return []
      if (!part) throw new UserError('unknownPromptPart', { part: name })
      if (!override.text.trim()) throw new UserError('promptPartEmpty', { part: name })
      const missing = (part.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) throw new UserError('promptPlaceholders', { part: name, placeholders: missing.join(', ') })
      const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name]!.base : undefined) ?? builtInBase(part.text)
      return override.text === part.text ? [] : [[name, { text: override.text, base }] as const]
    })
    const disabled = [...new Set(disabledSkills)].sort()
    const result: PromptConfig = { ...config, ...disabled.length ? { disabledSkills: disabled } : {},
      ...kept.length ? { overrides: Object.fromEntries(kept) } : {} }
    const limit = this.maxChars()
    if (JSON.stringify(result).length > limit) throw new UserError('promptTooLong', { limit: String(limit) })
    return result
  }
  /**
   * The overrides of `config` whose built-in part changed since the team edited it, by the `base` they were edited from, each
   * with the built-in text of that base when this installation kept it, and those of a part this version no longer has.
   */
  defaultChanged(config: PromptConfig): DefaultChange[] {
    return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]): DefaultChange[] => {
      const now = builtInPart(part)
      if (!now) return [{ part, ...base === undefined ? {} : { base }, removed: true as const }]
      if (base === undefined || base === builtInBase(now.text)) return []
      const previous = this.store.get(KV.prompts.builtIn(base))
      return [{ part, base, ...previous === undefined ? {} : { previous } }]
    })
  }
  preview(value: unknown) {
    const config = this.validate(value)
    const environment = environmentSection(config, this.environment()), settings = this.store.settings()
    const policy = policySection(config.admissionRules === undefined ? settings
      : { ...settings, policy: { ...settings.policy, rules: config.admissionRules } }, config)
    const skills = Object.fromEntries(this.skills(config))
    skills[SPLITTER_SKILL_KEY] = composeSkill(config, SPLITTER_SKILL_KEY)
    return { orchestrator: composePrompt(config, 'orchestrator', environment, policy), worker: composePrompt(config, 'worker', environment),
      planner: composePrompt(config, 'planner'), splitter: composePrompt(config, 'splitter'),
      parts: { orchestrator: promptParts(config, 'orchestrator', environment, policy), worker: promptParts(config, 'worker', environment),
        planner: promptParts(config, 'planner'), splitter: promptParts(config, 'splitter') },
      skills, scope: 'Team sections, skills, and overrides of built-in parts, which follow their built-in text until overridden. Workers additionally inherit the host prompt and repository AGENTS.md. Prompt text changes what the agents are told, not what dsh-superagent allows: tool permissions, the gate and account wrappers stay.' }
  }
  /** Store only a proposal, never an effective version. */
  stage(value: unknown, baseRevision: number, maintenanceTicketId: string): PromptVersion {
    const config = this.validate(value)
    return this.store.atomic(() => {
      const previous = this.current(), priorId = this.proposal(maintenanceTicketId)
      const prior = priorId === undefined ? undefined : this.version(priorId)
      if (prior?.previousRevision === baseRevision && this.state(prior.revision) === 'pending' && isDeepStrictEqual(prior.config, config)) return prior
      if (previous.revision !== baseRevision) throw new PromptConflict(`Prompt version changed to ${previous.revision}; compare the latest version before saving`)
      const ticket = this.store.tickets.get(maintenanceTicketId)
      const plan = ticket?.plan && this.store.get(KV.plans.record(ticket.plan.planId))
      if (!ticket?.plan || ticket.ended || plan?.nodes.length !== 1 || plan.nodes[0]?.id !== ticket.plan.nodeId)
        throw new PromptConflict('Shared rules require an open, independent Plan maintenance Ticket', 'promptProposalRefused')
      const attempt = this.store.get(KV.mainline.ticket(maintenanceTicketId))?.at(-1)
      if (attempt && (attempt.status === 'queued' || attempt.status === 'applying' || attempt.status === 'verified'))
        throw new PromptConflict('Cannot replace a shared rule proposal while its mainline attempt is pending or verified', 'promptProposalRefused')
      this.store.set(KV.prompts.active, previous.revision)
      for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
        const text = builtInParts()[part as PartKey].text
        if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === undefined) this.store.set(KV.prompts.builtIn(base), text)
      }
      const staged = this.versions.save(revision => ({ revision, previousRevision: previous.revision, savedAt: new Date().toISOString(),
        source: 'panel', config, maintenanceTicketId }))
      this.store.set(KV.prompts.proposal(maintenanceTicketId), staged.revision)
      return staged
    })
  }
  history(offset = 0, limit = 20) {
    const latest = this.versions.revision()
    const revisions = Array.from({ length: Math.min(limit, Math.max(0, latest + 1 - offset)) }, (_, i) => {
      const version = this.version(latest - offset - i)
      const { config, ...record } = version
      const summary = { ...record, state: this.state(version.revision) }
      const previous = version.previousRevision === null ? undefined : this.versions.get(version.previousRevision)?.config
      // Pre-team-section revisions are not comparable field-by-field.
      const legacy = version.legacy || (version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy)
      if (legacy) return { ...summary, changed: ['legacy'] }
      const entries = (value: PromptConfig) => ({ communication: value.communication, scope: value.scope, delivery: value.delivery,
        admissionRules: value.admissionRules === undefined ? undefined : JSON.stringify(value.admissionRules),
        ...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ['skill/' + name, text])),
        ...Object.fromEntries((value.disabledSkills ?? []).map(name => ['disabled-skill/' + name, 'true'])),
        // An override changes with its text or with the built-in text it was edited from.
        ...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)])) })
      const before = previous ? entries(previous) : {}
      const after = entries(config)
      const changed = previous ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before as Record<string, string>)[name] !== (after as Record<string, string>)[name]) : []
      return { ...summary, changed }
    })
    return { revisions, next_offset: offset + revisions.length <= latest ? offset + revisions.length : null }
  }
}
