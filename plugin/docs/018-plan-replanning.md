# 018 Plan replanning (S19, S22)

An active Plan has a numbered current graph and acceptance contract. Revision `1` is the registered DAG and the published Specification. Later revisions do not rewrite that registration, a Ticket's mandate, the project's handoff or external Git history. The Plan ID remains the handoff ID, and an acceptance reference remains its one-based Spec number.

## Technical recovery

The host evaluates registered Plan Tickets using the configured [stagnation thresholds and budget](016-run-limits.md). A failed check or repeated technical failure without useful progress can trigger a targeted diagnostic turn. Continued stagnation can replace the Assignment on the same Ticket, retaining its worktree and budget. The old writer must drain before a replacement can work. The node's `recovery` reports the failure and recovery state; a Worker report is not delivery. A missing product decision, missing credential or unreconciled mainline write is not an automatic retry. The Hub does not send technical progress as a proactive user notice.

`orchestrator_plan_replan` is Hub-only. Submit `{planId, nodeId, revision, failureId, reason, change}`. Use the active revision and current failure ID. A stale failure, a paused scope, or an unavailable budget on the triggering node or any changed node prevents the write. It returns `{planId, revision, scope, replacements, read}`; `scope` lists changed old node IDs and `replacements` maps retired IDs to successors. No Worker launches from a graph edit alone.

| `change.kind` | Fields and rules |
| --- | --- |
| `dependencies` | `updates: [{nodeId, blockedBy: string[]}]`. Change only unclaimed nodes. Keep undelivered and backend-to-frontend contract prerequisites. Unknown, duplicated or cyclic edges are refused. |
| `split` | `nodeId`, `groups: number[][]`. Partition every criterion of an unclaimed single-end node without an interface contract. All children retain its prerequisites; the old dependents require all children. |
| `merge` | `nodeIds: string[]`. Combine unclaimed nodes of the same execution role and the same original budget pool. Keep acceptance, demonstrations and external prerequisites. An internal prerequisite or conflicting contract cannot be merged away. |
| `repair` | No additional fields. Once per original budget pool, replace a still-stalled claimed node with a technical repair Ticket under the same scope. It inherits the old failed checks, prerequisites, acceptance, bound rules and any bound required CI. The old writer drains before the replacement can claim the work, including after a restart. |

Technical replan cannot edit acceptance text, release permission, rules, limits or failure evidence. The result must pass the same role, coverage and graph rules as registration. Splits and replacements share the original pool; reassignments retain Ticket history. See [failed-check continuity](013-development-verification.md#failed-check-continuity) for the queue and formal-delivery evidence gates.

Replacement is refused while an affected writer is reserved but its Worker launch is unconfirmed. Retry after verified start or release. A newer failure replaces an undelivered stalled-node review request; restart reconciles the request on the Hub before redelivery. Previously observed failures remain readable.

## Authorized requirement change

Call `orchestrator_plan_requirements` in the confirming project's Hub Session, on a private [operator-only Harness deployment](006-deployment.md#management-api). The pinned host identifies a direct user event, not an individual person sharing the same Session. Feishu answer access is not product-change authority.

1. The operator sends direct JSON with `intent: "change-plan-requirements"`, `planId`, `authorizedScope` (exact original handoff scope), optional `goal` and `changes: [{criterion, statement, observable}]`. The Hub calls `{mode: "preview"}`. An unknown criterion, or an empty `changes` with no changed goal, returns `needs-target`. Ask only which numbered criterion must change. A criterion edit affects its consumers and successors. A changed global goal affects **every** current node, even unclaimed nodes. The preview lists superseded Tickets, invalidated evidence and rechecks, plus all retained scope restrictions. It does not alter the graph or halt work. Retrying the same direct request returns its durable preview.
2. A preview queues one independent scope-review Session for the exact old and new terms and the original restrictions. It can submit only a verdict; it cannot write files, change a Plan or ask the operator. `scopeReview.status` is `pending`, `within-handoff`, `outside-handoff` or `uncertain`; a recorded result also has `reviewId`, `reviewerSessionId`, `reason` and `at`. No result or an uncertain result cannot authorize a write. On uncertainty the Hub asks only for the missing product detail and uses a fresh request. A wider scope or excluded work needs a new Handoff. The independent model assesses meaning; the host enforces its identity, the exact receipt and the unchanged authorization fields. This is not a deterministic analysis of arbitrary prose.
3. After `within-handoff`, show the exact impact and ask the operator for a separate direct `{"approved":true,"proposalId":"…","requestMessageId":"…","scopeReviewId":"…","scopeDecision":"within-handoff"}`. The Hub calls `{mode: "apply", proposalId}` against that exact latest direct event. Relays, technical advice and plain assent cannot create approval or a review result.
4. A stale or expired preview needs a new request, review and approval. In-flight mainline writes must reconcile, and all affected nodes need available run authorization. Approval publishes the revision, stops affected open Tickets and records the receipt atomically. Replay returns the same receipt. Successors wait for retired writers and formal predecessor delivery; they require fresh acceptance, review, tests and CI, and inherit known failed checks. Already observed Git writes and completed Tickets remain historical. Role classification, constraints, exclusions, test interfaces and authorization are not rewritten. A fully delivered Plan needs a new handoff.

## Reads and verification

| `orchestrator_read` resource | Audience and result |
| --- | --- |
| `plan/<id>` | Hub: current graph, `revision`, `revision_read`, `goal`, Frontier and concise recovery state. |
| `plan/<id>/revision/<n>` | Hub: saved graph, acceptance and revision cause, with paged nodes and the old-to-new replacement map for a replan. |
| `plan/<id>/node/<node-id>` | Hub: current or `superseded` node; follows the replacement map or the claim's failure history. `waiting_for: superseded-writers` means the old execution has not drained. |
| `plan/<id>/node/<node-id>/recovery/<failure-id>` | Hub: the retained failure used in a revision, even after a later attempt. |
| `plan-requirement/<id>` | Hub: durable impact preview, independent scope review and approval status. |
| `ticket/<id>/plan-scope` | Hub and this Ticket's Worker: applicable goal, constraints, authorized scope, acceptance scope, exclusions, role, demonstration, interface contract, test interfaces and criteria. Replacements expose `inheritedChecks`; a technical repair also names its original failure in `repair`. A superseded Ticket keeps its original contract. |

From `plugin/`, run `pnpm test tests/plans.spec.ts` for the public Hub and Worker commands, quota decisions, failure preservation and restart recovery. See [the source index](007-architecture.md#modules) for the implementation modules.
