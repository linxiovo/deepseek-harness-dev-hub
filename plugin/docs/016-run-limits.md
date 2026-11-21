# 016 Run-limit authorization (S18)

One mounted project has one effective run-limit configuration. The management API, Hub read tool, Frontier dispatch and Worker slot checks use those same saved settings. The run-limit ledger tracks admitted model streams, not supplier charges. The [project meter](014-project-metering.md) remains the historical view of Session logs and includes calls predating the run-limit ledger.

## Preset and operator override

The `default` preset has `maxWorkers: 3`, `projectTokens: null`, `ticketTokens: null`, and `stagnation: {maxAttemptsWithoutProgress: 3, idleSeconds: 900}`. `null` leaves that pool uncapped; `0` permits no calls. An operator sets caps explicitly rather than relying on unsupported model accounting by default. Stagnation values describe the effective policy for scheduling consumers; this interface does not change technical-failure retry or replan behavior.

Use the existing `PUT /orchestrator/api/settings/executor` with the mounted project header and `{revision, value}`. `value` is the **whole** Executor block, as returned by `GET /orchestrator/api/settings` in `executor.value`; send that block's revision, not the global revision. Set concurrency with `maxWorkers` (integer 1–16). Set any of the following with the optional strict `runLimits` object:

| Key | Input |
| --- | --- |
| `projectTokens` | `null` or nonnegative safe integer. An aggregate ceiling across the project's managed Sessions, including shared Hub/planning calls. |
| `ticketTokens` | `null` or nonnegative safe integer. A separate pool for each Ticket and its bound children. |
| `ticketOverrides` | Up to 256 distinct `{planId, nodeId, tokens}` records for registered Plan nodes; `tokens` uses the same cap type and replaces the Ticket default. Match on the exact pair, which is available before the Ticket is claimed. Each ID is 1–200 characters without whitespace, `/` or control characters. An override does not relax the project ceiling. |
| `stagnation` | Partial object with `maxAttemptsWithoutProgress` (1–100 attempts) and/or `idleSeconds` (1–86,400 seconds), both integers. Omitted fields use the preset. |

