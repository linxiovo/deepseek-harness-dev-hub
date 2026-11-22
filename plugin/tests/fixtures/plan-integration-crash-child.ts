/** Child process for plan-integration-crash.spec.ts; SIGKILLs after the remote accepts dispatch. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effects } from '../../src/app/effects.ts'
import type { Relay } from '../../src/app/notices.ts'
import { PlanIntegration } from '../../src/app/plan-integration.ts'
import { Store } from '../../src/app/store.ts'
import type { PlanArtifactDraft } from '../../src/app/plan-artifacts.ts'
import type { PlanIntegrationView, PlanVerificationConfig, PlanVerificationRequest, PlanVerificationRun } from '../../src/core/plan-integration.ts'
import type { MainlineTarget } from '../../src/executor/mainline-git.ts'
import { HealthBoard } from '../../src/infra/health.ts'

const [phase, root] = process.argv.slice(2) as ['crash' | 'recover', string]
const planId = 'plan-crash', sha = 'a'.repeat(40), integration = 'b'.repeat(40)
const projectId = 'c'.repeat(32), runPath = join(root, 'accepted-run.json'), countPath = join(root, 'dispatch-count')
const store = new Store(join(root, 'plan.sqlite'))
const effects = new Effects(store, new HealthBoard())
const verification: PlanVerificationConfig = { projectId, workflowId: '44', identityJob: 'verify', jobs: ['verify', 'full'],
  artifactName: 'package', configuration: 'checks-v1', environment: 'hosted-ci-v1' }
const target: MainlineTarget = { repository: root, slug: 'acme/widgets', ref: 'refs/heads/main' }
const plans = { list: () => [{ id: planId }], requiredDelivery: () => ({ waitingFor: [], integrations: [integration] }) }
const handoffs = { get: () => ({ project: { id: projectId }, authorization: { release: 'not-authorized' } }) }
const readAcceptedRun = (): { context: string; sha: string } | undefined =>
  existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) as { context: string; sha: string } : undefined
const dispatchCount = (): number => existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0
const ipc = process as typeof process & { send(message: unknown): void; disconnect(): void }
const hold = setInterval(() => {}, 1000)

const integrationHost = {
  store,
  effects,
  plans,
  handoffs,
  lifetime: new AbortController().signal,
  verification,
  paused: () => false,
  target: () => target,
  readTarget: async () => ({ sha, includesIntegrations: true }),
  observe: async (request: PlanVerificationRequest) => {
    const run = readAcceptedRun()
    if (!run || run.sha !== request.sha || run.context !== request.context) return { status: 'missing' as const }
    return { status: 'passed' as const,
      run: { id: 101, attempt: 1, url: 'https://github.com/acme/widgets/actions/runs/101',
        checks: verification.jobs.map(name => ({ name, status: 'completed', conclusion: 'success' })) },
      artifact: { id: 202, name: `package-${sha}-1`, url: 'https://github.com/acme/widgets/actions/runs/101/artifacts/202' } }
  },
  isLatestRun: async (_request: PlanVerificationRequest, _run: PlanVerificationRun) => true,
  downloadArtifact: async (_planId: string, _request: PlanVerificationRequest, _run: PlanVerificationRun,
    artifact: { id: number; name: string; url: string }): Promise<PlanArtifactDraft> => ({ directory: '', finalDirectory: '',
    artifact: { ...artifact, fileName: 'package.tgz', contentType: 'application/gzip', size: 1, sha256: 'd'.repeat(64) } }),
  commitArtifact: (_draft: PlanArtifactDraft) => {},
  discardArtifact: (_draft: PlanArtifactDraft) => {},
  artifactAvailable: async () => true,
  artifactExists: () => true,
  dispatch: async (request: PlanVerificationRequest) => {
    writeFileSync(runPath, JSON.stringify({ context: request.context, sha: request.sha }))
    writeFileSync(countPath, String(dispatchCount() + 1))
    if (phase === 'crash') {
      ipc.send({ kind: 'accepted', context: request.context })
      await Promise.withResolvers<void>().promise
    }
  },
  relay: (message: Relay) => appendFileSync(join(root, 'relay.jsonl'), `${JSON.stringify(message)}\n`),
} as never

const integrationAgent = new PlanIntegration(integrationHost)
if (phase === 'crash') {
  integrationAgent.enqueue(planId)
  effects.start()
  await Promise.withResolvers<void>().promise
} else {
  await integrationAgent.resume()
  effects.start()
  await effects.idle()
  const view = integrationAgent.view(planId) as PlanIntegrationView
  await effects.drain()
  store.close()
  clearInterval(hold)
  ipc.send({ kind: 'recovered', view, dispatches: dispatchCount(), relays: readFileSync(join(root, 'relay.jsonl'), 'utf8').trim().split('\n').length })
  ipc.disconnect()
}
