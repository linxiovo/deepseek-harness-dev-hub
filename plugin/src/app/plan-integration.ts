import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
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
  controlBlocked(planId: string): boolean
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
type ReleasedView = Extract<PlanIntegrationView, { status: 'released' }>
type MissingReleaseArtifact = Extract<PlanIntegrationView, { status: 'released-artifact-unavailable' }>
const missingReleaseArtifact = (view: ReleasedView): MissingReleaseArtifact =>
  ({ ...view, status: 'released-artifact-unavailable', reason: 'artifact_unavailable', artifactAvailable: false })
const integrationContext = ({ projectId, workflowId, identityJob, jobs, artifactName, configuration, environment }: PlanVerificationConfig,
  repository: string, ref: string, sha: string): string => createHash('sha256').update(JSON.stringify([1, projectId, repository, ref, sha,
  workflowId, identityJob, [...jobs].sort(), artifactName, configuration, environment])).digest('hex')

/** Owns Plan-wide integration evidence, durable Actions dispatch and the only final Plan push. */
export class PlanIntegration {
  private readonly releases: PlanRelease

  constructor(private readonly host: IntegrationHost) {
    this.releases = new PlanRelease({ store: host.store, adapter: host.release, relay: host.relay, cancelRelay: host.cancelRelay,
      deliveryLink: host.deliveryLink, artifact: host.releaseArtifact,
      complete: view => { if (!this.completeRelease(view)) this.rearm(view.planId) },
      save: view => this.save(view), verifyEvidence: view => this.verifyReleaseEvidence(view),
      restartVerification: (view, reason) => this.restartVerification(view, reason),
      controlBlocked: host.controlBlocked,
      ready: planId => host.plans.requiredDelivery(planId)?.waitingFor.length === 0,
    })
    host.effects.handle('planIntegration', (_, id) => this.verify(id), { limit: () => host.paused() ? 0 : 4, retry: [15_000, 60_000] })
  }

