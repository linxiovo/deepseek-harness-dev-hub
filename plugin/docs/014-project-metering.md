# 014 Project metering API

Read cumulative token usage for the mounted project, a registered Plan, or a Ticket. The HTTP routes and the Hub's `orchestrator_read` tool use the same Session samples and accounting rules. They do not start a model call and are not a provider bill. This contract does not describe a panel display.

## Read a meter

| Management HTTP method and path | Hub `orchestrator_read` resource | Scope |
| --- | --- | --- |
| `GET /orchestrator/api/project/meter` | `project/meter` | All usage recorded for the mounted project. No ID. |
| `GET /orchestrator/api/plans/:id/meter` | `plan/<id>/meter` | The registered Plan with this ID (the same ID as its Handoff). A Handoff without a registered Plan is not a meter target. |
| `GET /orchestrator/api/tickets/:id/meter` | `ticket/<id>/meter` | The persisted Ticket with this ID, not a Plan node ID. |

HTTP GETs have no query parameters or request body. URL-encode `:id` as one path segment. Use the [loopback management API](006-deployment.md#management-api) with `x-orchestrator-request: 1`. A client displaying a particular managed project should also send `x-orchestrator-project-id: <projectId>`, taken from `GET /orchestrator/api/runtime`. Without this optional header, the request targets whichever project is mounted. If supplied, the header is checked before and after sampling; it cannot select or read an inactive project. Omit it for the unregistered legacy mount. Responses are JSON and are not cached (`Cache-Control: no-store`).

For an adopted legacy deployment, the first Hub generation remains verified at its adoption-era state-directory working directory. A generation created by Hub rotation is verified in the mounted project workspace, so the retired first Hub and every successor generation keep contributing shared usage after a restart.

For the Hub, pass the resource string with the actual ID, for example `{"resource":"ticket/t1/meter"}`. A first page that contains every Session returns the same shape as HTTP. For more detail rows, the tool accepts `offset` (default 0) and `limit` (20 Sessions by default, capped at 50); follow `next_offset` when it is a number. An absent or `null` `next_offset` means there is no next page. The limit caps the number of detail rows, not the length of the JSON: every page includes full subtotals and their coverage. HTTP returns all rows. Each page is a fresh read; new events or bindings may change the sample between requests. The Hub tool alone accepts these resource names. The Worker tool cannot read them, even for its own Ticket. See [Session boundaries](010-session-boundaries.md) for the distinction between the tool boundary and local management access.

## Success response

HTTP `200` (or a successful tool result) contains:

| Field | Type and meaning |
| --- | --- |
| `scope`, `id` | `scope` is `project`, `plan` or `ticket`. `id` is `null` for `project`, otherwise the requested ID. |
| `attributed` | Subtotal of Sessions assigned to the requested Ticket or Plan, or assigned to any Ticket or Plan for project scope. |
| `shared` | Project overhead from Sessions assigned to neither a Ticket nor a Plan. This includes the Hub; other project-only Sessions can contribute too. |
| `total` | Attributed plus shared at project scope. Equal to `attributed` at Ticket and Plan scope; shared usage is visible but is never split across Tickets or Plans. |
| `sessions` | List of Session rows. For a Ticket or Plan, this lists directly attributed Sessions and shared project Sessions, not Sessions attributed elsewhere. |

Every Session row contains `session_id: string`, `roles: string[]` (values `hub`, `implementation`, `review`, `retro`, `retry`, `inspection`, `planner`, `splitter`), and `ticket_id`, `plan_id` and `parent_session_id` (each `string` or `null`). `parent_session_id` is the recorded business parent, not a fork parent. `cursor` is the exclusive event sequence boundary of the fold; `inherited_events` is the length of the fork's inherited prefix. Both are numbers or `null` when there is no sample. `log_status` is `available`, `not-found` (no log or saved sample), `unavailable` (failed to read a known log or it disappeared), or `unverified` (a reservation lacks proof of log identity, or existing metadata contradicts the binding).

An independent requirement-scope review is attributed to its Plan as `review`, without a Ticket. Its business parent is the confirming project's logical Hub; after rotation the parent may be any retained physical generation of that Hub, not a native fork parent.

- `own` is a subtotal for that Session alone. `including_children` covers the Session and its recorded business descendants visible in the requested scope, even when the Hub page does not list every descendant. It is a drill-down, **not** an input to another total. Do not sum `including_children` across rows or add shared Session drill-downs to Ticket totals. For a Ticket's parent with 10 reported tokens, a business child with 6, and a shared Hub call with 5, the parent shows 10 in `own.reported_total_tokens` and 16 in `including_children.reported_total_tokens`, the Ticket subtotals show 16 in `total` and 5 in `shared`, and the project shows 21 in `total` when these are the only calls.
- `context` is a Session snapshot, not cumulative usage. It is `null` without a sample. A saved snapshot with an unavailable log has `stale: true`. Its fields are:

| Context field | Type and meaning |
| --- | --- |
| `model`, `provider` | Last known route, each `string` or `null`. |
| `capacity_tokens`, `occupied_tokens` | Number or `null`. Capacity is the request-plus-response window. Occupancy is only populated when the host has a projection at this event boundary; treat it as an estimate, not an exact live reading. |
| `quality`, `source` | `quality` is `measured`, `estimated` or `unknown`; `source` is `dsh-token-meter`, `session-events` or `none`. |
| `sampled_at`, `range` | ISO timestamp of the snapshot and `{from, through}` event boundaries. |
| `last_input_tokens`, `last_input_at`, `last_input_range` | Last reported uncached input component (number), ISO timestamp and `{from, through}` for that sample; each can be `null`. Do not use this value as window occupancy. |
| `stale` | Boolean. The recorded input sample is not current at the fold boundary, or only a saved context was available for the row. |

### Subtotals and coverage

`attributed`, `shared`, `total`, `own` and `including_children` all use this shape:

| Subtotal field | Type and meaning |
| --- | --- |
| `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens` | Sum of observed uncached input, cache reads, cache writes and output, respectively; each is a number or `null`. |
| `reasoning_tokens` | Number or `null`. Reasoning is part of output, not an extra charge to add to it. |
| `known_components_total_tokens` | Number or `null`. Sum of known input, cache read, cache write and output components. It can be partial and is separate from the reported total. |
| `reported_total_tokens` | Number or `null`. Sum of the authoritative totals actually reported for settled calls; never substituted with component sums or added to them. It can be partial. |
| `counted_calls`, `reported_total_calls` | Nonnegative integers. Counts of calls with reported usage and with an authoritative total, respectively. A zero count means no such observations, not a measured zero-token bill. |
| `total_complete` | Boolean. True only for a nonempty set of Sessions whose logs were available and each had complete authoritative totals for its observed calls, with no known missing or in-flight coverage. |
| `range`, `in_flight` | Arrays of `{session_id, from, through}`, for the sampled ranges and known in-flight work respectively. |
| `missing` | Array of `{session_id, from, through, reason}`. `no-usage` means a call settled without reporting usage, including a cancellation if it reported none; `coverage-gap` means observed events did not yield a settlement. |
| `unknown` | Array of `{session_id, reason, range}`. Reasons: `log-not-found`, `log-unavailable`, `log-unverified`, `no-observed-usage` (no token bucket was reported) or `unreported-total` (some counted calls lack authoritative totals). The nested `range` is `{from, through}` for a known sample or `null` when the unobserved extent is unknown. |
| `sampled_at`, `source` | Latest contributing Session usage timestamp (ISO string), not the time of this query, or `null` if there is none. `source` is `session-events` or `none`. The Session ranges need not have the same timestamp or event boundaries. |
| `quality`, `billing_status` | `quality` is `measured` when there is observed usage and no known coverage issue, `partial` when there is observed usage but coverage is incomplete, or `unknown` when no token value is observed. `billing_status` is always `not-final`. |

All event ranges are **half-open**: `from` is inclusive and `through` is exclusive, local to the named Session. A `null` token value means nothing was reported for that bucket, whereas numeric `0` is a reported value. A missing or unreadable log does not make an existing scope a `404`: its row marks unknown coverage and retains any verified saved usage prefix. An unverified identity contributes no sample or saved prefix. A Ticket or Plan with no attributed Sessions has null attributed token totals and empty attributed ranges; its shared subtotal stays separate.

Cumulative usage follows persisted Session events and their durable cursor. Stream and message observations of the same call settle once; reported attempts, their retries and compaction summaries can contribute. A fork's inherited prefix is excluded. Re-reads, restarts and multiple recorded roles for one actual Session do not add its calls a second time. These rules are independent of the Session's current context occupancy.

After a same-ID log recreation, cumulative tokens include the earlier verified prefix and the current log. Coverage arrays can carry `created_at` (ISO timestamp of the log instance); sequence boundaries are local to that Session and log instance. An older log that is no longer observable has unknown tail coverage. The row's `context`, `cursor` and `inherited_events` refer only to the current log instance.

Attribution is recorded by the plugin at trusted delegation points; reading a meter, opening a Session, or forking its history grants no attribution or permissions. A Plan claim binds its Worker to that Ticket and Plan before launch. Verified standalone Workers are bound to their Tickets. An accepted retry can add `retry` to the existing Worker row without splitting its history. Native Worker descendants retain their direct business parent; a delegated review is recorded separately from implementation. The Hub and pre-Plan planning Sessions are project shared.

A trusted lifecycle caller can bind a separate retro Session to its Ticket, or register `inspection` with no Ticket. That caller must use a fresh Session ID for each dispatch, never an ID recycled from different work; registration is neither a dispatch mechanism nor a permission grant. Startup reconciles existing review receipts against host metadata for detached reviewers, excluding replacement logs created after the receipt. A receipt restores attribution, not a Session or its permission to submit evidence.

## Errors

| HTTP status and JSON body | Condition |
| --- | --- |
| `400 {error}` | Malformed escape in a path parameter. |
| `403 {error}` | Loopback management Host, Origin or request header check failed. |
| `404 {error}` | No such Ticket or registered Plan in the mounted project (`Ticket not found` or `Plan not found`), or unsupported path/method. No metering data, including shared overhead, is returned. |
| `409 {error, code}` | `staleProject` when the supplied scope does not match the mount, or the mount changes during a read; `switching` when a transition or shutdown blocks the query. Refresh the mounted ID and query only if it is the intended project. |
| `500 {error}` | Unexpected management or projection failure outside the per-Session log coverage cases. |

The Hub tool reports an error for an unknown Plan or Ticket, an invalid resource, or a Worker attempting to access a Hub resource; it does not return a partial scope for these requests.

## Verification

From `plugin/`, run `pnpm test tests/plans.spec.ts tests/runtime.spec.ts tests/http.spec.ts tests/tools.spec.ts tests/session-meter.spec.ts`. [plans.spec.ts](../tests/plans.spec.ts) verifies metering through the registered Hub tool and management HTTP, including log rotation during a read without mixing generations or duplicating usage. [runtime.spec.ts](../tests/runtime.spec.ts) exercises project isolation; [http.spec.ts](../tests/http.spec.ts) covers management transport and scope; [tools.spec.ts](../tests/tools.spec.ts) covers the Session tool boundary; [session-meter.spec.ts](../tests/session-meter.spec.ts) covers the event samples and cumulative cursor. The transport contracts live in [api.ts](../src/app/api.ts), [http.ts](../src/app/http.ts) and [resources.ts](../src/app/resources.ts); [project-meter.ts](../src/app/project-meter.ts) defines the projection.
