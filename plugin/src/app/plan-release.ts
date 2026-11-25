import { key } from '../core/ids.ts'
import { sameReleaseTarget, type Handoff } from '../core/handoff.ts'
import type { PlanIntegratedArtifact, PlanIntegrationView, PlanReleaseConfig, PlanReleaseIntent, PlanReleaseObservation,
  PlanReleaseRequest, PlanVerificationConfig } from '../core/plan-integration.ts'
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
  save(view: PlanIntegrationView): void
  verifyEvidence(view: IntegratedView): Promise<PlanVerificationConfig | undefined>
  restartVerification(view: IntegratedView, reason: 'artifact_unavailable' | 'regression_evidence_changed'): void
  complete(view: ReleasedView): void
  deliveryLink(planId: string): string
  relay(message: Relay): void
  cancelRelay(id: string): void
}

export const credentialRelayPrefix = 'plan-release-credential:'
const credentialPrompt = promptFile('plan-release-credential')
const matchesRequest = (request: PlanReleaseRequest, observation: PlanReleaseObservation): boolean =>
  observation.requestId === request.id && sameReleaseTarget(observation.target, request.target)
const adapterId = (config: PlanReleaseConfig): string => key('release-adapter', config.executable, JSON.stringify(config.args), config.credentialId)

/** Publishes verified packages under durable intents and reconciles the exact deployment before completion. */
export class PlanRelease {
  constructor(private readonly host: ReleaseHost) {}

  async start(prior: IntegratedView, handoff: Handoff, active: () => void): Promise<void | typeof Park> {
    const { host } = this, { store, adapter } = host, { planId, version, run, artifact, verifiedAt } = prior
    const intentKey = KV.plans.releaseIntent(planId)
    const base = { planId, version, run, artifact, verifiedAt }
    const release = handoff.authorization.release === 'authorized' ? handoff.authorization.releaseTarget : undefined
    if (!release) {
      host.save({ ...base, status: 'release-blocked', reason: 'authorization_missing' })
      return Park
    }
    if (!adapter || adapter.config.projectId !== handoff.project.id) {
      host.save({ ...base, status: 'release-blocked', release, reason: 'release_unconfigured' })
      return Park
    }
    if (handoff.project.repository.toLowerCase() !== version.repository || !sameReleaseTarget(release, adapter.config)) {
      host.save({ ...base, status: 'release-blocked', release, reason: 'target_scope_mismatch' })
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
      host.save({ ...base, status: 'release-blocked', release, reason: 'release_busy' })
      throw new Later()
    }
    let available: boolean
    try { available = await adapter.credentialAvailable(request) }
    catch {
      active()
      host.save({ ...base, status: 'release-blocked', release, reason: 'release_unavailable' })
      throw new Later()
    }
    active()
    const credentialRelay = credentialRelayPrefix + planId
    if (!available) return this.awaitCredentials(prior, request, adapter.config)
    const verified = await this.verifiedPackage(prior, request, active)
    if (!verified) return
    active()
    const intent: PlanReleaseIntent = { request, adapter: adapterId(adapter.config), verification: verified.verification }
    const publishing = { ...base, status: 'releasing' as const, release, releaseId: request.id }
    const acquired = store.atomic(() => {
      if (store.get(intentKey) || store.get(lock)) return false
      store.set(intentKey, intent)
      store.set(lock, request.id)
      host.save(publishing)
      host.cancelRelay(credentialRelay)
      return true
    })
    if (!acquired) throw new Later()
    let observation: PlanReleaseObservation
    try { observation = await adapter.publish(request, verified.path) }
    catch {
      host.save({ ...publishing, reason: 'release_dispatch_unconfirmed' })
      throw new Later()
    }
    // A pause prevents a new write, not recording the result of a write that already happened.
    return this.record(publishing, request, observation)
  }

