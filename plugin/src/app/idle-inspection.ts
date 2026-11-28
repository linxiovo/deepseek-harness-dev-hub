import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import type { InspectionObservation, ProjectRef } from '../core/handoff.ts'
import { key } from '../core/ids.ts'
import { PLAN_ROLES } from '../core/plan.ts'
import { inInspectionScope, inspectionCommit, inspectionFindingCurrent, readInspectionPath, validInspectionPath } from '../executor/inspection-git.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { InspectionGrant, RoleModel } from '../policy.ts'
import { Later, Park, type Effects } from './effects.ts'
import type { Handoffs } from './handoffs.ts'
import { InstallationError } from './installation-api.ts'
import type { Plans } from './plans.ts'
import type { ProjectMeter } from './project-meter.ts'
import type { BudgetView, RunLimits } from './run-limits.ts'
import type { Store } from './store.ts'

export interface InspectionTask {
  sessionId: string; scope: string; commit: string; sessionDirectory: string; hubSessionId: string; model: RoleModel | null; creationToken: string
}
export interface InspectionFindingInput { path: string; offset: number; evidence: string; summary: string }
export interface InspectionSchedule { nextDue: number | null; active?: string; last?: string; refused?: string }
export interface InspectionRun {
  sessionId: string; hubSessionId: string; creationToken: string; grant: InspectionGrant; model: RoleModel | null; baseRef: string
  startedAt: string; commit?: string; inspected?: true; endedAt?: string; reason?: string; todoIds?: string[]
  status: 'pending' | 'running' | 'completed' | 'withdrawn' | 'failed' | 'quota-paused'
}
const approvalText = z.string().trim().min(1).max(200)
const repairPath = z.string().max(1024).refine(path => validInspectionPath(path) && !path.includes('\uFFFD'))
export const InspectionRepairSchema = z.strictObject({ path: repairPath,
  sessionId: z.string().min(1).max(100), role: z.enum(PLAN_ROLES), goal: approvalText,
  supportingPaths: z.array(repairPath).max(16).optional(),
  check: z.strictObject({ seam: approvalText, observable: z.string().trim().min(1).max(1000) }) })
  .refine(({ path, supportingPaths }) => !supportingPaths || !supportingPaths.includes(path) && new Set(supportingPaths).size === supportingPaths.length)
export type InspectionRepairInput = z.infer<typeof InspectionRepairSchema>
export interface InspectionRepairApproval { planId: string; reused: boolean }
export interface InspectionTodo {
  id: string; projectId: string; path: string; evidence: string; summary: string
  first: InspectionObservation; latest: InspectionObservation; repairPlanId?: string
}
export interface InspectionView {
  grant: InspectionGrant | null; nextDueAt: string | null; budget: BudgetView | null; pausedReason: string | null
  lastRun: (Pick<InspectionRun, 'sessionId' | 'baseRef' | 'model' | 'status' | 'startedAt'> & {
    scope: string; commit: string | null; endedAt: string | null; reason: string | null; todoIds: string[]
  }) | null
  items: InspectionTodo[]; next_offset: number | null
}
interface Host {
  project: ProjectRef; sessionDirectory: string; commands: Commands; store: Store
  effects: Pick<Effects, 'handle' | 'enqueue' | 'cancel' | 'wakeParked' | 'pending'>
  meter: Pick<ProjectMeter, 'bind'>; limits: Pick<RunLimits, 'inspectionBudget' | 'view'>
  handoffs: Pick<Handoffs, 'get' | 'list' | 'recordStageTwo'>; plans: Pick<Plans, 'get' | 'state' | 'register'>
  stageTwo(): boolean; readyHub(): string | undefined; assertNewWork(): void
  relayConsumed(id: string): Promise<boolean>
  hub(): string | undefined; idle(): boolean; closing(): boolean
  deliver(sessionId: string): Promise<void>; modelAllowed(sessionId: string): boolean; cancel(sessionId: string): void
}

