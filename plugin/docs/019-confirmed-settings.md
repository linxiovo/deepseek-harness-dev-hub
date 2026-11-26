# 019 Confirmed settings

The local management API creates durable, project-scoped proposals for a narrow set of high-impact settings. A proposal never changes a setting until the original authorized person approves it through the Feishu confirmation flow or an operator explicitly approves it in the management API. Both paths approve the same stored request and captured block revision. An approval grants only the proposed setting change; it does not grant publication, release, or other authority.

## Management API

All routes use the loopback management transport described in [012 Project runtime](012-project-runtime.md#project-scope): send `x-orchestrator-request: 1`, `x-orchestrator-project-id: <mounted project ID>`, a loopback `Host`, and, when present, a same-origin `Origin`. Reads and writes both require a registered managed mount and its current ID. These are local operator routes, not Hub tools or remote Feishu callbacks.

Use `Content-Type: application/json` for the two POST bodies. Both bodies are limited to 131,072 bytes. Proposal and approval objects and nested changes reject unknown fields; none of the routes takes query parameters. Successful requests return HTTP 200 with JSON and `Cache-Control: no-store`.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /orchestrator/api/settings-confirmations` | `{ "revision": 12, "change": { "object": "projectTokens", "value": 500000 }, "approvers": ["ou_alice"] }` | `SettingsConfirmationView` for the new pending request |
| `GET /orchestrator/api/settings-confirmations/:id` | No body or query. URL-encode `id` as one path segment. | Current `SettingsConfirmationView` |
| `POST /orchestrator/api/settings-confirmations/:id/approve` | `{ "revision": 12 }` | `SettingsConfirmationView` with `status: "approved"` |

The supported `change` variants are strict objects:

| `change` | Meaning |
| --- | --- |
| `{ "object": "projectTokens" \| "ticketTokens", "value": number \| null }` | Raise the project cap or the default per-Ticket cap. A numeric value must be a nonnegative safe integer; only a finite cap can be raised to `null` (uncapped). The project cap and per-Ticket overrides still apply. |
| `{ "object": "maxWorkers", "value": number }` | Raise worker concurrency to an integer from 1 to 16. |
| `{ "object": "feishuChat", "chatId": "oc_team", "value": "mentions" \| "all" }` | Widen intake in an enabled Feishu Source for exactly this group chat. A chat without an explicit entry inherits the current other-chats scope. Allowed transitions are `none` to `mentions` or `all`, and `mentions` to `all`. |

For an explicit Feishu grant, the interactive card is delivered to the original bound conversation. Only its verified action from a named approver can approve there: forwarded cards, plain text, stale cards, and Hub relays cannot approve. If the card stream is unavailable, the notice provides a text summary and a settings link instead. Opening a link never approves the request.

`approvers` is optional. Omit it or pass `[]` for API-only approval. A nonempty list explicitly grants this request's Feishu approval to those open IDs, and every ID must already be an allowed participant in the current Feishu topic binding. Group membership, binding membership by itself, the ability to answer a product question, and Hub summaries do not authorize a configuration approval. If that binding epoch changes, a pending request is superseded. A newer proposal for the same setting or a change to its captured settings block revision also supersedes it.

### Revision and effect

Before proposing, read `GET /orchestrator/api/settings` with the same project header. Use `blocks.executor.revision` for `projectTokens`, `ticketTokens`, and `maxWorkers`. For `feishuChat`, use the `revision` on the `sources` entry whose `id` is `feishu` (the `source:feishu` block). Do not use the global settings revision or silently change the project header if selection changes while the form is open. Submit the original proposal's `revision` on approval, not `effectiveRevision`. The server uses the value already stored for that request.

After approval, the saved setting takes effect through its normal settings path. For token caps, the project and ticket admission behavior remains as described in [016 Run limits](016-run-limits.md); an increase does not settle missing usage or authorize release. For `feishuChat`, the `source:feishu` settings block controls whether the group receives mentions or all messages.

## Confirmation view and lifecycle

Example POST response prior to approval:

```json
{
  "id": "31926947-461d-48dc-b583-b348c8607d78",
  "projectId": "project-alpha",
  "repository": "acme/widgets",
  "object": "projectTokens",
  "revision": 12,
  "currentValue": 250000,
  "proposedValue": 500000,
  "effectiveValue": 250000,
  "effectiveRevision": 12,
  "impact": "Changes the project-wide ceiling for managed model calls, not release authorization.",
  "status": "pending",
  "expiresAt": "2026-11-26T12:15:00.000Z"
}
```

Keep `projectId` and `id` to query or approve this proposal. The same view includes `chatId` only for `feishuChat`. `currentValue` is the value captured at proposal time. `effectiveValue` and `effectiveRevision` report the setting and block revision at read time. After approving the example, the view has `status: "approved"`, `effectiveValue: 500000`, and the new `effectiveRevision`. A subsequent setting change can alter the effective value and revision without changing that historical `approved` status.

A proposal is valid for up to 15 minutes. An approval is `approved` only after the atomic setting write succeeds. Repeated approval, an expired or superseded proposal, or a revision mismatch returns `409`; no second write occurs. After restart, the same `GET` still reads the durable decision and current effective state. The original trusted card's status action re-queries that same result, including after restart, as long as the same binding, bot, and granted participant are still authorized. If the card is no longer authorized, query through the operator API.

The response does not contain credentials, access tokens, bot secrets, the original request body, or the approver list. The approval body accepts neither actor identity nor a replacement value.

## Refusals

| Status | Conditions |
| --- | --- |
| `400 {error}` | Malformed JSON, oversized body, malformed ID escape, unexpected query parameter, unknown field, invalid value or a change that would not widen the current limit or listening scope. |
| `403 {error}` | Loopback/same-origin transport check failed, or a proposed card approver is not an authorized participant in the current topic binding. |
| `404 {error}` | Unknown confirmation ID in this project, no confirmation service on this host, or unknown route. |
| `409 {error, code}` | Mount and write exclusions: `noProject`, `projectScopeRequired`, `staleProject`, `switching` or `projectConflict`. Refresh the mounted project; do not automatically resubmit the refused operation. |
| `409 {error}` | Stale block or submitted revision, already approved, expired or superseded request, or Feishu Source not enabled for a listening proposal. Query the original ID, then reload the settings before creating a new proposal. |
| `500 {error}` | Unexpected server failure; internal diagnostics are not returned. |

`GET` also requires the current managed project header. A correctly scoped request on a host without the confirmation module returns `404`; requests without the managed scope are refused rather than reading a process-global or previous project's record.

## Code and verification

The HTTP contract is in [api.ts](../src/app/api.ts) and [http.ts](../src/app/http.ts). The schemas are in [confirmed-settings.ts](../src/confirmed-settings.ts), and the durable confirmation state machine is in [settings-confirmations.ts](../src/app/settings-confirmations.ts). Public-route coverage is in [http.spec.ts](../tests/http.spec.ts).

[Topic binding checks](../tests/topic-binding.spec.ts) exercise original-card correlation, a lost send receipt, expiry, unbinding during a callback, shared decisions, and fresh reads after a restart. [Plan checks](../tests/plans.spec.ts) verify that approval resumes the same budget-paused worker without granting release authorization; [maintenance checks](../tests/maintenance-recovery.spec.ts) exercise the next authorized event in the bound topic.
