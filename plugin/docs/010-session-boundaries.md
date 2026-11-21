# 010 Session boundaries

This document builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md) and [003 Execution](003-execution.md); [007 Architecture](007-architecture.md) indexes the classes and tests below.

The deployment runs one Hub Agent as its main Session and one Worker Session per Ticket. The Hub is the only Session role with an in-plugin tool that sends a message to a person; the host also queues an accepted Ticket's acknowledgement automatically. Worker Sessions execute, test and report to the Hub. The boundary is enforced by the bundle's presets and by the runtime's tool registration and restriction, not by prompt text alone; prompts describe the boundary but cannot widen it.

The boundary is a cooperative default-path guardrail, not an OS sandbox. It is meant for the ordinary case: a routine tool call, or a CLI invoked by name, would otherwise reach a person outside the Hub's path. It does not defend against a determined process. An installed CLI run by absolute path, raw HTTP from a shell, or another identity's credentials can still reach a channel; the deployment runs as the operator's OS user with no container and no network isolation. Normal development stays as it was: workers install dependencies, use `web_search`, and call the read-only Context7 MCP tools that `DEV_MCP_TOOLS` names. This document is the plugin's working contract, not a security guarantee.

## Hub Agent

The main Session is created with `ROUTER_PRESET` (`dsh-superagent-router`). The preset is read-only: file inspection (`read`, `read_image`), file search (`glob`, `grep`), skills, instructions, time context and compaction. It leaves out `bash`, `pwsh`, `job_output`, `job_list`, `job_kill`, `write`, `edit`, `apply_patch`, subagent, web, todo, question, presentation, plan, plugin-manager, scheduling, goal and workflow tools. `Sessions.decorate` then applies `tools.restrict({ allow: HUB_TOOLS })`, with `HUB_TOOLS` (`skill`, `read`, `read_image`, `glob`, `grep`) in `src/app/sessions.ts`, so an inherited tool the profile adds later cannot be called unless it is one of those five; an MCP tool the profile mounts is outside the allow list too. The Session's own `orchestrator_*` registrations are not masked. There is no Hub wait guard because there is no shell or job tool to guard.

The Hub keeps the coordination and assessment tools registered by `mainTools` in `src/app/tools/main.ts`: `orchestrator_read`, `orchestrator_route`, `orchestrator_plan_dispatch`, `orchestrator_plan_deliver`, `orchestrator_ticket_retry`, `orchestrator_ticket_request_status`, `orchestrator_ticket_note`, `orchestrator_trigger_requeue`, `orchestrator_eval`, `orchestrator_eval_read`, `orchestrator_eval_decide`, `orchestrator_reply`, `orchestrator_thread_unsubscribe`, `orchestrator_settings_save`, `orchestrator_policy_sync` and `orchestrator_prompts_save`. They read ticket and Plan state and evidence, dispatch only registered Frontier nodes through durable claims, record only an exact formal delivery-check receipt for a completed node, route or attach work to existing Tickets and their Worker Sessions, ask a waiting Worker for a status report, and relay a report or question to a person through a Channel; the three save and sync tools change deployment configuration. `orchestrator_read` exposes the same read-only ticket, Trigger, Thread, Decision, settings, prompt and repository resources to the Hub, and its read-only tools let it inspect code, images, logs and linked documents; it executes no work and changes no repository file.

If DeepSeek Harness selects another preset for the main Session before its first turn, `Sessions` selects `ROUTER_PRESET` again. A main Session the host creates or reloads is decorated with the runtime restriction, so it cannot recover shell, job or write tools even when the profile mounts one.

The Hub also owns `orchestrator_handoff_confirm`, `orchestrator_handoff_answer` and `orchestrator_plan_context`. Neither planning Session owns these tools. [009 Handoff](009-handoff.md) describes the planner and splitter scopes; they can submit only their own planning artifact, never issue a Channel reply or start a Worker.

## Worker Session

An Executor Session is created with `WORKER_PRESET` (`dsh-superagent-worker`) and keeps the file, search, shell, job, web, skill, todo and subagent tools listed in `WORK_TOOLS` (`src/app/sessions.ts`). `Sessions.workOnly` adds only the MCP tools named in `DEV_MCP_TOOLS`, the read-only Context7 lookups `mcp__context7__resolve-library-id` and `mcp__context7__query-docs`. No other MCP server is allowed: a mounted tool such as `mcp__feishu__send_message` is not in the allow list, so a Worker cannot send a person a message through MCP. The preset also keeps the shell's network access: a worker installs dependencies and reaches the Context7 service its MCP tools use. It works in its Ticket directory and may create subagents, which run under DeepSeek Harness's `standard` preset with the worker's permissions. It receives no tool for asking or presenting to a person, changing the deployment profile, scheduling work outside the worker slots, or sending a Channel message.