const repairRelayPrefix = 'inspection-repair:'
const repairNode = 'repair'

/** Runs read-only inspections and promotes their findings only through separate operator approval. */
export class IdleInspection {
  constructor(private readonly host: Host) {
    host.effects.handle('inspection', (_, id) => this.deliver(id), { limit: () => host.closing() ? 0 : 1 })
  }

  /** Called in the settings transaction, so revoke/regrant cannot resurrect an old Session between ticks. */
  configure(): void {
    const { store } = this.host, grant = store.settings().executor.idleInspection
    const prior = store.get(KV.inspection.schedule)
    if (prior?.active) this.end(prior.active, 'withdrawn', 'Inspection authorization changed')
    store.set(KV.inspection.schedule, { nextDue: grant ? Date.now() + grant.intervalSeconds * 1000 : null,
      ...(prior?.last && { last: prior.last }) })
  }

  async resume(): Promise<void> {
    const { store, effects } = this.host, schedule = store.get(KV.inspection.schedule)
    if (!schedule && store.settings().executor.idleInspection) this.configure()
    if (schedule?.active) {
      if (!effects.pending('inspection', schedule.active)) effects.enqueue('inspection', schedule.active, {})
      else effects.wakeParked('inspection')
    }
    if (!this.host.stageTwo()) return
    for (const handoff of this.host.handoffs.list()) {
      if (this.host.closing()) return
      const planId = handoff.id
      if (!handoff.inspectionRepair || !this.awaitingRepairClaim(planId)) continue
      const wake = KV.inspection.repairWake(planId), id = this.repairRelayId(planId)
      const consumed = await this.host.relayConsumed(id)
      store.atomic(() => {
        if (this.host.closing() || !this.awaitingRepairClaim(planId) || this.repairRelayId(planId) !== id) return
        if (consumed) {
          effects.cancel('relay', id)
          store.set(wake, `${repairRelayPrefix}${planId}:${randomUUID()}`)
        } else if (effects.pending('relay', id)) return
        this.relayRepair(planId)
      })
    }
  }

  private awaitingRepairClaim(planId: string): boolean {
    return !this.host.plans.state(planId, repairNode) && this.host.plans.get(planId)?.nodes.some(node => node.id === repairNode) === true
  }

  private repairRelayId(planId: string): string {
    return this.host.store.get(KV.inspection.repairWake(planId)) ?? `${repairRelayPrefix}${planId}`
  }

  private relayRepair(planId: string): void {
    this.host.effects.enqueue('relay', this.repairRelayId(planId), {
      text: JSON.stringify({ kind: 'inspection-repair-approved', planId, nodeId: repairNode, read: `plan/${planId}` }),
    })
  }

  relayAvailable(id: string): boolean {
    if (!id.startsWith(repairRelayPrefix)) return true
    const planId = id.slice(repairRelayPrefix.length).split(':', 1)[0]!
    return this.awaitingRepairClaim(planId) && this.repairRelayId(planId) === id
  }

  tick(): void {
    const { host } = this, { store } = host, schedule = store.get(KV.inspection.schedule)
    if (!schedule || schedule.nextDue === null || host.closing()) return
    if (schedule.active) {
      const hold = this.activeQuotaHold(schedule.active)
      if (hold) this.quotaRefused(schedule.active, hold)
      else if (!host.idle()) this.end(schedule.active, 'withdrawn', 'Authorized project work or a pause took precedence')
      return
    }
    const now = Date.now()
    if (schedule.refused || now < schedule.nextDue || !host.idle()) return
    const { idleInspection: grant, baseRef, lightweightModel } = store.settings().executor, hubSessionId = host.hub()
    if (!grant || !baseRef || !hubSessionId) return
    const budget = host.limits.inspectionBudget(grant.scope, grant.maxTokens), projectState = host.limits.view()?.budget.state
    if (budget.state !== 'available' || (projectState !== 'available' && projectState !== 'unlimited')) return
    store.atomic(() => {
      const sessionId = `inspection-${randomUUID()}`
      store.set(KV.inspection.run(sessionId), { sessionId, hubSessionId, creationToken: randomUUID(), grant, baseRef,
        model: lightweightModel ?? null, startedAt: new Date(now).toISOString(), status: 'pending' })
      store.set(KV.inspection.schedule, { active: sessionId, last: sessionId, nextDue: now + grant.intervalSeconds * 1000 })
      host.meter.bind({ session_id: sessionId, parent_session_id: hubSessionId, role: 'inspection' })
      host.effects.enqueue('inspection', sessionId, {})
    })
  }

