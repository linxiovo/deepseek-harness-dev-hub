import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlanArtifact, PlanVerificationRequest, PlanVerificationRun } from '../src/core/plan-integration.ts'
import { cleanupPlanArtifactStaging, commitPlanArtifact, discardPlanArtifact, downloadPlanArtifact, openPlanArtifact,
  planArtifactExists } from '../src/app/plan-artifacts.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plan-artifact-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const request: PlanVerificationRequest = { repository: 'acme/widgets', ref: 'refs/heads/main', sha: 'a'.repeat(40), context: 'b'.repeat(64),
  verification: { projectId: 'c'.repeat(32), workflowId: '44', identityJob: 'identity', jobs: ['identity', 'check', 'bundle'],
    artifactName: 'plugin-bundle', configuration: 'checks-v1', environment: 'hosted-v1' } }
const run: PlanVerificationRun = { id: 21, attempt: 2, url: 'https://github.com/acme/widgets/actions/runs/21', checks: [] }
const packageBytes = Buffer.from('verified package bytes')
const fileName = 'dsh-superagent-0.1.0.tgz'
const sha256 = createHash('sha256').update(packageBytes).digest('hex')
const reference = { id: 42, name: `plugin-bundle-${request.sha}-${run.attempt}`, url: `${run.url}/artifacts/42` }
const manifest = { repository: 'acme/widgets', ref: request.ref, sha: request.sha, context: request.context,
  configuration: request.verification.configuration, environment: request.verification.environment, runId: run.id, attempt: run.attempt,
  fileName, contentType: 'application/gzip', sha256 }
function commands(overrides: Record<string, unknown> = {}) {
  const execute = vi.fn(async (_program: string, args: string[]) => {
    const destination = args[args.indexOf('--dir') + 1]!
    const outputFile = typeof overrides.fileName === 'string' ? overrides.fileName : fileName
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, outputFile), packageBytes)
    writeFileSync(join(destination, 'dsh-artifact.json'), JSON.stringify({ ...manifest, ...overrides }))
  })
  return { value: { deployment: { github: { cli: 'gh' } }, run: execute }, execute }
}
function deliveredView(artifact: PlanArtifact) {
  return { status: 'delivered' as const, planId: 'plan-a', version: { repository: request.repository, ref: request.ref,
    sha: request.sha, context: request.context, workflowId: request.verification.workflowId,
    configuration: request.verification.configuration, environment: request.verification.environment }, run, artifact,
    verifiedAt: new Date().toISOString() }
}

it('downloads, binds and serves only the package whose manifest matches the exact Actions attempt', async () => {
  const cli = commands()
  const draft = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-${run.attempt}`, url: `${run.url}/artifacts/42` })
  expect(cli.execute).toHaveBeenCalledWith('gh', ['run', 'download', '21', '--repo', 'acme/widgets', '--name',
    `plugin-bundle-${request.sha}-2`, '--dir', expect.stringContaining('plan-artifacts-incoming-')], root)
  expect(draft.artifact).toMatchObject({ fileName, contentType: 'application/gzip', size: packageBytes.length, sha256 })
  commitPlanArtifact(draft)
  const view = deliveredView(draft.artifact)
  const file = await openPlanArtifact(root, 'plan-a', view)
  expect(file && readFileSync(file.path)).toEqual(packageBytes)
  expect(file).toMatchObject({ fileName, contentType: 'application/gzip', size: packageBytes.length, sha256 })
  writeFileSync(file!.path, 'tampered package')
  expect(await openPlanArtifact(root, 'plan-a', view)).toBeUndefined()
  const damaged = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-${run.attempt}`, url: `${run.url}/artifacts/42` })
  commitPlanArtifact(damaged)
  expect(await openPlanArtifact(root, 'plan-a', view)).toMatchObject({ sha256 })
  expect(readFileSync(file!.path)).toEqual(packageBytes)
  rmSync(file!.path)
  expect(await openPlanArtifact(root, 'plan-a', view)).toBeUndefined()
  const missing = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-${run.attempt}`, url: `${run.url}/artifacts/42` })
  commitPlanArtifact(missing)
  expect(readFileSync(file!.path)).toEqual(packageBytes)
})

it('rejects a package manifest for another workflow attempt', async () => {
  const cli = commands({ attempt: 1 })
  await expect(downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-2`, url: `${run.url}/artifacts/42` })).rejects.toThrow(/attempt/)
})