For example, with no aggregate project cap, `runLimits: {"ticketTokens":1000000,"ticketOverrides":[{"planId":"…","nodeId":"accounts","tokens":2000000}]}` gives independent Ticket pools. Omitted values use the preset; omitting `runLimits` removes all its saved overrides. `maxWorkers` remains the same Executor value used to allocate slots, with the existing priority for human follow-ups. A stale write returns `409`; malformed configuration returns `400`. `orchestrator_settings_save` cannot change `maxWorkers` or any `runLimits` setting, including by omission; it refuses with `panelOnlyRunLimits`. A scope header prevents mistakes across mounts; the [operator-only loopback transport](006-deployment.md#management-api) is not an OS-level sandbox.

## Read contract

| HTTP GET path | Hub `orchestrator_read` resource | HTTP 200 JSON |
| --- | --- | --- |
| `/orchestrator/api/project/run-limits` | `project/run-limits` | `RunLimitStatus` with `scope: "project"`, `ticketId: null` and `budget` for the project aggregate. |
| `/orchestrator/api/tickets/:id/run-limits` | `ticket/<id>/run-limits` | `RunLimitStatus` with `scope: "ticket"`, `ticketId: string`, `budget` for that Ticket and `projectBudget` for the aggregate that also applies. |

Neither route takes a request body or query arguments. URL-encode `:id` as one path segment. Use `Host: 127.0.0.1:<port>` or `localhost:<port>`, `x-orchestrator-request: 1`, `x-orchestrator-project-id: <mounted ID>`, and if sent, same-origin `Origin: http://<Host>`. See [project mount scope](012-project-runtime.md#project-scope). Responses are JSON with `Cache-Control: no-store`. Hub resources are not accessible to Worker or planning Sessions.

`configuration` is `{preset: "default", defaults, overrides, effective}`. `defaults` is the preset above; `overrides` contains the stored `maxWorkers` value and only the explicitly supplied `runLimits` fields; `effective` has the resolved `maxWorkers`, `projectTokens`, `ticketTokens`, `ticketOverrides` (an array, empty if omitted), and both stagnation fields. The `budget.limitTokens` for a Ticket already accounts for its override.

| Budget field | Type and meaning |
| --- | --- |
| `state` | `unlimited` (no strict cap), `available` (positive known balance; a particular request may still not fit), `reserved` (existing requests reserve all free balance or do not yet have a bound), `exhausted` (known tokens reached the cap), or `usage-missing` (strict cap requires missing usage). |
| `limitTokens`, `accountedTokens` | `number \| null`; the cap and sum of valid reported totals. A `null` total means none observed; a numeric total can be partial. |
| `reservedTokens`, `availableTokens` | Sum of known in-flight bounds (`number`), and remaining unreserved balance (`number \| null`). The latter is `null` when not capped or not safely known; do not present it as zero or unlimited. |
| `trackedSince`, `reportedCalls` | UTC ISO timestamp of the first instrumented project mount and the number of settled calls included in `accountedTokens`. |
| `inFlight` | `{sessionId, ticketId, startedAt, maximumTokens}[]` for currently authorized calls. `ticketId` is `null` for shared use; `maximumTokens` is `null` for a call admitted without a known bound under uncapped pools. |
| `missing` | `{sessionId, calls, interrupted, lastAt}[]` for settled calls without a usable total, grouped by Session. `interrupted` counts the subset recovered without a receipt. `lastAt` and `startedAt` are UTC ISO timestamps. These are not reservations. |

| HTTP refusal | Conditions |
| --- | --- |
| `400 {error}` | `Invalid run limits query` or malformed path escape. |
| `403 {error}` | Loopback host, request marker, or Origin check failed. |
| `404 {error}` | `Ticket not found` in this mount, missing run-limit surface, or unknown method/path. |
| `409 {error, code}` | `noProject`, `projectScopeRequired`, `staleProject`, or `switching`; select or refresh the intended mount before retrying. |

## Admission, settlement and notification

- The [Frontier](009-handoff.md#frontier-dispatch-and-claims) describes satisfied dependencies, not resource authorization. `orchestrator_plan_dispatch` returns `waiting-for-budget` for a temporary reservation conflict or `quota-paused` for an exhausted or unknown strict pool. A refusal of an unclaimed node creates no claim, Slot or Worker; replay of an already paused Ticket retains its existing claim. Neither response adds a durable node status or delivers a predecessor.
- The pinned DSH `llm/stream` waterfall is the second gate, at each provider attempt, including retry. For a verified normal loop call it uses the bound adapter's declared combined input/output context capacity, not a token estimate or the last request's usage. Both applicable pools must cover the full bound before provider I/O. A route without that capacity, including an auxiliary compaction request without a bound in the host, is refused under a strict cap. Optional title generation for managed Sessions is suppressed. Unmanaged Sessions do not charge a mounted project's authorization.
- Attempt reservation and settlement use the project's SQLite Store. A stream settles only the authoritative `totalTokens` it observed, not the reserved amount or a sum guessed from components. Usage observed before a failure or cancellation still counts; missing or contradictory totals are not free. A cut between admission and durable settlement reopens as missing, not as an active request or a zero receipt. A late old-mount completion cannot alter a new mount's ledger. No Session-log replay is added to the stream sums.
- Exhausted or unknown strict pools stop new affected work and queue one `quota-paused` Hub relay per continuous scope pause in the [attention allowlist](015-scoped-attention.md#plan-notification-policy). The relay includes `scope`, `reason`, `ticketId`, `resource`, and for a Ticket its title and Plan/node identifiers when applicable. The affected Worker drains admitted work before resuming is possible; unrelated Tickets with a separate usable pool continue. Quota pauses do not fabricate a report, close a Ticket or grant merge permission. If the Hub itself lacks aggregate quota, consult the HTTP read without requiring a Hub model turn. A cap increase cannot turn unknown usage into a known balance; an operator can explicitly change the strict policy. The Hub cannot do so on its own.

## Code and verification

[run-limits.ts](../src/app/run-limits.ts) owns the budget ledger and status, [model-admission.ts](../src/app/model-admission.ts) owns the DSH streaming gate, and [policy.ts](../src/policy.ts) resolves the preset. [plan-dispatch.ts](../src/app/plan-dispatch.ts) checks the budget before claiming a Plan node; [dsh.ts](../src/executor/dsh.ts) drains and fences the affected Worker. [api.ts](../src/app/api.ts), [http.ts](../src/app/http.ts) and [resources.ts](../src/app/resources.ts) expose the contract.

From `plugin/`, run `pnpm test tests/plans.spec.ts tests/http.spec.ts` for startup and scoped configuration, two requests competing for the last balance, authoritative settlement, missing versus in-flight usage, replay/restart, and isolated Ticket progress. The simulated provider is not a live bill or proof of any individual adapter's usage accuracy.