  private activeQuotaHold(id: string): string | undefined {
    const { store, limits } = this.host, run = store.get(KV.inspection.run(id))
    if (!run) return undefined
    const { scope, maxTokens } = run.grant
    const scoped = limits.inspectionBudget(scope, maxTokens).state
    if (scoped === 'exhausted' || scoped === 'usage-missing') return scoped
    const project = limits.view()?.budget.state
    if (project === 'exhausted' || project === 'usage-missing') return `Project budget: ${project}`
  }

  private current(id: string): InspectionRun | undefined {
    const { store } = this.host
    if (this.host.closing() || store.get(KV.inspection.schedule)?.active !== id || !this.host.idle()) return undefined
    const run = store.get(KV.inspection.run(id))
    return run?.status === 'pending' || run?.status === 'running' ? run : undefined
  }

  task(id: string): InspectionTask | undefined {
    const run = this.current(id)
    return run?.commit ? { sessionId: id, hubSessionId: run.hubSessionId, creationToken: run.creationToken, scope: run.grant.scope,
      commit: run.commit, model: run.model, sessionDirectory: this.host.sessionDirectory } : undefined
  }

  private async deliver(id: string): Promise<void | typeof Park> {
    const { host } = this
    try {
      const run = this.current(id)
      if (!run) {
        if (!host.closing()) this.end(id, 'withdrawn', 'Project is not idle')
        return
      }
      const hold = this.activeQuotaHold(id)
      if (hold) return this.quotaRefused(id, hold)
      if (!run.commit) {
        const commit = await inspectionCommit(host.commands, host.project, run.baseRef, run.grant.scope)
        if (!this.current(id)) return
        const currentHold = this.activeQuotaHold(id)
        if (currentHold) return this.quotaRefused(id, currentHold)
        host.store.set(KV.inspection.run(id), { ...run, commit, status: 'running' })
      }
      mkdirSync(host.sessionDirectory, { recursive: true, mode: 0o700 })
      await host.deliver(id)
      if (host.store.get(KV.inspection.schedule)?.active === id) return Park
    } catch (error) {
      if (error instanceof Later) throw error
      if (!host.closing()) this.abandon(id, error instanceof Error ? error.message : String(error))
    } finally {
      if (!host.closing() && host.store.get(KV.inspection.schedule)?.active === id && !this.current(id)) {
        this.end(id, 'withdrawn', 'Project is not idle')
      }
    }
  }

  private authorized(id: string): InspectionTask {
    const task = this.task(id)
    if (!task || !this.host.modelAllowed(id)) throw new Error('Inspection Session no longer has its authorized task')
    return task
  }

  async read(id: string, path: string, offset: number) {
    const { host } = this, task = this.authorized(id)
    const page = await readInspectionPath(host.commands, host.project, task.commit, task.scope, path, offset)
    this.authorized(id)
    host.store.atomic(() => {
      const inspected = page.kind === 'file' ? page.text.length > 0 || offset === 0 : !page.entries.length && offset === 0
      if (page.kind === 'file' && inspected) host.store.set(KV.inspection.page(id, path, offset), true)
      if (inspected) {
        const run = host.store.get(KV.inspection.run(id))!
        if (!run.inspected) host.store.set(KV.inspection.run(id), { ...run, inspected: true })
      }
    })
    return page
  }

