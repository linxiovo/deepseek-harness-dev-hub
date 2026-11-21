/** Admission at DSH's one-stream-per-attempt waterfall, before delegation to the adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest, LlmError, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { addAbortListener } from 'node:events'

/** Stable host refusal; a competing reservation is not a provider failure or a failed Ticket. */
export const RUN_LIMIT_REFUSAL = 'SUPERAGENT_RUN_LIMIT'

export type ModelAdmission = { admitted: true; settle(totalTokens: number | null): void } | { admitted: false; reason: string }
interface AdmissionHost {
  owns(sessionId: string): boolean
  acquire(sessionId: string, reservation: number | null, signal?: AbortSignal): ModelAdmission
}

/** Throw outside the finish-chunk protocol: even a DSH `always` provider retry policy must not retry admission. */
function refuse(reason = 'Model request refused by host run limits.'): never {
  throw new LlmError(reason, RUN_LIMIT_REFUSAL)
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const

/** Snapshot only DSH counters before yielding. Omitted cache buckets are unknown, not reported zeros. */
function receipt(usage: TokenUsage): TokenUsage | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!count(inputTokens) || !count(outputTokens) || !count(totalTokens)
    || (cacheReadTokens !== undefined && !count(cacheReadTokens)) || (cacheWriteTokens !== undefined && !count(cacheWriteTokens))
    || (reasoningTokens !== undefined && (!count(reasoningTokens) || reasoningTokens > outputTokens))) return null
  // Only a consistency lower bound. Never use it to synthesize a missing total; reasoning is already in output.
  const known = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(known) || known > totalTokens
    || (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && known !== totalTokens)) return null
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens }
}

/** The loop records this exact prepared adapter generation's combined input/output capacity before dispatch. */
function reservation(options: GenerateOptions, agent: Agent): number | null {
  if (!isAgentLoopRequest(options) || options.sessionId !== agent.id) return null
  const route = agent.session.requestContext()
  if (!route || route.provider !== options.provider || route.model !== options.model) return null
  return count(route.contextWindow) && route.contextWindow > 0 ? route.contextWindow : null
}

/**
 * Install on the owning Runtime's Cordis context. `owns` classifies, it does not authorize: `acquire` must
 * synchronously revalidate ownership, liveness and limits (including pending attempts) and persist before returning.
 * Only loop-built requests expose registration-bound capacity through their Session. A fresh model lookup, a
 * catalog entry, the last conversational route of an auxiliary call, or an output cap alone is not that evidence.
 *
 * @param context - plugin context with the pinned DSH agent registry and LLM stream event.
 * @param host - trusted Session ownership, durable admission and settlement. Null means unknown, never zero.
 * @returns the listener disposer; leave installed until owned Sessions are stopped and drained.
 */
export function installModelAdmission(context: Context, host: AdmissionHost): () => void {
  let installed = true
  const remove = context.on('llm/stream', (options, next) => {
    // Capture at dispatch, not at first pull: the initiating async scope and the Session's prepared route
    // belong to the caller, not necessarily to the consumer that later iterates the returned handle.
    const initiator = context.agents.currentInitiator()
    const { sessionId, signal } = options
    const subject = sessionId ?? initiator?.id
    if (subject === undefined) return next()
    const owned = host.owns(subject)
    if (initiator && subject !== initiator.id && (owned || host.owns(initiator.id))) refuse()
    if (!owned) return next()
    // No prepared bound for title generation. Suppress this optional call rather than creating a budget
    // blocker for its Worker. Setting this purpose cannot grant a passthrough or start provider I/O.
    if (options.purpose === 'session-title') refuse()
    if (!initiator || context.agents.get(subject) !== initiator) refuse()
    const maximum = reservation(options, initiator)

    // No reservation for a handle never iterated. Each DSH retry/restart dispatches a fresh handle.
    const stream = (async function* (): AsyncGenerator<StreamChunk, void> {
      if (!installed || signal?.aborted || options.sessionId !== sessionId || context.agents.get(subject) !== initiator) refuse()
      let lease: ModelAdmission
      try { lease = host.acquire(subject, maximum, signal) } catch { refuse() }
      if (!lease.admitted) refuse(lease.reason)
      let evidence: TokenUsage | null | undefined
      let finished = false
      let cancellation: Disposable | undefined
      try {
        if (!installed || signal?.aborted) refuse()
        // A consumer can be suspended at `yield` when cancellation arrives. Close even if it never pulls
        // again. If a pull is pending, return queues behind it, preserving usage delivered by that pull.
        if (signal) cancellation = addAbortListener(signal, () => {
          void stream.return(undefined).catch(() => context.logger.error('Could not close admitted model stream after cancellation.'))
        })
        for await (const chunk of next()) {
          if (finished) evidence = null // DSH forbids any further chunks after the terminal finish.
          else if (chunk.type === 'finish') finished = true
          else if (chunk.type === 'usage' && evidence !== null) {
            const previous: TokenUsage | undefined = evidence
            // Poison first: even a malformed adapter object throwing during inspection cannot retain an old receipt.
            evidence = null
            const current = receipt(chunk.usage)
            if (current && (!previous || usageKeys.every(key => previous[key] === current[key]))) evidence = current
          }
          yield chunk
        }
      } finally {
        cancellation?.[Symbol.dispose]()
        try { lease.settle(evidence?.totalTokens ?? null) } catch {
          // A failed commit remains the host's recovery responsibility. Do not retry or expose store/provider details.
          throw new LlmError('Host could not settle model usage.', RUN_LIMIT_REFUSAL)
        }
      }
    })()
    return stream
  }, { global: true })
  return () => { installed = false; remove() }
}
