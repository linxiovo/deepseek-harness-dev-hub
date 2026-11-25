import { createHash } from 'node:crypto'
import type { PlanActionsObservation, PlanArtifactReference, PlanIntegratedArtifact, PlanIntegrationVersion, PlanIntegrationView,
  PlanVerificationConfig, PlanVerificationRequest, PlanVerificationRun } from '../core/plan-integration.ts'
import type { PlanArtifactDraft } from './plan-artifacts.ts'
import { credentialRelayPrefix, PlanRelease, type ReleaseAdapter } from './plan-release.ts'
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
  plans: Pick<Plans, 'list' | 'get' | 'state' | 'requiredDelivery'>
  handoffs: Pick<Handoffs, 'get'>
  lifetime: AbortSignal
  verification?: PlanVerificationConfig
  release?: ReleaseAdapter
  releaseArtifact?: (planId: string, view: PlanIntegratedArtifact) => Promise<string | undefined>
  paused(): boolean
  target(): MainlineTarget | undefined
  readTarget(target: MainlineTarget, integrations: readonly string[]): Promise<{ sha: string; includesIntegrations: boolean }>
  observe(request: PlanVerificationRequest): Promise<PlanActionsObservation>
  isLatestRun(request: PlanVerificationRequest, run: PlanVerificationRun): Promise<boolean>
  downloadArtifact(planId: string, request: PlanVerificationRequest, run: PlanVerificationRun, artifact: PlanArtifactReference): Promise<PlanArtifactDraft>
  commitArtifact(draft: PlanArtifactDraft): void
  discardArtifact(draft: PlanArtifactDraft): void
  artifactAvailable(planId: string, view: Extract<PlanIntegrationView, { artifact: PlanIntegratedArtifact['artifact'] }>): Promise<boolean>
  artifactExists(planId: string, view: Extract<PlanIntegrationView, { artifact: PlanIntegratedArtifact['artifact'] }>): boolean
  dispatch(request: PlanVerificationRequest): Promise<void>
  deliveryLink(planId: string): string
  relay(message: Relay): void
  cancelRelay(id: string): void
}

const deliveryRelayPrefix = 'plan-delivered:'
const deliveryRelayId = (planId: string): string => deliveryRelayPrefix + planId
const terminal = (view: PlanIntegrationView | undefined): boolean =>
  view?.status === 'delivered' || view?.status === 'released' || view?.status === 'release-failed'
const integrated = (view: PlanIntegrationView | undefined): view is IntegratedView => !!view && 'artifact' in view
type IntegratedView = Extract<PlanIntegrationView, PlanIntegratedArtifact>

/** Owns Plan-wide integration evidence, durable Actions dispatch and the only final Plan push. */
export class PlanIntegration {
  private readonly releases: PlanRelease

  constructor(private readonly host: IntegrationHost) {
    this.releases = new PlanRelease({ store: host.store, adapter: host.release, relay: host.relay, cancelRelay: host.cancelRelay,
      deliveryLink: host.deliveryLink, artifact: host.releaseArtifact,
      complete: view => { if (host.artifactExists(view.planId, view)) this.deliver(view) },
      invalidate: view => this.invalidateArtifact(view),
    })
    host.effects.handle('planIntegration', (_, id) => this.verify(id), { limit: () => host.paused() ? 0 : 4, retry: [15_000, 60_000] })
  }

