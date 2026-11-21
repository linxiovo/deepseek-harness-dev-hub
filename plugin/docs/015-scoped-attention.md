# 015 Scoped Plan attention (S21)

When a Plan Ticket cannot use a required test account, pause that Ticket and send one configuration request to its project Hub. The operator configures the account in its credential provider and asks the host to verify it. The Hub and management API read the same project-local state. A credential action is an identifier and a verification receipt, not a credential form or a formal Plan delivery.

## Report a missing test account

The current root Worker of a live Plan Ticket calls `orchestrator_credential_blocked` with `{"credential_id":"test-account"}` and, only for a distinct failure after verification, the next integer `occurrence` (default `0`). Use the non-secret project credential identifier (`^[a-z][a-z0-9-]{0,63}$`). The schema rejects extra fields, including links, reasons, secrets and caller-supplied project or Ticket IDs. The Hub, planning Sessions, standalone Ticket Workers and Worker descendants do not have this tool.

The host requires the current Plan claim and Worker Session in a configured mount. A new action requires an available writer and no active credential blocker for the Ticket. A missing verifier does not prevent a pause; deploy a verifier for that ID before resuming. A successful report returns `CredentialAction` (below). Replaying the same Ticket, Assignment, credential ID and occurrence returns the same action with its latest verification state; it cannot create a second relay. Only a verified occurrence permits the next occurrence for that ID.

The host atomically stores the action (`awaiting` / `not-checked`) and queues the relay. It fences the Ticket's tools and input delivery, cancels its turn, and drains its jobs and descendants before yielding its writer. Other Tickets continue. Restart preserves the pause and does not send a second request. Follow-ups and reports cannot bypass it; in a runnable project, ordinary Ticket retry refuses with `400 credentialBlocked` (the management endpoint checks project availability and scope first). The old writer must be idle before a check is run. After successful verification, continuation is queued for the same Assignment, Worker Session and verified worktree. If an actual PR merge was observed for that Assignment while blocked, the Ticket instead moves to `awaiting-delivery` without restarting the merged writer. Neither verification nor a merged PR unlocks successors; they still need formal delivery ([009 Handoff](009-handoff.md#frontier-dispatch-and-claims)).

## Read attention and request verification

