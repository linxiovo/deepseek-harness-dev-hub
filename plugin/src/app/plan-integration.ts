import { createHash } from 'node:crypto'
import type { PlanActionsObservation, PlanArtifactReference, PlanIntegrationVersion, PlanIntegrationView, PlanVerificationConfig, PlanVerificationRequest, PlanVerificationRun } from '../core/plan-integration.ts'
import type { PlanArtifactDraft } from './plan-artifacts.ts'
import type { MainlineTarget } from '../executor/mainline-git.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { Later, Park, type Effects } from './effects.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import type { Plans } from './plans.ts'
import type { Handoffs } from './handoffs.ts'
import type { Store } from './store.ts'

interface IntegrationHost {
  store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete'>
  effects: Pick<Effects, 'handle' | 'enqueue' | 'pending'>
  plans: Pick<Plans, 'list' | 'requiredDelivery'>
  handoffs: Pick<Handoffs, 'get'>
  lifetime: AbortSignal
  verification?: PlanVerificationConfig
  paused(): boolean
  target(): MainlineTarget | undefined
  readTarget(target: MainlineTarget, integrations: readonly string[]): Promise<{ sha: string; includesIntegrations: boolean }>
  observe(request: PlanVerificationRequest): Promise<PlanActionsObservation>
  isLatestRun(request: PlanVerificationRequest, run: PlanVerificationRun): Promise<boolean>
  downloadArtifact(planId: string, request: PlanVerificationRequest, run: PlanVerificationRun, artifact: PlanArtifactReference): Promise<PlanArtifactDraft>
  commitArtifact(draft: PlanArtifactDraft): void
  discardArtifact(draft: PlanArtifactDraft): void
  artifactAvailable(planId: string, view: Extract<PlanIntegrationView, { status: 'delivered' | 'awaiting-release-verification' }>): Promise<boolean>
  artifactExists(planId: string, view: Extract<PlanIntegrationView, { status: 'delivered' | 'awaiting-release-verification' }>): boolean
  dispatch(request: PlanVerificationRequest): Promise<void>
  relay(message: Relay): void
}

const terminal = (view: PlanIntegrationView | undefined): view is Extract<PlanIntegrationView, { status: 'delivered' | 'awaiting-release-verification' }> =>
  view?.status === 'delivered' || view?.status === 'awaiting-release-verification'

/** Owns Plan-wide integration evidence, durable Actions dispatch and the only final Plan push. */
export class PlanIntegration {
  constructor(private readonly host: IntegrationHost) {
    host.effects.handle('planIntegration', (_, id) => this.verify(id), { limit: () => host.paused() ? 0 : 4, retry: [15_000, 60_000] })
  }

  view(planId: string): PlanIntegrationView | undefined {
    const required = this.host.plans.requiredDelivery(planId)
    if (!required) return undefined
    if (required.waitingFor.length) return { planId, status: 'awaiting-tickets', waitingFor: required.waitingFor }
    const prior = this.host.store.get(KV.plans.integration(planId))
    if (terminal(prior)) return this.host.artifactExists(planId, prior) ? prior
      : { planId, status: 'blocked', reason: 'artifact_unavailable', version: prior.version, run: prior.run }
    if (!this.host.verification) return { planId, status: 'blocked', reason: 'verification_unconfigured' }
    return prior ?? { planId, status: 'blocked', reason: 'integration_unavailable' }
  }

  /** Called in the formal closure transaction; an incomplete Plan cannot enqueue verification. */
  enqueue(planId: string): void {
    const { verification, effects, plans, store } = this.host
    const ready = verification && plans.requiredDelivery(planId)
    if (ready && !ready.waitingFor.length && !terminal(store.get(KV.plans.integration(planId))) && !effects.pending('planIntegration', planId))
      effects.enqueue('planIntegration', planId, {})
  }

  /** Reconcile terminal receipts with retained package bytes and rearm unfinished Plans. */
  async resume(): Promise<void> {
    for (const { id } of this.host.plans.list()) {
      const slot = KV.plans.integration(id), prior = this.host.store.get(slot)
      if (terminal(prior)) {
        if (await this.host.artifactAvailable(id, prior)) continue
        this.host.store.set(slot, { planId: id, status: 'blocked', reason: 'artifact_unavailable', version: prior.version, run: prior.run })
      }
      if (!this.host.verification) continue
      const required = this.host.plans.requiredDelivery(id)
      if (required && !required.waitingFor.length) this.host.effects.enqueue('planIntegration', id, {})
    }
  }

  private active(target: MainlineTarget): void {
    this.host.lifetime.throwIfAborted()
    const current = this.host.target()
    if (this.host.paused() || current?.ref !== target.ref || current.repository !== target.repository || current.slug !== target.slug) throw new Later()
  }

