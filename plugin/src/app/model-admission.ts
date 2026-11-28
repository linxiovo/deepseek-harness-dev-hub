/** Admission at DSH's one-stream-per-attempt waterfall, before delegation to the adapter. */
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, LlmError, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { addAbortListener } from 'node:events'

/** Stable host refusal; a competing reservation is not a provider failure or a failed Ticket. */
export const RUN_LIMIT_REFUSAL = 'SUPERAGENT_RUN_LIMIT'

export type ModelAdmission = { admitted: true; settle(totalTokens: number | null): void }
  | { admitted: false; reason: string; wait?: Promise<void>; requiresOperator?: true }
interface AdmissionHost {
  owns(sessionId: string): boolean
  acquire(sessionId: string, reservation: number | null, signal: AbortSignal | undefined, loopRequest: GenerateOptions | undefined): ModelAdmission
}

async function waitForBalance(change: Promise<void>, signal: AbortSignal): Promise<void> {
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const listener = addAbortListener(signal, () => reject(new LlmError('Model request cancelled while waiting for quota.', RUN_LIMIT_REFUSAL)))
  try { await Promise.race([change, aborted]) }
  finally { listener[Symbol.dispose]() }
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

/**
 * Install on the owning Runtime's Cordis context. `owns` classifies, it does not authorize: `acquire` must
 * synchronously revalidate ownership, liveness and limits (including pending attempts) and persist before returning.
 * Only loop-built requests expose registration-bound capacity through their Session. A fresh model lookup, a
 * catalog entry, the last conversational route of an auxiliary call, or an output cap alone is not that evidence.
 *
 * @param context - plugin context with the pinned DSH agent registry and LLM stream event.
 * @param host - trusted Session ownership, durable admission and settlement. Null means unknown, never zero.
 * @param lifetime - aborts requests still waiting at admission when the Runtime stops.
 * @returns the listener disposer; leave installed until owned Sessions are stopped and drained.
 */
export function installModelAdmission(context: Context, host: AdmissionHost, lifetime: AbortSignal): () => void {
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
    const route = isAgentLoopRequest(options) && sessionId === initiator.id ? initiator.session.requestContext() : undefined
    const loopRequest = !!route && route.provider === options.provider && route.model === options.model
    const maximum = loopRequest && count(route.contextWindow) && route.contextWindow > 0 ? route.contextWindow : null

    // No reservation for a handle never iterated. Each DSH retry/restart dispatches a fresh handle.
    const stream = (async function* (): AsyncGenerator<StreamChunk, void> {
      let lease: Extract<ModelAdmission, { admitted: true }>
      let waitSignal: AbortSignal | undefined
      for (;;) {
        if (!installed || lifetime.aborted || signal?.aborted || options.sessionId !== sessionId || context.agents.get(subject) !== initiator) refuse()
        let decision: ModelAdmission
        try { decision = host.acquire(subject, maximum, signal, loopRequest ? options : undefined) }
        catch { throw new LlmError('Host could not reserve model usage.', 'SUPERAGENT_USAGE_RESERVATION_FAILED') }
        if (decision.admitted) { lease = decision; break }
        if (decision.requiresOperator) throw new LlmError(decision.reason, 'SUPERAGENT_RUN_LIMIT_CONFIGURATION')
        if (!decision.wait) refuse(decision.reason)
        waitSignal ??= signal ? AbortSignal.any([signal, lifetime]) : lifetime
        await waitForBalance(decision.wait, waitSignal)
      }
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
          // Keep the durable reservation for recovery; a store failure is not a quota refusal or provider retry.
          context.logger.error('Could not persist model usage settlement; reservation retained for restart recovery.')
          throw new LlmError('Host could not settle model usage. Restart to recover the pending reservation.', 'SUPERAGENT_USAGE_SETTLEMENT_FAILED')
        }
      }
    })()
    return stream
  }, { global: true })
  return () => { installed = false; remove() }
}
