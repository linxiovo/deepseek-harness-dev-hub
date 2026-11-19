import { fork } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { CrashPoint, Evidence, Observation } from './fixtures/runtime-crash-child.ts'

const childEntry = fileURLToPath(new URL('./fixtures/runtime-crash-child.ts', import.meta.url))

async function withCrash(point: CrashPoint, verify: (before: Evidence, after: Evidence, timeline: Observation[], crashOffset: number) => void) {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'orchestrator-crash-'))
  const readJournal = (): Observation[] => {
    const file = join(directory, 'observations.jsonl')
    try { return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async function run(phase: 'crash' | 'recover', ticket?: string) {
    const child = fork(childEntry, [point, phase, directory, ...ticket ? [ticket] : []], {
      execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let logs = ''
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs = `${logs}${chunk}`.slice(-16_384) })
    const evidence = Promise.withResolvers<Evidence>()
    const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    child.once('message', message => evidence.resolve(message as Evidence))
    child.once('error', error => evidence.reject(error))
    child.once('close', (code, signal) => {
      closed.resolve({ code, signal })
      evidence.reject(new Error(`Child closed before ${phase} evidence (${code ?? signal})`))
    })
    const timeout = setTimeout(() => {
      evidence.reject(new Error(`Timed out waiting for the ${point}/${phase} breakpoint`))
      child.kill('SIGKILL')
    }, 25_000)
    try {
      const snapshot = await evidence.promise
      expect(snapshot.pid).toBe(child.pid)
      if (phase === 'crash') expect(child.kill('SIGKILL')).toBe(true)
      expect(await closed.promise).toEqual(phase === 'crash' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null })
      return snapshot
    } catch (cause) {
      throw new Error(`${point}/${phase}: ${String(cause)}\n${logs}`, { cause })
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed.promise
    }
  }
  try {
    const before = await run('crash')
    const crashOffset = readJournal().length
    const lock = join(directory, 'installation.lock')
    expect(statSync(lock).isDirectory()).toBe(true)
    // Simulate the stale-lock interval passing only after confirmed process death. Leave the lock and SQLite to normal recovery.
    const stale = new Date(Date.now() - 60_000)
    utimesSync(lock, stale, stale)
    const after = await run('recover', before.ticket?.id)
    verify(before, after, readJournal(), crashOffset)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('mounts the selected project after SIGKILL before the old mount can shut down', async () => {
  await withCrash('switch', (before, after) => {
    const target = before.target!
    expect(before.mount).toMatchObject({ status: 'paused', reason: 'switching' })
    expect(before.mount.projectId).not.toBe(target.id)
    expect(before.state.setup.accounts?.repository).toBe('acme/widgets')
    expect(after.mount).toMatchObject({ mode: 'headless', status: 'ready', projectId: target.id, resumedFrom: null })
    expect(after.state).toMatchObject({ projectId: target.id, masterId: target.hubSessionId, setup: { accounts: { repository: 'acme/gadgets' } } })
  })
}, 60_000)

it('does not deliver a second worker assignment after SIGKILL before dispatch confirmation', async () => {
  await withCrash('dispatch', (before, after, timeline, crashOffset) => {
    const assignment = before.ticket!.assignments[0]!
    const execution = before.ticket!.execution!
    expect(assignment).toMatchObject({ state: 'pending' })
    expect(assignment).not.toHaveProperty('startedAt')
    expect(execution).toMatchObject({ preparation: { state: 'verified' }, active_writer: { assignment: assignment.id, session: expect.any(String) } })
    const session = execution.active_writer!.session
    const isDelivery = (event: Observation) => event.kind === 'delivery' && event.session === session
    expect(timeline.slice(0, crashOffset).filter(isDelivery)).toHaveLength(1)
    expect(timeline.filter(isDelivery)).toHaveLength(1)
    expect(after.mount).toMatchObject({ status: 'ready', projectId: before.mount.projectId, resumedFrom: { reason: 'interrupted' } })
    // A dead Runtime is not proof that the old DSH writer and all its subprocesses stopped. Fail closed rather than redeliver.
    expect(after.ticket).toMatchObject({ assignments: [{ id: assignment.id, report: { state: 'failed', summary: expect.stringContaining('previous writer') } }],
      execution: { worktree: execution.worktree, active_writer: execution.active_writer } })
  })
}, 60_000)

it('reconciles a merge after SIGKILL before its local receipt without calling merge again', async () => {
  await withCrash('merge', (before, after, timeline, crashOffset) => {
    expect(before.ticket).toMatchObject({ state: 'open', assignments: [{ state: 'running', report: { state: 'progress' } }] })
    expect(before.ticket!.threads).toContainEqual(expect.objectContaining({ key: 'github:42' }))
    expect(before.ticket).not.toHaveProperty('ended')
    expect(timeline.slice(0, crashOffset).filter(event => event.kind === 'merge')).toEqual([{ kind: 'merge', number: 42 }])
    expect(timeline.slice(crashOffset)).toContainEqual({ kind: 'pull-read', number: 42 })
    expect(timeline.filter(event => event.kind === 'merge')).toEqual([{ kind: 'merge', number: 42 }])
    expect(after.mount).toMatchObject({ projectId: before.mount.projectId, status: 'ready', resumedFrom: { reason: 'interrupted' } })
    expect(after.ticket).toMatchObject({ id: before.ticket!.id, state: 'ended', ended: { by: 'executor', outcome: 'merged' },
      assignments: [{ id: before.ticket!.assignments[0]!.id, state: 'ended' }] })
  })
}, 60_000)