  view(planId: string): PlanIntegrationView | undefined {
    const required = this.host.plans.requiredDelivery(planId)
    if (!required) return undefined
    const prior = this.host.store.get(KV.plans.integration(planId))
    if (required.waitingFor.length && !(prior && 'releaseId' in prior))
      return { planId, status: 'awaiting-tickets', waitingFor: required.waitingFor }
    if (integrated(prior)) {
      if (prior.status === 'released-artifact-unavailable' || this.retainedArtifactExists(prior)) return prior
      if (prior.status === 'released') return missingReleaseArtifact(prior)
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
    if (this.retainedArtifactExists(prior)) return true
    this.invalidateArtifact(prior)
    return false
  }

  /** Reconcile retained packages without discarding an already-started publication. */
  async resume(): Promise<void> {
    for (const { id } of this.host.plans.list()) {
      const prior = this.host.store.get(KV.plans.integration(id))
      if (integrated(prior)) {
        if (this.host.store.get(KV.plans.releaseIntent(id)) && !terminal(prior)) {
          this.rearm(id)
          continue
        }
        if (!await this.retainedArtifactAvailable(prior)) this.invalidateArtifact(prior)
        else if (!terminal(prior)) this.rearm(id)
      } else this.rearm(id)
    }
  }

  private save(view: PlanIntegrationView): void {
    this.host.store.set(KV.plans.integration(view.planId), view)
  }

  private invalidateArtifact(prior: IntegratedView): void {
    const { planId } = prior, { store } = this.host
    store.atomic(() => {
      if (store.get(KV.plans.releaseIntent(planId))) {
        this.host.cancelRelay(deliveryRelayId(planId))
        if (prior.status === 'released') this.save(missingReleaseArtifact(prior))
        if (prior.status === 'released' || !terminal(prior)) this.rearm(planId)
        return
      }
      this.restartVerification(prior, 'artifact_unavailable')
    })
  }

  private retainedArtifactExists(view: IntegratedView): boolean {
    try { return this.host.artifactExists(view.planId, view) }
    catch (error) {
      if (view.status === 'delivered') throw error
      return false
    }
  }

  private async retainedArtifactAvailable(view: IntegratedView): Promise<boolean> {
    try { return await this.host.artifactAvailable(view.planId, view) }
    catch (error) {
      if (view.status === 'delivered') throw error
      return false
    }
  }

  private completeRelease(view: ReleasedView): boolean {
    if (!this.retainedArtifactExists(view)) {
      this.save(missingReleaseArtifact(view))
      return false
    }
    this.save(view)
    this.deliver(view)
    return true
  }

  private async restoreReleaseArtifact(prior: MissingReleaseArtifact, verification: PlanVerificationConfig): Promise<void> {
    const { host } = this, { planId, artifact, version, run } = prior
    if (!await this.retainedArtifactAvailable(prior)) {
      const draft = await host.downloadArtifact(planId, { ...version, verification }, run, artifact)
      try {
        if (!isDeepStrictEqual(draft.artifact, artifact)) throw new Later('Downloaded artifact differs from the released package')
        host.lifetime.throwIfAborted()
        host.commitArtifact(draft)
      } finally { host.discardArtifact(draft) }
    }
    const { reason: _, artifactAvailable: __, ...receipt } = prior
    if (!host.store.atomic(() => this.completeRelease({ ...receipt, status: 'released' }))) throw new Later()
  }

  /** Rearm one durable verification/release intent after a matching scope resumes. */
  resumePlan(planId: string): void { if (!this.host.controlBlocked(planId)) this.rearm(planId) }
  private restartVerification({ planId, version, run }: IntegratedView, reason: 'artifact_unavailable' | 'regression_evidence_changed'): void {
    this.host.store.atomic(() => {
      this.save({ planId, status: 'blocked', reason, version, run })
      this.host.cancelRelay(deliveryRelayId(planId))
      this.host.cancelRelay(credentialRelayPrefix + planId)
      this.rearm(planId)
    })

  }

  private async verifyReleaseEvidence(prior: IntegratedView): Promise<PlanVerificationConfig | undefined> {
    const { host } = this, { verification } = host, target = host.target()
    if (!verification) return undefined
    if (!target) throw new Error('The integrated branch is unavailable')
    const required = host.plans.requiredDelivery(prior.planId)
    if (!required || required.waitingFor.length) return undefined
    const { repository, ref, sha, context } = prior.version
    if (target.slug.toLowerCase() !== repository || target.ref !== ref || integrationContext(verification, repository, ref, sha) !== context)
      return undefined
    const request: PlanVerificationRequest = { repository, ref, sha, context, verification }
    if (!await host.isLatestRun(request, prior.run)) return undefined
    this.active(target)
    const actual = await host.readTarget(target, required.integrations)
    this.active(target)
    if (actual.sha !== sha || !actual.includesIntegrations) return undefined
    const latest = await host.isLatestRun(request, prior.run)
    this.active(target)
    return latest && isDeepStrictEqual(host.plans.requiredDelivery(prior.planId), required) ? verification : undefined
  }

  private rearm(planId: string): void {
    const { verification, plans, effects } = this.host
    if (this.host.store.get(KV.plans.releaseIntent(planId)) || (verification && plans.requiredDelivery(planId)?.waitingFor.length === 0))
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
    const getHandoff = () => {
      const plan = host.plans.get(planId)
      return plan && host.handoffs.get(plan.handoffId)
    }
    if (intent && prior?.status === 'released-artifact-unavailable') return this.restoreReleaseArtifact(prior, intent.verification)
    if (intent && integrated(prior)) return this.releases.reconcile(prior, intent, getHandoff, () => {
      host.lifetime.throwIfAborted()
      if (host.paused()) throw new Later()
    })
    if (intent) throw new Error('Plan release intent has no integrated artifact record')
    const required = host.plans.requiredDelivery(planId)
    if (!required || required.waitingFor.length) return
    if (integrated(prior)) return this.releases.start(prior, getHandoff, () => {
      host.lifetime.throwIfAborted()
      if (host.paused()) throw new Later()
    })
    const handoff = getHandoff()
    if (!handoff) return
    if (!verification || handoff.project.id !== verification.projectId) return
    const retry = (view: PlanIntegrationView): never => { this.save(view); throw new Later() }
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
    const { workflowId, configuration, environment } = verification
    const context = integrationContext(verification, repository, ref, sha)
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
          this.save({ planId, status: 'verifying', version })
          return true
        })
        if (!first) throw new Later()
        try { await host.dispatch(request) }
        catch (error) {
          if (error instanceof CliError && error.code !== undefined && error.code >= 400 && error.code < 500 &&
              ![408, 425, 429].includes(error.code)) {
            store.atomic(() => {
              store.delete(dispatch)
              this.save({ planId, status: 'blocked', reason: 'actions_unavailable', version })
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
              this.save({ ...receipt, status: 'awaiting-release-verification' })
              host.effects.enqueue('planIntegration', planId, {})
            } else {
              this.save({ ...receipt, status: 'delivered' })
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
