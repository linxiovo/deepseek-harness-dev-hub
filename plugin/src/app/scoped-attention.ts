/** Durable per-Ticket credential pauses and their shared Hub/management read model. */
import { key, latestAssignment, liveTicket, UserError } from '../core/index.ts'
import { KV } from '../kv.ts'
import { InstallationError } from './installation-api.ts'
import { projectPushRelay, type Relay } from './notices.ts'
import type { Plans } from './plans.ts'
import { promptFile } from './skill-files.ts'
import type { Store } from './store.ts'

const credentialRequest = promptFile('credential-action')

/** The project-scoped configuration entry returned to the Hub and management clients. */
export interface CredentialAction {
  id: string
  projectId: string
  planId: string
  nodeId: string
  ticketId: string
  title: string
  credentialId: string
  occurrence: number
  affectedNodes: string[]
  configuration: string
  providerUrl: string | null
  verifierConfigured: boolean
  status: 'awaiting' | 'verified'
  verification: 'not-checked' | 'failed' | 'passed'
}

export interface CredentialBlocker extends Omit<CredentialAction, 'configuration' | 'providerUrl' | 'verifierConfigured'> {
  assignmentId: string
  sessionId: string
}

export interface AttentionSummary {
  planId: string | null
  running: number
  awaitingHuman: number
  message: string
  actions: CredentialAction[]
}

interface AttentionHost {
  store: Pick<Store, 'get' | 'set' | 'tickets' | 'atomic' | 'afterCommit'>
  plans: Pick<Plans, 'get' | 'list' | 'state'>
  projectId: string | undefined
  available(): boolean
  writerAuthorized(ticketId: string, sessionId: string): boolean
  verifier(credentialId: string): { providerUrl?: string } | undefined
  check(credentialId: string): Promise<boolean>
  relay(message: Relay): void
  suspend(ticketId: string): void
  drained(ticketId: string): Promise<boolean>
  resume(ticketId: string, blockerId: string): void
}

/** Commits ticket pauses with deduplicated Hub relays, and only clears a current pause after trusted verification. */
export class ScopedAttention {
  constructor(private readonly host: AttentionHost) {}

