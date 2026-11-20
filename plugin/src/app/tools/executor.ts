/** Executor Session tools for reading ticket context, taking requests up internally, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { DshExecutor } from '../../executor/dsh.ts'
import { isMarkdownDocument } from '../../executor/doc-tree.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'takeUp' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  readonly executor: Pick<DshExecutor, 'inspectDocImpact' | 'inspectTestEvidence'>
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
const docImpactSchema = z.strictObject({
  candidate: commitHash,
  root: markdownPath.nullable(), routes: docPaths, leaves: docPaths,
  impact: z.looseObject({ kind: z.enum(['updated', 'unchanged']) }),
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
})

export function executorTools(host: ExecutorToolsHost, ticket: Ticket, sessionId: string): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_doc_impact',
      description: 'Check candidate Doc Tree impact as the doc-tree skill says.',
      schema: docImpactSchema,
      execute: async ({ candidate, root, routes, leaves, impact: declaration }, signal) => {
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
        return { ...revision, scope: { root, routes, leaves }, impact, structure: issues.length ? 'issues' : root === null ? 'not-applicable' : 'checked',
          issues, semantic_review: 'required' }
      },
    }),
    tool({
      name: 'orchestrator_test_evidence',
      description: 'Bind observed test runs and scope to the clean Worker candidate as the implement skill says.',
      schema: testEvidenceSchema,
      execute: async (args, signal) => {
        const { candidate, checks, red } = args
        const revision = await host.executor.inspectTestEvidence(ticketId, sessionId, candidate, red?.map(run => run.revision) ?? [], signal)
        const allPassed = checks.length > 0 && checks.every(check => check.status === 'passed')
        const redCovered = red === null || red.length > 0 && red.every(run => checks.some(check => check.directory === run.directory && check.command === run.command))
        const result = checks.some(check => check.status === 'failed') ? 'failed' : allPassed && redCovered ? 'reported_passed' : 'unverified'
        return { ...args, ...revision, result, source: 'worker' }
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
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
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
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
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
}
