import { key } from '../core/ids.ts'
import type { Handoff, ReleaseTarget } from '../core/handoff.ts'
import type { PlanIntegratedArtifact, PlanIntegrationView, PlanReleaseConfig, PlanReleaseIntent, PlanReleaseObservation,
  PlanReleaseRequest } from '../core/plan-integration.ts'
import { KV } from '../kv.ts'
import { Later, Park } from './effects.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import { promptFile } from './skill-files.ts'
import type { Store } from './store.ts'

export interface ReleaseAdapter {
  config: PlanReleaseConfig
  credentialAvailable(request: PlanReleaseRequest): Promise<boolean>
  publish(request: PlanReleaseRequest, artifactPath: string): Promise<PlanReleaseObservation>
  observe(request: PlanReleaseRequest): Promise<PlanReleaseObservation>
}

type IntegratedView = Extract<PlanIntegrationView, PlanIntegratedArtifact>
type ReleasedView = Extract<PlanIntegrationView, { status: 'released' }>
interface ReleaseHost {
  store: Pick<Store, 'get' | 'set' | 'delete' | 'atomic'>
  adapter?: ReleaseAdapter
  artifact?(planId: string, view: PlanIntegratedArtifact): Promise<string | undefined>
  invalidate(view: IntegratedView): void
  complete(view: ReleasedView): void
  deliveryLink(planId: string): string
  relay(message: Relay): void
  cancelRelay(id: string): void
}

export const credentialRelayPrefix = 'plan-release-credential:'
const credentialPrompt = promptFile('plan-release-credential')
const sameTarget = (a: ReleaseTarget, b: ReleaseTarget): boolean =>
  a.environment === b.environment && a.target === b.target && a.scope === b.scope
const matchesRequest = (request: PlanReleaseRequest, observation: PlanReleaseObservation): boolean =>
  observation.requestId === request.id && sameTarget(observation.target, request.target)
const adapterId = (config: PlanReleaseConfig): string => key('release-adapter', config.executable, JSON.stringify(config.args), config.credentialId)

/** Publishes verified packages under durable intents and reconciles the exact deployment before completion. */
export class PlanRelease {
  constructor(private readonly host: ReleaseHost) {}

  async start(prior: IntegratedView, handoff: Handoff, active: () => void): Promise<void | typeof Park> {
    const { host } = this, { store, adapter } = host, { planId, version, run, artifact, verifiedAt } = prior
    const slot = KV.plans.integration(planId), intentKey = KV.plans.releaseIntent(planId)
    const base = { planId, version, run, artifact, verifiedAt }
    const release = handoff.authorization.release === 'authorized' ? handoff.authorization.releaseTarget : undefined
    if (!release) {
      store.set(slot, { ...base, status: 'release-blocked', reason: 'authorization_missing' })
      return Park
    }
    if (!adapter || adapter.config.projectId !== handoff.project.id) {
      store.set(slot, { ...base, status: 'release-blocked', release, reason: 'release_unconfigured' })
      return Park
    }
    if (handoff.project.repository.toLowerCase() !== version.repository || !sameTarget(release, adapter.config)) {
      store.set(slot, { ...base, status: 'release-blocked', release, reason: 'target_scope_mismatch' })
      return Park
    }
    active()
    const request: PlanReleaseRequest = {
      id: key('plan-release', handoff.project.id, planId, version.context, String(run.id), String(run.attempt), String(artifact.id), artifact.sha256,
        release.environment, release.target, release.scope), planId, projectId: handoff.project.id, target: release, version,
      run: { id: run.id, attempt: run.attempt }, artifact: { id: artifact.id, name: artifact.name, sha256: artifact.sha256,
        size: artifact.size, fileName: artifact.fileName, contentType: artifact.contentType },
    }
    const lock = KV.plans.releaseActive(request.projectId, release.environment, release.target)
    if (store.get(lock)) {
      store.set(slot, { ...base, status: 'release-blocked', release, reason: 'release_busy' })
      throw new Later()
    }
    let available: boolean
    try { available = await adapter.credentialAvailable(request) }
    catch {
      active()
      store.set(slot, { ...base, status: 'release-blocked', release, reason: 'release_unavailable' })
      throw new Later()
    }
    active()
    const credentialRelay = credentialRelayPrefix + planId
    if (!available) return this.awaitCredentials(prior, request, adapter.config)
    let path: string | undefined
    try { path = await host.artifact?.(planId, prior) }
    catch {
      active()
      store.set(slot, { ...base, status: 'release-blocked', release, reason: 'release_unavailable' })
      throw new Later()
    }
    active()
    if (!path) { host.invalidate(prior); return }
    const intent: PlanReleaseIntent = { request, adapter: adapterId(adapter.config) }
    const publishing = { ...base, status: 'releasing' as const, release, releaseId: request.id }
    const acquired = store.atomic(() => {
      if (store.get(intentKey) || store.get(lock)) return false
      store.set(intentKey, intent)
      store.set(lock, request.id)
      store.set(slot, publishing)
      host.cancelRelay(credentialRelay)
      return true
    })
    if (!acquired) throw new Later()
    let observation: PlanReleaseObservation
    try { observation = await adapter.publish(request, path) }
    catch {
      store.set(slot, { ...publishing, reason: 'dispatch_unconfirmed' })
      throw new Later()
    }
    active()
    return this.record(publishing, request, observation)
  }