  private current(ticketId: string): CredentialBlocker | undefined {
    const { store } = this.host
    const id = store.get(KV.attention.active(ticketId))
    const record = id && store.get(KV.attention.credential(id))
    if (!record || record.status !== 'awaiting' || record.projectId !== this.host.projectId) return undefined
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== record.assignmentId) return undefined
    return record
  }

  private action({ id, projectId, planId, nodeId, ticketId, title, credentialId, occurrence, affectedNodes, status, verification }: CredentialBlocker): CredentialAction {
    const verifier = this.host.verifier(credentialId)
    return { id, projectId, planId, nodeId, ticketId, title, credentialId, occurrence, affectedNodes, status, verification,
      configuration: `/orchestrator/api/attention/credentials/${id}`, providerUrl: verifier?.providerUrl ?? null, verifierConfigured: !!verifier }
  }

  blocked(ticketId: string): boolean { return this.current(ticketId) !== undefined }

  forTicket(ticketId: string): CredentialAction | undefined {
    const current = this.current(ticketId)
    return current && this.action(current)
  }

  summary(planId?: string): AttentionSummary {
    const record = planId === undefined ? undefined : this.host.plans.get(planId)
    if (planId !== undefined && !record) throw new UserError('unknownPlan', { id: planId })
    const plans = record ? [record] : this.host.plans.list()
    let running = 0, awaitingHuman = 0
    const actions: CredentialAction[] = []
    for (const plan of plans) for (const node of plan.nodes) {
      const state = this.host.plans.state(plan.id, node.id)
      if (!state || state.status !== 'running') continue
      const ticket = this.host.store.tickets.get(state.claim.ticketId)
      if (!ticket || !liveTicket(ticket)) continue
      const blocker = this.forTicket(ticket.id)
      if (blocker || ticket.attention) {
        awaitingHuman++
        if (blocker) actions.push(blocker)
      } else {
        const assignment = latestAssignment(ticket)
        const status = assignment?.report?.state
        if (assignment?.state === 'running' && status !== 'blocked' && status !== 'failed' && status !== 'ready') running++
      }
    }
    return { planId: planId ?? null, running, awaitingHuman, message: `${running} 张执行中，${awaitingHuman} 张待你处理`, actions }
  }

  entry(id: string): CredentialAction | undefined {
    const record = this.host.store.get(KV.attention.credential(id))
    if (!record || record.projectId !== this.host.projectId) return undefined
    if (record.status === 'awaiting' && this.current(record.ticketId)?.id !== id) return undefined
    return this.action(record)
  }

  block(ticketId: string, credentialId: string, sessionId: string, occurrence: number): CredentialAction {
    const { store, plans, projectId } = this.host
    return store.atomic(() => {
      const ticket = store.tickets.get(ticketId), binding = ticket?.plan, assignment = ticket && latestAssignment(ticket)
      if (!projectId || !this.host.available() || !ticket || !liveTicket(ticket) || !assignment || !binding
        || ticket.execution?.session !== sessionId || plans.state(binding.planId, binding.nodeId)?.claim.ticketId !== ticketId) {
        throw new UserError('invalidCredentialAction', { reason: 'Requires the current Plan Worker Session' })
      }
      const id = key('credential-action', projectId, ticketId, assignment.id, credentialId, String(occurrence))
      const prior = store.get(KV.attention.credential(id))
      if (prior?.sessionId === sessionId) return this.action(prior)
      if (this.blocked(ticketId)) throw new UserError('credentialBlocked')
      if (!this.host.writerAuthorized(ticketId, sessionId)) throw new UserError('invalidCredentialAction', { reason: 'Requires an active writer' })
      if (occurrence > 0 && store.get(KV.attention.credential(key('credential-action', projectId, ticketId, assignment.id, credentialId,
        String(occurrence - 1))))?.status !== 'verified') {
        throw new UserError('invalidCredentialAction', { reason: 'The previous occurrence was not verified' })
      }
      const affected = new Set([binding.nodeId])
      const nodes = plans.get(binding.planId)!.nodes
      for (;;) {
        const before = affected.size
        for (const node of nodes) if (node.blockedBy.some(predecessor => affected.has(predecessor))) affected.add(node.id)
        if (affected.size === before) break
      }
      affected.delete(binding.nodeId)
      const blocker: CredentialBlocker = { id, projectId, planId: binding.planId, nodeId: binding.nodeId, ticketId, title: ticket.title,
        credentialId, occurrence, affectedNodes: [...affected], assignmentId: assignment.id, sessionId, status: 'awaiting', verification: 'not-checked' }
      store.set(KV.attention.credential(id), blocker)
      store.set(KV.attention.active(ticketId), id)
      const action = this.action(blocker)
      const relay = projectPushRelay({ id: `credential-action:${id}`, kind: 'human-action', payload: {
        ...this.summary(binding.planId), action, request: credentialRequest
      } })
      if (relay) this.host.relay(relay)
      store.afterCommit(() => this.host.suspend(ticketId))
      return action
    })
  }

  async verify(id: string): Promise<CredentialAction | undefined> {
    const entry = this.entry(id)
    if (!entry || entry.status === 'verified') return entry
    if (!this.host.available()) throw new InstallationError(409, 'projectSetupRequired')
    const drained = await this.host.drained(entry.ticketId)
    if (!this.host.available()) throw new InstallationError(409, 'switching')
    if (!drained) throw new InstallationError(409, 'projectConflict')
    if (this.current(entry.ticketId)?.id !== id) return this.entry(id)
    const passed = await this.host.check(entry.credentialId)
    if (!this.host.available()) throw new InstallationError(409, 'switching')
    const { store } = this.host
    return store.atomic(() => {
      const current = this.current(entry.ticketId)
      if (current?.id !== id) return this.entry(id)
      current.verification = passed ? 'passed' : 'failed'
      if (passed) current.status = 'verified'
      store.set(KV.attention.credential(id), current)
      if (passed) this.host.resume(current.ticketId, id)
      return this.action(current)
    })
  }
}
