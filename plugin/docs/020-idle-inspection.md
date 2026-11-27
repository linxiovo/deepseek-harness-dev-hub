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

After a restart, the host reconciles the existing Session and native task. An interrupted consumed task without a conclusion ends as failed. Findings and the run's conclusion are committed together. Quotes on the same line of the same file page reuse the todo ID across runs. First and latest observations carry the scope, commit, Session ID and timestamp. Todos have no Ticket or Plan association.

## Read contract and limits

`GET /orchestrator/api/project/inspection?offset=0&limit=20` requires `x-orchestrator-request: 1` and `x-orchestrator-project-id: <active project ID>`. The Hub reads the same view with `orchestrator_read {resource:'project/inspection',offset?,limit?}`. HTTP caps each page at 100 items. The Hub applies its resource page limit.

| Response field | Meaning |
| --- | --- |
| `grant`, `nextDueAt` | Current grant and ISO due time; `null` when disabled. |
| `budget`, `pausedReason` | [Budget view](016-run-limits.md#read-contract) for the configured path, or `null` when off. `pausedReason` describes exhaustion, missing usage or a model request whose verified upper bound cannot fit. |
| `lastRun` | `null` before the first run. Fields are `{sessionId,scope,baseRef,commit,model,status,startedAt,endedAt,reason,todoIds}`. `commit`, `model`, `endedAt` and `reason` may be `null`. `model:null` denotes the default route. Status values are `pending`, `running`, `completed`, `withdrawn`, `failed` and `quota-paused`. |
| `items`, `next_offset` | Todos `{id,projectId,path,evidence,summary,first,latest}`. Each observation is `{sessionId,scope,commit,at}`. `next_offset:null` ends pagination. Todos remain readable after revocation. |

An invalid or incomplete grant returns HTTP 400 with `issues`. An unavailable model returns `modelUnavailable`. A missing base ref returns `invalidRequest`. An outdated executor revision returns 409. Wrong, missing or unavailable project scope returns 409 with `staleProject`, `projectScopeRequired` or `noProject`. Requests failing the loopback guard receive 403. Object or Session errors during a run appear in its failure record.

Provider admission reserves the verified request bound against the project and inspection path pools. Settlement charges each pool once. Each path keeps its cumulative usage across settings changes and restarts. The ledger reports unreceipted calls as missing. The inspection cap governs that path and a configured strict project cap governs all project work. `GET /orchestrator/api/project/meter` lists inspection usage as project-shared under its Hub generation. See [project metering](014-project-metering.md).

Run `pnpm test tests/idle-inspection.spec.ts tests/inspection-git.spec.ts tests/inspection-quota.spec.ts` for the clock, Session, repository and quota checks. The `artifact-only` scenario in `tests/mainline-queue.spec.ts` exercises inspection after formal delivery. See the [scheduler](../src/app/idle-inspection.ts), [scoped reader](../src/executor/inspection-git.ts) and [inspection tools](../src/app/tools/inspection.ts).
