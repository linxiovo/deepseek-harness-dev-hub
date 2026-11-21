/** Executor Session tools for reading ticket context, taking requests up internally, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, UserError, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { credentialIdPattern } from '../../deployment.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { DshExecutor } from '../../executor/dsh.ts'
import { isMarkdownDocument } from '../../executor/doc-tree.ts'
import { deliveryAcceptance, readResource, resourceName, type ResourceHost } from '../resources.ts'
import type { ScopedAttention } from '../scoped-attention.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import { promptFile } from '../skill-files.ts'
import type { Sessions } from '../sessions.ts'
import { readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'recordReview' | 'recordDeliveryEvidence' | 'takeUp' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify' | 'authorizeReviewSession'>
  readonly resources: ResourceHost
  readonly attention: Pick<ScopedAttention, 'block'>
  readonly executor: Pick<DshExecutor, 'inspectDocImpact' | 'inspectTestEvidence' | 'inspectReviewCandidate' | 'inspectDeliveryCandidate'>
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
}

const markdownPath = z.string().refine(path => path.length <= 512 && isMarkdownDocument(path) && !/[\\:\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a repository-relative Markdown path')
const docPaths = z.array(markdownPath).refine(paths => paths.length <= 100, 'At most 100 paths may be declared')
const impactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('updated'), documents: docPaths.refine(paths => paths.length > 0), contracts: docPaths }),
  z.strictObject({ kind: z.literal('unchanged'), reason: z.string().trim().min(1).max(1000) }),
])
const commitHash = z.string().refine(sha => /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha), 'Expected a full lowercase commit hash')
const evidenceReference = z.string().trim().min(1).max(1000)
const evidenceLinks = z.array(evidenceReference).min(1).max(20)
const evidenceId = z.string().trim().min(1).max(100)
const evidenceKeys = z.array(evidenceId).max(100)
const docImpactSchema = z.strictObject({
  candidate: commitHash,
  root: markdownPath.nullable(), routes: docPaths, leaves: docPaths,
  impact: z.looseObject({ kind: z.enum(['updated', 'unchanged']) }),
  reference: evidenceReference.optional(),
})

const runEvidence = {
  directory: z.string().min(1).max(512).refine(path => path === '.' || !/[\\:\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a worktree-relative directory'),
  command: z.string().trim().min(1).max(1000),
  observed: z.string().trim().min(1).max(1000),
}
const testEvidenceSchema = z.strictObject({
  candidate: commitHash,
  scope: z.enum(['focused', 'consumers', 'full']),
  reason: z.string().trim().min(1).max(1000),
  checks: z.array(z.strictObject({ ...runEvidence, status: z.enum(['passed', 'failed', 'not_run', 'pending', 'cancelled']) })).max(50),
  red: z.array(z.strictObject({ ...runEvidence, revision: commitHash })).max(50).nullable(),
  reference: evidenceReference.optional(),
})
const reviewSubmitSchema = z.strictObject({
  candidate: commitHash,
  axis: z.enum(['standards', 'spec']),
  basis: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  conclusion: z.enum(['passed', 'blocked']),
  summary: z.string().trim().min(1).max(4000),
  blockers: z.array(z.string().trim().min(1).max(1000)).max(50),
  reuses: evidenceKeys.optional(),
})
const retroSchema = z.strictObject({
  candidate: commitHash,
  kind: z.enum(['first-retro', 'acceptance', 'final-retro', 'repair']),
  findings: z.array(z.strictObject({ id: evidenceId, category: z.enum(['correctness', 'security', 'standard', 'optional']),
    summary: evidenceReference, evidence: evidenceLinks, affects: evidenceKeys.optional() })).max(50).optional(),
  results: z.array(z.strictObject({ id: evidenceId, status: z.enum(['passed', 'failed', 'not_run']), evidence: evidenceLinks })).max(100).optional(),
  fixes: z.array(z.strictObject({ id: evidenceId, evidence: evidenceLinks })).min(1).max(100).optional(),
})

// Credentials go through the structured blocker, not the free-text product-question path.
const credentialTerms = /\b(?:passwords?|passcodes?|credentials?|secrets?|(?:api|access|private)[ -]?keys?|(?:access|auth|api|bearer) tokens?)\b|密钥|密码|口令|凭据|令牌/iu
const requestsCredential = /^\s*(?:please\s+)?(?:provide|paste|send|share|give|reveal|enter|tell me|what is|what's)\b|请(?:提供|粘贴|输入|发给|告知)|是什么[？?]?$/iu

export function executorTools(host: ExecutorToolsHost, ticket: Ticket, sessionId: string, reviewOnly = false): Tool[] {
  const ticketId = ticket.id
  const tools: Tool[] = [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_review_submit',
      description: 'Submit your independent standards or specification review of the exact clean current ticket candidate. Cite concrete repository documents or ticket/spec evidence in basis; report blockers explicitly.',
      schema: reviewSubmitSchema,
      execute: async (args, signal) => {
        if (!await host.sessions.authorizeReviewSession?.(ticketId, sessionId, args.axis, args.candidate))
          throw new Error('Review submission requires an active code-review descendant assigned to this axis')
        const revision = await host.executor.inspectReviewCandidate(ticketId, sessionId, args.candidate, signal)
        const recorded = host.engine.recordReview(ticketId, sessionId, { ...args, base: revision.base })
        return { evidence: recorded.evidence, aggregate: recorded.status }
      },
    }),
    tool({
      name: 'orchestrator_retro_evidence',
      description: 'Record candidate delivery evidence.',
      schema: retroSchema,
      execute: async ({ candidate, kind, findings, results, fixes }, signal) => {
        const count = Number(findings !== undefined) + Number(results !== undefined) + Number(fixes !== undefined)
        const expected = kind === 'acceptance' ? results : kind === 'repair' ? fixes : findings
        if (count !== 1 || !expected) throw new Error('Supply only findings for retro, results for acceptance, or fixes for repair')
        const current = host.store.tickets.get(ticketId)
        if (!current) throw new Error('Unknown ticket')
        const prior = kind === 'repair' ? current.deliveryCheck?.events.at(-1)?.revision : undefined
        if (kind === 'repair' && !prior) throw new Error('No retro or acceptance finding has been recorded for repair')
        const revision = await host.executor.inspectDeliveryCandidate(ticketId, sessionId, candidate, prior?.candidate, signal)
        const event = kind === 'acceptance' && results ? { kind, results, expected: deliveryAcceptance(host.resources, current) }
          : kind === 'repair' && fixes ? { kind, fixes }
          : (kind === 'first-retro' || kind === 'final-retro') && findings ? { kind, findings } : undefined
        if (!event) throw new Error('Missing evidence for this delivery step')
        const evidence = event.kind === 'acceptance' ? event.results : event.kind === 'repair' ? event.fixes : event.findings
        for (const item of evidence) for (const ref of item.evidence) {
          const reference = resourceName(ref)
          if (reference === `ticket/${ticketId}/delivery-check`) throw new Error('Cite the original observation, not the delivery-check package itself')
          if (!reference.startsWith('ticket/') || !reference.includes('/delivery-observation/')) continue
          const match = /^ticket\/([^/]+)\/delivery-observation\/(0|[1-9]\d*)$/.exec(reference)
          const observation = match?.[1] === ticketId ? current.deliveryCheck?.events[Number(match[2])] : undefined
          if (!observation) throw new Error('Delivery observation is missing or belongs to another ticket')
          if (event.kind === 'acceptance' && (observation.revision.candidate !== candidate || observation.revision.base !== revision.base
            || observation.revision.generation !== revision.generation)) throw new Error('Acceptance observation must match the current revision')
        }
        host.engine.recordDeliveryEvidence(ticketId, sessionId, revision, event, prior)
        return { ...revision, recorded: kind, read: `ticket/${ticketId}/delivery-check` }
      },
    }),
    tool({
      name: 'orchestrator_doc_impact',
      description: 'Check candidate Doc Tree impact as the doc-tree skill says.',
      schema: docImpactSchema,
      execute: async ({ candidate, root, routes, leaves, impact: declaration, reference }, signal) => {
        const impact = impactSchema.parse(declaration)
        if (root === null && (routes.length || leaves.length || impact.kind === 'updated')) {
          throw new Error('Doc Tree updates and declared nodes require a navigation root')
        }
        if (impact.kind === 'updated' && impact.contracts.some(path => !leaves.includes(path) || !impact.documents.includes(path))) {
          throw new Error('Each changed interface contract must be a declared leaf and an updated document')
        }
        const documents = impact.kind === 'updated' ? impact.documents : undefined
        const { changes, issues, ...revision } = await host.executor.inspectDocImpact(ticketId, sessionId, candidate, { root, routes, leaves, documents }, signal)
        const scope = new Set([root, ...routes, ...leaves])
        const changedDocuments = changes.filter(path => scope.has(path))
        if (impact.kind === 'unchanged' && changedDocuments.length) throw new Error('Documents in the declared Doc Tree changed in this candidate')
        if (impact.kind === 'updated') {
          const changed = new Set(changes)
          for (const path of impact.documents) if (!changed.has(path)) throw new Error(`Document is not changed in this candidate: ${path}`)
          for (const path of changedDocuments) if (!impact.documents.includes(path)) throw new Error(`Changed Doc Tree document is not declared: ${path}`)
        }
        const structure = issues.length ? 'issues' : root === null ? 'not-applicable' : 'checked'
        const evidence = { scope: { root, routes, leaves }, impact, issues: issues.map(issue => ({ ...issue })), semantic_review: 'required' as const }
        const index = host.engine.recordDeliveryEvidence(ticketId, sessionId, revision,
          { kind: 'docs', structure, evidence, reference: reference ?? `ticket/${ticketId}/delivery-check` })
        const { base } = revision
        return { candidate, base, ...evidence, structure, read: `ticket/${ticketId}/delivery-observation/${index}` }
      },
    }),
    tool({
      name: 'orchestrator_test_evidence',
      description: 'Bind observed test runs and scope to the clean Worker candidate as the implement skill says.',
      schema: testEvidenceSchema,
      execute: async (args, signal) => {
        const { candidate, checks, red, reference, scope, reason } = args
        const revision = await host.executor.inspectTestEvidence(ticketId, sessionId, candidate, red?.map(run => run.revision) ?? [], signal)
        const allPassed = checks.length > 0 && checks.every(check => check.status === 'passed')
        const redCovered = red === null || red.length > 0 && red.every(run => checks.some(check => check.directory === run.directory && check.command === run.command))
        const result = checks.some(check => check.status === 'failed') ? 'failed' : allPassed && redCovered ? 'reported_passed' : 'unverified'
        const index = host.engine.recordDeliveryEvidence(ticketId, sessionId, revision, { kind: 'tests', result, evidence: { scope, reason, checks, red },
          reference: reference ?? `ticket/${ticketId}/delivery-check` })
        return { ...args, base: revision.base, result, source: 'worker', read: `ticket/${ticketId}/delivery-observation/${index}` }
      },
    }),
    tool({
      name: 'orchestrator_ack',
      description: 'Record that you take this human request up as work within this ticket, before substantial work, as the replies section says; the record stays internal and sends nothing to the person.',
      schema: z.object({
        trigger_id: z.string().describe('The trigger_id of the original human message, which must have reached this ticket.'),
      }).strict(),
      execute: async args => {
        const takeUp = host.engine.takeUp(ticketId, args.trigger_id)
        return { trigger_id: args.trigger_id, taken_up: true, reused: takeUp.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed && !ticket.plan) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish(),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        if (current.plan && args.human_action && credentialTerms.test(args.human_action) && requestsCredential.test(args.human_action)) {
          throw new UserError('invalidCredentialAction', { reason: 'Use the credential blocker for account configuration' })
        }
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue any eligible relay in the same transaction.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
  if (!reviewOnly && ticket.plan && liveTicket(ticket)) tools.push(tool({
    name: 'orchestrator_credential_blocked',
    description: promptFile('worker-credential-report'),
    schema: z.strictObject({ credential_id: z.string().regex(credentialIdPattern), occurrence: z.number().int().nonnegative().default(0) }),
    // The host validates the live writer and permits a repeat of an already recorded action.
    execute: async ({ credential_id, occurrence }) => host.attention.block(ticketId, credential_id, sessionId, occurrence),
  }))
  return reviewOnly ? tools.filter(item => item.name === 'orchestrator_review_submit') : tools.filter(item => item.name !== 'orchestrator_review_submit')
}
