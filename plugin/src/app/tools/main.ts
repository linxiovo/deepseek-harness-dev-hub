/** Main Session tools for routing triggers, assessing candidates, sending replies, and updating settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { releaseNamePattern, releaseScopePattern, sameReleaseTarget, type ReleaseTarget } from '../../core/handoff.ts'
import { UserError, followupOwners, reasonText, type Decision, type DecisionKind, type Engine, type EngineForMainSession, type EngineForPeople }
  from '../../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from '../../infra/text.ts'
import { AssessmentSchema, EvalReadSchema, WorktreeNameSchema, type MasterAssessor } from '../assessment.ts'
import type { Handoffs } from '../handoffs.ts'
import { InstallationError } from '../installation-api.ts'
import { PlanTargetSchema, type Plans } from '../plans.ts'
import type { PlanDispatcher } from '../plan-dispatch.ts'
import { replanTechnical, TechnicalReplanSchema } from '../plan-replan.ts'
import type { PlanRequirements } from '../plan-requirements.ts'
import { PlanControlCommandSchema, type PlanControl } from '../plan-control.ts'
import type { MainlineQueue } from '../mainline-queue.ts'
import type { ProjectMeter } from '../project-meter.ts'
import { ticketCard } from '../cards.ts'
import { planQuestionRelay } from '../notices.ts'
import { readResource, type MainResourceHost, type ResourceHost } from '../resources.ts'
import type { RunLimits } from '../run-limits.ts'
import type { ScopedAttention } from '../scoped-attention.ts'
import type { Sessions } from '../sessions.ts'
import type { Settings } from '../settings.ts'
import { promptFile } from '../skill-files.ts'
import type { Store } from '../store.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

const RoutingNoteSchema = z.string().trim()
  .refine(text => wordCount(text) <= NOTE_WORDS, `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`)
  .describe(`Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`)
const HandoffAuthorizationSchema = z.object({
  scope: z.string().trim().min(1), release: z.enum(['authorized', 'not-authorized']),
  releaseTarget: z.object({ environment: z.string(), target: z.string(), scope: z.string() }).strict().optional(),
}).strict()
type DirectHandoffAuthorization = { scope: string; release: 'not-authorized' }
  | { scope: string; release: 'authorized'; releaseTarget: ReleaseTarget }
const isDirectHandoffAuthorization = (authorization: z.infer<typeof HandoffAuthorizationSchema>): authorization is DirectHandoffAuthorization => {
  if (authorization.release === 'not-authorized') return authorization.releaseTarget === undefined
  const target = authorization.releaseTarget
  return !!target && releaseNamePattern.test(target.environment) && releaseNamePattern.test(target.target)
    && releaseScopePattern.test(target.scope)
}
/** A handoff is a single product intent the user confirmed, not a bundle of unrelated goals. */
const HandoffConfirmationSchema = z.object({
  project: z.object({ repository: z.string().trim().min(1), workspace: z.string().trim().min(1) }).strict(),
  goal: z.string().trim().min(1),
  constraints: z.array(z.string().trim().min(1)),
  acceptanceScope: z.array(z.string().trim().min(1)).min(1),
  authorization: HandoffAuthorizationSchema,
  confirmation: z.string().min(1).refine(text => !!text.trim(), 'Confirmation cannot be blank')
    .describe('Verbatim latest direct Hub user confirmation; never relay.'),
}).strict()
const ApprovalSchema = z.object({
  confirmed: z.literal(true),
  brief: HandoffConfirmationSchema.omit({ confirmation: true }),
}).strict()
const PlanMessageSchema = z.object({
  planId: z.string().trim().min(1),
  target: PlanTargetSchema,
  text: z.string().trim().min(1).max(4000),
}).strict()
const PlanAnswerSchema = z.object({
  ticket_id: z.string().min(1).refine(id => !!id.trim()),
  question_id: z.string().min(1).refine(id => !!id.trim()),
  answer: z.string().min(1).refine(text => !!text.trim(), 'Answer cannot be blank'),
}).strict()
const handoffErrors = z.object({
  latestConfirmation: z.string().min(1),
  latestAnswer: z.string().min(1),
  confirmationSession: z.string().min(1),
  answerSession: z.string().min(1),
  invalidConfirmation: z.string().min(1),
  mismatchedBrief: z.string().min(1),
  latestPlanMessage: z.string().min(1),
}).strict().parse(JSON.parse(promptFile('handoff-errors')))
/** Only the latest direct Hub user event may authorize a handoff or address a plan. */
function latestDirectUserMessageId(agent: Agent, expected: string | ((text: string) => boolean), mismatch: string): string {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const message = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (typeof expected === 'string' ? message === expected : expected(message)) return String(event.seq)
    break
  }
  throw new Error(mismatch)
}

