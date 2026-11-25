# 015 Scoped Plan attention (S21)

When a Plan Ticket cannot use a required test account, pause that Ticket and send one configuration request to its project Hub. The operator configures the account in its credential provider and asks the host to verify it. The Hub and management API read the same project-local state. A credential action is an identifier and a verification receipt, not a credential form or a formal Plan delivery.

## Report a missing test account

The current root Worker of a live Plan Ticket calls `orchestrator_credential_blocked` with `{"credential_id":"test-account"}` and, only for a distinct failure after verification, the next integer `occurrence` (default `0`). Use the non-secret project credential identifier (`^[a-z][a-z0-9-]{0,63}$`). The schema rejects extra fields, including links, reasons, secrets and caller-supplied project or Ticket IDs. The Hub, planning Sessions, standalone Ticket Workers and Worker descendants do not have this tool.

The host requires the current Plan claim and Worker Session in a configured mount. A new action requires an available writer and no active credential blocker for the Ticket. A missing verifier does not prevent a pause; deploy a verifier for that ID before resuming. A successful report returns `CredentialAction` (below). Replaying the same Ticket, Assignment, credential ID and occurrence returns the same action with its latest verification state; it cannot create a second relay. Only a verified occurrence permits the next occurrence for that ID.

The host atomically stores the action (`awaiting` / `not-checked`) and queues the relay. It fences the Ticket's tools and input delivery, cancels its turn, and drains its jobs and descendants before yielding its writer. Other Tickets continue. Restart preserves the pause and does not send a second request. Follow-ups and reports cannot bypass it; in a runnable project, ordinary Ticket retry refuses with `400 credentialBlocked` (the management endpoint checks project availability and scope first). The old writer must be idle before a check is run. Successful verification queues continuation for the same Assignment, Worker Session and verified worktree, but does not clear a separate quota pause (`016-run-limits.md`). A PR lifecycle event does not change that continuation or prove mainline integration. Successors still need formal delivery ([009 Handoff](009-handoff.md#frontier-dispatch-and-claims)).

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
| `running` | Number of live Tickets on `running` Plan nodes that have a running Assignment, no current credential blocker, pending question or quota pause, and no latest `blocked`, `failed` or `ready` report. |
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

For Plan execution push, the allowlist is `human-action`, `quota-paused` and `plan-delivered`. The stable credential relay ID is `credential-action:<id>`; the payload includes `kind`, the Plan `AttentionSummary` fields, the triggering `action`, and a request for controlled configuration and verification. The quota producer is described in `016-run-limits.md`. Plan progress, readiness, technical blockers, failures, closure and review stay internal. Legacy non-Plan behavior is unchanged. None of these relays is a Channel send from the Worker.

The `plan-delivered` relay comes from the Plan-level delivery result, not Ticket closure. The Hub reads `plan/<id>/delivery`; a release-authorized Handoff emits no final delivery relay before deployment verification. If its controlled release adapter is missing or mismatched, the Plan stays `release-blocked` rather than appearing ready for publication. Details are in `017-plan-integration.md`.

The Hub instructions in `prompts/handoff-orchestrator.md` tell it to show the operator the Ticket, affected work, status and controlled configuration reference in Harness, rather than asking for a secret or announcing an unchanged or failed check again. S21 supplies API resources and a relay, not a credential entry form or panel UI.

A Plan Worker's `human_action` returns `question_proposal` and an internal `plan-question-review` relay. It creates neither user attention nor a pause. Before asking, the Hub checks that it is a missing product decision, not a request to fix tests or resolve a technical conflict, and calls `orchestrator_plan_question` with `{ticket_id, question_id, criterion}`. The criterion must belong to the active Ticket, and the ID must identify the current Assignment's proposal. Approval records attention and queues one `human-action` relay; repeating it while pending reuses the receipt.

The Hub asks in Harness. The operator replies with `{"ticket_id":"…","question_id":"…","answer":"…"}`; only the Hub calls `orchestrator_plan_answer` with those exact fields from the latest direct user message. It returns `{ticket_id, question_id, input_id}`, clears the question and queues the verbatim answer to that Ticket only. Wrong Ticket, stale question, altered answer or replay is refused. The answer grants no new authorization and cannot clear a credential blocker. The planner's `orchestrator_handoff_answer` remains separate.

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
3. When the Hub receives a credential action, configure the account through its approved provider, not through the management request. A chat acknowledgement or caller-supplied `verified` field cannot resume the Ticket.

## Live test-account smoke check

