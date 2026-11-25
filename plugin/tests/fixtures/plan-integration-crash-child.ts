/** Child process for SIGKILL on either side of the external workflow dispatch POST. */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effects } from '../../src/app/effects.ts'
import { commitPlanArtifact, discardPlanArtifact, downloadPlanArtifact, openPlanArtifact, planArtifactExists } from '../../src/app/plan-artifacts.ts'
import { PlanIntegration } from '../../src/app/plan-integration.ts'
import { Store } from '../../src/app/store.ts'
import type { Handoff } from '../../src/core/handoff.ts'
import type { Plan } from '../../src/core/plan.ts'
import type { PlanIntegrationIdentity, PlanVerificationConfig } from '../../src/core/plan-integration.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { KV } from '../../src/kv.ts'
import { dispatchPlanActions, isLatestPlanActions, observePlanActions } from '../../src/sources/actions-evidence.ts'
import { testDeployment } from './deployment.ts'

const [phase, root] = process.argv.slice(2) as ['crash' | 'crash-before-post' | 'recover' | 'recover-missing', string]
const planId = 'plan-crash', sha = 'a'.repeat(40), integration = 'b'.repeat(40)
const projectId = 'c'.repeat(32), runPath = join(root, 'accepted-run.json'), countPath = join(root, 'dispatch-count')
const store = new Store(join(root, 'plan.sqlite'))
const effects = new Effects(store, new HealthBoard())
const relayPath = join(root, 'relay.jsonl')
effects.handle('relay', async ({ text }, id) => { appendFileSync(relayPath, `${JSON.stringify({ id, text })}\n`) }, { ordered: true })
const verification: PlanVerificationConfig = { projectId, workflowId: '44', identityJob: 'verify', jobs: ['verify', 'full'],
  artifactName: 'package', configuration: 'checks-v1', environment: 'hosted-ci-v1' }
const target = { repository: root, slug: 'acme/widgets', ref: 'refs/heads/main' }
const plan: Plan = { id: planId, handoffId: planId, specId: 'spec-crash', status: 'registered', features: [], nodes: [] }
const handoff: Handoff = { id: planId, project: { id: projectId, repository: target.slug, workspace: root },
  authorization: { scope: 'verify integration', release: 'not-authorized' }, status: 'specified', goal: 'verify integration',
  constraints: [], acceptanceScope: [], confirmedBy: { sessionId: 'session', messageId: 'message', text: 'verify integration' } }
type RemoteRun = PlanIntegrationIdentity & { id: number; configuration: string; environment: string }
const dispatchCount = (): number => existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0
const hold = setInterval(() => {}, 1000)
const interrupted = new Promise<never>(() => {})
const crashAt = (kind: 'accepted' | 'before-post', context: string): Promise<never> => {
  process.send!({ kind, context })
  return interrupted
}

