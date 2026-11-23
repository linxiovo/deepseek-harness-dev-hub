# 018 Plan replanning (S19, S22)

An active Plan has a numbered current graph and acceptance contract. Revision `1` is the registered DAG and the published Specification. Later revisions do not rewrite that registration, a Ticket's mandate, the project's handoff or external Git history. The Plan ID remains the handoff ID, and an acceptance reference remains its one-based Spec number.

## Technical recovery

The host evaluates registered Plan Tickets using the configured [stagnation thresholds and budget](016-run-limits.md). A failed check or repeated technical failure without useful progress can trigger a targeted diagnostic turn. Continued stagnation can replace the Assignment on the same Ticket, retaining its worktree and budget. The old writer must drain before a replacement can work. The node's `recovery` reports the failure and recovery state; a Worker report is not delivery. A missing product decision, missing credential or unreconciled mainline write is not an automatic retry. The Hub does not send technical progress as a proactive user notice.

`orchestrator_plan_replan` is Hub-only. Submit `{planId, nodeId, revision, failureId, reason, change}`. Use the active revision and the failure ID on the stalled node's `recovery`. A stale/unknown failure, paused scope or unavailable quota prevents the write. The command returns `{planId, revision, scope, replacements, read}`; `scope` lists the old node IDs actually changed and `replacements` maps retired IDs to their successors. No Worker launches from a graph edit alone.

| `change.kind` | Fields and rules |
| --- | --- |
| `dependencies` | `updates: [{nodeId, blockedBy: string[]}]`. Change only unclaimed nodes. Keep undelivered and backend-to-frontend contract prerequisites. Unknown, duplicated or cyclic edges are refused. |
| `split` | `nodeId`, `groups: number[][]`. Partition every criterion of an unclaimed single-end node without an interface contract. All children retain its prerequisites; the old dependents require all children. |
| `merge` | `nodeIds: string[]`. Combine unclaimed nodes of the same execution role and the same original budget pool. Keep acceptance, demonstrations and external prerequisites. An internal prerequisite or conflicting contract cannot be merged away. |
| `repair` | No additional fields. Once per original budget pool, replace a still-stalled claimed node with a technical repair Ticket under the same scope. It inherits the old failed checks, prerequisites, acceptance, bound rules and any bound required CI. The old writer drains before the replacement can claim the work, including after a restart. |

The command cannot edit acceptance text, release permission, rules, limits or failure evidence. The complete result is validated against the same role, coverage and graph rules as registration. Splits and replacements share the original pool; IDs do not reset usage. Reassignments keep the original Ticket and evidence history. A Plan candidate cannot use an unrelated passing command to clear a previous failed check for that Ticket; the [delivery-check gate](013-development-verification.md#repair-and-evidence-reuse) lists `failed_checks_require_recheck` until the same checks are re-observed as passing on its exact candidate and writer generation.

Replacement is refused while an affected writer is reserved but its Worker launch is unconfirmed. Retry with current observations after startup or confirmed release. A recorded command result is Worker evidence, not proof that an assertion still runs; the independent reviews must inspect the exact candidate for deletion or weakening of failed checks.

## Authorized requirement change

Call `orchestrator_plan_requirements` in the confirming project's Hub Session:

1. Preview `{mode: "preview", request: {planId, goal?, changes: [{criterion, statement, observable}]}}`. The `criterion` is the number from the current Plan revision. An empty list or an unknown criterion returns `needs-target` and the available criteria; ask only which criterion the person means. A valid `preview` gives the old and new goal, `invalidated` criteria, and all direct and transitive `affected` nodes, old Tickets, evidence references and required rechecks. It does not edit the graph or stop any work.
2. Show the impact in Harness. The person explicitly approves with `{"approved":true,"proposalId":"…"}` in the same Hub Session that confirmed the handoff. Then call `{mode: "apply", proposalId, message}` with that exact latest direct user message. A plain assent, a Worker, a relay, or permission to answer Feishu questions cannot approve a change. If the preview is expired or its plan, evidence or in-flight state changed, refresh the preview and obtain a fresh approval. A `queued` or `applying` mainline intent must be reconciled before the affected Ticket can be replaced.
3. Before any write, all affected nodes must have available run authorization. Approval then retires the affected nodes and stops superseded open Tickets atomically with the new revision and approval receipt. Already observed Git writes and completed Tickets remain historical. Replays return the existing receipt. Replacement nodes wait for retired writers to drain and for formal predecessor delivery; their own fresh acceptance, review, tests and CI are required. Unaffected nodes and their claims continue. The same original execution-role classification, constraints, test interfaces and operating authorization apply. For a different authorized scope or a fully delivered Plan, start a new handoff.

## Reads and verification

| `orchestrator_read` resource | Audience and result |
| --- | --- |
| `plan/<id>` | Hub: current graph, `revision`, `revision_read`, `goal`, Frontier and concise recovery state. |
| `plan/<id>/revision/<n>` | Hub: saved graph, acceptance and revision cause, with paged nodes and the old-to-new replacement map for a replan. |
| `plan/<id>/node/<node-id>` | Hub: current or `superseded` node; follows the replacement map or the claim's failure history. `waiting_for: superseded-writers` means the old execution has not drained. |
| `plan/<id>/node/<node-id>/recovery/<failure-id>` | Hub: the retained failure used in a revision, even after a later attempt. |
| `plan-requirement/<id>` | Hub: durable impact preview and approval status. |
| `ticket/<id>/plan-scope` | Hub and this Ticket's Worker: the goal, constraints, authorized scope, role, demonstration, interface contract, test interfaces and criteria applicable to that Ticket. A repair includes its original failure and required reruns. A superseded Ticket still shows its original contract. |

From `plugin/`, run `pnpm test tests/plans.spec.ts` for the public Hub and Worker commands, quota decisions, failure preservation and restart recovery. See [the source index](007-architecture.md#modules) for the implementation modules.