  async reconcile(prior: IntegratedView, intent: PlanReleaseIntent, active: () => void): Promise<void | typeof Park> {
    const { adapter } = this.host, { request } = intent
    if (!adapter || adapter.config.projectId !== request.projectId || !sameTarget(adapter.config, request.target) || adapterId(adapter.config) !== intent.adapter)
      return this.unavailable(prior, request, 'release_configuration_changed')
    active()
    let observation: PlanReleaseObservation
    try { observation = await adapter.observe(request) }
    catch { return this.unavailable(prior, request, 'release_unavailable') }
    active()
    if (observation.status === 'missing' && prior.status !== 'released-unverified') {
      if (!matchesRequest(request, observation)) return this.unavailable(prior, request, 'release_unavailable')
      let path: string | undefined
      try { path = await this.host.artifact?.(request.planId, prior) }
      catch { return this.unavailable(prior, request, 'release_unavailable') }
      active()
      if (!path) return this.blockUnavailable(prior, request)
      let credentialsAvailable: boolean
      try { credentialsAvailable = await adapter.credentialAvailable(request) }
      catch { return this.unavailable(prior, request, 'release_unavailable') }
      active()
      if (!credentialsAvailable) return this.awaitCredentials(prior, request, adapter.config)
      const { store } = this.host, { planId, target: release, id: releaseId } = request
      const { version, run, artifact, verifiedAt } = prior
      store.atomic(() => {
        store.set(KV.plans.integration(planId), { planId, version, run, artifact, verifiedAt, status: 'releasing', release, releaseId })
        this.host.cancelRelay(credentialRelayPrefix + planId)
      })
      try { observation = await adapter.publish(request, path) }
      catch { return this.unavailable(prior, request, 'release_unavailable') }
      active()
    }
    return this.record(prior, request, observation)
  }

  private awaitCredentials(prior: IntegratedView, request: PlanReleaseRequest, config: PlanReleaseConfig): never {
    const { store } = this.host, slot = KV.plans.integration(request.planId)
    const credential = { id: config.credentialId, providerUrl: config.credentialProviderUrl }
    store.atomic(() => {
      store.set(slot, { planId: prior.planId, version: prior.version, run: prior.run, artifact: prior.artifact, verifiedAt: prior.verifiedAt,
        status: 'awaiting-release-credentials', release: request.target, credential })
      if (prior.status === 'awaiting-release-credentials') return
      const relay = projectPushRelay({ id: credentialRelayPrefix + request.planId, kind: 'human-action', payload: {
        planId: request.planId, release: request.target, credential, request: credentialPrompt,
        read: `plan/${request.planId}/delivery`, harness: this.host.deliveryLink(request.planId),
      } })
      if (relay) this.host.relay(relay)
    })
    throw new Later()
  }

  private blockUnavailable(prior: IntegratedView, request: PlanReleaseRequest): typeof Park {
    this.host.store.set(KV.plans.integration(request.planId), { ...prior, status: 'release-blocked',
      release: request.target, reason: 'release_unavailable' })
    return Park
  }

  private unavailable(prior: IntegratedView, request: PlanReleaseRequest, reason: 'release_unavailable' | 'release_configuration_changed'): typeof Park {
    const view: PlanIntegrationView = prior.status === 'released-unverified' ? { ...prior, reason }
      : { ...prior, status: 'releasing', release: request.target, releaseId: request.id, reason }
    this.host.store.set(KV.plans.integration(request.planId), view)
    if (reason === 'release_configuration_changed') return Park
    throw new Later()
  }

  private record(prior: IntegratedView, request: PlanReleaseRequest, result: PlanReleaseObservation): void | typeof Park {
    if (!matchesRequest(request, result)) return this.unavailable(prior, request, 'release_unavailable')
    const { store } = this.host, { planId, target: release, id: releaseId } = request
    const slot = KV.plans.integration(planId), lock = KV.plans.releaseActive(request.projectId, release.environment, release.target)
    const base = { planId, version: prior.version, run: prior.run, artifact: prior.artifact, verifiedAt: prior.verifiedAt, release, releaseId }
    const finish = (view: PlanIntegrationView) => store.atomic(() => {
      store.set(slot, view)
      if (store.get(lock) === releaseId) store.delete(lock)
      if (view.status === 'released') this.host.complete(view)
    })
    if (result.status !== 'published') {
      if (prior.status === 'released-unverified') return this.unavailable(prior, request, 'release_unavailable')
      if (result.status === 'not-published') { finish({ ...base, status: 'release-failed' }); return Park }
      store.set(slot, { ...base, status: 'releasing', ...(result.status === 'missing' ? { reason: 'dispatch_unconfirmed' } : {}) })
      throw new Later()
    }
    const { deployment, verification } = result
    if (prior.status === 'released-unverified' && (deployment.id !== prior.deployment.id || deployment.sha !== prior.deployment.sha ||
      deployment.sha256 !== prior.deployment.sha256 || deployment.at !== prior.deployment.at)) return this.unavailable(prior, request, 'release_unavailable')
    const sameArtifact = deployment.sha === request.version.sha && deployment.sha256 === request.artifact.sha256
    if (sameArtifact && verification.status === 'passed' && verification.deploymentId === deployment.id &&
      verification.sha === deployment.sha && verification.sha256 === deployment.sha256 && Date.parse(verification.at) >= Date.parse(deployment.at)) {
      finish({ ...base, status: 'released', deployment, verification })
      return
    }
    const mismatch = !sameArtifact || verification.status === 'passed'
    const view: PlanIntegrationView = { ...base, status: 'released-unverified', deployment, verification,
      ...(mismatch ? { reason: 'release_evidence_mismatch' } : {}) }
    if (mismatch) { finish(view); return Park }
    store.set(slot, view)
    throw new Later()
  }
}
