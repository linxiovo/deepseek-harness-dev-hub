import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { ApiError, apiMessages, caller } from './api.ts'
import type { T } from './text.ts'

/** The public sidebar-right observable of the Session visible in the main Conversation. */
export interface MountedConversation {
  getSnapshot(): SessionId | undefined
  subscribe(listener: () => void): () => void
}

interface FollowOptions {
  mounted: MountedConversation
  sessions: Pick<ISessions, 'list' | 'refresh'>
  openSession: (id: SessionId) => void
  reportError: (failure: unknown) => void
  t: T
}

const POLL_MS = 5000

/** Follow a project Hub in the host's native Conversation, independently of the management panel. */
export function followHubConversation({ mounted, sessions, openSession, reportError, t }: FollowOptions): () => void {
  let selected: SessionId | undefined
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  async function redirect(sessionId: SessionId, signal: AbortSignal) {
    const stillVisibleRoot = () => !signal.aborted && mounted.getSnapshot() === sessionId
      && sessions.list.getSnapshot().byId[sessionId]?.origin !== 'subagent'
    if (!stillVisibleRoot()) return
    const messages = () => apiMessages(t)
    const { projectId, masterId } = await caller(messages, undefined, signal)('GET state')
    if (!projectId || masterId === sessionId || !stillVisibleRoot()) return

    const scoped = caller(messages, projectId, signal)
    const { target } = await scoped('GET hub/conversation', { query: { sessionId } })
    if (!stillVisibleRoot() || !target || target.projectId !== projectId || target.sessionId === sessionId) return

    let commit: Promise<void> | undefined
    await openKnownSession(sessions, target.sessionId as SessionId, id => {
      // Catalog hydration can outlast another rotation or a project remount. Ask the scoped resolver again before committing.
      commit = (async () => {
        if (!stillVisibleRoot()) return
        const latest = await scoped('GET hub/conversation', { query: { sessionId } })
        if (!stillVisibleRoot() || latest.target?.projectId !== projectId || latest.target.sessionId !== id) return
        const catalog = sessions.list.getSnapshot()
        if (catalog.phase !== 'ready') throw new SessionNavigationError('not-ready')
        if (!catalog.byId[id]) throw new SessionNavigationError('not-listed')
        openSession(id)
      })()
    }, signal)
    await commit
  }

  function poll(sessionId: SessionId) {
    const request = new AbortController()
    controller = request
    void redirect(sessionId, request.signal).catch(failure => {
      if (request.signal.aborted) return
      // A mount changing during lookup invalidates this observation; the next poll reads the new mount.
      if (failure instanceof ApiError && (failure.details.code === 'staleProject' || failure.details.code === 'switching'
        || failure.details.code === 'noProject')) return
      reportError(failure)
    }).finally(() => {
      if (!request.signal.aborted) timer = setTimeout(() => poll(sessionId), POLL_MS)
    })
  }

  function selectionChanged() {
    const next = mounted.getSnapshot()
    if (next === selected) return
    selected = next
    clearTimeout(timer)
    controller?.abort()
    if (next) poll(next)
  }

  const unsubscribe = mounted.subscribe(selectionChanged)
  selectionChanged()
  return () => { unsubscribe(); clearTimeout(timer); controller?.abort() }
}