  async finish(id: string, findings: InspectionFindingInput[], assertNativeCall: () => void): Promise<void> {
    const { host } = this, { store } = host, task = this.authorized(id)
    if (!store.get(KV.inspection.run(id))?.inspected) throw new Error('Read the authorized content before completing an inspection')
    const observed = new Map<string, InspectionFindingInput>()
    for (const finding of findings) {
      const { path, offset, evidence } = finding
      this.authorized(id)
      if (!store.get(KV.inspection.page(id, path, offset))) throw new Error('Finding must cite a file page read in this Session')
      const page = await readInspectionPath(host.commands, host.project, task.commit, task.scope, path, offset)
      const position = page.kind === 'file' && evidence.trim() ? page.text.indexOf(evidence) : -1
      if (page.kind !== 'file' || position === -1) throw new Error('Evidence must quote the inspected file page')
      const start = position === 0 ? 0 : page.text.lastIndexOf('\n', position - 1) + 1
      const end = page.text.indexOf('\n', position + evidence.length)
      const line = page.text.slice(start, end === -1 ? undefined : end).trim()
      const todoId = key('inspection-finding', host.project.id, path, line)
      if (!observed.has(todoId)) observed.set(todoId, finding)
    }
    store.atomic(() => {
      this.authorized(id)
      assertNativeCall()
      const latest: InspectionObservation = { sessionId: id, scope: task.scope, commit: task.commit, at: new Date().toISOString() }
      for (const [todoId, { path, evidence, summary }] of observed) {
        const todoKey = KV.inspection.todo(todoId)
        const prior = store.get(todoKey)
        store.set(todoKey, prior ? { ...prior, latest } : { id: todoId, projectId: host.project.id, path, evidence, summary, first: latest, latest })
      }
      this.end(id, 'completed', undefined, [...observed.keys()])
    })
  }

  abandon(id: string, reason: string): void { this.end(id, 'failed', reason) }
  quotaRefused(id: string, reason: string): void { this.end(id, 'quota-paused', reason) }

  private end(id: string, status: 'completed' | 'withdrawn' | 'failed' | 'quota-paused', reason?: string, todoIds?: string[]): void {
    const { store, effects } = this.host
    store.atomic(() => {
      const schedule = store.get(KV.inspection.schedule), run = store.get(KV.inspection.run(id))
      if (!run || schedule?.active !== id) return
      store.set(KV.inspection.run(id), { ...run, status, endedAt: new Date().toISOString(), ...(reason && { reason: reason.slice(0, 500) }),
        ...(todoIds && { todoIds }) })
      store.set(KV.inspection.schedule, { nextDue: schedule.nextDue, last: id, ...(status === 'quota-paused' && { refused: reason }) })
      effects.cancel('inspection', id)
      for (const page of store.keys(`${KV.inspection.page.prefix}${id}:`)) store.delete(page)
      if (status !== 'completed') store.afterCommit(() => this.host.cancel(id))
    })
  }

