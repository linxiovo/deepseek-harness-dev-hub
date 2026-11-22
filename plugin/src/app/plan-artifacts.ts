/** Downloads and verifies the file attached to the latest successful Plan regression run. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PlanArtifact, PlanArtifactReference, PlanIntegrationView, PlanVerificationRequest, PlanVerificationRun } from '../core/plan-integration.ts'
import type { Commands } from '../infra/commands.ts'
const fileNameSchema = z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(value => !value.endsWith('.') &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))
const contentTypeSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
const Manifest = z.strictObject({ repository: z.string(), ref: z.string(), sha: z.string(), context: z.string(), configuration: z.string(),
  environment: z.string(), runId: z.number().int().positive(), attempt: z.number().int().positive(), fileName: fileNameSchema,
  contentType: contentTypeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const PlanArtifactFileSchema = z.strictObject({ path: z.string().min(1), fileName: fileNameSchema, contentType: contentTypeSchema,
  size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export type PlanArtifactFile = z.infer<typeof PlanArtifactFileSchema>
export interface PlanArtifactDraft { directory: string; finalDirectory: string; artifact: PlanArtifact }
interface VerifiedArtifact { size: number; mtimeMs: number; ino: number; sha256: string }
const verifiedArtifacts = new Map<string, VerifiedArtifact>()
/** Removes uncommitted extracts and displaced copies left by a crash; called under the Runtime's state lock. */
export function cleanupPlanArtifactStaging(stateDir: string): void {
  const root = join(stateDir, 'plan-artifacts')
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) if (name.startsWith('plan-artifacts-incoming-') || name.startsWith('plan-artifacts-replaced-')) {
    rmSync(join(root, name), { recursive: true, force: true })
  }
}

function planDirectory(stateDir: string, planId: string): string {
  const key = createHash('sha256').update(planId).digest('hex')
  return join(stateDir, 'plan-artifacts', key)
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function regularFile(path: string): number {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Plan artifact contains a non-regular file')
  return info.size
}
function missingFile(path: string, error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') return false
  let ancestor = dirname(path)
  for (;;) {
    try { return lstatSync(ancestor).isDirectory() }
    catch (failure) {
      if (!failure || typeof failure !== 'object' || !('code' in failure) || failure.code !== 'ENOENT') throw failure
      const parent = dirname(ancestor)
      if (parent === ancestor) return true
      ancestor = parent
    }
  }
}
/** Cheap synchronous check for the project panel; the actual download verifies the checksum again. */
export function planArtifactExists(stateDir: string, planId: string, view: PlanIntegrationView): boolean {
  if (view.status !== 'delivered' && view.status !== 'awaiting-release-verification' || !fileNameSchema.safeParse(view.artifact.fileName).success ||
      !contentTypeSchema.safeParse(view.artifact.contentType).success) return false
  const path = join(planDirectory(stateDir, planId), view.version.context, `${view.run.id}-${view.run.attempt}`, view.artifact.fileName)
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== view.artifact.size) return false
    const prior = verifiedArtifacts.get(path)
    if (prior && prior.size === info.size && prior.mtimeMs === info.mtimeMs && prior.ino === info.ino)
      return prior.sha256 === view.artifact.sha256
    const valid = digestSync(path) === view.artifact.sha256
    verifiedArtifacts.set(path, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, sha256: valid ? view.artifact.sha256 : '' })
    return valid
  } catch (error) { if (missingFile(path, error)) return false; throw error }
}
function digestSync(path: string): string {
  const descriptor = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let position = 0
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position)
      if (!count) return hash.digest('hex')
      hash.update(buffer.subarray(0, count)); position += count
    }
  } finally { closeSync(descriptor) }
}