  async reconcile(prior: IntegratedView, intent: PlanReleaseIntent, active: () => void): Promise<void | typeof Park> {
    const { adapter } = this.host, { request } = intent
    if (!adapter || adapter.config.projectId !== request.projectId || !sameReleaseTarget(adapter.config, request.target) || adapterId(adapter.config) !== intent.adapter)
      return this.unavailable(prior, request, 'release_configuration_changed')
    active()
    let observation: PlanReleaseObservation
    try { observation = await adapter.observe(request) }
    catch { return this.unavailable(prior, request, 'release_unavailable') }
    if (observation.status === 'not-started' && prior.status !== 'released-unverified') {
      if (!matchesRequest(request, observation)) return this.unavailable(prior, request, 'release_unavailable')
      active()
      let credentialsAvailable: boolean
      try { credentialsAvailable = await adapter.credentialAvailable(request) }
      catch { return this.unavailable(prior, request, 'release_unavailable') }
      active()
      if (!credentialsAvailable) return this.awaitCredentials(prior, request, adapter.config)
      const verified = await this.verifiedPackage(prior, request, active, true)
      if (!verified) return
      active()
      const { store } = this.host, { planId, target: release, id: releaseId } = request
      const { version, run, artifact, verifiedAt } = prior
      store.atomic(() => {
        this.host.save({ planId, version, run, artifact, verifiedAt, status: 'releasing', release, releaseId })
        this.host.cancelRelay(credentialRelayPrefix + planId)
      })
      try { observation = await adapter.publish(request, verified.path) }
      catch { return this.unavailable(prior, request, 'release_unavailable') }
    }
    return this.record(prior, request, observation)
  }

  private awaitCredentials(prior: IntegratedView, request: PlanReleaseRequest, config: PlanReleaseConfig): never {
    const { store } = this.host
    const credential = { id: config.credentialId, providerUrl: config.credentialProviderUrl }
    store.atomic(() => {
      this.host.save({ planId: prior.planId, version: prior.version, run: prior.run, artifact: prior.artifact, verifiedAt: prior.verifiedAt,
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

  private async verifiedPackage(prior: IntegratedView, request: PlanReleaseRequest, active: () => void, retry = false):
    Promise<{ path: string; verification: PlanVerificationConfig } | undefined> {
    const { host } = this, { store } = host, { planId, target: release } = request
    let path: string | undefined, verification: PlanVerificationConfig | undefined
    try {
      path = await host.artifact?.(planId, prior)
      if (path) verification = await host.verifyEvidence(prior)
    } catch {
      active()
      if (retry) {
        this.unavailable(prior, request, 'release_unavailable')
      } else {
        const { version, run, artifact, verifiedAt } = prior
        host.save({ planId, version, run, artifact, verifiedAt, status: 'release-blocked', release, reason: 'release_unavailable' })
      }
      throw new Later()
    }
    active()
    if (path && verification) return { path, verification }
    store.atomic(() => {
      // Only a matching absence observation allows retiring an already-persisted intent.
      if (retry) {
        const lock = KV.plans.releaseActive(request.projectId, release.environment, release.target)
        if (store.get(lock) !== request.id) throw new Error('Release intent does not own its target')
        store.delete(lock)
        store.delete(KV.plans.releaseIntent(planId))
      }
      host.restartVerification(prior, path ? 'regression_evidence_changed' : 'artifact_unavailable')
    })
  }

  private unavailable(prior: IntegratedView, request: PlanReleaseRequest, reason: 'release_unavailable' | 'release_configuration_changed'): typeof Park {
    const view: PlanIntegrationView = prior.status === 'released-unverified' ? { ...prior, reason }
      : { ...prior, status: 'releasing', release: request.target, releaseId: request.id, reason }
    this.host.save(view)
    if (reason === 'release_configuration_changed') return Park
    throw new Later()
  }

  private record(prior: IntegratedView, request: PlanReleaseRequest, result: PlanReleaseObservation): void | typeof Park {
    if (!matchesRequest(request, result)) return this.unavailable(prior, request, 'release_unavailable')
    const { store } = this.host, { planId, target: release, id: releaseId } = request
    const lock = KV.plans.releaseActive(request.projectId, release.environment, release.target)
    const base = { planId, version: prior.version, run: prior.run, artifact: prior.artifact, verifiedAt: prior.verifiedAt, release, releaseId }
    const finish = (view: PlanIntegrationView) => store.atomic(() => {
      if (store.get(lock) === releaseId) store.delete(lock)
      if (view.status === 'released') this.host.complete(view)
      else this.host.save(view)
    })
    if (result.status !== 'published') {
      if (prior.status === 'released-unverified') return this.unavailable(prior, request, 'release_unavailable')
      if (result.status === 'not-published' || result.status === 'not-started') {
        finish({ ...base, status: 'release-failed' })
        return Park
      }
      this.host.save({ ...base, status: 'releasing', ...(result.status === 'publishing' ? {} : { reason: 'release_dispatch_unconfirmed' }) })
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
    this.host.save(view)
    throw new Later()
  }
}