  async approveRepair(todoId: string, { path, sessionId, role, goal, check, supportingPaths = [] }: InspectionRepairInput): Promise<InspectionRepairApproval> {
    const { host } = this, { store, project, handoffs } = host, todoKey = KV.inspection.todo(todoId)
    const finding = () => {
      const todo = store.get(todoKey)
      if (!todo || todo.projectId !== project.id) throw new InstallationError(404, 'inspectionFindingNotFound')
      if (path !== todo.path) throw new InstallationError(409, 'inspectionRepairConflict', 'Approval must name the exact finding path.')
      return todo
    }
    const before = finding(), run = store.get(KV.inspection.run(sessionId))
    if (!before.repairPlanId) {
      if (before.latest.sessionId !== sessionId || run?.status !== 'completed' || run.commit !== before.latest.commit ||
          run.grant.scope !== before.latest.scope || !run.todoIds?.includes(todoId) || !inInspectionScope(path, before.latest.scope) ||
          run.baseRef !== store.settings().executor.baseRef) {
        throw new InstallationError(409, 'inspectionRepairConflict', 'Approval must match the finding’s latest in-scope observation on the configured ref.')
      }
      const freshness = await inspectionFindingCurrent(host.commands, project, run.baseRef, before.latest.commit, path)
      if (freshness !== 'current') throw new InstallationError(409, 'inspectionRepairConflict', freshness === 'ref-moved'
        ? 'The target ref moved during approval; retry against the current target.'
        : 'The observed file changed or disappeared; inspect it again before approving repair.')
    }
    return store.atomic(() => {
      host.assertNewWork()
      const todo = finding()
      if (todo.repairPlanId) {
        const prior = handoffs.get(todo.repairPlanId), receipt = prior?.inspectionRepair, criterion = prior?.spec?.acceptance[0]
        if (receipt?.observation.sessionId !== sessionId || prior?.goal !== goal || criterion?.delivery !== role ||
            criterion.observable !== check.observable || prior.spec?.testInterfaces[0]?.seam !== check.seam ||
            receipt.supportingPaths.length !== supportingPaths.length || supportingPaths.some(path => !receipt.supportingPaths.includes(path))) {
          throw new InstallationError(409, 'inspectionRepairConflict', 'This finding already has a different repair approval.')
        }
        return { planId: todo.repairPlanId, reused: true }
      }
      const hubSessionId = host.readyHub()
      if (!host.stageTwo() || host.closing() || !hubSessionId) {
        throw new InstallationError(409, 'inspectionRepairConflict', 'Repair approval requires Stage 2 and a ready Hub.')
      }
      const { latest } = todo
      if (!run || latest.sessionId !== sessionId || latest.commit !== before.latest.commit || run.baseRef !== store.settings().executor.baseRef) {
        throw new InstallationError(409, 'inspectionRepairConflict', 'The observation or target changed during approval.')
      }
      const spec = handoffs.recordStageTwo({ inspectionRepair: { todoId, observation: latest, hubSessionId,
        baseRef: run.baseRef, supportingPaths, approvedAt: new Date().toISOString() } }, { scope: path, goal, constraints: [] }, {
        body: goal, acceptance: [{ statement: goal, observable: check.observable, delivery: role }],
        testInterfaces: [{ seam: check.seam, kind: 'proposed', note: check.observable }], outOfScope: [],
      })
      const { id: planId } = host.plans.register(spec.handoffId, spec.id, {
        features: [{ id: repairNode, kind: role }],
        nodes: [{ id: repairNode, featureId: repairNode, title: goal, role, acceptance: [1], demonstration: check.observable, blockedBy: [] }],
      })
      store.set(todoKey, { ...todo, repairPlanId: planId })
      this.relayRepair(planId)
      return { planId, reused: false }
    })
  }

  view(offset = 0, limit = 20): InspectionView {
    const { store, limits } = this.host, schedule = store.get(KV.inspection.schedule), grant = store.settings().executor.idleInspection ?? null
    const run = schedule?.last ? store.get(KV.inspection.run(schedule.last)) : undefined
    const keys = store.keys(KV.inspection.todo).sort(), end = offset + limit
    const budget = grant ? limits.inspectionBudget(grant.scope, grant.maxTokens) : null
    return { grant, nextDueAt: schedule?.nextDue ? new Date(schedule.nextDue).toISOString() : null,
      budget, pausedReason: schedule?.refused ?? (budget?.state === 'exhausted' || budget?.state === 'usage-missing' ? budget.state : null),
      lastRun: run ? { sessionId: run.sessionId, scope: run.grant.scope, baseRef: run.baseRef, commit: run.commit ?? null, model: run.model,
        status: run.status, startedAt: run.startedAt, endedAt: run.endedAt ?? null, reason: run.reason ?? null, todoIds: run.todoIds ?? [] } : null,
      items: keys.slice(offset, end).map(k => store.get(k)!), next_offset: end < keys.length ? end : null }
  }
}
