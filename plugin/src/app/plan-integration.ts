import { createHash } from 'node:crypto'
import type { PlanActionsObservation, PlanIntegrationVersion, PlanIntegrationView, PlanVerificationConfig, PlanVerificationRequest } from '../core/plan-integration.ts'
import type { MainlineTarget } from '../executor/mainline-git.ts'
import { KV } from '../kv.ts'
import { Later, type Effects } from './effects.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import type { Plans } from './plans.ts'
import type { Handoffs } from './handoffs.ts'
import type { Store } from './store.ts'

interface IntegrationHost {
  store: Pick<Store, 'atomic' | 'get' | 'set'>
  effects: Pick<Effects, 'handle' | 'enqueue' | 'pending'>
  plans: Pick<Plans, 'list' | 'requiredDelivery'>
  handoffs: Pick<Handoffs, 'get'>
  lifetime: AbortSignal
  verification?: PlanVerificationConfig
  paused(): boolean
  target(): MainlineTarget | undefined
  readTarget(target: MainlineTarget, integrations: readonly string[]): Promise<{ sha: string; includesIntegrations: boolean }>
  observe(request: PlanVerificationRequest): Promise<PlanActionsObservation>
  dispatch(request: PlanVerificationRequest): Promise<void>
  relay(message: Relay): void
}

const terminal = (view: PlanIntegrationView | undefined) =>
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
    if (terminal(prior)) return prior
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

  /** Resume unfinished registered Plans, including those formally closed before verification was configured. */
  resume(): void {
    if (!this.host.verification) return
    for (const { id } of this.host.plans.list()) {
      if (!terminal(this.host.store.get(KV.plans.integration(id)))) {
        const required = this.host.plans.requiredDelivery(id)
        if (required && !required.waitingFor.length) this.host.effects.enqueue('planIntegration', id, {})
      }
    }
  }

  private active(target: MainlineTarget): void {
    this.host.lifetime.throwIfAborted()
    const current = this.host.target()
    if (this.host.paused() || current?.ref !== target.ref || current.repository !== target.repository || current.slug !== target.slug) throw new Later()
  }

  private async verify(planId: string): Promise<void> {
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
        catch {
          this.active(target)
          return retry({ planId, status: 'blocked', reason: 'dispatch_unconfirmed', version })
        }
        this.active(target)
        return retry({ planId, status: 'verifying', version })
      }
      case 'pending': return retry({ planId, status: 'verifying', version, run: observed.run })
      case 'failed': return retry({ planId, status: 'blocked', reason: observed.reason, version, run: observed.run })
      case 'passed': {
        const { run, artifact } = observed
        const status = handoff.authorization.release === 'authorized' ? 'awaiting-release-verification' : 'delivered'
        const verifiedAt = new Date().toISOString()
        store.atomic(() => {
          store.set(slot, { planId, status, version, run, artifact, verifiedAt })
          if (status !== 'delivered') return
          const relay = projectPushRelay({ id: `plan-delivered:${planId}`, kind: 'plan-delivered', payload: {
            planId, version, artifact, verification: run.url, read: `plan/${planId}/delivery`,
          } })
          if (relay) host.relay(relay)
        })
      }
    }
  }
}