  private async verify(planId: string): Promise<void | typeof Park> {
    const { host } = this, { store, verification } = host, slot = KV.plans.integration(planId)
    if (!verification || terminal(store.get(slot))) return
    const required = host.plans.requiredDelivery(planId), handoff = host.handoffs.get(planId)
    if (!required || required.waitingFor.length || !handoff || handoff.project.id !== verification.projectId) return
    const retry = (view: PlanIntegrationView): never => { store.set(slot, view); throw new Later() }
    const target = host.target()
    if (!target) return retry({ planId, status: 'blocked', reason: 'integration_unavailable' })
    const targetObservation = async (integrations: readonly string[]) => {
      try { return await host.readTarget(target, integrations) }
      catch {
        this.active(target)
        return retry({ planId, status: 'blocked', reason: 'integration_unavailable' })
      }
    }
    const { sha, includesIntegrations } = await targetObservation(required.integrations)
    this.active(target)
    if (!includesIntegrations) return retry({ planId, status: 'blocked', reason: 'integration_not_on_target' })
    const repository = target.slug.toLowerCase(), { ref } = target
    const { workflowId, jobs, artifactName, configuration, environment } = verification
    const context = createHash('sha256').update(JSON.stringify([1, verification.projectId, repository, ref, sha, workflowId,
      [...jobs].sort(), artifactName, configuration, environment])).digest('hex')
    const version: PlanIntegrationVersion = { repository, ref, sha, context, workflowId, configuration, environment }
    const request: PlanVerificationRequest = { repository, ref, sha, context, verification }
    const currentTip = async () => {
      const observed = await targetObservation([])
      this.active(target)
      if (observed.sha !== sha) return retry({ planId, status: 'blocked', reason: 'target_changed', version })
    }
    let observed: PlanActionsObservation
    try { observed = await host.observe(request) }
    catch {
      this.active(target)
      return retry({ planId, status: 'blocked', reason: 'actions_unavailable', version })
    }
    this.active(target)
    await currentTip()
    switch (observed.status) {
      case 'missing': {
        const dispatch = KV.plans.integrationDispatch(context)
        if (store.get(dispatch)) return retry({ planId, status: 'blocked', reason: 'dispatch_unconfirmed', version })
        await currentTip()
        const first = store.atomic(() => {
          if (store.get(dispatch)) return false
          store.set(dispatch, true)
          store.set(slot, { planId, status: 'verifying', version })
          return true
        })
        if (!first) throw new Later()
        try { await host.dispatch(request) }
        catch (error) {
          if (error instanceof CliError && error.code !== undefined && error.code >= 400 && error.code < 500 &&
              ![408, 425, 429].includes(error.code)) {
            store.atomic(() => {
              store.delete(dispatch)
              store.set(slot, { planId, status: 'blocked', reason: 'actions_unavailable', version })
            })
            return Park
          }
          this.active(target)
          return retry({ planId, status: 'blocked', reason: 'dispatch_unconfirmed', version })
        }
        this.active(target)
        host.effects.enqueue('planIntegration', planId, {})
        return
      }
      case 'pending': return retry({ planId, status: 'verifying', version, run: observed.run })
      case 'failed': return retry({ planId, status: 'blocked', reason: observed.reason, version, run: observed.run })
      case 'passed': {
        const { run, artifact } = observed
        let draft: PlanArtifactDraft
        try { draft = await host.downloadArtifact(planId, request, run, artifact) }
        catch {
          this.active(target)
          return retry({ planId, status: 'blocked', reason: 'artifact_unavailable', version, run })
        }
        try {
          await currentTip()
          let latest: boolean
          try { latest = await host.isLatestRun(request, run) }
          catch {
            this.active(target)
            return retry({ planId, status: 'blocked', reason: 'actions_unavailable', version, run })
          }
          if (!latest) {
            host.effects.enqueue('planIntegration', planId, {})
            return
          }
          this.active(target)
          try { host.commitArtifact(draft) }
          catch { return retry({ planId, status: 'blocked', reason: 'artifact_unavailable', version, run }) }
          const status = handoff.authorization.release === 'authorized' ? 'awaiting-release-verification' : 'delivered'
          const verifiedAt = new Date().toISOString()
          store.atomic(() => {
            store.set(slot, { planId, status, version, run, artifact: draft.artifact, verifiedAt })
            if (status !== 'delivered') return
            const relay = projectPushRelay({ id: `plan-delivered:${planId}`, kind: 'plan-delivered', payload: {
              planId, version, artifact: draft.artifact, verification: run.url, read: `plan/${planId}/delivery`,
            } })
            if (relay) host.relay(relay)
          })
        } finally { host.discardArtifact(draft) }
      }
    }
  }
}
