import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PlanIntegration } from '../src/app/plan-integration.ts'
import { Store } from '../src/app/store.ts'
import { releaseAdapter } from '../src/app/release-adapter.ts'
import type { Handoff } from '../src/core/handoff.ts'
import type { Plan } from '../src/core/plan.ts'
import type { PlanActionsObservation, PlanEnvironmentVerification, PlanReleaseConfig, PlanReleaseObservation, PlanReleaseRequest,
  PlanVerificationConfig, PlanVerificationRequest } from '../src/core/plan-integration.ts'
import { Later } from '../src/app/effects.ts'

const planId = 'plan-release'
const projectId = 'a'.repeat(32)
const sha = 'b'.repeat(40)
const artifactSha = 'c'.repeat(64)
const verification: PlanVerificationConfig = { projectId, workflowId: '44', identityJob: 'identity', jobs: ['identity', 'check'],
  artifactName: 'package', configuration: 'checks-v1', environment: 'ci-v1' }
const release: PlanReleaseConfig = { projectId, executable: '/opt/release/adapter', args: [], environment: 'production', target: 'storefront',
  scope: 'catalog service', credentialId: 'production-deploy', credentialProviderUrl: 'https://vault.example.test/projects/storefront' }
const deployment = { id: 'deployment-1', sha, sha256: artifactSha, at: '2026-11-25T10:00:00.000Z' }
const releaseRun = (environmentCheck: PlanEnvironmentVerification): PlanReleaseObservation =>
  ({ requestId: 'set-by-test', target: release, status: 'published', deployment, verification: environmentCheck })

type Options = { authorized?: boolean; authorizationScope?: string; authorizationTarget?: 'default' | 'missing'; authorizedTarget?: PlanReleaseConfig;
  credentialAvailable?: boolean; credentialSequence?: boolean[]; publication?: PlanReleaseObservation; publishAcceptedThenLoseResponse?: boolean }