### Internal take-up

`orchestrator_ack` takes `{ trigger_id }` and records that the Worker takes up a person's request. It calls the Engine's atomic `takeUp(ticketId, triggerId)`, which returns `{ ticketId, triggerId, reused }` and only appends the Ticket id to the Trigger's disposition `acked` list; it never queues, sends or refreshes an outbox message. The tool returns `{ trigger_id, taken_up: true, reused }`, where `reused` is true when this Ticket had already recorded the take-up. The request must be a person's message that reached a live Ticket on a writable Thread: an ended Ticket is `ackEnded`, an unknown Ticket or Trigger is `unknownTicket` or `unknownTrigger`, another Ticket's message or a context-only Thread is `notReached`, and a bot, CI or worker message is `ackNotPerson`. Repeating the call is idempotent.

Acceptance is different from Worker take-up: when a Ticket is created with an acknowledgement, `Tickets.create` calls `Replies.acknowledgeAccepted` to queue it for the original human Trigger's Channel. This host-side confirmation does not come from `orchestrator_ack`; taking up the request later neither queues nor refreshes it.

### Reports and questions

`orchestrator_report` records progress, `ready`, `blocked`, `failed` or `dropped` and an optional `human_action` question. The result is a report on the Ticket and an internal relay to the Hub; it sends nothing to a person. The Hub decides whether and where to answer with `orchestrator_reply` (`answer`, `result` or `attention`), its model-facing Channel send tool. Host-side acceptance acknowledgement is a separate outbox path; no Worker tool exposes a Channel send path.

### CLI guard

Worker shells run as the deployment's GitHub account and Feishu bot. Setup writes shims first on `PATH` in `<stateDir>/worker-bin`: `gh` runs the agent's CLI, `lark-cli` runs the bot's CLI, and a command named in the Execution settings' `blockedCommands` fails; `gh`, `git` and `lark-cli` cannot be blocked. A shim removes its own directory from `PATH` and runs the real program, so a wrapper that execs `gh` or `lark-cli` by name still reaches the deployment's account. On every platform the shims are the extensionless `gh` and `lark-cli` scripts and one `send-guard.mjs` holding the refusal policy; Windows also writes `gh.cmd` and `lark-cli.cmd`, and a `.cmd` for each blocked command, so cmd and PowerShell resolve them by name.

The `gh` and `lark-cli` shims refuse the ordinary human-facing sends by name, before the CLI runs:

| CLI | Refused by name |
| --- | --- |
| `gh` | `issue comment`, `pr comment` and `pr review`; `pr close`, `pr reopen`, `issue close` or `issue reopen` when passed `-c`/`--comment`; a `gh api` write to a `/comments`, `/reviews` or `/replies` resource, such as `/comments/<id>/replies`; a `gh api graphql` write whose query creates or submits a comment or review, such as `addComment` or `submitPullRequestReview` |
| `lark-cli` | every `+messages-*` shortcut except the message reads (`+messages-mget`, `+messages-search`, `+messages-read-status`, `+messages-resources-download`); `im messages` and `im messages.<operation>` except read operations; `im threads forward`; `api` with a method other than `GET`, or a body and no explicit method |

Reads and other non-comment work still run: every `gh` read, `gh pr create`, `gh pr merge`, `gh pr`/`gh issue close` and `reopen` without a comment option, non-comment API writes such as resolving a review thread, `lark-cli` message reads, and its read-only API calls. What a worker may do with them is for the prompts and the Delivery requirements to say, not the shim. The plugin's own `Commands` run the configured CLIs by absolute path, so the Hub's `orchestrator_reply` and the other Channel messages still send.

For `gh api`, `-f`/`--raw-field`, `-F`/`--field`, and `--input` are ordinary supported CLI parameters. Short field and method (`-X`) flags accept separate or compact values; long flags accept separate or `--flag=value` values. Fields and input bodies default the request to `POST`; an explicit `-X GET`/`--method GET` still permits a read. On `graphql`, the guard checks the query supplied inline, from typed `query=@file` or `query=@-`, or in a JSON `--input file`/`--input -` body before running the real CLI. It resolves filenames in the caller's working directory and forwards inspected standard input byte-for-byte. If it cannot inspect a prospective GraphQL write, it refuses without printing the input. Read queries, other mutations such as `resolveReviewThread`, and non-comment API writes continue to run; passing a query in a file or standard input is not a bypass of the by-name guard.