/** DSH identifies the local operator channel, not individuals. Inherited events and relay text confer no authority. */
function latestOperatorMessage(agent: Agent, currentTurn = false) {
  const events = agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= agent.session.inheritedEventCount; i--) {
    const event = events[i]
    if (currentTurn && event?.type === 'turn/end') break
    if (event?.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') {
      if (currentTurn) break
      continue
    }
    const [block] = event.data.content
    if (event.data.content.length === 1 && block?.type === 'text' && event.data.id) {
      return { sessionId: agent.id, messageId: event.data.id, seq: event.seq, at: event.time, text: block.text }
    }
    break
  }
  throw new Error(currentTurn ? 'Plan control requires a direct Harness operator message in the current turn'
    : 'A product change needs a single text message from the direct Harness operator')
}

export interface MainToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForMainSession, 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note' | 'approvePlanQuestion' | 'answerPlanQuestion'> &
    EngineForPeople & Pick<Engine, 'supersedePlanTicket'>
  readonly store: Pick<Store, 'get' | 'tickets' | 'triggers' | 'threads' | 'atomic' | 'replyStatus' | 'settings'>
  readonly settings: Pick<Settings, 'view' | 'block' | 'save' | 'pause' | 'sync'>
  readonly assessor: Pick<MasterAssessor, 'context' | 'read' | 'decide'>
  readonly resources: ResourceHost
  readonly sessions: MainResourceHost['sessions'] & Pick<Sessions, 'relay'>
  readonly projectMeter: Pick<ProjectMeter, 'read'>
  readonly runLimits: Pick<RunLimits, 'forDispatch' | 'view'>
  readonly attention: Pick<ScopedAttention, 'summary' | 'forTicket'>
  readonly planIntegration?: MainResourceHost['planIntegration']
  readonly handoffs: Pick<Handoffs, 'confirm' | 'answer' | 'get' | 'spec'>
  readonly plans: Pick<Plans, 'get' | 'definition' | 'repairSource' | 'testHistory' | 'view' | 'node' | 'append' | 'at' | 'revision' | 'current' | 'state' | 'requiredDelivery' | 'revise'>
  readonly stagnation: MainResourceHost['stagnation']
  readonly requirements: Pick<PlanRequirements, 'preview' | 'apply' | 'get'>
  readonly planControl: Pick<PlanControl, 'change' | 'view' | 'dispatchBlocked'>
  readonly planDispatcher: Pick<PlanDispatcher, 'dispatch'>
  readonly mainline: Pick<MainlineQueue, 'enqueue'>
  assertNewWork?(): void
  verifyProjectBinding?(): Promise<string | undefined>
  /** Schedules a pass to carry out work queued by an Engine command (such as an Eval or ticket resume). */
  requestPass(): void
  sendReplies(): Promise<void>
  /** Runs an Engine command initiated by the main Session without emitting self-notifications. */
  quietly<T>(run: () => T): T
}
/** Schedules an Engine pass to execute the recorded routing decision and formats the tool response. */
function routed(host: MainToolsHost, result: { decision?: DecisionKind; reason: string; ticketId?: string | undefined }) {
  host.requestPass()
  const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
    ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
}
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * One routing decision of `orchestrator_route`. The schema holds only its shape: each kind's fields are checked as its item
 * runs (`FIELDS`), so an item that lacks one, or whose value breaks a limit, is refused alone.
 */