All three HTTP routes use the [loopback management API](006-deployment.md#management-api): `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, `x-orchestrator-request: 1` is required, and `Origin`, if sent, must be `http://<Host>`. **Every request**, including GET, requires `x-orchestrator-project-id: <projectId>` for the currently mounted, registered project. Obtain that ID from `GET /orchestrator/api/runtime` and confirm it is the intended project. The header checks scope; it does not select a mount or grant access to an inactive project. Responses on these routes are JSON (`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`).

| Method and full path | Input | HTTP 200 body |
| --- | --- | --- |
| `GET /orchestrator/api/attention/summary` | No body. Optional `?planId=<id>` selects a registered Plan in the mount (its Handoff ID); omit it for the project-wide Plan summary. | `AttentionSummary` |
| `GET /orchestrator/api/attention/credentials/:id` | No body or query. `:id` is the action ID from `configuration`, not `credentialId`, URL-encoded as one path segment. | `CredentialAction` |
| `POST /orchestrator/api/attention/credentials/:id/verify` | Same action ID, no query. Send `Content-Type: application/json` and the empty JSON object `{}`; an empty body is not `{}`. | Updated `CredentialAction`. A failed check is HTTP 200 with `awaiting` / `failed`; only a passed check returns `verified` / `passed`. Repeating verification of a verified action returns the stored receipt without running the verifier or queuing continuation again. |

`configuration` points to the GET action record; the client appends `/verify` for POST. An awaiting action is readable or verifiable only while it is the current blocker on its live Ticket and Assignment. A verified action remains readable by ID in its project, but is no longer included as pending attention.

The Hub passes `{"resource":"project/attention"}` or `{"resource":"plan/<id>/attention"}` to `orchestrator_read` for the same `AttentionSummary` shapes. These two reads return complete summaries, not pages. `orchestrator_read` of `plan/<id>/node/<node-id>` adds `attention: CredentialAction` when the claimed Ticket has a current credential blocker, and otherwise omits the property. A same-node `orchestrator_plan_dispatch` replay reuses the claim and likewise includes `attention` only if present; the blocker does not introduce a Plan node lifecycle status. The Hub read of an unknown Plan reports `unknownPlan`; Worker and planning Sessions cannot read these resources.

### Response fields

| `AttentionSummary` field | Type and meaning |
| --- | --- |
| `planId` | `string` for a Plan summary; `null` for the mounted project summary. |
| `running` | Number of live Tickets on `running` Plan nodes that have a running Assignment, no current credential blocker or pending question, and no latest `blocked`, `failed` or `ready` report. |
| `awaitingHuman` | Number of live Tickets on `running` Plan nodes with a current credential blocker or pending Ticket question, counted once even if both are present. |
| `message` | String in the format `<running> 张执行中，<awaitingHuman> 张待你处理`. |
| `actions` | Array of current `CredentialAction` records among the Tickets counted as awaiting human action. Ordinary Ticket questions affect the count but do not create credential actions. |

These counts are not total Project workload or Executor slot occupancy. For example, two executing Plan Tickets and one waiting for a test account produce `running: 2`, `awaitingHuman: 1`; an undispatched successor awaiting formal delivery does not add to either count.

| `CredentialAction` field | Type and meaning |
| --- | --- |
| `id` | Stable opaque action ID for the project, Ticket, Assignment, credential identifier and occurrence. |
| `projectId`, `planId`, `nodeId`, `ticketId` | String IDs of the mounted project, Plan, owning node and Ticket. |
| `title` | Ticket title (`string`). |
| `credentialId` | Configured credential identifier (`string`), never its value. |
| `occurrence` | Nonnegative counter for this credential on this Assignment; starts at `0`. |
| `affectedNodes` | `string[]` of downstream Plan node IDs reached transitively through `blockedBy`, not including the reporting node. |
| `configuration` | Relative URL `/orchestrator/api/attention/credentials/<id>` (`string`). |
| `providerUrl` | Operator-configured HTTPS page for entering the test-account configuration, or `null` if none was configured. |
| `verifierConfigured` | Boolean indicating whether this mounted project currently has a verifier for the credential ID. |
| `status`, `verification` | `awaiting` with `not-checked` or `failed`; `verified` with `passed`. |

Assignment and Session IDs, verifier executable and arguments, credential values, subprocess output and raw subprocess failures are not part of this response.

### HTTP refusals

| Status and body | Condition |
| --- | --- |
| `400 {error}` | Malformed path escape; unknown or duplicate query field (`Invalid attention query`); missing or non-JSON verification media type (`Expected Content-Type: application/json`); missing/invalid JSON, oversized body, or a body other than `{}`. Caller-supplied verification claims and secrets are refused without being echoed. |
| `403 {error}` | Host, Origin or request-header check failed (`Same-origin management request required`). |
| `404 {error}` | Action unknown, no longer current while awaiting, or not in this mounted project (`Credential action not found`); or no matching API method/path (`Unknown operation`). |
| `404 {error, code, values}` | `planId` in the summary is not a known Plan of the mounted project: `{ "error": "Unknown Plan <id>", "code": "unknownPlan", "values": { "id": "<id>" } }`. |
| `409 {error, code}` | `noProject`: no registered mount and no scope supplied. `projectScopeRequired`: missing project header. `staleProject`: scope differs from the mount. `switching`: transition or shutdown. `projectConflict`: concurrent project write, or the old writer has not safely drained; the Ticket remains paused. `projectSetupRequired`: the mounted project cannot verify the current action. |
| `500 {error}` | Unexpected attention operation failure (`Attention operation failed.`). |

## Plan notification policy

For Plan execution push, the allowlist is `human-action`, `quota-paused` and `plan-delivered`. This flow produces `human-action` from a credential blocker (and Plan reports with a concrete `human_action` can relay a question). The credential relay has stable ID `credential-action:<id>` and its payload includes `kind`, the Plan `AttentionSummary` fields, the triggering `action`, and a `request` to configure and verify the test account without sharing credentials in chat. The quota-pause and Plan-delivery event producers are outside S21; having these event kinds does not make a Worker report, provider retry or PR close generate one. Plan progress, readiness, ordinary technical blockers, failures, closure and review activity stay internal. This policy does not replace handoff, intake or other control-plane messages. Legacy non-Plan notification behavior is unchanged. The relay is to the Hub, not an outgoing Channel message from the Worker.

The Hub instructions in `prompts/handoff-orchestrator.md` tell it to show the operator the Ticket, affected work, status and controlled configuration reference in Harness, rather than asking for a secret or announcing an unchanged or failed check again. S21 supplies API resources and a relay, not a credential entry form or panel UI.

For a product question raised by a live Plan Worker, the Hub asks in Harness with the Ticket and current `question_id`. The person replies with `{"ticket_id":"…","question_id":"…","answer":"…"}`. Only the Hub calls `orchestrator_plan_answer` with those exact fields from the latest direct user message. It returns `{ticket_id, question_id, input_id}`, clears that question, and queues the verbatim answer to that Ticket only. Wrong Ticket, stale question, altered answer or replay is refused. An answer grants no new authorization and cannot clear a credential blocker. The planner's pre-Plan `orchestrator_handoff_answer` remains separate.

As with other management routes, project scope and same-origin checks are not an OS sandbox or a per-caller identity check. Expose the port only to authorized operators. Verification accepts neither credential data nor executable selection from HTTP and does not trust the caller to attest success.

## Deploy and use a trusted verifier

1. Register and select the project as in [006 Deployment](006-deployment.md#settings). Record the returned project ID. Install an independently released, operator-owned test-account verifier at a trusted absolute path outside any project checkout or worktree. The verifier must read private data from its own controlled external configuration or credential store, using a dedicated test account. Do not point to a Worker-controlled script, load executable code from the checkout, or put secrets in `args`, HTTP, or chat. The absolute-path check is not code provenance or OS isolation.
2. Merge `credentialChecks` into the `dsh-superagent` entry of the DSH profile's `cordis.patch.yml`, then restart the profile. It is a Machine setting, not a project settings save. The default is `[]`; each entry requires a registered-format `projectId` (32 lowercase hex characters), `id` (pattern above), absolute `executable`, and optional string-array `args` (default `[]`). Duplicate `(projectId, id)` entries are rejected. Only entries matching the mounted project's ID are active.
   Optionally set `providerUrl` to the approved HTTPS credential provider page, without embedded credentials, a query string or a fragment. This is where the person configures the account; the plugin does not visit it. If no verifier exists, the action stays awaiting and the operator must configure one using this step.

   ```yaml
   - id: dsh-superagent
     config:
       stateDir: /srv/dsh/state/superagent
       credentialChecks:
         - projectId: '0123456789abcdef0123456789abcdef'
           id: test-account
           executable: /opt/operator-verifiers/bin/check-widget-test-account
           args: ['--profile', 'widgets-test']
           providerUrl: https://accounts.example.test/widgets-test
   ```

   Replace the example ID and path with the actual registered ID and installed executable. The profile name here is a non-secret selector for that verifier's own configuration. On Windows use an absolute executable path such as `'C:\OperatorTools\check-widget-test-account.exe'`. The runtime invokes the configured argv directly, from the Machine state directory, with stdin ignored and a 30-second deadline. Only exit code `0` without a terminating signal or abort counts as passed. A nonzero exit, timeout, signal, launch error or missing check leaves the action awaiting (a concurrent mount shutdown instead refuses the request). The verifier should test actual use of the account and should not print secrets; captured output does not go to HTTP or the Hub.
3. When the Hub receives a credential action, configure the account through its credential provider, then invoke verification through loopback (or the [authorized SSH tunnel](006-deployment.md#headless-access-over-ssh)). For example, set `project_id` to the intended mount ID and `configuration` to the action's returned `/orchestrator/api/attention/credentials/<id>` path:

   ```sh
   base=http://127.0.0.1:3082
   curl -sS -H 'x-orchestrator-request: 1' -H "x-orchestrator-project-id: $project_id" \
     "$base/orchestrator/api/attention/summary"
   curl -sS -H 'x-orchestrator-request: 1' -H "x-orchestrator-project-id: $project_id" \
     "$base$configuration"
   curl -sS -H 'x-orchestrator-request: 1' -H "x-orchestrator-project-id: $project_id" \
     -H 'Content-Type: application/json' -d '{}' "$base$configuration/verify"
   ```

   If the result is `awaiting` / `failed`, inspect or repair the account in the operator-controlled provider and verify again. A chat acknowledgement or caller-supplied `verified` field cannot resume the Ticket.

## Code and verification

The action lifecycle and shared read model live in [scoped-attention.ts](../src/app/scoped-attention.ts); [api.ts](../src/app/api.ts) and [http.ts](../src/app/http.ts) own the management contract. [deployment.ts](../src/deployment.ts) validates the Machine configuration and [runtime.ts](../src/app/runtime.ts) owns the subprocess invocation. [resources.ts](../src/app/resources.ts) and [tools/executor.ts](../src/app/tools/executor.ts) own the Session interfaces; [dsh.ts](../src/executor/dsh.ts) owns suspension and continuation.

From `plugin/`, the acceptance entry point is `pnpm test tests/plans.spec.ts tests/http.spec.ts tests/docs.spec.ts`:

- [plans.spec.ts](../tests/plans.spec.ts), `pauses only the Plan ticket with a missing test account and sends one controlled action request`: dispatch independent A/B/C Tickets (`catalog`, `accounts`, `export`); B pauses while A/C still work, and B's successor `dashboard` remains blocked. The test exercises replay, shared summary and Hub relay, cross-project and self-attested verification refusals, failed verification surviving restart without a duplicate relay, and successful verification reusing B's claim. Verification uses a simulated Harness host, not a production credential.
- [http.spec.ts](../tests/http.spec.ts): loopback and project-scope management transport, error and concurrent-write boundaries.
- [docs.spec.ts](../tests/docs.spec.ts): consecutive numbering, root index registration, link rules, and source and test index coverage.