These refusals cover calls made by name. A worker that runs the real CLI by absolute path, posts over HTTP, or uses another identity's credentials is outside the shims and outside this contract; the prompts forbid it, and the refusal is cooperative rather than enforced. The same limit covers a process the Worker starts in its shell: it is outside the tool and message boundary.

## Ticket end

Every Worker Session and every subagent below it, at any depth, is restricted to the worker's work tools, `DEV_MCP_TOOLS` and a guard on each call. `Sessions.owningTicket(agent)` climbs `session.header.parentSession` without a depth limit, detects cycles, and falls back to `ctx.sessionController.inspect(parent).meta.parentSession` for an ancestor that is not loaded; when `Sessions.install` or agent decoration sees a child Session whose `parentSession` ancestry is not yet resolved, `Sessions.limitSubagent` fails closed by installing a temporary tool guard first so no tool runs during async `inspect`. If `inspect` rejects, that failure does not prove non-ownership: the error propagates and the temporary guard stays in place until the Session is released or rebound. Only when the full ancestor chain is verified to have no Worker ancestor does `limitSubagent` revoke the temporary guard without affecting an unrelated Session; otherwise it swaps the temporary guard for `workOnly(agent, ticketId)` (restricting the Session to `WORK_TOOLS` and `DEV_MCP_TOOLS` and adding the ended-Ticket guard). The guard reads the Ticket from the Store on every call and refuses every work tool once `liveTicket` is false, with `Ticket ended; new work needs a new authorized ticket`. The check therefore covers a subagent created before or after the Ticket ended and one reloaded afterwards. Ending a Ticket also cancels a worker turn that is still working through the host's cooperative cancel, and on Ticket close or hand-off `stopSubagents` (`src/executor/background.ts`) first kills and collects tracked jobs by Session id across all non-`external` descendants in the persistent catalog (`listChildren`), then calls `drainChildren` so the SDK recursively releases its resident managed subtree, and finally stops (`Agent.cancel` and `whenIdle`) any descendant still loaded after `drainChildren`—covering independently restored live grandchildren whose intermediate parent was unloaded—so neither tracked jobs nor live descendant turns can keep writing to the repository after close.

That cancellation ends the Session's turn and its tracked work, not every process the turn may have started. A process that detached from the job registry, or one started outside the deployment's tool and shim tracking, is not promised to stop; the guard stops the normal tool path from writing after the end, and a deliberate escape is outside it.

A Session is protected only when its ancestry reaches a `worker-<ticketId>` Session; an unrelated Session keeps the preset it was created with. The runtime cannot infer a Ticket for a Session with no Worker ancestor, so the boundary does not claim to limit an arbitrary Session outside the deployment's execution tree.

The Hub may still read an ended Ticket's reports and results through `orchestrator_read` (`ticket/<id>`, `/result`, `/report/<assignment id>`) and the management HTTP reads; the end of a Ticket removes Worker write access, not Hub or management read access.

## Acceptance

The agreed contract for this boundary:

- The Hub coordinates and inspects through its own tools: it has no shell, job or file-write tool, its inherited surface is restricted to `HUB_TOOLS`, and its human-facing responses use `orchestrator_reply`; host-side acceptance acknowledgement separately queues an outbox message.
- A Worker takes a person's request up internally (`orchestrator_ack`), reports internally, and has no Channel send path; the `gh` and `lark-cli` shims refuse the by-name CLI sends that the CLI guard lists.
- When a Ticket ends, every work tool refuses further calls at any depth (failing closed while a reloaded child resolves its `parentSession` ancestry, and staying guarded if `inspect` fails rather than proving non-ownership), and the Executor cancels the turn, kills and collects tracked jobs across all non-`external` descendants before `drainChildren`, and cancels any descendant Session still loaded afterward.
- Normal development keeps its network, dependency installs, `web_search` and the two read-only Context7 MCP tools in `DEV_MCP_TOOLS`; no other MCP tool is allowed.
- Not covered: escape through absolute paths, raw HTTP or substitute credentials; a container, network or OS-user isolation; stopping a process that left the job and shim tracking.

## Code and tests

