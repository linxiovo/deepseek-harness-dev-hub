# 010 Session boundaries

This document builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md) and [003 Execution](003-execution.md); [007 Architecture](007-architecture.md) indexes the classes and tests below.

The deployment runs one Hub Agent as its main Session and one Worker Session per Ticket. The Hub is the only Session role with an in-plugin tool that sends a message to a person; the host also queues an accepted Ticket's acknowledgement automatically. Worker Sessions execute, test and report to the Hub. The boundary is enforced by the bundle's presets and by the runtime's tool registration and restriction, not by prompt text alone; prompts describe the boundary but cannot widen it.

The boundary is a cooperative default-path guardrail, not an OS sandbox. It is meant for the ordinary case: a routine tool call, or a CLI invoked by name, would otherwise reach a person outside the Hub's path. It does not defend against a determined process. An installed CLI run by absolute path, raw HTTP from a shell, or another identity's credentials can still reach a channel; the deployment runs as the operator's OS user with no container and no network isolation. Normal development stays as it was: workers install dependencies, use `web_search`, and call the read-only Context7 MCP tools that `DEV_MCP_TOOLS` names. This document is the plugin's working contract, not a security guarantee.

## Hub Agent

The main Session is created with `ROUTER_PRESET` (`dsh-superagent-router`). The preset is read-only: file inspection (`read`, `read_image`), file search (`glob`, `grep`), skills, instructions, time context and compaction. It leaves out `bash`, `pwsh`, `job_output`, `job_list`, `job_kill`, `write`, `edit`, `apply_patch`, subagent, web, todo, question, presentation, plan, plugin-manager, scheduling, goal and workflow tools. `Sessions.decorate` then applies `tools.restrict({ allow: HUB_TOOLS })`, with `HUB_TOOLS` (`skill`, `read`, `read_image`, `glob`, `grep`) in `src/app/sessions.ts`, so an inherited tool the profile adds later cannot be called unless it is one of those five; an MCP tool the profile mounts is outside the allow list too. The Session's own `orchestrator_*` registrations are not masked. There is no Hub wait guard because there is no shell or job tool to guard.

The Hub's coordination tools are registered by `mainTools` in `src/app/tools/main.ts`: they inspect evidence, dispatch registered Frontier nodes, route work, and relay reports and questions. `orchestrator_settings_save` and `orchestrator_policy_sync` do not publish shared rules. Only the operator can edit admission Policy or the configured required CI checks; Source membership sync uses the configured Source. See [Prompt versions](004-prompts.md#versions) for staging and publication.

If DeepSeek Harness selects another preset for the main Session before its first turn, `Sessions` selects `ROUTER_PRESET` again. A main Session the host creates or reloads is decorated with the runtime restriction, so it cannot recover shell, job or write tools even when the profile mounts one.

The Hub also owns `orchestrator_handoff_confirm`, `orchestrator_handoff_answer`, `orchestrator_plan_context`, `orchestrator_plan_question` and `orchestrator_plan_answer`. Neither planning Session owns these tools. [009 Handoff](009-handoff.md) describes the planner and splitter scopes; they submit only their own planning artifact, never issue a Channel reply or start a Worker. Planner questions still use `orchestrator_handoff_answer`.

`orchestrator_plan_replan` and `orchestrator_plan_requirements` are also Hub-only. Technical recovery does not confer product authority, and requirement changes require a direct Harness approval after preview. Workers can read their own `ticket/<id>/plan-scope`, not the Plan's approvals or graph history. See `018-plan-replanning.md`.

