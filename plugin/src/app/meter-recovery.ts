import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { KV } from '../kv.ts'
import type { MeterSessionBinding, ProjectMeter } from './project-meter.ts'
import type { Store } from './store.ts'

/** Backfill attribution from historical review submissions, never from task markers, and without loading an Agent. */
export async function restoreReviewBindings(ctx: Pick<Context, 'sessionPersistence'>, store: Pick<Store, 'tickets' | 'get'>,
  projectMeter: Pick<ProjectMeter, 'bind' | 'owns'>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const parents = new Map<string, string | undefined>()
  async function nativeParent(id: string): Promise<string | undefined> {
    signal.throwIfAborted()
    if (!parents.has(id)) {
      let parent: string | undefined
      try {
        const snapshot = await ctx.sessionPersistence.stat(id as SessionId, { signal })
        const header = snapshot?.header
        if (snapshot?.formatStatus !== 'migration-required' && header?.id === id && header.origin === 'subagent') {
          parent = header.parentSession
        }
      } catch {
        // An unavailable log cannot corroborate a receipt. A later recovery can try again.
      }
      signal.throwIfAborted()
      parents.set(id, parent)
    }
    return parents.get(id)
  }

  for (const ticket of store.tickets.list()) {
    for (const assignment of ticket.assignments) {
      const evidence = assignment.reviews?.evidence, workerId = assignment.writer?.session
      if (!evidence?.length || !workerId) continue
      const worker = store.get(KV.projectMeter.binding(workerId))
      if (worker?.session_id !== workerId || worker.ticket_id !== ticket.id || !worker.roles.includes('implementation')) continue
      for (const { reviewer_session: id } of evidence) {
        if (!id || id === workerId || projectMeter.owns(id)) continue
        const direct = await nativeParent(id)
        if (!direct) continue

        // Every intermediate hop must already have a matching business edge in this ticket.
        // Do not synthesize missing bindings or flatten a nested reviewer under the Worker.
        let ancestor: string | undefined = direct
        if (ancestor !== workerId) {
          const seen: Set<string> = new Set([id])
          while (ancestor && ancestor !== workerId && !seen.has(ancestor)) {
            seen.add(ancestor)
            const binding: MeterSessionBinding | undefined = store.get(KV.projectMeter.binding(ancestor))
            if (binding?.session_id !== ancestor || binding.ticket_id !== ticket.id || binding.plan_id !== worker.plan_id
              || !(binding.roles.includes('implementation') || binding.roles.includes('review'))
              || !binding.parent_session_id || await nativeParent(ancestor) !== binding.parent_session_id) break
            ancestor = binding.parent_session_id
          }
        }
        signal.throwIfAborted()
        // Live registration may have bound this child while stat was pending.
        if (ancestor === workerId && !projectMeter.owns(id)) {
          projectMeter.bind({ session_id: id, role: 'review', ticket_id: ticket.id, parent_session_id: direct })
        }
      }
    }
  }
}