| Entry | Role |
| --- | --- |
| `plugin/cordis.patch.yml` | Defines `dsh-superagent-worker` and the read-only `dsh-superagent-router` preset rows |
| `plugin/src/app/sessions.ts` | `ROUTER_PRESET`, `WORKER_PRESET`, `HUB_TOOLS`, `WORK_TOOLS`, `DEV_MCP_TOOLS`, `Sessions.decorate`, `Sessions.workOnly`, `Sessions.owningTicket` and `Sessions.limitSubagent` (role restrictions and Worker/descendant guards) |
| `plugin/src/executor/background.ts` | `stopSubagents` and `stopBackground`: Worker and descendant tracked-job shutdown and subagent release on Ticket close and hand-off |
| `plugin/src/app/tools/main.ts` | The Hub's coordination, inspection and evaluation tools |
| `plugin/src/app/plan-dispatch.ts` | Hub-only Frontier selection, slot reservation, durable Plan Ticket claims and restart rearming |
| `plugin/src/app/tools/executor.ts` | Worker read, take-up, report, Thread and hand-back tools, plus candidate evidence in `011-doc-tree-impact.md` and `013-development-verification.md` |
| `plugin/src/core/replies.ts` | `Replies.takeUpInternally` records a Worker's take-up without sending; `Replies.acknowledgeAccepted` queues the host's accepted-Ticket acknowledgement for a human Trigger |
| `plugin/src/core/engine.ts` | `Engine.takeUp` (atomic take-up entry) and `Engine.reply` (Hub answer, result and attention messages) |
| `plugin/src/infra/environment.ts` | Worker command shims: `gh` and `lark-cli`, `blockedCommands`, and the by-name refusal of human-facing CLI sends |
| `plugin/tests/bundle-patch.spec.ts` | Reads the patch as the host does and checks both presets and their tool sets |
| `plugin/tests/environment.spec.ts` | Runs the shims against a fake CLI and inbox: refused sends, allowed reads and authorized writes, and the host's own absolute CLIs |
| `plugin/tests/runtime.spec.ts` | Calls mounted Hub and Worker tools, observes files and the outbox, and verifies the Ticket-end and descendant boundaries under simulated SDK dispatch and tracked jobs |
| `plugin/tests/tools.spec.ts`, `plugin/tests/core-engine.spec.ts` | Tool shapes and take-up, reply and outbox effects |
| `plugin/tests/service-script.spec.ts` | The service script's start, stop, restart and status routing; it has no outbound Channel command |
| `plugin/tests/followups.spec.ts` | Follow-up ownership on Ticket Threads, internal `orchestrator_ack` with no outbox receipt, `orchestrator_thread_follow` and `orchestrator_trigger_handback` |
| `plugin/tests/runtime-concurrency.spec.ts` | Concurrent `orchestrator_ack` take-up without outbox receipts, background job and subagent release on Ticket stop or hand-off, and Worker slot boundaries |
| `plugin/tests/model-surface.spec.ts` | Closed role tool lists (`orchestrator_*` on Hub vs Worker) and cross-role tool-reference checks across prompts, skills and inputs |
| `plugin/prompts/shared.md`, `plugin/prompts/orchestrator.md`, `plugin/prompts/admission.md` | Hub read-only inspection, routing and assessment role; relies on host-enforced denial of shell, jobs and file writes |
| `plugin/prompts/worker.md`, `plugin/prompts/work.md`, `plugin/prompts/handoff-worker.md` | Worker execution role: internal `orchestrator_ack` take-up, `orchestrator_report` (`human_action`, `reply_to_trigger_id`), hand-back and no direct IM delivery |
| `plugin/prompts/replies.md`, `plugin/prompts/dispatch.md`, `plugin/prompts/handoff-orchestrator.md` | Hub-only Channel replies (`orchestrator_reply` purposes and `follow_up` boundary) vs Worker internal take-up and reporting |
| `plugin/prompts/cli.md` | Worker CLI boundaries (`gh` and read-only `lark-cli --as bot` without Channel sends) vs shell-less Hub inspection |
| `plugin/prompts/team/communication.md` | Default communication instructions distinguishing internal `orchestrator_ack` and `orchestrator_report` review replies from Hub delivery |
| `plugin/skills/dsh-superagent-github/SKILL.md` | Worker GitHub skill: `orchestrator_read`, internal `orchestrator_ack`, `orchestrator_report` review answers and no direct `gh` comment/review sends |
| `plugin/skills/dsh-superagent-feishu/SKILL.md` | Worker Feishu skill: read-only `orchestrator_read` and bot-identity `lark-cli` reads without sending replies |