const workflow = `repos/${target.slug}/actions/workflows/44`
const artifactName = (run: RemoteRun) => `package-${run.sha}-1`
const page = (field: string, rows: object[]) => JSON.stringify({ total_count: rows.length, [field]: rows })
class GitHubFixture extends Commands {
  override async run(program: string, args: string[]): Promise<string> {
    const [command, path] = args
    const runs = existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) as RemoteRun[] : []
    if (program === 'fixture-gh' && command === 'api' && path) {
      if (args.includes('POST')) {
        writeFileSync(countPath, String(dispatchCount() + 1))
        if (path !== `${workflow}/dispatches`) throw new Error(`Unexpected GitHub POST: ${path}`)
        const field = (name: string): string => {
          const prefix = `${name}=`
          const flag = args.find((arg, index) => args[index - 1] === '-f' && arg.startsWith(prefix))
          if (!flag) throw new Error(`Missing GitHub dispatch field: ${name}`)
          return flag.slice(prefix.length)
        }
        const context = field('inputs[dsh_context]')
        writeFileSync(runPath, JSON.stringify([...runs, { id: 101, repository: target.slug, ref: `refs/heads/${field('ref')}`,
          sha: field('inputs[dsh_commit]'), context, configuration: field('inputs[dsh_configuration]'), environment: field('inputs[dsh_environment]') }]))
        if (phase === 'crash') return crashAt('accepted', context)
        return ''
      }
      const route = path.split('?')[0]
      if (route === `${workflow}/runs`) {
        // Return near-misses too: the production Actions reader must validate the listing itself.
        return page('workflow_runs', runs.map(run => ({ id: run.id, workflow_id: 44, run_number: run.id, run_attempt: 1,
          head_sha: run.sha, head_branch: run.ref.slice('refs/heads/'.length), event: 'workflow_dispatch',
          display_title: `dsh-plan-verification:${run.context}`, status: 'completed', conclusion: 'success' })))
      }
      for (const run of runs) {
        const runRoute = `repos/${target.slug}/actions/runs/${run.id}`
        if (route === `${runRoute}/attempts/1/jobs`) return page('jobs', verification.jobs.map((name, index) => ({
          id: 301 + index, name, run_id: run.id, run_attempt: 1, head_sha: run.sha, status: 'completed', conclusion: 'success',
        })))
        if (route === `${runRoute}/artifacts`) return page('artifacts', [{ id: 202, name: artifactName(run),
          expired: false, size_in_bytes: 1, workflow_run: { id: run.id, head_sha: run.sha } }])
      }
    }
    if (program === 'fixture-gh' && command === 'run' && path === 'download') {
      const run = runs.find(item => String(item.id) === args[2])
      const directory = args[8]
      if (run && args[3] === '--repo' && args[4] === run.repository && args[5] === '--name' && args[6] === artifactName(run) &&
          args[7] === '--dir' && directory) {
        const { id: runId, ...identity } = run
        const fileName = 'package.tgz', contentType = 'application/gzip', bytes = 'verified package bytes'
        writeFileSync(join(directory, fileName), bytes)
        writeFileSync(join(directory, 'dsh-artifact.json'), JSON.stringify({ ...identity, runId, attempt: 1,
          fileName, contentType, sha256: createHash('sha256').update(bytes).digest('hex') }))
        return ''
      }
    }
    throw new Error(`Unexpected GitHub fixture command: ${program} ${args.join(' ')}`)
  }
}

const lifetime = new AbortController().signal
const deployment = testDeployment()
deployment.github.cli = 'fixture-gh'
const commands = new GitHubFixture(() => deployment, {}, lifetime)

const integrationAgent = new PlanIntegration({
  store,
  effects,
  plans: { list: () => [plan], get: id => id === planId ? plan : undefined, state: () => undefined,
    requiredDelivery: id => id === planId ? { waitingFor: [], integrations: [integration] } : undefined },
  handoffs: { get: id => id === planId ? handoff : undefined },
  lifetime,
  verification: phase === 'recover-missing' ? undefined : verification,
  paused: () => false,
  controlBlocked: () => false,
  target: () => target,
  readTarget: async () => ({ sha, includesIntegrations: true }),
  observe: request => observePlanActions(commands, request),
  isLatestRun: (request, run) => isLatestPlanActions(commands, request, run),
  downloadArtifact: (id, request, run, artifact) => downloadPlanArtifact(commands, root, id, request, run, artifact),
  commitArtifact: commitPlanArtifact,
  discardArtifact: discardPlanArtifact,
  artifactAvailable: async (id, view) => !!await openPlanArtifact(root, id, view),
  artifactExists: (id, view) => planArtifactExists(root, id, view),
  dispatch: request => phase === 'crash-before-post' ? crashAt('before-post', request.context) : dispatchPlanActions(commands, request),
  deliveryLink: () => 'http://127.0.0.1:3082/?superagentProject=test&superagentTicket=test',
  relay: ({ id, text }) => effects.enqueue('relay', id, { text }),
  cancelRelay: (id: string) => effects.cancel('relay', id),
})

if (phase === 'crash' || phase === 'crash-before-post') {
  integrationAgent.enqueue(planId)
  effects.start()
  await interrupted
} else {
  await integrationAgent.resume()
  effects.start()
  await effects.idle()
  const view = integrationAgent.view(planId)
  await effects.drain()
  const retained = store.get(KV.plans.integration(planId))
  store.close()
  clearInterval(hold)
  const relays = existsSync(relayPath) ? readFileSync(relayPath, 'utf8').trimEnd().split('\n').length : 0
  process.send!({ kind: 'recovered', view, retained, dispatches: dispatchCount(), relays })
  process.disconnect!()
}
