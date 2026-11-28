# 020 Read-only idle inspection

An operator can authorize read-only idle inspection for a mounted project in Stage 2. Inspection is off by default. Findings go into a project backlog. Maintenance events, Worker document-impact checks and independent reviews continue when inspection is disabled. See [Stage 2](009-handoff.md#stage-2-maintenance).

## Grant and schedule

Read `blocks.executor` from `GET /orchestrator/api/settings`. Update the existing executor value as shown below. Send the complete `value` and current `revision` to `PUT /orchestrator/api/settings/executor` with the [loopback and mounted-project headers](012-project-runtime.md#project-scope).

```json
{
  "idleInspection": { "scope": "src/widgets", "intervalSeconds": 3600, "maxTokens": 500000 },
  "lightweightModel": { "provider": "local", "model": "small" }
}
```

`scope` names one literal file or directory relative to the repository root. `intervalSeconds` is an integer from 1 to 31,536,000. `maxTokens` is a nonnegative safe integer for that scope. Zero prevents provider calls. Supply all three fields to enable inspection. Omit `idleInspection` or set it to `null` to revoke it. The optional `lightweightModel` takes `{provider,model,reasoningEffort?}` and applies to the inspection Session. Omit it or pass `null` to use the DSH default.

The first run is due one interval after authorization. The orchestration pass starts at most one inspection and skips missed intervals. The project must be configured and unpaused, with a ready idle Hub, no pending authorized maintenance event, open Ticket or unfinished handoff or Plan. New authorized work takes precedence. Revoking or replacing the grant fences the old Session immediately. The Session reads committed objects from the configured local base ref as it was at dispatch.

## Read and report

The host records the intent, project attribution and Session ID before dispatch. It checks the checkout identity with isolated Git, pins a commit and verifies the scope before involving a model. The inspection root lives in the project's private state directory. The sealed `{scope,commit}` task has two available tools.

| Tool | Contract |
| --- | --- |
| `orchestrator_inspection_read` | `{path,offset?}` reads one page at the pinned commit. Returns `{kind:'file',path,text,nextOffset}` or `{kind:'directory',path,entries,nextOffset}`. Offsets count UTF-16 units for files and entries for directories. Follow `nextOffset` until `null`. Use exact case-sensitive repo-relative names. The reader refuses symbolic links, submodules, external object stores, missing objects, non-text blobs and objects over 1 MiB. |
| `orchestrator_inspection_finish` | `{findings:[{path,offset?,evidence,summary}]}` accepts at most 32 findings. Each needs a nonblank, single-line quote of up to 1,000 characters from a file page the Session read and a summary of up to 500 characters. The host rechecks the page, grant and native call before storing the conclusion. After inspecting content, submit an empty array when there are no findings. A turn ending without a conclusion records a failure. |

After a restart, the host reconciles the existing Session and native task. An interrupted consumed task without a conclusion ends as failed. Findings and the run's conclusion are committed together. Quotes on the same line of the same file page reuse the todo ID across runs. First and latest observations carry the scope, commit, Session ID and timestamp. Findings stay readable in the backlog; approval links one finding to its repair Plan.

## Approve one repair

In a ready Stage 2 project, an operator can send `POST /orchestrator/api/project/inspection/:id/repair`, where `:id` is the backlog finding ID. Send the [loopback and mounted-project headers](012-project-runtime.md#project-scope) and `Content-Type: application/json`. No query parameters or additional JSON fields are accepted.

```json
{
  "path": "src/widgets/labels.ts",
  "sessionId": "inspection-…",
  "role": "backend",
  "goal": "Correct label casing",
  "supportingPaths": ["docs/widgets.md", "tests/labels.spec.ts"],
  "check": { "seam": "Public label formatter", "observable": "A mixed-case label renders lowercase" }
}
```

The path must exactly match the finding, and `sessionId` must match its latest completed observation when first approved. The configured base ref must still be the inspected ref and the observed file must be unchanged there. If the file has changed or disappeared, inspect it again; commits affecting only other files do not invalidate the finding. The grant covers the exact finding path and up to 16 optional, distinct `supportingPaths` for necessary files, not the whole inspection scope or the contents of a directory. Choose `backend` or `frontend` for one independently verifiable repair. The trimmed `goal` and test `seam` must be nonblank and at most 200 characters each; `observable` must be nonblank and at most 1,000 characters. The approved fields, not the finding's text, supply the Plan goal and acceptance. Turning off inspections does not revoke a completed observation or authorize any repair.

If the ref moves during verification, the approval is refused without recording a Plan. Retry against the current ref; a changed finding still requires a new inspection.

The request returns HTTP `200 {planId, reused}`. Approval, the one-node Plan, and its Hub relay commit together. Replaying the same approval returns the same Plan with `reused: true`, even after restart or a later observation. A changed approval cannot replace it. On restart the host reconciles the relay with native history; if the Hub consumed it without claiming the node, the host wakes the Hub again for the same Plan. The Hub uses the [normal Frontier and claim path](009-handoff.md#frontier-dispatch-and-claims) to create an independent Ticket, Worker Session and worktree. The Worker reads the exact paths from `ticket/<id>/plan-scope`. The [delivery gates](013-development-verification.md#delivery-check) also compare the committed base and candidate: `inspection_repair_scope` blocks edits outside approved files, and `inspection_repair_target` blocks a different ref or a changed observed file at the reviewed base. The Plan has no production release authorization. Neither the original inspection Session nor an already delivered Plan is reopened or rewritten.

| Error | Condition |
| --- | --- |
| `400` | Invalid path, body, query or content type, or rejection by the registered-project checkout check. |
| `403` | The loopback management guard refused the request. |
| `404 inspectionFindingNotFound` | No finding with that ID in the mounted project. |
| `409 inspectionRepairConflict` | Path, observed file, latest Session or configured ref mismatch, conflicting replay, or Stage 2/Hub not ready for a new approval. |
| `409` with a project error code | Missing or stale mount, processing paused, unavailable setup, or another management write in progress. |
| `500` | The isolated Git verification failed (for example, an alternate object store was found); no approval was recorded. |

## Read contract and limits

`GET /orchestrator/api/project/inspection?offset=0&limit=20` requires `x-orchestrator-request: 1` and `x-orchestrator-project-id: <active project ID>`. The Hub reads the same view with `orchestrator_read {resource:'project/inspection',offset?,limit?}`. HTTP caps each page at 100 items. The Hub applies its resource page limit.

| Response field | Meaning |
| --- | --- |
| `grant`, `nextDueAt` | Current grant and ISO due time; `null` when disabled. |
| `budget`, `pausedReason` | [Budget view](016-run-limits.md#read-contract) for the configured path, or `null` when off. `pausedReason` describes exhaustion, missing usage or a model request whose verified upper bound cannot fit. |
| `lastRun` | `null` before the first run. Fields are `{sessionId,scope,baseRef,commit,model,status,startedAt,endedAt,reason,todoIds}`. `commit`, `model`, `endedAt` and `reason` may be `null`. `model:null` denotes the default route. Status values are `pending`, `running`, `completed`, `withdrawn`, `failed` and `quota-paused`. |
| `items`, `next_offset` | Todos `{id,projectId,path,evidence,summary,first,latest,repairPlanId?}`. Each observation is `{sessionId,scope,commit,at}`. `repairPlanId` is absent until separately approved; `handoff/<repairPlanId>` records the repair authorization and its pinned `inspectionRepair` with `observation`, `todoId`, `baseRef`, `supportingPaths`, `approvedAt` and `hubSessionId`. `next_offset:null` ends pagination. Todos remain readable after revocation. |

An invalid or incomplete grant returns HTTP 400 with `issues`. An unavailable model returns `modelUnavailable`. A missing base ref returns `invalidRequest`. An outdated executor revision returns 409. Wrong, missing or unavailable project scope returns 409 with `staleProject`, `projectScopeRequired` or `noProject`. Requests failing the loopback guard receive 403. Object or Session errors during a run appear in its failure record.

Provider admission reserves the verified request bound against the project and inspection path pools. Settlement charges each pool once. Each path keeps its cumulative usage across settings changes and restarts. The ledger reports unreceipted calls as missing. The inspection cap governs that path and a configured strict project cap governs all project work. `GET /orchestrator/api/project/meter` lists inspection usage as project-shared under its Hub generation. See [project metering](014-project-metering.md).

Run `pnpm test tests/idle-inspection.spec.ts tests/inspection-git.spec.ts tests/inspection-quota.spec.ts` for the clock, Session, repository, approval and quota checks. In `tests/mainline-queue.spec.ts`, `artifact-only` exercises inspection after formal delivery and `inspection-repair` exercises independent repair through real worktrees and the standard delivery gates. See the [scheduler and approval](../src/app/idle-inspection.ts), [scoped reader](../src/executor/inspection-git.ts) and [inspection tools](../src/app/tools/inspection.ts).