function fixture(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plan-release-'))
  const store = new Store(join(root, 'state.sqlite'))
  let handler: ((payload: Record<string, never>, id: string) => Promise<unknown>) | undefined
  const enqueue = vi.fn()
  const relay = vi.fn()
  const effects = { handle: (_kind: string, run: (payload: Record<string, never>, id: string) => Promise<unknown>) => { handler = run },
    enqueue, pending: () => false }
  const artifact = { id: 7, name: 'package-b-1', url: 'https://github.com/acme/widgets/actions/runs/1/artifacts/7',
    fileName: 'package.tgz', contentType: 'application/gzip', size: 12, sha256: artifactSha }
  const draft = { directory: root, finalDirectory: root, artifact }
  const run = { id: 1, attempt: 1, url: 'https://github.com/acme/widgets/actions/runs/1', checks: [] }
  const integrationObservation: PlanActionsObservation = { status: 'passed', run, artifact }
  const authorization = options.authorized === false ? { scope: options.authorizationScope ?? 'implement only', release: 'not-authorized' as const }
    : { scope: 'implement and release', release: 'authorized' as const,
      ...(options.authorizationTarget === 'missing' ? {} : { releaseTarget: { environment: 'production', target: 'storefront', scope: 'catalog service' } }) }
  const handoff: Handoff = { id: planId, project: { id: projectId, repository: 'acme/widgets', workspace: root }, authorization,
    status: 'specified', goal: 'Release the catalog', constraints: [], acceptanceScope: [],
    confirmedBy: { sessionId: 'hub', messageId: '1', text: 'release' } }
  const plan: Plan = { id: planId, handoffId: planId, specId: 'spec-release', status: 'registered', features: [], nodes: [] }
  const credentialAvailable = vi.fn(async (_request: PlanReleaseRequest) => options.credentialSequence?.shift() ?? options.credentialAvailable ?? false)
  let externalObservation: PlanReleaseObservation | undefined
  let loseNextResponse = options.publishAcceptedThenLoseResponse ?? false
  const publish = vi.fn(async (request: PlanReleaseRequest): Promise<PlanReleaseObservation> => {
    const configured = options.publication ?? { target: release, status: 'not-published' as const }
    externalObservation = { ...configured, requestId: request.id } as PlanReleaseObservation
    if (loseNextResponse) { loseNextResponse = false; throw new Error('The adapter response was interrupted') }
    return externalObservation
  })
  const observe = vi.fn(async (request: PlanReleaseRequest): Promise<PlanReleaseObservation> => externalObservation ??
    ({ requestId: request.id, target: release, status: 'missing' }))
  const adapter = { config: options.authorizedTarget ?? release, credentialAvailable, publish, observe }
  const host = {
    store, effects,
    plans: { list: () => [plan], get: () => plan, state: () => undefined, requiredDelivery: () => ({ waitingFor: [], integrations: [sha] }) },
    handoffs: { get: () => handoff }, lifetime: new AbortController().signal, verification, release: adapter,
    paused: () => false, target: () => ({ repository: root, slug: 'acme/widgets', ref: 'refs/heads/main' }),
    readTarget: vi.fn(async () => ({ sha, includesIntegrations: true })),
    observe: vi.fn(async () => integrationObservation), isLatestRun: vi.fn(async () => true),
    downloadArtifact: vi.fn(async (_id: string, _request: PlanVerificationRequest) => draft),
    commitArtifact: vi.fn(), discardArtifact: vi.fn(), artifactAvailable: vi.fn(async () => true), artifactExists: vi.fn(() => true),
    dispatch: vi.fn(async () => {}), releaseArtifact: vi.fn(async () => join(root, artifact.fileName)),
    deliveryLink: () => 'http://127.0.0.1:3082/project', relay, cancelRelay: vi.fn(),
  }
  const integration = new PlanIntegration(host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
  return { root, store, draft, integration, host, getHandler: () => handler! }
}

async function integrate(app: ReturnType<typeof fixture>) {
  try { await app.getHandler()({}, planId) }
  catch (error) { if (!(error instanceof Later)) throw error }
  if (app.integration.view(planId)?.status === 'awaiting-release-verification') {
    try { await app.getHandler()({}, planId) }
    catch (error) { if (!(error instanceof Later)) throw error }
  }
}

it('holds an authorized release behind the configured credential provider without publishing', async () => {
  const app = fixture()
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'awaiting-release-credentials',
      release: { environment: 'production', target: 'storefront', scope: 'catalog service' },
      credential: { id: 'production-deploy', providerUrl: release.credentialProviderUrl } })
    expect(app.host.release.credentialAvailable).toHaveBeenCalledOnce()
    expect(app.host.release.publish).not.toHaveBeenCalled()
    expect(app.host.relay).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('does not probe or publish production credentials when the handoff did not authorize release', async () => {
  const app = fixture({ authorized: false, credentialAvailable: true })
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'delivered', version: { sha }, artifact: { sha256: artifactSha } })
    expect(app.host.release.credentialAvailable).not.toHaveBeenCalled()
    expect(app.host.release.publish).not.toHaveBeenCalled()
    expect(app.host.relay).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it.each(['repair-only authorization', 'quota-only authorization'] as const)('%s does not authorize production publication when credentials exist', async authorizationScope => {
  const app = fixture({ authorized: false, authorizationScope, credentialAvailable: true })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'delivered' })
    expect(app.host.release.credentialAvailable).not.toHaveBeenCalled()
    expect(app.host.release.publish).not.toHaveBeenCalled()
    expect(app.host.relay).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('requires an explicit release target even in legacy authorized Handoff records', async () => {
  const app = fixture({ authorizationTarget: 'missing', credentialAvailable: true })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'release-blocked', reason: 'authorization_missing' })
    expect(app.host.release.credentialAvailable).not.toHaveBeenCalled()
    expect(app.host.release.publish).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('emits one controlled credential request, then resumes when that provider becomes available', async () => {
  const publication = releaseRun({ status: 'passed', at: '2026-11-25T10:01:00.000Z', deploymentId: deployment.id, sha, sha256: artifactSha })
  const app = fixture({ credentialSequence: [false, true], publication })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'awaiting-release-credentials' })
    expect(app.host.relay).toHaveBeenCalledOnce()

    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'released', deployment })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).toHaveBeenCalledTimes(2)
    expect(app.host.relay.mock.calls.map(([message]) => JSON.parse(message.text).kind)).toEqual(['human-action', 'plan-delivered'])
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('refuses a different configured target and scope before probing credentials', async () => {
  const app = fixture({ authorizedTarget: { ...release, scope: 'all services' }, credentialAvailable: true })
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'release-blocked', reason: 'target_scope_mismatch' })
    expect(app.host.release.credentialAvailable).not.toHaveBeenCalled()
    expect(app.host.release.publish).not.toHaveBeenCalled()
    expect(app.host.relay).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('does not deliver a failed publication as if it had been rolled back', async () => {
  const publication: PlanReleaseObservation = { requestId: 'set-by-test', target: release, status: 'not-published' }
  const app = fixture({ credentialAvailable: true, publication })
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'release-failed',
      release: { environment: release.environment, target: release.target, scope: release.scope } })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('keeps a deployment unverified until the receipt proves the exact regression artifact passed', async () => {
  const publication = releaseRun({ status: 'failed', at: '2026-11-25T10:01:00.000Z' })
  const app = fixture({ credentialAvailable: true, publication })
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'released-unverified', deployment,
      verification: { status: 'failed' }, release: { environment: 'production', target: 'storefront', scope: 'catalog service' } })
    expect(app.host.relay).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('delivers only after the exact deployed artifact has a matching successful environment receipt', async () => {
  const publication = releaseRun({ status: 'passed', at: '2026-11-25T10:01:00.000Z', deploymentId: deployment.id, sha, sha256: artifactSha })
  const app = fixture({ credentialAvailable: true, publication })
  try {
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'released', deployment, verification: { status: 'passed', sha, sha256: artifactSha } })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).toHaveBeenCalledOnce()
    expect(JSON.parse(app.host.relay.mock.calls[0]![0].text)).toMatchObject({
      kind: 'plan-delivered', release: { environment: 'production', target: 'storefront', scope: 'catalog service' },
      deployment, environmentVerification: { status: 'passed', sha, sha256: artifactSha },
    })
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('leaves a deployment unverified when its reported checksum differs from the regression artifact', async () => {
  const publication = releaseRun({ status: 'passed', at: '2026-11-25T10:01:00.000Z', deploymentId: deployment.id,
    sha, sha256: 'd'.repeat(64) })
  const app = fixture({ credentialAvailable: true, publication })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'released-unverified', reason: 'release_evidence_mismatch',
      deployment, verification: { status: 'passed', sha, sha256: 'd'.repeat(64) } })
    expect(app.host.relay).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it.each(['available', 'unreadable'] as const)('reconciles an external deployment after restart with an %s package', async availability => {
  const publication = releaseRun({ status: 'passed', at: '2026-11-25T10:01:00.000Z', deploymentId: deployment.id, sha, sha256: artifactSha })
  const app = fixture({ credentialAvailable: true, publication, publishAcceptedThenLoseResponse: true })
  try {
    await app.getHandler()({}, planId)
    await expect(app.getHandler()({}, planId)).rejects.toThrow()
    expect(app.integration.view(planId)).toMatchObject({ status: 'releasing' })
    if (availability === 'unreadable') {
      const failure = Object.assign(new Error('retained file cannot be read'), { code: 'EACCES' })
      app.host.artifactAvailable.mockRejectedValue(failure)
      app.host.artifactExists.mockImplementation(() => { throw failure })
    }

    const recovered = new PlanIntegration(app.host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
    await recovered.resume()
    app.host.release.observe.mockImplementationOnce(async request => ({ requestId: request.id, target: request.target, status: 'missing' }))
    await integrate(app)
    expect(recovered.view(planId)).toMatchObject({ status: 'releasing', reason: 'release_dispatch_unconfirmed' })
    expect(app.host.release.publish).toHaveBeenCalledOnce()

    app.host.readTarget.mockResolvedValue({ sha: 'e'.repeat(40), includesIntegrations: true })
    await app.getHandler()({}, planId)

    expect(recovered.view(planId)).toMatchObject({ status: availability === 'available' ? 'released' : 'released-artifact-unavailable',
      releaseId: expect.any(String), deployment, verification: { status: 'passed' } })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).toHaveBeenCalledTimes(availability === 'available' ? 1 : 0)
    expect(app.host.release.observe.mock.calls.at(-1)?.[0].id).toBe(app.host.release.publish.mock.calls[0]?.[0].id)
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})
it('rechecks credentials before retrying an absent publication after restart', async () => {
  const app = fixture({ credentialSequence: [true, false], publication: { requestId: 'set-by-test', target: release, status: 'not-started' },
    publishAcceptedThenLoseResponse: true })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'releasing' })

    const recovered = new PlanIntegration(app.host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
    await recovered.resume()
    await expect(app.getHandler()({}, planId)).rejects.toThrow()

    expect(recovered.view(planId)).toMatchObject({ status: 'awaiting-release-credentials',
      release: { environment: release.environment, target: release.target, scope: release.scope },
      credential: { id: release.credentialId, providerUrl: release.credentialProviderUrl } })
    expect(app.host.release.credentialAvailable).toHaveBeenCalledTimes(2)
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.release.observe).toHaveBeenCalledOnce()
    expect(app.host.relay).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it.each(['request', 'target'] as const)('does not retry publication on an absence receipt for another %s', async mismatch => {
  const app = fixture({ credentialAvailable: true, publishAcceptedThenLoseResponse: true })
  try {
    await integrate(app)
    app.host.release.observe.mockImplementationOnce(async request => ({ status: 'not-started',
      requestId: mismatch === 'request' ? 'another-request' : request.id,
      target: mismatch === 'target' ? { ...request.target, environment: 'staging' } : request.target }))

    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'releasing', reason: 'release_unavailable' })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('preserves an observed deployment when a later observation incorrectly reports absence', async () => {
  const app = fixture({ credentialAvailable: true, publication: releaseRun({ status: 'pending' }) })
  try {
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'released-unverified', deployment })
    app.host.release.observe.mockImplementationOnce(async request => ({ status: 'not-started', requestId: request.id, target: request.target }))

    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'released-unverified', deployment, reason: 'release_unavailable' })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('records a deployment whose receipt arrives while processing is paused', async () => {
  const app = fixture({ credentialAvailable: true, publication: releaseRun({ status: 'pending' }) })
  try {
    const publish = app.host.release.publish.getMockImplementation()!
    app.host.release.publish.mockImplementationOnce(async request => {
      const receipt = await publish(request)
      app.host.paused = () => true
      return receipt
    })
    await integrate(app)
    expect(app.integration.view(planId)).toMatchObject({ status: 'released-unverified', deployment })

    app.host.paused = () => false
    app.host.release.observe.mockImplementationOnce(async request => ({ status: 'not-started', requestId: request.id, target: request.target }))
    const recovered = new PlanIntegration(app.host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
    await recovered.resume()
    await integrate(app)

    expect(recovered.view(planId)).toMatchObject({ status: 'released-unverified', deployment })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it.each(['branch', 'profile', 'run'] as const)('does not release an old artifact when the %s changes while credentials are missing', async drift => {
  const app = fixture({ credentialSequence: [false, true], publication: releaseRun({ status: 'pending' }) })
  try {
    await integrate(app)
    expect(app.integration.view(planId)?.status).toBe('awaiting-release-credentials')
    if (drift === 'branch') app.host.readTarget.mockResolvedValue({ sha: 'e'.repeat(40), includesIntegrations: true })
    if (drift === 'profile') app.host.verification = { ...verification, jobs: [...verification.jobs, 'release-regression'] }
    if (drift === 'run') app.host.isLatestRun.mockResolvedValue(false)

    const recovered = new PlanIntegration(app.host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
    await recovered.resume()
    await integrate(app)

    expect(recovered.view(planId)).toMatchObject({ status: 'blocked', reason: 'regression_evidence_changed' })
    expect(app.host.release.publish).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('rechecks the regression before retrying a publication proved absent', async () => {
  const app = fixture({ credentialAvailable: true, publication: { requestId: 'set-by-test', target: release, status: 'not-started' },
    publishAcceptedThenLoseResponse: true })
  try {
    await integrate(app)
    app.host.isLatestRun.mockResolvedValue(false)
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'blocked', reason: 'regression_evidence_changed' })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it.each([
  { name: 'missing', output: 'missing', exitCode: 0, status: 'awaiting-release-credentials' },
  { name: 'process error', output: 'credential verification failed', exitCode: 1, status: 'release-blocked' },
  { name: 'invalid output', output: '', exitCode: 0, status: 'release-blocked' },
] as const)('distinguishes $name when asking an operator for credentials', async ({ output, exitCode, status }) => {
  const app = fixture()
  try {
    const adapter = releaseAdapter(release, app.root, { spawn: () => ({
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, terminate() {}, waitForExit: async () => true,
      done: Promise.resolve({ exitCode, signal: null }),
      collected: { stdout: { readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }) } },
    }) }, app.host.lifetime)
    app.host.release.credentialAvailable.mockImplementationOnce(adapter.credentialAvailable)

    await integrate(app)

    expect(app.integration.view(planId)?.status).toBe(status)
    expect(app.host.relay).toHaveBeenCalledTimes(status === 'awaiting-release-credentials' ? 1 : 0)
    expect(app.host.release.publish).not.toHaveBeenCalled()
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

it('keeps the verified deployment when the package disappears and restores only the same package', async () => {
  const publication = releaseRun({ status: 'passed', at: '2026-11-25T10:01:00.000Z', deploymentId: deployment.id, sha, sha256: artifactSha })
  const app = fixture({ credentialAvailable: true, publication })
  try {
    const publish = app.host.release.publish.getMockImplementation()!
    app.host.release.publish.mockImplementationOnce(async request => {
      const receipt = await publish(request)
      app.host.artifactExists.mockReturnValue(false)
      app.host.artifactAvailable.mockResolvedValue(false)
      return receipt
    })
    await integrate(app)

    expect(app.integration.view(planId)).toMatchObject({ status: 'released-artifact-unavailable', artifactAvailable: false,
      deployment, verification: { status: 'passed' } })
    expect(app.host.relay).not.toHaveBeenCalled()
    app.host.downloadArtifact.mockResolvedValueOnce({ ...app.draft, artifact: { ...app.draft.artifact, sha256: 'd'.repeat(64) } })
    app.host.verification = { ...verification, configuration: 'checks-v2' }
    const recovered = new PlanIntegration(app.host as unknown as ConstructorParameters<typeof PlanIntegration>[0])
    await recovered.resume()
    await integrate(app)
    expect(recovered.view(planId)?.status).toBe('released-artifact-unavailable')
    expect(app.host.relay).not.toHaveBeenCalled()

    app.host.commitArtifact.mockImplementationOnce(() => { app.host.artifactExists.mockReturnValue(true) })
    await integrate(app)
    expect(recovered.view(planId)).toMatchObject({ status: 'released', deployment, artifact: { sha256: artifactSha } })
    expect(app.host.downloadArtifact.mock.calls.at(-1)?.[1]).toMatchObject({ sha, verification: { configuration: 'checks-v1' } })
    expect(app.host.release.publish).toHaveBeenCalledOnce()
    expect(app.host.relay).toHaveBeenCalledOnce()
    app.host.artifactExists.mockReturnValue(false)
    expect(recovered.view(planId)).toMatchObject({ status: 'released-artifact-unavailable', deployment })
  } finally {
    app.store.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})