/** Extracts the exact artifact into private staging and binds its file to run, attempt, commit and profile. */
export async function downloadPlanArtifact(commands: Commands, stateDir: string, planId: string, request: PlanVerificationRequest,
  run: PlanVerificationRun, artifact: PlanArtifactReference): Promise<PlanArtifactDraft> {
  if (artifact.name !== `${request.verification.artifactName}-${request.sha}-${run.attempt}`) throw new Error('Plan artifact name does not match its attempt')
  const root = join(stateDir, 'plan-artifacts')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(root, 'plan-artifacts-incoming-'))
  try {
    await commands.run(commands.deployment.github.cli, ['run', 'download', String(run.id), '--repo', request.repository,
      '--name', artifact.name, '--dir', directory], stateDir)
    const files = readdirSync(directory, { withFileTypes: true })
    if (files.length !== 2 || files.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error('Plan artifact must contain exactly one file and its identity manifest')
    }
    if (!files.some(entry => entry.name === 'dsh-artifact.json')) throw new Error('Plan artifact identity manifest is missing')
    const rawManifest = readFileSync(join(directory, 'dsh-artifact.json'))
    if (rawManifest.byteLength > 16_384) throw new Error('Plan artifact identity manifest is too large')
    const manifest = Manifest.parse(JSON.parse(rawManifest.toString('utf8')))
    const identity = { repository: request.repository.toLowerCase(), ref: request.ref, sha: request.sha, context: request.context,
      configuration: request.verification.configuration, environment: request.verification.environment, runId: run.id, attempt: run.attempt }
    for (const [key, value] of Object.entries(identity)) if (manifest[key as keyof typeof identity] !== value) {
      throw new Error(`Plan artifact identity does not match ${key}`)
    }
    if (files.filter(entry => entry.name !== 'dsh-artifact.json').map(entry => entry.name).join() !== manifest.fileName) {
      throw new Error('Plan artifact must contain one file with a safe filename')
    }
    const path = join(directory, manifest.fileName), size = regularFile(path)
    if (!size || await digest(path) !== manifest.sha256) throw new Error('Plan artifact file checksum is invalid')
    const finalDirectory = join(planDirectory(stateDir, planId), request.context, `${run.id}-${run.attempt}`)
    return { directory, finalDirectory, artifact: { ...artifact, fileName: manifest.fileName, contentType: manifest.contentType, size, sha256: manifest.sha256 } }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

/** Publishes verified bytes, repairing a missing or damaged copy for the same pinned run. */
export function commitPlanArtifact(draft: PlanArtifactDraft): void {
  const root = dirname(draft.directory), path = join(draft.finalDirectory, draft.artifact.fileName)
  mkdirSync(dirname(draft.finalDirectory), { recursive: true, mode: 0o700 })
  let exists = false, existingDirectory = false
  try {
    const info = lstatSync(draft.finalDirectory)
    exists = true
    existingDirectory = info.isDirectory() && !info.isSymbolicLink()
  } catch (error) { if (!missingFile(draft.finalDirectory, error)) throw error }
  let reusable = false
  if (existingDirectory) {
    try {
      const info = lstatSync(path)
      reusable = info.isFile() && !info.isSymbolicLink() && info.size === draft.artifact.size && digestSync(path) === draft.artifact.sha256
    } catch (error) { if (!missingFile(path, error)) throw error }
  }
  if (reusable) {
    const info = lstatSync(path)
    verifiedArtifacts.set(path, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, sha256: draft.artifact.sha256 })
    rmSync(draft.directory, { recursive: true, force: true })
    return
  }
  verifiedArtifacts.delete(path)
  const replacement = join(root, `plan-artifacts-replaced-${randomUUID()}`)
  let displaced = false
  if (exists) {
    renameSync(draft.finalDirectory, replacement)
    displaced = true
  }
  try { renameSync(draft.directory, draft.finalDirectory) }
  catch (error) {
    if (displaced) {
      try { renameSync(replacement, draft.finalDirectory) }
      catch (restoreError) { throw new AggregateError([error, restoreError], 'Could not publish or restore the retained Plan artifact') }
    }
    throw error
  }
  if (displaced) rmSync(replacement, { recursive: true, force: true })
  const info = lstatSync(path)
  verifiedArtifacts.set(path, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, sha256: draft.artifact.sha256 })
}

/** Discards an uncommitted download after a target or Actions attempt changes during final verification. */
export function discardPlanArtifact(draft: PlanArtifactDraft): void {
  rmSync(draft.directory, { recursive: true, force: true })
}

/** Rechecks the stored file checksum before opening it to a project-scoped Harness download. */
export async function openPlanArtifact(stateDir: string, planId: string, view: PlanIntegrationView): Promise<PlanArtifactFile | undefined> {
  if (view.status !== 'delivered' && view.status !== 'awaiting-release-verification') return undefined
  const { artifact, version, run } = view
  if (!fileNameSchema.safeParse(artifact.fileName).success || !contentTypeSchema.safeParse(artifact.contentType).success) return undefined
  const path = join(planDirectory(stateDir, planId), version.context, `${run.id}-${run.attempt}`, artifact.fileName)
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size || await digest(path) !== artifact.sha256) return undefined
    const current = statSync(path)
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ino !== info.ino) return undefined
    verifiedArtifacts.set(path, { size: current.size, mtimeMs: current.mtimeMs, ino: current.ino, sha256: artifact.sha256 })
    return { path, fileName: artifact.fileName, contentType: artifact.contentType, size: artifact.size, sha256: artifact.sha256 }
  } catch (error) { if (missingFile(path, error)) return undefined; throw error }
}