it('rejects extra files in a downloaded artifact instead of serving an ambiguous package', async () => {
  const cli = commands()
  cli.execute.mockImplementationOnce(async (_program, args) => {
    const destination = args[args.indexOf('--dir') + 1]!
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, fileName), packageBytes)
    writeFileSync(join(destination, 'dsh-artifact.json'), JSON.stringify(manifest))
    writeFileSync(join(destination, 'unexpected.txt'), 'extra')
  })
  await expect(downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-2`, url: `${run.url}/artifacts/42` })).rejects.toThrow(/exactly one file/)
})

it('rejects package bytes that do not match the identity manifest checksum', async () => {
  const cli = commands({ sha256: 'd'.repeat(64) })
  await expect(downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-2`, url: `${run.url}/artifacts/42` })).rejects.toThrow(/checksum/)
})
it('accepts a safely named executable artifact with its declared content type', async () => {
  const contentType = 'application/vnd.microsoft.portable-executable'
  const cli = commands({ fileName: 'worker.exe', contentType })
  const draft = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-${run.attempt}`, url: `${run.url}/artifacts/42` })
  expect(draft.artifact).toMatchObject({ fileName: 'worker.exe', contentType, sha256 })
})

it.each(['file', 'symbolic link'] as const)('reports a run slot replaced by a %s as unavailable and repairs it', async (kind) => {
  const cli = commands()
  const draft = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)
  mkdirSync(dirname(draft.finalDirectory), { recursive: true })
  const target = join(root, 'outside-run-slot')
  if (kind === 'file') writeFileSync(draft.finalDirectory, 'damaged run slot')
  else {
    mkdirSync(target)
    writeFileSync(join(target, fileName), packageBytes)
    symlinkSync(target, draft.finalDirectory, 'junction')
  }
  const view = deliveredView(draft.artifact)
  expect(planArtifactExists(root, 'plan-a', view)).toBe(false)
  await expect(openPlanArtifact(root, 'plan-a', view)).resolves.toBeUndefined()

  commitPlanArtifact(draft)

  expect(planArtifactExists(root, 'plan-a', view)).toBe(true)
  await expect(openPlanArtifact(root, 'plan-a', view)).resolves.toMatchObject({ sha256 })
  expect(readFileSync(join(draft.finalDirectory, fileName))).toEqual(packageBytes)
  if (kind === 'symbolic link') expect(readFileSync(join(target, fileName))).toEqual(packageBytes)
})

it('keeps the retained copy when a fresh download verifies the same bytes', async () => {
  const cli = commands()
  const first = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)
  commitPlanArtifact(first)
  const retained = join(first.finalDirectory, fileName)
  const { ino } = lstatSync(retained)
  const duplicate = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)

  commitPlanArtifact(duplicate)

  expect(lstatSync(retained).ino).toBe(ino)
  expect(readFileSync(retained)).toEqual(packageBytes)
  expect(() => readFileSync(join(duplicate.directory, fileName))).toThrow()
})

it('distinguishes an absent retained file from an unexpected I/O error', async () => {
  const cli = commands()
  const blockedAncestor = join(root, 'state-parent')
  const stateDir = join(blockedAncestor, 'state')
  const draft = await downloadPlanArtifact(cli.value as never, stateDir, 'plan-a', request, run, reference)
  const view = deliveredView(draft.artifact)
  expect(planArtifactExists(stateDir, 'plan-a', view)).toBe(false)
  await expect(openPlanArtifact(stateDir, 'plan-a', view)).resolves.toBeUndefined()

  rmSync(blockedAncestor, { recursive: true })
  writeFileSync(blockedAncestor, 'file')
  for (const inaccessibleRoot of [blockedAncestor, stateDir]) {
    expect(() => cleanupPlanArtifactStaging(inaccessibleRoot)).toThrow()
    expect(() => planArtifactExists(inaccessibleRoot, 'plan-a', view)).toThrow()
    await expect(openPlanArtifact(inaccessibleRoot, 'plan-a', view)).rejects.toThrow()
  }
  expect(() => commitPlanArtifact(draft)).toThrow()
  await expect(downloadPlanArtifact(cli.value as never, stateDir, 'plan-a', request, run, reference)).rejects.toThrow()
  expect(readFileSync(blockedAncestor, 'utf8')).toBe('file')
})

it('removes staging directories left by a process restart', () => {
  const rootDir = join(root, 'plan-artifacts'), stale = join(rootDir, 'plan-artifacts-incoming-abandoned')
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, 'partial'), 'interrupted')
  cleanupPlanArtifactStaging(root)
  expect(() => readFileSync(join(stale, 'partial'))).toThrow()
})

it('cleans an interrupted repair before serving or downloading again', async () => {
  const cli = commands()
  const original = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)
  commitPlanArtifact(original)
  writeFileSync(join(original.finalDirectory, fileName), 'damaged package')
  const interrupted = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)
  // Recreate a stop after removing the damaged slot but before publishing the verified draft.
  rmSync(original.finalDirectory, { recursive: true })
  const view = deliveredView(original.artifact)

  cleanupPlanArtifactStaging(root)

  expect(() => readFileSync(join(interrupted.directory, fileName))).toThrow()
  expect(planArtifactExists(root, 'plan-a', view)).toBe(false)
  await expect(openPlanArtifact(root, 'plan-a', view)).resolves.toBeUndefined()
  const retry = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run, reference)
  commitPlanArtifact(retry)
  expect(planArtifactExists(root, 'plan-a', view)).toBe(true)
  await expect(openPlanArtifact(root, 'plan-a', view)).resolves.toMatchObject({ sha256 })
})

it('removes an uncommitted download draft', async () => {
  const cli = commands()
  const draft = await downloadPlanArtifact(cli.value as never, root, 'plan-a', request, run,
    { id: 42, name: `plugin-bundle-${request.sha}-2`, url: `${run.url}/artifacts/42` })
  discardPlanArtifact(draft)
  expect(() => readFileSync(join(draft.directory, fileName))).toThrow()
})