const RouteItemSchema = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().nullish().describe('accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice.'),
  worktree_name: z.string().nullish().describe(`accept: ${WorktreeNameSchema.description ?? ''}`),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source on acceptance, so do not quote the source; quote an earlier proposal briefly only when the trigger merely confirms it and the sentence does not already state it. No generic I will handle it.`),
  note: z.string().nullish().describe(`accept and attach: ${RoutingNoteSchema.description ?? ''}`),
  reason: z.string().nullish().describe('ignore and stop: why, at most 500 characters; an ignore needs it.'),
}).strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
}
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    if (value === undefined || value === null || value.trim() === '') {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  return undefined
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
/**
 * Carry out one routing decision as its Engine command, in a transaction of its own. `decided` holds the Triggers that this
 * call's earlier items decided, with their batches.
 */
function route(host: MainToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const note = item.note ? { note: item.note } : {}
  // A Trigger an earlier item decided went with that item's Decision, also as a member of its batch.
  // A stop of it for another ticket is the Engine's to judge.
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      host.assertNewWork?.()
      const before = host.store.triggers.disposition(item.trigger_id)?.decisionId
      const decision = host.engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, name: item.worktree_name!, ...note })
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      host.assertNewWork?.()
      const ticket = host.quietly(() => host.engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // Through `engine.decide`, so only a person's message the gate admits with explicit strength stops a ticket.
    case 'stop': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
  }
}
/**
 * `orchestrator_route`: routing decisions for several triggers in one call, in order. Each runs as its own Engine command; one
 * that is refused, or fails, is answered so, and the others still run.
 */
function routeTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_route',
    description: 'Route candidates, one item each by the card\'s trigger_id, in one call: accept an explicit request as a new ticket, attach a trigger to an existing ticket, stop a ticket on a person\'s stop message, or ignore a candidate that needs no ticket or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others. An inferred candidate may be ignored here; accepting one goes through orchestrator_eval_decide.',
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const decided = new Map<string, string>()
      const results = decisions.map(item => {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const problem = invalid(item)
        if (problem) return { ...head, refused: problem }
        try {
          const result = route(host, item, decided)
          if ('refused' in result) return { ...head, ...result }
          for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
          const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
          return { ...head, ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
            ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
        } catch (error) {
          if (error instanceof UserError || error instanceof InstallationError) return { ...head, refused: error.message }
          host.context.logger.warn('dsh-superagent could not route trigger %s: %s', item.trigger_id, String(error))
          return { ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` }
        }
      })
      if (results.some(result => !('refused' in result))) host.requestPass()
      return { results }
    },
  })
}
/** Builds the main Session's tools; `agent` scopes prompt preview resources to that Session. */
export function mainTools(host: MainToolsHost, agent: Agent): Tool[] {
  const resources: MainResourceHost = { ...host.resources, sessions: host.sessions, settings: host.settings,
    handoffs: host.handoffs, plans: host.plans, projectMeter: host.projectMeter, runLimits: host.runLimits, attention: host.attention,
    planIntegration: host.planIntegration, stagnation: host.stagnation, requirements: host.requirements, planControl: host.planControl }
  return [
    readTool('Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.',
      false, (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, undefined, signal)),
    tool({
      name: 'orchestrator_handoff_confirm',
      description: 'Direct Hub approval only; release requires the exact environment, target and scope in that confirmation.',
      schema: HandoffConfirmationSchema,
      execute: async ({ confirmation, ...brief }) => {
        if (agent.id !== host.resources.masterId) throw new Error(handoffErrors.confirmationSession)
        const messageId = latestDirectUserMessageId(agent, confirmation, handoffErrors.latestConfirmation)
        let parsed: unknown
        try { parsed = JSON.parse(confirmation) } catch {
          throw new Error(handoffErrors.invalidConfirmation)
        }
        const approval = ApprovalSchema.safeParse(parsed)
        if (!approval.success) throw new Error(handoffErrors.invalidConfirmation)
        const approvedBrief = approval.data.brief
        if (!isDirectHandoffAuthorization(brief.authorization) || !isDirectHandoffAuthorization(approvedBrief.authorization)) {
          throw new Error(handoffErrors.invalidConfirmation)
        }
        if (brief.project.repository !== approvedBrief.project.repository || brief.project.workspace !== approvedBrief.project.workspace
          || brief.goal !== approvedBrief.goal
          || brief.constraints.length !== approvedBrief.constraints.length
          || brief.constraints.some((value, index) => value !== approvedBrief.constraints[index])
          || brief.acceptanceScope.length !== approvedBrief.acceptanceScope.length
          || brief.acceptanceScope.some((value, index) => value !== approvedBrief.acceptanceScope[index])
          || brief.authorization.scope !== approvedBrief.authorization.scope
          || brief.authorization.release !== approvedBrief.authorization.release
          || (brief.authorization.release === 'authorized' && approvedBrief.authorization.release === 'authorized' &&
            !sameReleaseTarget(brief.authorization.releaseTarget, approvedBrief.authorization.releaseTarget))) {
          throw new Error(handoffErrors.mismatchedBrief)
        }
        await host.verifyProjectBinding?.()
        const { handoff, reused } = host.handoffs.confirm({ ...approvedBrief,
          confirmedBy: { sessionId: agent.id, messageId, text: confirmation } })
        return { id: handoff.id, reused, handoff, spec: handoff.spec ?? null,
          read: { handoff: `handoff/${handoff.id}`, spec: `spec/${handoff.id}`, plan: `plan/${handoff.id}` } }
      },
    }),
    tool({
      name: 'orchestrator_handoff_answer',
      description: 'Hub only: relay the direct user answer to this handoff’s planner question; never infer it.',
      schema: z.object({ handoffId: z.string().trim().min(1), questionId: z.string().trim().min(1),
        answer: z.string().min(1).refine(text => !!text.trim(), 'Answer cannot be blank') }).strict(),
      execute: async ({ handoffId, questionId, answer }) => {
        if (agent.id !== host.resources.masterId) throw new Error(handoffErrors.answerSession)
        latestDirectUserMessageId(agent, answer, handoffErrors.latestAnswer)
        const handoff = host.handoffs.answer(handoffId, questionId, answer)
        return { handoffId, handoff, read: `handoff/${handoffId}`, spec: `spec/${handoffId}` }
      },
    }),
    tool({
      name: 'orchestrator_plan_question',
      description: promptFile('plan-question-tool'),
      schema: PlanAnswerSchema.omit({ answer: true }).extend({ criterion: z.number().int().positive() }),
      execute: async ({ ticket_id, question_id, criterion }) => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may approve Plan product questions')
        host.assertNewWork?.()
        return host.store.atomic(() => {
          const binding = host.store.tickets.get(ticket_id)?.plan
          const scope = binding && host.plans.definition(binding.planId, binding.nodeId)
          if (!scope || scope.retired || scope.node.role !== binding?.role || !scope.node.acceptance.includes(criterion)) {
            throw new UserError('invalidPlan', { detail: 'A product question must identify a criterion of the active Plan Ticket' })
          }
          const { ticket, reused } = host.engine.approvePlanQuestion(ticket_id, question_id)
          const relay = !reused && planQuestionRelay(ticket)
          if (relay) host.sessions.relay(relay.id, relay.text)
          return { ticket_id, question_id, criterion, reused }
        })
      },
    }),
    tool({
      name: 'orchestrator_plan_answer',
      description: 'Record the latest direct Hub user’s JSON answer to a current Plan Ticket question.',
      schema: PlanAnswerSchema,
      execute: async ({ ticket_id, question_id, answer }) => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may record Plan Ticket answers')
        const messageId = latestDirectUserMessageId(agent, text => {
          let raw: unknown
          try { raw = JSON.parse(text) } catch { return false }
          const parsed = PlanAnswerSchema.safeParse(raw)
          return parsed.success && parsed.data.ticket_id === ticket_id && parsed.data.question_id === question_id
            && parsed.data.answer === answer
        }, 'Plan answer must match the latest direct user message: JSON with ticket_id, question_id and answer')
        const input_id = host.engine.answerPlanQuestion(ticket_id, question_id, answer, agent.id, messageId)
        host.requestPass()
        return { ticket_id, question_id, input_id }
      },
    }),
    tool({
      name: 'orchestrator_plan_context',
      description: 'Record plan background or one node’s instruction from the direct user.',
      schema: z.object({ message: z.string().min(1).max(32_000)
        .describe('Verbatim user JSON: {planId, target: {kind: "background"} or {kind: "node", nodeId}, text}.') }).strict(),
      execute: async ({ message }) => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may record plan messages')
        const messageId = latestDirectUserMessageId(agent, message, handoffErrors.latestPlanMessage)
        let value: unknown
        try { value = JSON.parse(message) } catch { throw new Error('Plan context needs a JSON message with planId, target and text') }
        const { planId, target, text } = PlanMessageSchema.parse(value)
        host.plans.append(planId, target, { sessionId: agent.id, messageId, text })
        return { read: target.kind === 'node' ? `plan/${planId}/node/${target.nodeId}` : `plan/${planId}` }
      },
    }),
    tool({
      name: 'orchestrator_plan_dispatch',
      description: 'Dispatch a Frontier node after formal predecessor delivery; persist its claim before launch.',
      schema: z.object({ planId: z.string().trim().min(1), nodeId: z.string().trim().min(1) }).strict(),
      execute: async ({ planId, nodeId }) => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may dispatch Plan nodes')
        host.assertNewWork?.()
        return host.planDispatcher.dispatch(planId, nodeId)
      },
    }),
    tool({
      name: 'orchestrator_plan_replan',
      description: promptFile('plan-replan-tool'),
      schema: TechnicalReplanSchema,
      execute: async args => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may replan technical work')
        host.assertNewWork?.()
        return replanTechnical(host, args)
      },
    }),
    tool({
      name: 'orchestrator_plan_requirements',
      description: promptFile('plan-requirements-tool'),
      schema: z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('preview') }),
        z.strictObject({ mode: z.literal('apply'), proposalId: z.uuid() }),
      ]),
      execute: async args => {
        if (agent.id !== host.resources.masterId) throw new Error('Only the Hub may handle Plan requirement changes')
        if (args.mode === 'preview') return host.requirements.preview(latestOperatorMessage(agent))
        const replay = host.requirements.get(args.proposalId)?.status === 'applied'
        if (!replay) {
          host.assertNewWork?.()
          await host.verifyProjectBinding?.()
        }
        const result = host.requirements.apply(args.proposalId, latestOperatorMessage(agent))
        if (!replay) host.requestPass()
        return result
      },
    }),
    tool({
      name: 'orchestrator_plan_control',
      description: promptFile('plan-control-tool'),
      schema: PlanControlCommandSchema,
      execute: async args => {
        if (agent.id !== host.resources.masterId) throw new UserError('invalidPlan', { detail: 'Only the Hub may control Plan execution' })
        if (args.action === 'status') return host.planControl.view(args.planId)
        return host.planControl.change(args, latestOperatorMessage(agent, true))
      },
    }),
    tool({
      name: 'orchestrator_queue_merge',
      description: promptFile('queue-merge-tool'),
      schema: z.object({ ticket_id: z.string().trim().min(1), candidate: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
      execute: async ({ ticket_id, candidate }, signal) => {
        if (agent.id !== host.resources.masterId) throw new UserError('mainlineRefused', { reason: 'Only the Hub may queue a mainline merge' })
        host.assertNewWork?.()
        return host.mainline.enqueue(ticket_id, candidate, signal)
      },
    }),
    routeTool(host),
    tool({
      name: 'orchestrator_ticket_retry',
      description: 'Start a new assignment on an explicit human request to retry a ticket whose worker reported failed or blocked, or whose input was not delivered; the stalled one ends.',
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async args => {
        host.assertNewWork?.()
        if (host.store.tickets.get(args.ticket_id)?.plan) {
          throw new UserError('invalidPlan', { detail: 'Plan recovery follows the effective stagnation policy; manual retry requires an operator' })
        }
        return routed(host, { reason: 'Started a new assignment', ticketId: host.engine.retryTicket(args.ticket_id).id })
      },
    }),
    tool({
      name: 'orchestrator_ticket_request_status',
      description: 'Ask the worker of an idle ticket, one whose turn ended without a report, for a status report; for other tickets it sends nothing and returns the card.',
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async args => {
        const reason = host.engine.requestStatus(args.ticket_id) ? 'Asked the worker for a status report' : 'The worker is not waiting; nothing was sent'
        return routed(host, { reason, ticketId: args.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_ticket_note',
      description: 'Tell a ticket\'s worker a fact from other work, such as what another ticket found; it grants no authority.',
      schema: z.object({
        ticket_id: z.string(),
        text: z.string().trim().min(1).refine(text => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words`),
      }).strict(),
      execute: async args => {
        host.engine.note(args.ticket_id, args.text)
        return routed(host, { reason: 'Noted for the worker', ticketId: args.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_trigger_requeue',
      description: 'Queue a trigger for a fresh assessment, such as after its Source\'s access changed; a follow-up that reached a ticket comes back only from its worker.',
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async args => {
        host.assertNewWork?.()
        // A follow-up that reached a ticket is its worker's to judge, which hands back what is not its own; a person may still requeue it.
        const trigger = host.store.triggers.get(args.trigger_id)
        const owners = trigger ? followupOwners(trigger, host.store) : []
        if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
        const queued = host.quietly(() => host.engine.reevaluate(args.trigger_id))
        host.requestPass()
        return { queued }
      },
    }),
    tool({
      name: 'orchestrator_eval',
      description: 'Load a proactive candidate\'s window and its thread\'s tickets; repeated calls reuse them.',
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async (args, signal) => host.assessor.context(args.trigger_id, signal),
    }),
    tool({
      name: 'orchestrator_eval_read',
      description: 'Read more of a candidate\'s context, always with its trigger_id: a message or stub whole by message_id, an image by image_id, the root, the parent, a thread page by cursor, or a file or directory by path.',
      schema: EvalReadSchema,
      execute: async (read, signal) => host.assessor.read(agent, read, signal),
    }),
    tool({
      name: 'orchestrator_eval_decide',
      description: 'Record the decision of an assessment, as admission describes it, after orchestrator_eval with the same trigger_id.',
      schema: z.object({ trigger_id: z.string().min(1), ...AssessmentSchema.shape }).strict(),
      execute: async ({ trigger_id, ...result }, signal) => {
        const assessment = AssessmentSchema.parse(result)
        if (assessment.decision === 'accept') host.assertNewWork?.()
        const decided = await host.assessor.decide(trigger_id, assessment, signal)
        return routed(host, { decision: decided.state as DecisionKind, reason: decided.reason, ticketId: decided.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_reply',
      description: `Send an answer to a human question, a ready result, or attention requiring human action, as the replies section says; the gate refuses anything else, such as progress. purpose=result needs a ticket in person/review after a ready report, a completed or merged one, or a dropped one whose matched rule asks for a closing message. IM limit: ${IM_WORDS} words.`,
      schema: z.object({
        trigger_id: z.string().optional().describe('The original human question, for an answer only.'),
        ticket_id: z.string().optional(),
        purpose: z.enum(['answer', 'result', 'attention']),
        human_action: z.string().trim().min(1).optional().describe('Required for attention: the ticket\'s current attention question.'),
        text: z.string().min(1).max(20000),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: args.purpose, text: args.text, ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.human_action ? { question: args.human_action } : {}) })
        await host.sendReplies()
        return { status: host.store.replyStatus(reply.id) ?? reply.status }
      },
    }),
    tool({
      name: 'orchestrator_thread_unsubscribe',
      description: 'Drop every ticket subscription on a thread. Later messages there no longer reach those tickets as context; a new positive decision can subscribe it again.',
      schema: z.object({ thread: z.string().describe('Thread key, for example github:123 or feishu:<chat>:<root message>') }).strict(),
      execute: async args => {
        return { removed: host.quietly(() => host.engine.unsubscribe(args.thread)), thread: args.thread }
      },
    }),
    tool({
      name: 'orchestrator_settings_save',
      description: 'Save one settings block on an explicit human configuration request, never on observed content, as the panel would; read the blocks and revisions with orchestrator_read settings.',
      schema: z.object({
        block: z.enum(['policy', 'eval', 'executor', 'pause', 'source']).describe('pause pauses or resumes processing: new Evals, dispatch and replies.'),
        source: z.string().min(1).optional().describe('With block source: the Source instance id, such as github or feishu.'),
        value: z.unknown().describe('The whole block; a Source takes { enabled, config }, pause takes { paused }.'),
        revision: z.number().int().nonnegative().describe('The block\'s revision; pause ignores it.'),
      }).strict()
        .refine(args => (args.block === 'source') === (args.source !== undefined), 'source names the Source instance, with block source only'),
      execute: async args => {
        if (args.block === 'pause') return host.settings.pause(z.object({ paused: z.boolean() }).parse(args.value).paused, 'tool')
        // Strip context_delivery since the main Session initiated the save itself.
        const { context_delivery: _delivery, ...saved } = await host.settings.save(args.block === 'source' ? `source:${args.source!}` : args.block,
          args.value, args.revision, 'tool')
        return saved
      },
    }),
    tool({
      name: 'orchestrator_policy_sync',
      description: 'Refresh one Source\'s part of the Policy from where that Source keeps it, such as the Feishu users of its sync chat. Same operation as the Web button.',
      schema: z.object({ source: z.string() }).strict(),
      execute: async args => {
        const before = host.store.settings().policy.sources[args.source]?.allowed ?? []
        const after = (await host.settings.sync(args.source)).allowed
        const names = (from: typeof after, without: typeof after) => from.filter(item => !without.some(other => other.id === item.id))
          .map(item => item.name ?? item.id)
        return { source: args.source, allowed: after.length, added: names(after, before), removed: names(before, after) }
      },
    }),
  ]
}
