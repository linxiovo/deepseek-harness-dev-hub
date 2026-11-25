import { z } from 'zod'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { PlanReleaseConfig, PlanReleaseObservation, PlanReleaseRequest } from '../core/plan-integration.ts'
import type { ReleaseAdapter } from './plan-release.ts'

const target = z.strictObject({ environment: z.string().min(1), target: z.string().min(1), scope: z.string().min(1) })
const deployment = z.strictObject({ id: z.string().min(1), sha: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime() })
const verification = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('failed'), at: z.iso.datetime() }),
  z.strictObject({ status: z.literal('passed'), at: z.iso.datetime(), deploymentId: z.string().min(1),
    sha: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
])
const absentRelease = z.strictObject({ requestId: z.string().min(1), target,
  status: z.enum(['missing', 'not-started', 'publishing', 'not-published']) })
const publishedRelease = z.strictObject({ requestId: z.string().min(1), target, status: z.literal('published'), deployment, verification })
const PlanReleaseObservationSchema = z.union([absentRelease, publishedRelease])

interface ReleaseSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}
interface Inputs { executable: string; args: readonly string[]; cwd: string; signal: AbortSignal }

async function execute(subprocess: ReleaseSubprocess, inputs: Inputs, command: 'credential-check' | 'publish' | 'observe',
  request: PlanReleaseRequest, timeout: number, artifactPath?: string): Promise<string> {
  const signal = AbortSignal.any([inputs.signal, AbortSignal.timeout(timeout)])
  const handle = subprocess.spawn({ argv: [inputs.executable, ...inputs.args, command, '--request-stdin'], cwd: inputs.cwd,
    signal, graceMs: 2000, stdio: { stdin: { data: JSON.stringify({ request, ...(artifactPath ? { artifactPath } : {}) }) },
      stdout: { maxBytes: 64_000 }, stderr: { maxBytes: 2048 } } })
  const result = await handle.done
  if (signal.aborted || result.exitCode !== 0 || result.signal !== null) throw new Error(`Release adapter ${command} did not complete successfully`)
  const exited = await handle.waitForExit(signal)
  if (!exited) throw new Error(`Release adapter ${command} left an active process after completion`)
  const stdout = handle.collected.stdout?.readFrom(0)
  if (!stdout || stdout.lossy) throw new Error(`Release adapter ${command} returned incomplete output`)
  return stdout.text.trim()
}

/** Binds the trusted release executable to bounded stdin/stdout and validates every target receipt. */
export function releaseAdapter(config: PlanReleaseConfig, cwd: string, subprocess: ReleaseSubprocess, signal: AbortSignal): ReleaseAdapter {
  const inputs: Inputs = { executable: config.executable, args: config.args, cwd, signal }
  const run = async (command: 'publish' | 'observe', request: PlanReleaseRequest, artifactPath?: string): Promise<PlanReleaseObservation> =>
    PlanReleaseObservationSchema.parse(JSON.parse(await execute(subprocess, inputs, command, request,
      command === 'publish' ? 120_000 : 30_000, artifactPath))) as PlanReleaseObservation
  return {
    config,
    credentialAvailable: async request => {
      const result = await execute(subprocess, inputs, 'credential-check', request, 30_000)
      if (result === 'ready') return true
      if (result === 'missing') return false
      throw new Error('Release credential check returned neither ready nor missing')
    },
    publish: (request, artifactPath) => run('publish', request, artifactPath),
    observe: request => run('observe', request),
  }
}