  view(planId: string): PlanIntegrationView | undefined {
    const required = this.host.plans.requiredDelivery(planId)
    if (!required) return undefined
    if (required.waitingFor.length) return { planId, status: 'awaiting-tickets', waitingFor: required.waitingFor }
    const prior = this.host.store.get(KV.plans.integration(planId))
    if (integrated(prior)) {
      if (this.host.artifactExists(planId, prior)) return prior
      if ('releaseId' in prior) return { ...prior, artifactAvailable: false }
      return { planId, status: 'blocked', reason: 'artifact_unavailable', version: prior.version, run: prior.run }
    }
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

  /** Check a Plan push at the Hub inbox boundary, after the Session and its history are ready. */
  relayAvailable(requestId: string): boolean {
    if (requestId.startsWith(credentialRelayPrefix))
      return this.view(requestId.slice(credentialRelayPrefix.length))?.status === 'awaiting-release-credentials'
    if (!requestId.startsWith(deliveryRelayPrefix)) return true
    const planId = requestId.slice(deliveryRelayPrefix.length)
    const prior = this.host.store.get(KV.plans.integration(planId))
    if (prior?.status !== 'delivered' && prior?.status !== 'released') return false
    if (this.host.artifactExists(planId, prior)) return true
    this.invalidateArtifact(prior)
    return false
  }

  /** Reconcile retained packages without discarding an already-started publication. */
  async resume(): Promise<void> {
    for (const { id } of this.host.plans.list()) {
      const prior = this.host.store.get(KV.plans.integration(id))
      if (integrated(prior)) {
        if (!await this.host.artifactAvailable(id, prior)) this.invalidateArtifact(prior)
        else if (!terminal(prior)) this.rearm(id)
      } else this.rearm(id)
    }
  }

  private invalidateArtifact(prior: IntegratedView): void {
    const { planId, version, run } = prior, { store } = this.host
    store.atomic(() => {
      if (store.get(KV.plans.releaseIntent(planId))) {
        this.host.cancelRelay(deliveryRelayId(planId))
        if (!terminal(prior)) this.rearm(planId)
        return
      }
      store.set(KV.plans.integration(planId), { planId, status: 'blocked', reason: 'artifact_unavailable', version, run })
      this.host.cancelRelay(deliveryRelayId(planId))
      this.rearm(planId)
    })
  }

  private rearm(planId: string): void {
    const { verification, plans, effects } = this.host
    if ((verification || this.host.store.get(KV.plans.releaseIntent(planId))) && plans.requiredDelivery(planId)?.waitingFor.length === 0)
      effects.enqueue('planIntegration', planId, {})
  }

  private active(target: MainlineTarget): void {
    this.host.lifetime.throwIfAborted()
    const current = this.host.target()
    if (this.host.paused() || current?.ref !== target.ref || current.repository !== target.repository || current.slug !== target.slug) throw new Later()
  }

  private async verify(planId: string): Promise<void | typeof Park> {
    const { host } = this, { store, verification } = host, slot = KV.plans.integration(planId)
    const prior = store.get(slot), intent = store.get(KV.plans.releaseIntent(planId))
    if (terminal(prior)) return
    const required = host.plans.requiredDelivery(planId), plan = host.plans.get(planId)
    if (!required || required.waitingFor.length || !plan) return
    if (intent && integrated(prior)) return this.releases.reconcile(prior, intent, () => {
      host.lifetime.throwIfAborted()
      if (host.paused()) throw new Later()
    })
    if (intent) throw new Error('Plan release intent has no integrated artifact record')
    const handoff = host.handoffs.get(plan.handoffId)
    if (!handoff) return
    if (integrated(prior)) return this.releases.start(prior, handoff, () => {
      host.lifetime.throwIfAborted()
      if (host.paused()) throw new Later()
    })
    if (!verification || handoff.project.id !== verification.projectId) return
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
    const { workflowId, identityJob, jobs, artifactName, configuration, environment } = verification
    const context = createHash('sha256').update(JSON.stringify([1, verification.projectId, repository, ref, sha, workflowId, identityJob,
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
          const confirmLatest = async (): Promise<boolean> => {
            let latest: boolean
            try { latest = await host.isLatestRun(request, run) }
            catch {
              this.active(target)
              return retry({ planId, status: 'blocked', reason: 'actions_unavailable', version, run })
            }
            this.active(target)
            if (!latest) host.effects.enqueue('planIntegration', planId, {})
            return latest
          }
          // The pre-download target read and these checks bracket the same Git/Actions identity.
          if (!await confirmLatest()) return
          await currentTip()
          if (!await confirmLatest()) return
          this.active(target)
          try { host.commitArtifact(draft) }
          catch { return retry({ planId, status: 'blocked', reason: 'artifact_unavailable', version, run }) }
          const receipt = { planId, version, run, artifact: draft.artifact, verifiedAt: new Date().toISOString() }
          store.atomic(() => {
            if (handoff.authorization.release === 'authorized') {
              store.set(slot, { ...receipt, status: 'awaiting-release-verification' })
              host.effects.enqueue('planIntegration', planId, {})
            } else {
              store.set(slot, { ...receipt, status: 'delivered' })
              this.deliver(receipt)
            }
          })
        } finally { host.discardArtifact(draft) }
      }
    }
  }

  private deliver(view: PlanIntegratedArtifact & { planId: string } | Extract<PlanIntegrationView, { status: 'released' }>): void {
    const { planId, version, artifact, run } = view
    const relay = projectPushRelay({ id: deliveryRelayId(planId), kind: 'plan-delivered', payload: {
      planId, version, artifact, verification: run.url,
      ...'deployment' in view ? { release: view.release, deployment: view.deployment, environmentVerification: view.verification } : {},
      read: `plan/${planId}/delivery`, harness: this.host.deliveryLink(planId),
    } })
    if (relay) this.host.relay(relay)
  }
}
