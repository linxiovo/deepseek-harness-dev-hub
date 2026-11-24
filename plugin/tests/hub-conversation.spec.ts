import { afterEach, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { followHubConversation } from '../src/client/hub-conversation.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

const PROJECT = 'a'.repeat(32)
const OTHER_PROJECT = 'b'.repeat(32)
const FIRST = 'first+hub' as SessionId
const NEXT = 'current-hub' as SessionId
const OTHER_HUB = 'other-hub' as SessionId
const CHILD = 'child' as SessionId
const t: T = key => zh[key]

function fixture(selected?: SessionId, listed = true) {
  vi.useFakeTimers()
  const listeners = new Set<() => void>()
  const show = (id: SessionId | undefined) => {
    selected = id
    for (const listener of listeners) listener()
  }
  const lookup = { projectId: PROJECT, masterId: FIRST, target: null as { projectId: string; sessionId: string } | null }
  const requests: { url: string; scope: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    expect(headers.get('x-orchestrator-request')).toBe('1')
    requests.push({ url, scope: headers.get('x-orchestrator-project-id') })
    if (url === '/orchestrator/api/state') return Response.json({ projectId: lookup.projectId, masterId: lookup.masterId })
    if (!url.startsWith('/orchestrator/api/hub/conversation?')) throw new Error(`Unexpected URL: ${url}`)
    if (headers.get('x-orchestrator-project-id') !== lookup.projectId) {
      return Response.json({ error: 'Project changed', code: 'staleProject' }, { status: 409 })
    }
    return Response.json({ target: lookup.target })
  }))
  const ready = Promise.withResolvers<void>()
  const catalog: SessionListState = { phase: 'ready', byId: {}, ids: [], projectionsBySession: {} }
  const list = (id: SessionId) => {
    catalog.byId[id] = { id, displayTitle: id, blank: false, running: false, updatedAt: 0, retainedBy: {} }
    catalog.ids.push(id)
  }
  if (listed) list(NEXT)
  list(CHILD)
  catalog.byId[CHILD]!.origin = 'subagent'
  const refresh = vi.fn(() => ready.promise)
  const sessions = { list: { getSnapshot: () => catalog, subscribe: () => () => {} }, refresh }
  const openSession = vi.fn((id: SessionId) => show(id))
  const reportError = vi.fn()
  const follow = () => followHubConversation({ mounted: {
    getSnapshot: () => selected,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }, sessions, openSession, reportError, t })
  return { show, lookup, requests, openSession, reportError, follow, refresh, releaseCatalog: () => { list(NEXT); ready.resolve() } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('continues the same native tab across multiple generations, including when startup restores the old selection later', async () => {
  const { follow, show, lookup, requests, openSession } = fixture(FIRST)
  const stop = follow()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession).not.toHaveBeenCalled()
    lookup.masterId = NEXT
    // The server resolves the first retired identity directly to the latest generation.
    lookup.target = { projectId: PROJECT, sessionId: NEXT }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(openSession).toHaveBeenCalledExactlyOnceWith(NEXT)
  } finally { stop() }

  show(undefined)
  const stopAfterRefresh = follow()
  try {
    const beforeRestore = requests.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requests).toHaveLength(beforeRestore)
    show(FIRST)
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession.mock.calls).toEqual([[NEXT], [NEXT]])
    expect(requests).toContainEqual({ url: '/orchestrator/api/hub/conversation?sessionId=first%2Bhub', scope: PROJECT })
  } finally { stopAfterRefresh() }
})

it('does not open a successor when its project unmounts during Session catalog hydration', async () => {
  const { follow, show, lookup, openSession, refresh, releaseCatalog, reportError } = fixture(FIRST, false)
  lookup.masterId = NEXT
  lookup.target = { projectId: PROJECT, sessionId: NEXT }
  const stop = follow()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()
    lookup.projectId = OTHER_PROJECT
    lookup.masterId = OTHER_HUB
    releaseCatalog()
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession).not.toHaveBeenCalled()

    show(OTHER_HUB)
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession).not.toHaveBeenCalled()
    lookup.projectId = PROJECT
    lookup.masterId = NEXT
    lookup.target = null
    await vi.advanceTimersByTimeAsync(5_000)
    expect(openSession).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  } finally { stop() }
})

it('does not take over a child selected while the previous Hub navigation awaits the catalog', async () => {
  const { follow, show, lookup, openSession, refresh, releaseCatalog } = fixture(FIRST, false)
  lookup.masterId = NEXT
  lookup.target = { projectId: PROJECT, sessionId: NEXT }
  const stop = follow()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()
    show(CHILD)
    releaseCatalog()
    await vi.advanceTimersByTimeAsync(0)
    // The old result cannot take over, and the child itself is never followed.
    expect(openSession).not.toHaveBeenCalled()
  } finally { stop() }
})