The Hub alone owns `orchestrator_queue_merge`; it requests the checked, durable operation in [Merging](003-execution.md#merging), not a general Git command. Worker and planning tools cannot start it.

## Hub Session rotation

The project Hub identity remains stable while its physical DSH Session may rotate. `HubAuthority` persists a monotonic physical generation and a `rotating` intent in the project Store. `Runtime.rotateHub()` first fences the old generation, waits for registered Hub operations and the old turn to settle, creates a deterministic explicit-ID target Session, then activates it. A restart adopts the same target instead of creating another Session.

Relay and notice effects address the logical Hub, not a physical Session. They remain queued while no generation is active. `AgentDelivery` records a durable receipt after the target Session's persistence flush and scans prior Hub generations before retrying, so a crash after delivery does not replay the same request. Pending inbox messages move to the new Session at the quiescent point; durable project state, not a transcript copy, is the continuation summary.

Retired Hub generations remain readable and metered as historical Sessions, but `agent/pre-step`, tool registration and the Hub operation lease reject their model turns and coordination tools. Worker and Plan recovery effects use their existing durable claims and do not require a live Hub generation.
The resume input is a bounded JSON summary after the fixed `hub-resume` preface. It contains `hub_id`, positive `epoch`, nullable `project`, `tickets`, `handoffs`, `pending_events`, `actions`, `pending_effects`, their total counts, `truncated` flags, and `reads`. Ticket, handoff, event and effect entries carry `read` pointers (`ticket/<id>`, `handoff/<id>`, or `ticket/<id>/input/<key>`); an empty collection is `[]`, an absent report/result is `null`, and `project` is `null` before project binding. At most 64 tickets, 32 handoffs, 128 pending events and 64 effects are embedded; text fields are capped at 2,000 characters and handoff lists at 16 items. Counts and `truncated` identify omitted records; the Hub reads the named resources for full evidence.

## Worker Session

An Executor Session is created with `WORKER_PRESET` (`dsh-superagent-worker`) and keeps the file, search, shell, job, web, skill, todo and subagent tools listed in `WORK_TOOLS` (`src/app/sessions.ts`). `Sessions.workOnly` adds only the MCP tools named in `DEV_MCP_TOOLS`, the read-only Context7 lookups `mcp__context7__resolve-library-id` and `mcp__context7__query-docs`. No other MCP server is allowed: a mounted tool such as `mcp__feishu__send_message` is not in the allow list, so a Worker cannot send a person a message through MCP. The preset also keeps the shell's network access: a worker installs dependencies and reaches the Context7 service its MCP tools use. It works in its Ticket directory and may create subagents, which run under DeepSeek Harness's `standard` preset with the worker's permissions. It receives no tool for asking or presenting to a person, changing the deployment profile, scheduling work outside the worker slots, or sending a Channel message.

### Independent review subagents

Workers use two separate code-review subagent Sessions for the `standards` and `spec` lanes; each receives the same pinned base/candidate pair and its own evidence sources. The initial delegated task binds axis, base, candidate and lease generation; the real child must load the packaged review Skill before its session receives `orchestrator_review_submit`. Only that reviewer submits its own conclusion; the Worker cannot self-sign either lane. Review evidence is not a Hub reply. Both lanes must pass for the same current generation before readiness.
Marked review children lose direct file-write/edit/patch, job-management, delegation and message tools; their shell remains for Git inspection. This is a cooperative guardrail, not an OS sandbox. Submission rechecks the full candidate SHA and clean worktree; the Hub resource returns pending unless evidence matches the live Worker lease generation. Ordinary Worker descendants keep their existing work tools.

Before the first model request, the host binds a proven native review child to its Worker's Ticket and registers the packaged Skill in the child's scoped skill service. Model calls charge that Ticket and the project before the child can submit any evidence. Loading the Skill is still required to expose the submission tool.

Only the active parent Worker can record retro, acceptance, repair, test and document observations for its own candidate; the Hub and reviewers cannot write them. The Delivery-check section in `013-development-verification.md` defines the status and evidence fields.

### Internal take-up

`orchestrator_ack` takes `{ trigger_id }` and records that the Worker takes up a person's request. It calls the Engine's atomic `takeUp(ticketId, triggerId)`, which returns `{ ticketId, triggerId, reused }` and only appends the Ticket id to the Trigger's disposition `acked` list; it never queues, sends or refreshes an outbox message. The tool returns `{ trigger_id, taken_up: true, reused }`, where `reused` is true when this Ticket had already recorded the take-up. The request must be a person's message that reached a live Ticket on a writable Thread: an ended Ticket is `ackEnded`, an unknown Ticket or Trigger is `unknownTicket` or `unknownTrigger`, another Ticket's message or a context-only Thread is `notReached`, and a bot, CI or worker message is `ackNotPerson`. Repeating the call is idempotent.

Acceptance is different from Worker take-up: when a Ticket is created with an acknowledgement, `Tickets.create` calls `Replies.acknowledgeAccepted` to queue it for the original human Trigger's Channel. This host-side confirmation does not come from `orchestrator_ack`; taking up the request later neither queues nor refreshes it.

### Reports and questions

`orchestrator_report` records progress, `ready`, `blocked`, `failed` or `dropped` and an optional `human_action` question. A Plan Worker's question is an internal proposal, not an operator request; only the Hub can confirm it as a missing product decision. A report with `reply_to_trigger_id` that the Engine accepts as an answer to a reached human question still relays as `worker_report` with `answer_to`. Review evidence alone is not a proactive receipt. Non-Plan reports retain the legacy relay policy. The Hub owns `orchestrator_reply` (`answer`, `result` or `attention`) for Channel sends; host-side acceptance acknowledgement has a separate outbox path.

Only the current root Worker of a Plan Ticket has `orchestrator_credential_blocked`. It registers a blocker with an identifier, not a secret, and routes the operator action to the Hub. No Session tool verifies the account; verification is a scoped management operation. The Hub's `project/attention` and `plan/<id>/attention` reads are not Worker or planner resources. See `015-scoped-attention.md` for the role, replay and management contracts.

### Direct Harness answers to Plan Workers

Plan product questions and addressed answers stay in Harness; see the question and answer contract in `015-scoped-attention.md`. The Hub does not use `orchestrator_reply` or guess a Channel destination for them.

`orchestrator_plan_answer` is Hub-only. Its strict input is `{"ticket_id":"<ticket id>","question_id":"<attention id>","answer":"<verbatim answer>"}`: all three fields are required, nonblank strings and no extra fields are accepted. The latest direct `user/message` in the Hub must itself be that JSON object, with all three decoded strings equal to the tool arguments. JSON whitespace and key order do not matter; plain text, code fences, paraphrases, source relays and earlier direct messages are not proof. The Hub cannot construct an answer on the user's behalf.

Success returns `{ticket_id, question_id, input_id}`. The Engine requires a live Plan Ticket with that exact current attention ID; unknown, ended, non-Plan, replaced, cross-Ticket or already answered questions are refused. It atomically clears the attention and queues one `kind: 'text'` input with the answer unchanged. The durable ID binds the Ticket, question and direct Hub session event, so retry or restart does not create a second copy. The Worker receives the answer through normal input delivery (oversized text is readable in full at the supplied input resource). No mandate, dependency, credential or delivery status is changed by the answer. If credential verification is pending, the answer is recorded but not delivered until trusted verification resumes the Ticket.

### CLI guard

Worker shells run as the deployment's GitHub account and Feishu bot. Setup writes shims first on `PATH` in `<stateDir>/worker-bin`: `gh` runs the agent's CLI, `lark-cli` runs the bot's CLI, and a command named in the Execution settings' `blockedCommands` fails; `gh`, `git` and `lark-cli` cannot be blocked. A shim removes its own directory from `PATH` and runs the real program, so a wrapper that execs `gh` or `lark-cli` by name still reaches the deployment's account. On every platform the shims are the extensionless `gh` and `lark-cli` scripts and one `send-guard.mjs` holding the refusal policy; Windows also writes `gh.cmd` and `lark-cli.cmd`, and a `.cmd` for each blocked command, so cmd and PowerShell resolve them by name.

The `gh` and `lark-cli` shims refuse the following alternate merge commands and human-facing sends by name before the CLI runs:

| CLI | Refused by name |
| --- | --- |
| `gh` | `pr merge` and REST or GraphQL merge/auto-merge/merge-queue writes; `issue comment`, `pr comment` and `pr review`; `pr close`, `pr reopen`, `issue close` or `issue reopen` when passed `-c`/`--comment`; writes to `/comments`, `/reviews` or `/replies`, and GraphQL comment and review submissions |
| `lark-cli` | every `+messages-*` shortcut except the message reads (`+messages-mget`, `+messages-search`, `+messages-read-status`, `+messages-resources-download`); `im messages` and `im messages.<operation>` except read operations; `im threads forward`; `api` with a method other than `GET`, or a body and no explicit method |

Reads and other supported non-comment work still run: `gh` reads, `gh pr create`, `gh pr`/`gh issue close` and `reopen` without a comment option, non-comment API writes such as resolving a review thread, `lark-cli` message reads, and its read-only API calls. The plugin's own `Commands` run the configured CLIs by absolute path, so the Hub's `orchestrator_reply` and the other Channel messages still send.

For `gh api`, `-f`/`--raw-field`, `-F`/`--field`, and `--input` are ordinary supported CLI parameters. Short field and method (`-X`) flags accept separate or compact values; long flags accept separate or `--flag=value` values. Fields and input bodies default the request to `POST`; an explicit `-X GET`/`--method GET` still permits a read. On `graphql`, the guard checks the query supplied inline, from typed `query=@file` or `query=@-`, or in a JSON `--input file`/`--input -` body before running the real CLI. It resolves filenames in the caller's working directory and forwards inspected standard input byte-for-byte. If it cannot inspect a prospective GraphQL write, it refuses without printing the input. Read queries, other mutations such as `resolveReviewThread`, and non-comment API writes continue to run; passing a query in a file or standard input is not a bypass of the by-name guard.

These refusals cover calls made by name. A worker that runs the real CLI by absolute path, posts over HTTP, or uses another identity's credentials is outside the shims and outside this contract; the prompts forbid it, and the refusal is cooperative rather than enforced. The same limit covers a process the Worker starts in its shell: it is outside the tool and message boundary.

## Ticket end

Every Worker Session and every subagent below it, at any depth, is restricted to the worker's work tools, `DEV_MCP_TOOLS` and a guard on each call. `Sessions.owningTicket(agent)` climbs `session.header.parentSession` without a depth limit, detects cycles, and falls back to `ctx.sessionController.inspect(parent).meta.parentSession` for an ancestor that is not loaded; when `Sessions.install` or agent decoration sees a child Session whose `parentSession` ancestry is not yet resolved, `Sessions.limitSubagent` fails closed by installing a temporary tool guard first so no tool runs during async `inspect`. If `inspect` rejects, that failure does not prove non-ownership: the error propagates and the temporary guard stays in place until the Session is released or rebound. Only when the full ancestor chain is verified to have no Worker ancestor does `limitSubagent` revoke the temporary guard without affecting an unrelated Session; otherwise it swaps the temporary guard for `workOnly(agent, ticketId)` (restricting the Session to `WORK_TOOLS` and `DEV_MCP_TOOLS` and adding the ended-Ticket guard). The guard reads the Ticket from the Store on every call and refuses every work tool once `liveTicket` is false, with `Ticket ended; new work needs a new authorized ticket`. The check therefore covers a subagent created before or after the Ticket ended and one reloaded afterwards. Ending a Ticket also cancels a worker turn that is still working through the host's cooperative cancel, and on Ticket close or hand-off `stopSubagents` (`src/executor/background.ts`) first kills and collects tracked jobs by Session id across all non-`external` descendants in the persistent catalog (`listChildren`), then calls `drainChildren` so the SDK recursively releases its resident managed subtree, and finally stops (`Agent.cancel` and `whenIdle`) any descendant still loaded after `drainChildren`—covering independently restored live grandchildren whose intermediate parent was unloaded—so neither tracked jobs nor live descendant turns can keep writing to the repository after close.

That cancellation ends the Session's turn and its tracked work, not every process the turn may have started. A process that detached from the job registry, or one started outside the deployment's tool and shim tracking, is not promised to stop; the guard stops the normal tool path from writing after the end, and a deliberate escape is outside it.

A Session is protected only when its ancestry reaches a `worker-<ticketId>` Session; an unrelated Session keeps the preset it was created with. The runtime cannot infer a Ticket for a Session with no Worker ancestor, so the boundary does not claim to limit an arbitrary Session outside the deployment's execution tree.

The Hub may still read an ended Ticket's reports and results through `orchestrator_read` (`ticket/<id>`, `/result`, `/report/<assignment id>`) and the management HTTP reads; the end of a Ticket removes Worker write access, not Hub or management read access.

A PR closure or merge observed during a credential pause is still recorded on the followed Thread, but it does not end the Ticket, complete its Plan node, or release successors. A restart does not lift the pause. A human STOP still ends the paused Ticket.

## Acceptance

The agreed contract for this boundary:

- The Hub coordinates and inspects through its own tools: it has no shell, job or file-write tool, its inherited surface is restricted to `HUB_TOOLS`, and external Channel replies use `orchestrator_reply`; host-side acceptance acknowledgement separately queues an outbox message. Channel-less Plan questions and their explicitly addressed answers stay in Harness.
- A Worker takes a person's request up internally (`orchestrator_ack`), reports internally, and has no Channel send path; the `gh` and `lark-cli` shims refuse the by-name CLI sends that the CLI guard lists.
- When a Ticket ends, every work tool refuses further calls at any depth (failing closed while a reloaded child resolves its `parentSession` ancestry, and staying guarded if `inspect` fails rather than proving non-ownership), and the Executor cancels the turn, kills and collects tracked jobs across all non-`external` descendants before `drainChildren`, and cancels any descendant Session still loaded afterward.
- Normal development keeps its network, dependency installs, `web_search` and the two read-only Context7 MCP tools in `DEV_MCP_TOOLS`; no other MCP tool is allowed.
- Not covered: escape through absolute paths, raw HTTP or substitute credentials; a container, network or OS-user isolation; stopping a process that left the job and shim tracking.

## Code and tests

| Entry | Role |
| --- | --- |
| `plugin/cordis.patch.yml` | Defines `dsh-superagent-worker` and the read-only `dsh-superagent-router` preset rows |
| `plugin/src/app/sessions.ts` | `ROUTER_PRESET`, `WORKER_PRESET`, `HUB_TOOLS`, `WORK_TOOLS`, `DEV_MCP_TOOLS`, `Sessions.decorate`, `Sessions.workOnly`, `Sessions.owningTicket` and `Sessions.limitSubagent` (role restrictions and Worker/descendant guards) |
| `plugin/src/app/hub-authority.ts` | Durable logical Hub identity, physical generation fence, deterministic rotation target and restart-safe resume marker |
| `plugin/src/app/delivery.ts` | Cross-generation delivery history and durable flush receipt used by Hub relay/notice retries |
| `plugin/src/app/runtime.ts` | `Runtime.rotateHub()`, project-fact continuation summary, authority activation and historical Hub shutdown |
| `plugin/tests/hub-rotation.spec.ts` | Public Runtime rotation seam: pending direct input transfer, stale old-tool refusal, stable Worker Assignment and restart adoption |
| `plugin/src/executor/background.ts` | `stopSubagents` and `stopBackground`: Worker and descendant tracked-job shutdown and subagent release on Ticket close and hand-off |
| `plugin/src/app/tools/main.ts` | The Hub's coordination, inspection and evaluation tools |
| `plugin/src/app/plan-dispatch.ts` | Hub-only Frontier selection, slot reservation, durable Plan Ticket claims and restart rearming |
| `plugin/src/app/tools/executor.ts` | Worker read, take-up, report, Thread and hand-back tools, plus candidate evidence in `011-doc-tree-impact.md` and `013-development-verification.md` |
| `plugin/src/core/replies.ts` | `Replies.takeUpInternally` records a Worker's take-up without sending; `Replies.acknowledgeAccepted` queues the host's accepted-Ticket acknowledgement for a human Trigger |
| `plugin/src/core/engine.ts` | Atomic take-up, Channel reply, Plan question answer and verified credential continuation commands |
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
