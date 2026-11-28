/** Prove a host-created physical root against its durable creation intent before exposing a live Agent. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

type Creation = { token: string; cwd: string; marker?: 'dsh-superagent/inspection-root' | 'dsh-superagent/lookup-root' }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'dsh-superagent/hub-root': { sessionId: string; token: string }
    'dsh-superagent/inspection-root': { sessionId: string; token: string }
    'dsh-superagent/lookup-root': { sessionId: string; token: string }
  }
}

function rootHeader(header: SessionHeader, inherited: number, id: SessionId, creation: Creation, preset: string): boolean {
  return header.id === id && header.isSeeded === false && inherited === 0 && header.origin === undefined && header.parentSession === undefined
    && (header.delegationDepth ?? 0) === 0 && header.agentPreset === preset && !!header.cwd && isAbsolute(header.cwd) && isAbsolute(creation.cwd)
    && relative(realpathSync.native(header.cwd), realpathSync.native(creation.cwd)) === ''
}

function hasMarker(event: SessionEvent | undefined, id: SessionId, creation: Creation): boolean {
  return !!creation.token && !!event && event.type === (creation.marker ?? 'dsh-superagent/hub-root')
    && event.seq === 0 && event.ignorable === true
    && event.data?.sessionId === id && event.data.token === creation.token
}

function foldPreset(current: unknown, event: { type: string; data: unknown }): unknown {
  if (event.type !== 'agent-preset/selected') return current
  const data = event.data
  return data && typeof data === 'object' && 'agentPreset' in data ? data.agentPreset : undefined
}

/** Synchronous event ingress must not resolve an Agent (which can itself announce agent/created). */
export function matchesNativeRoot(ctx: Context, agent: Agent, creation: Creation, preset: string): boolean {
  try {
    const { session, id } = agent
    if (ctx.agents.get(id) !== agent || session.id !== id || !rootHeader(session.header, session.inheritedEventCount, id, creation, preset)
      || !hasMarker(session.eventAt(SessionSeq(0)), id, creation)) return false
    const projections = ctx.get('sessionProjections') as { stateOf(session: Agent['session'], name: 'agentPreset'): unknown } | undefined
    if (projections) return projections.stateOf(session, 'agentPreset') === preset
    return session.snapshotEvents().reduce<unknown>(foldPreset, session.header.agentPreset) === preset
  } catch { return false }
}

/** Create exclusively if permitted; an existing log is read-only evidence, never somewhere to add a missing marker. */
export async function openNativeRoot(ctx: Context, id: SessionId, creation: Creation, preset: string, allowCreate: boolean,
  authorize?: () => void): Promise<Agent> {
  if (!creation.token || !isAbsolute(creation.cwd)) throw new Error('Invalid native Session creation intent')
  const cwd = realpathSync.native(creation.cwd)
  const foreign = () => new Error(`Session ${id} does not match its persisted creation intent`)
  const persistence = ctx.sessionPersistence
  if (allowCreate && !ctx.agents.get(id) && !await persistence.stat(id)) {
    authorize?.()
    const time = Date.now()
    await using fresh = await persistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: time, cwd, agentPreset: preset, isSeeded: false })
    authorize?.()
    // V4 preserves unknown, explicitly ignorable, log-only events without projecting them into model history.
    await fresh.append([{ type: creation.marker ?? 'dsh-superagent/hub-root', seq: SessionSeq(0), time, data: { sessionId: id, token: creation.token }, ignorable: true }])
    await fresh.flush()
  } else await persistence.flush() // A same-process read may otherwise observe another handle's buffered writes.
  await using log = await persistence.open(id, 'read')
  if (log.id !== id || !rootHeader(log.header, log.inheritedEventCount, id, creation, preset)
    || !hasMarker((await log.read(0, 1)).events[0], id, creation)) throw foreign()
  let effective: unknown = log.header.agentPreset
  for (let offset = 1; ; ) {
    const { events } = await log.read(offset, 512)
    if (!events.length) break
    effective = events.reduce<unknown>(foldPreset, effective)
    offset += events.length
  }
  if (effective !== preset) throw foreign()
  const matches = (agent: Agent) => agent.id === id && agent.session.header.createdAt === log.header.createdAt && matchesNativeRoot(ctx, agent, creation, preset)
  const live = ctx.agents.get(id)
  if (live && !matches(live)) throw foreign()
  authorize?.()
  const workspace = await ctx.workspaceRegistry.create(cwd)
  if (!isAbsolute(workspace.path) || relative(cwd, realpathSync.native(workspace.path)) !== '') throw foreign()
  authorize?.()
  await workspace.attachSession(id)
  authorize?.()
  const resolved = await ctx.sessionController.resolveAgent(id)
  if ('error' in resolved) throw resolved.error
  if (!matches(resolved.agent)) throw foreign()
  return resolved.agent
}