Use the [credential smoke CLI](../scripts/credential-smoke.mjs) from `plugin/` against a running **candidate bundle** in a dedicated DSH profile, with an isolated test project and real, dedicated provider test account. This is not a production account check. Run on the host or through an [authenticated SSH tunnel](006-deployment.md#headless-access-over-ssh) whose local and remote port numbers match. Verify separately that the endpoint is your intended host/profile and that access is limited to authorized OS users or authenticated SSH operators. The fixed management headers are not same-machine user authentication. Do not expose the port to untrusted local users or let another client verify this action during the smoke check. The existing interface does not correlate a POST receipt with a unique verifier invocation if another client verifies the same action between the CLI's GET and POST.

1. Confirm the candidate revision installed in the profile and the intended selected project ID (`GET /orchestrator/api/runtime` in the [management API](006-deployment.md#management-api)). Set up the trusted verifier above to test actual account access, with no secret in its arguments. In the provider, prepare a known denial on this isolated account (for example, temporarily revoke a test-only grant). Confirm that the verifier is installed and runnable; a failed receipt alone cannot tell an account denial from a verifier launch error or timeout.
2. Let the current root Worker of a live Plan Ticket report the test-account blocker. In Harness, confirm the Hub sends one credential `human-action` notice for the intended Ticket with the controlled configuration reference, without requesting secrets. Copy the mounted project ID and the current action's relative `configuration` path from that notice, not the credential identifier or provider URL. Note the Ticket's Assignment, Worker Session and worktree before verification so you can check continuation. Do not race this check with another verification or a project switch.
3. Read the status, then verify the failing state explicitly. Replace the example IDs in **all** commands with those of the selected project and current action. `--url` defaults to `http://127.0.0.1:3082`; for a different port supply `--url http://127.0.0.1:<port>` on each invocation. These commands use no shell-specific substitutions and run on Windows and Unix.

   ```text
   pnpm credential:smoke --project 0123456789abcdef0123456789abcdef --action /orchestrator/api/attention/credentials/11111111111111111111111111111111
   pnpm credential:smoke verify --project 0123456789abcdef0123456789abcdef --action /orchestrator/api/attention/credentials/11111111111111111111111111111111 --expect failed
   ```

   The initial read should show `awaiting / not-checked` for a fresh action. The failing verification must exit 0 with `awaiting / failed`. Confirm in Harness that the Ticket stays paused with no duplicate credential notice. If verification unexpectedly passes, the CLI exits nonzero but the host may already have resumed the Ticket. Investigate and start with a fresh blocker; do not count it as a passing smoke check.
4. Restore the test account's access through the provider, outside this CLI. For the **same** action:

   ```text
   pnpm credential:smoke verify --project 0123456789abcdef0123456789abcdef --action /orchestrator/api/attention/credentials/11111111111111111111111111111111 --expect passed
   ```

   This requires an `awaiting / failed` record beforehand and exits 0 only on the matching `verified / passed` receipt. Confirm in Harness that the original Ticket continues in the same Assignment, Worker Session and worktree without a second credential notice. Verification is not formal delivery and must not alone unblock a successor. A read can show a stored verified receipt; running `verify` on it is refused and is not a new live check.
5. Record the candidate and test profile, the two observed results and the manual Harness checks in verification evidence. Record no credentials or raw verifier output. If the verification call is interrupted or times out, the host may still finish the operation: read status before attempting anything else. An observed stored receipt does not repair missing live evidence; use a fresh action for a new sequence. If the candidate host, isolated provider or manual verification is unavailable, record the live smoke check as **not run**, not passed on the strength of simulated results.

Use `pnpm credential:smoke --help` for the contract. A status read exits 0 on any valid matching receipt, not on a fresh verification; `verify` exits 0 only for the expected pair. Exit 1 means refusal, incomplete request or unexpected result; exit 2 means invalid arguments. Only explicit `verify` sends a POST, with `{}`. The CLI never reads or configures credentials, opens provider pages, follows redirects, or prints raw management responses or verifier output.

## Code and verification

The action lifecycle and shared read model live in [scoped-attention.ts](../src/app/scoped-attention.ts); [api.ts](../src/app/api.ts) and [http.ts](../src/app/http.ts) own the management contract. [deployment.ts](../src/deployment.ts) validates the Machine configuration and [runtime.ts](../src/app/runtime.ts) owns the subprocess invocation. [resources.ts](../src/app/resources.ts) and [tools/executor.ts](../src/app/tools/executor.ts) own the Session interfaces; [dsh.ts](../src/executor/dsh.ts) owns suspension and continuation.

From `plugin/`, the automated acceptance entry point is `pnpm test tests/plans.spec.ts tests/http.spec.ts tests/credential-smoke.spec.ts tests/docs.spec.ts`:

- [plans.spec.ts](../tests/plans.spec.ts), `pauses only the Plan ticket with a missing test account and sends one controlled action request`: dispatch independent A/B/C Tickets (`catalog`, `accounts`, `export`); B pauses while A/C still work, and B's successor `dashboard` remains blocked. The test exercises replay, shared summary and Hub relay, cross-project and self-attested verification refusals, failed verification surviving restart without a duplicate relay, and successful verification reusing B's claim. Verification uses a simulated Harness host, not a production credential.
- [http.spec.ts](../tests/http.spec.ts): loopback and project-scope management transport, error and concurrent-write boundaries.
- [credential-smoke.spec.ts](../tests/credential-smoke.spec.ts): CLI subprocess against a simulated IPv4 loopback listener. It checks default GET-only behavior, project and action scope, explicit POST, redaction, and refusal of redirects, interrupted or unexpected verification, and stored-receipt replay. It does not exercise a real host or provider.
- [docs.spec.ts](../tests/docs.spec.ts): consecutive numbering, root index registration, link rules, and source and test index coverage.
