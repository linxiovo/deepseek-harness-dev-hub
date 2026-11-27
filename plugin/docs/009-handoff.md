# 009 Handoff

This document follows a confirmed Harness handoff from the conversation to a published specification and registered Plan DAG. It builds on [001 Domain model](001-domain.md), [003 Execution](003-execution.md), [004 Prompts](004-prompts.md) and [007 Architecture](007-architecture.md).

A handoff carries a project, goal, constraints, acceptance scope and authorization; it is neither a Source Trigger nor a Ticket. A person confirms the initial product brief in the Hub's Harness conversation and a read-only planner writes the specification. After delivery, a matching maintenance rule can authorize a separate brief and specification without a human confirmation; see Stage 2 below. The Hub does not modify the repository.

## Records

| Record | Fields | Rules |
| --- | --- | --- |
| Project | `id`, `repository`, `workspace` | `workspace` is resolved to an absolute path. `id` derives from the repository and that path, so one checkout keeps one identity |
| Handoff | `id`, `project`, `goal`, `constraints`, `acceptanceScope`, `authorization {scope, release, releaseTarget?}`, `confirmedBy` or `maintenance`, `status`, `question?`, `spec?` | The brief is written once. Direct confirmation binds one user message to one brief; a project has at most one handoff that is not `specified`. Maintenance records the intake event and matching rules instead and grants no release authority. `releaseTarget {environment, target, scope}` is required when `release: authorized`; older records without it cannot publish. |
| Question | `id`, `text`, `why`, `affectedAcceptance`, `status`, `answer?`, `answeredBy?` | At most one per handoff. Its status is `awaiting` or `answered`; every affected item belongs to `acceptanceScope`. Feishu answers retain the sender's open ID and the originating Trigger ID. |
| Spec | `id`, `handoffId`, `revision`, `body`, `acceptance`, `testInterfaces`, `outOfScope` | Stored once with revision `1`; never updated in place. `outOfScope` is required and may be empty: `[]` explicitly means there are no confirmed exclusions, while every entry is an actual excluded item; the field is neither omitted nor filled with invented items |

Statuses:

| Status | Meaning | Moves to |
| --- | --- | --- |
| `confirmed` | The brief is stored; the planner has not started | `planning`, by `begin` |
| `planning` | The planner may read, ask or publish | `awaiting`, by its one question; `specified`, by publication |
| `awaiting` | One question waits for a person | `planning`, by the answer |
| `specified` | The immutable specification is published and a separate Plan DAG can be registered | Terminal for the handoff |

`Handoffs` (`src/app/handoffs.ts`) is the only writer; record types are in `src/core/handoff.ts`. Store `kv` families in `src/kv.ts` hold projects, each project's current handoff, immutable handoff records and specifications, and `handoff-confirmation:<session/message>` receipts binding a direct user event to one brief. Commands use `Store.atomic`; equal normalized briefs have equal `key` ids. The flow needs no schema migration.

| Method | Does |
| --- | --- |
| `confirm(input)` | Stores the project and brief once and returns `{handoff, reused}` |
| `get(id)`, `list()` | Reads one full handoff, or every full handoff; a published record stays readable after a later one becomes current |
| `isPlanning(id)` | Whether the stored status is exactly `planning`; missing or malformed state fails closed |
| `begin(id)` | Moves `confirmed` to `planning`; any other status is returned unchanged, so a resumed delivery cannot overwrite `awaiting` or `specified` |
| `question(id, input)` | Stores the single question and moves the handoff to `awaiting` |
| `answer(id, questionId, answer)` | Records the first answer, or the same answer again; moves the handoff to `planning` and enqueues a planning effect |
| `publish(id, input)` | Stores the immutable specification, moves the handoff to `specified` and enqueues splitting |
| `spec(id)` | Reads the published specification |

## Confirmation

After grill-with-docs or wayfinder aligns a request, the Hub shows its complete project, goal, constraints, acceptance scope and authorization in the Harness conversation and asks the requester to approve those exact fields in one direct message. The message is exactly a JSON object `{"confirmed": true, "brief": {...}}` with no extra keys. Its brief has `project {repository, workspace}`, `goal`, `constraints`, `acceptanceScope`, and `authorization {scope, release}`; when `release` is `authorized`, authorization also requires `releaseTarget {environment, target, scope}`. This confirmation is the only release authorization. A credential, quota change or repair scope is not release authorization.

`orchestrator_handoff_confirm` is a main Session tool. It takes the same five fields separately plus `confirmation`, the verbatim latest direct Hub user message. Only the current Hub Session may call it; `confirmation` must equal the latest direct user message exactly, and that message must be an explicit approval rather than a task, quoted content, a relay or silence. The tool parses the message as that JSON approval object and requires `confirmed: true` and the complete brief with no extra keys, so a bare yes cannot authorize an independently supplied scope. For authorized release, the exact environment, target and scope must match in the direct approval and tool arguments. It compares every parsed field and refuses a mismatch. Refusal messages come from `prompts/handoff-errors.md`; no such text is hardcoded in the tool.

The tool then persists the parsed approved fields, not independently supplied values, and records `confirmedBy {sessionId, messageId, text}` from the current Hub Session and latest direct user message. `Handoffs.confirm` derives the project and handoff ids from the normalized approved brief. A confirmation receipt binds that user message to its brief and prevents it from authorizing a different brief even after publication. Replaying the same brief returns `reused: true` without re-enqueuing; a different brief while the current handoff is active is refused. A later brief needs a new direct JSON confirmation, and earlier records stay readable.

The same transaction enqueues the durable `planning` effect, keyed by the handoff id with payload `{handoffId}`.

## Planning, question and publication

A planner Session is named `planner-<handoff id>`, runs in the handoff's project workspace and uses the `dsh-superagent-planner` preset. Its prompt is `runtime/planner` and its only skill is the bundled `dsh-superagent-to-spec`. The Session is read-only: it may read files, images, search results and skills, but it has no write or edit, shell or job, subagent, acknowledgement, report or user-message tool.

Its host tools are limited to the same handoff:

| Tool | Does |
| --- | --- |
| `orchestrator_read` | Reads only `handoff/<its id>` or `spec/<its id>` |
| `orchestrator_spec_question` | Atomically stores the single product-intent question and queues a Hub conversation relay |
| `orchestrator_spec_publish` | Atomically publishes the specification and queues a Hub conversation relay and the splitter task |

`orchestrator_spec_question` requires `handoffId`, `text`, `why` and `affectedAcceptance[]`. The handoff must be `planning` and have no earlier question, and each affected criterion must already be in `acceptanceScope`. The tool refuses known technical-boundary and file-organization formulations; the planner prompt forbids those questions altogether. The question becomes `awaiting`, and the planner stops until an answer resumes it.

The same state transaction queues a relay to the Hub naming the project, question, reason and affected acceptance. Its text comes from `prompts/handoff-relay.md`; publication uses the same template. A Harness answer via `orchestrator_handoff_answer` (`handoffId`, `questionId`, `answer`) must equal the latest direct user's answer. The [optional Feishu entry](#optional-feishu-entry) verifies answers at the Source instead. Both paths use `Handoffs.answer`: it accepts the matching first answer, repeats that answer idempotently and rejects a changed answer or unknown question. The first answer resumes `planning` and enqueues a planning effect for the same Session.

`orchestrator_spec_publish` requires `handoffId`, a non-empty `body`, observable `acceptance` entries, at least one selected public `testInterfaces` entry of kind `existing` or `proposed`, and a required `outOfScope` list. `outOfScope: []` is accepted only as the explicit statement that there are no confirmed exclusions; each non-empty entry names an actual excluded item, and a caller neither omits the field nor fabricates entries. Only a `planning` handoff may publish. The immutable revision `1` and `specified` status are stored together with a Hub relay containing the `spec/<id>` read resource; the requester sees that result in Harness without IM. A second publication is refused.

Each acceptance entry includes `delivery: backend | frontend | cross-end`, decided during specification planning and immutable after publication. A spec published without those classifications remains readable (`unclassified-spec` in the plan read) but cannot start splitting; the host does not guess execution roles for it.

## Reads

The main Session reads the flow with `orchestrator_read`:

| Resource | Returns |
| --- | --- |
| `handoff/<id>` | The whole handoff record: project, brief, authorization provenance, status, question and answer |
| `spec/<id>` | The published specification, or `{handoffId, status: 'pending'}` before publication |
| `plan/<id>` | The Plan DAG with roles, acceptance references, blocked-by edges, role totals and delivered counts, plus root background. `offset` and `limit` page the nodes and background in parallel. Before registration the status is `awaiting-spec`, `pending`, or `unclassified-spec` |
| `plan/<id>/node/<node-id>` | One registered Slice Ticket with a page of its addressed instructions, without root background or other nodes' instructions |

These are main-Session resources, so a Worker Session is refused. A planner's own `orchestrator_read` accepts only its two matching resources while its handoff is `planning`.

## Durable planning

`Planning` (`src/app/planning.ts`) handles the `planning` effect. It ignores `awaiting` and `specified` handoffs, rejects a payload whose id differs from its key, and defers while processing is paused or the Runtime is stopping. For a `confirmed` handoff it calls `begin` before creating the Session.

It ensures `planner-<id>` in `project.workspace` and sends the full persisted brief (handoff id, project, goal, constraints, acceptance scope, authorization and confirming message) with the unattended to-spec task under request id `handoff:<id>:task`. When the handoff has an answered question, it also sends that question and answer under `handoff:<id>:answer:<question id>`. The first delivery's task text is `prompts/planner-task.md`; the answer delivery's task text is `prompts/planner-resume.md`. Both are built-in prompt files loaded through `promptFile`, so the code carries no inline prompt copy. The stable request ids let `AgentDelivery` deliver each of these at most once across retries and restarts, and the same Session is reused.

At startup, before effects and passes start, `Planning.resume` enqueues planning for stored handoffs in `confirmed` or `planning`. A missing or disposed Session is retried through `Later`. Shutdown cancels planning Sessions, including ones created while stopping.

## Plan handoff change map

For a published spec, follow this implementation path: **specification publication** (`orchestrator_spec_publish`) → the durable `Planning` **splitting effect** → a scoped splitter Session and its tools (`orchestrator_read`, `orchestrator_plan_register`) → the validated `Plans` registry → Hub `orchestrator_read` resources `plan/<handoff-id>` and `plan/<handoff-id>/node/<node-id>` → **no Worker**: registration creates no executable Ticket, Assignment, Worker Session or worktree. Session tool and preset boundaries are enforced in `plugin/docs/010-session-boundaries.md`; simulated-host coverage is in `tests/plans.spec.ts`.

## Automatic Plan registration

Publication also persists a `splitting` effect for the exact handoff and spec. The effect starts `splitter-<handoff id>` in the handoff workspace with the read-only planning preset and sends `prompts/splitter-task.md`, the two IDs and scoped resource pointers under `handoff:<id>:plan:<specId>`. The splitter loads `dsh-superagent-to-tickets`, reads only that handoff and its immutable spec, and calls `orchestrator_plan_register`. Stable delivery IDs prevent duplicate queue deliveries on restart. The Hub does not read or write the draft to continue the pipeline, and no user approval is needed.

The effect remains parked after a successful prompt until registration cancels it in the same transaction as the Plan write. On restart the host rearms only persisted splitting intents, checks for the last message in the Session history or inbox, and either delivers it once or steers an idle splitter with a new, persisted continuation ID. No continuation is enqueued for a registered Plan. An idle unfinished turn is not retried in a loop on the same Runtime.

The registration takes `handoffId`, `specId`, `features[]` and `nodes[]`. A feature declares its `id` and `kind` (`backend`, `frontend`, `cross-end`); its nodes hold stable `id`, `featureId`, `title`, one execution `role`, one-based `acceptance` indices into the spec, a `demonstration` and explicit `blockedBy` IDs. A cross-end feature needs one backend node with a repository-relative `interfaceContract {path, requirements}` deliverable and one frontend node explicitly blocked by it. A single-end feature gets one matching node. The splitter judges fit to the prose and the demonstrations; the registry validates the submitted roles, graph and acceptance coverage before writing. An identical replay reuses the registered graph; malformed submissions and attempts to replace it do not mutate the old graph.
Every backend predecessor explicitly referenced by a frontend node needs an interface contract, including when the two nodes belong to different features.
The registry compares each acceptance reference with its immutable delivery classification. A `cross-end` criterion must be referenced by both an interface-contract backend node and a frontend node explicitly blocked by that node, even if the draft labels the feature as single-end. Role labels in a draft cannot weaken a specification.

Only `blockedBy` creates an edge. Before dispatch, a node without predecessors is `waiting-for-slot` and a node with predecessors is `blocked` with `waiting_for: predecessors`; registration creates no executable Ticket, Worker Session, Assignment or worktree. `stats` reports registered and formally delivered counts separately for `backend` and `frontend`; no node is delivered at registration.

For an already registered plan, `orchestrator_plan_context` takes the verbatim latest direct Hub user message as `message`. That message is JSON with `planId`, `target: {"kind":"background"}` or `target: {"kind":"node","nodeId":"…"}`, and `text`. The tool parses the plan and target from the message itself, records the event once, and stores root background separately from the addressed node's instructions. Neither record, message visibility nor Thread subscription creates authorization, alters the graph, or starts work.

## Frontier dispatch and claims

The Hub starts one node with `orchestrator_plan_dispatch {planId, nodeId}`. The registered node role is authoritative; callers cannot supply a role or dispatch an unregistered Plan. A node enters the Frontier only when every `blockedBy` node has a persisted formal delivery receipt. A Worker report, PR close or delivery-check package (`013-development-verification.md`) cannot issue that receipt or unlock a successor. No Session tool writes formal delivery.

The dispatch transaction reserves the existing `DshExecutor` launch slot synchronously, creates one stable Plan Ticket/Assignment, and writes the node claim before the launch effect can run. The claim records `planId`, `nodeId`, `ticketId`, `assignmentId`, Worker Session, execution role, and `pendingAction`. Same-node replays return that claim; a competing request that cannot reserve the last slot returns `waiting-for-slot` without a second claim. The Plan read and Ticket detail expose these facts before a Session or directory exists. The Ticket uses the normal verified worktree and single-writer checks; an ordinary directory or chat message is never a lock.

`plan/<id>` and `plan/<id>/node/<node-id>` join the immutable graph with the durable node state: `claimed`, `running`, `awaiting-delivery`, `delivered`, `failed` or `stopped`. The `delivery` receipt names the Ticket, delivering Assignment and generation, reviewed base and candidate, intent ID (`receiptId`), integration SHA, and actual tip observed at `verifiedAt`. A blocked node lists the remaining predecessors under `waiting_on`; after each formally closes, its receipt is readable on that predecessor. See [formal Plan closure](003-execution.md#formal-plan-closure).

`plan/<id>/delivery` is the Plan-level result after formal node receipts. It is separate from each node's `delivery` receipt and does not change Frontier state; details are in `017-plan-integration.md`.

On restart, the dispatcher rearms the same pending Assignment and the Executor adopts a persisted Plan writer claim without issuing a new generation. Stable `assignment:<ticket>` delivery IDs prevent a second Worker message; a missing start receipt is completed when the existing Session is found and the Assignment start is recorded.

`awaiting-delivery` is not delivery. A ready report can put an open Plan Ticket in that state without ending it; a baseline repair returns it to running until the Worker reports ready again. A verified mainline result also waits for the separate formal receipt.

A credential pause keeps the claim and does not add a node status. `plan/<id>/node/<node-id>` and a dispatch replay include `attention` only while the claimed Ticket has a current credential blocker. The Hub can read `plan/<id>/attention` for the Plan summary. Verifying the credential resumes the existing Assignment; it is not a formal delivery receipt and does not unlock a successor. See `015-scoped-attention.md`.

Budget admission can also pause or defer dispatch without issuing a formal delivery receipt. See `016-run-limits.md` for the refusal and replay contract.

An active Plan can publish a revised graph and acceptance view without overwriting its original registration; see `018-plan-replanning.md`. Only the current graph contributes required work and Frontier nodes. A superseded claim and its evidence stay readable.

## Pause and resume execution

The confirming project's current Hub accepts an explicit direct Harness operator message. A Ticket hold pauses the named claim and blocks the first Assignment message for any descendant that has yet to start. A branch hold also pauses descendants that have already started. A whole-Plan hold covers all nodes. Descendants still require formal predecessor delivery. Independent nodes remain eligible.

| Scope | Example pause command | Example resume command |
| --- | --- | --- |
| Ticket | `暂停工单 <ticketId>` | `恢复工单 <ticketId>` |
| Branch | `暂停计划 <planId> 的分支 <nodeId>` | `恢复计划 <planId> 的分支 <nodeId>` |
| Plan | `暂停整个计划 <planId>` | `恢复整个计划 <planId>` |

An ambiguous direct command returns `needs-target` without creating a hold or a receipt. The Hub asks for the exact scope using the examples above or the JSON `orchestrator_plan_control` arguments. A direct event authorizes one exact command. Holds survive restart, overlap independently and carry over to replacement nodes in a requirement revision. See `018-plan-replanning.md`.

Read `plan/<id>/control` or call `orchestrator_plan_control` with `{action: 'status', planId}`. `stop-requested` means an in-flight action still needs confirmation, `stopped` means the action was prevented or the Worker drained, and `already-happened` identifies a completed dispatch, observed Git write or actual deployment. Deployment remains visible after pause. Clear the same named hold to resume. The runtime checks the remaining scope, credentials, predecessors and run limits before rearming the same Assignment. Read the Plan Frontier for newly eligible dispatches and `plan/<id>/delivery` for release prerequisites. The simulated Harness scenarios are in `tests/plans.spec.ts`.

A failed Worker drain keeps its writer fenced. The durable resume task retries the drain against the current Worker and its descendants. Repeating the exact resume command can rearm a pending retry without clearing another hold.

The read resource pages `actions` with `offset`, `limit` and `next_offset`. Keep the returned Plan ID and operation IDs when reporting a stop.

## Optional Feishu entry

A selected, registered project can use one Feishu private chat or group topic as a second entrance. This does not create a second Hub or change a Worker's tools. Harness confirmation, questions, and specification reads do not require a binding.

Use the existing loopback management API under `/orchestrator/api/`, with `x-orchestrator-request: 1` and `x-orchestrator-project-id` set to the selected project ID. `POST topic-binding` accepts `{ "triggerId": "…", "allowedActors": ["ou_…"] }`. Select a message observed by the project's Feishu Source, not a caller-supplied chat address. The operator grants those open IDs permission to answer product questions in that destination; group membership and the Source admission list do not confer that permission. `GET topic-binding` reads the binding; `POST topic-binding/unbind` removes it. Unbind before changing destination or participants.

The Hub sends a binding confirmation once. Question and result notices link back to the selected project; they do not copy conversation history, answers or specification text into a group. To answer a pending product question, use the reply format in its notice. The Hub verifies the question reference and the sender reported by Feishu before recording an answer on the same handoff that Harness reads. Plain assent such as `同意` is not an approval. Configuration proposals use the separate, versioned authorization flow in `019-confirmed-settings.md`; Hub summaries and question-answer authority do not grant that approval. Settings links open Harness; they do not apply a change by themselves.

An allowed participant can send `status` or `状态` for a text summary of the current handoff. An answer uses `answer <code>: <answer>` with the 24-character code from the current question's notice. The reply format stays reserved even when the code is stale. A forwarded link or code is not a grant. Harness links open on the Harness machine or through an authorized tunnel. If another project is active, the link asks the operator to select the named project.

## Stage 2 maintenance

`orchestrator_read` on `project/stage` returns `{stage: 1}` until the mounted project has a fully delivered Plan. The first complete artifact-only or verified-release delivery persists `{stage: 2, deliveredPlan, startedAt}` with its final receipt. A restart can adopt a retained, verified delivery from an older store. This is a project milestone, not a claim that the original package remains available forever; its current availability is on `plan/<id>/delivery`. Later work uses the same Hub and separate Plans. There is no idle repository scan or timer that creates maintenance work.

Stage 2 keeps new Source work out of ordinary Ticket routing, including attach, replay and automatic wake-up. Selected-repository pull request reviews and CI may still reach existing open Tickets as context; that delivery cannot launch a Worker. The Hub considers only fresh, original text from an authorized entrance:

| Entrance | Required authority |
| --- | --- |
| Harness | A fresh single-text direct operator message. Native inputs are recorded before adjudication; cold recovery of unrecorded messages requires unchanged authorization since arrival. During rotation the host records native inbox evidence, not the carried relay. |
| GitHub | A new issue or conversation comment in the selected repository, an enabled receive-all scope, a listed human account and a row that admits unaddressed messages. A later edit to a pre-delivery comment does not make it eligible. |
| Feishu | The exact current private chat or group root, matching bot and binding epoch, a listed human who is also an allowed binding participant, and an enabled Source scope. A group must receive all messages; direct chat must be enabled. Partial live events await their record in the exact-bound history; an unresolved admitted message pins the cursor for up to 14 days. Native replies with a direct parent, forwards, quoted text, system and join events convey no work. |

`off` disables intake; `observe` permits assessment without registration; `auto` permits registration after an enabled rule matches. A pending event binds its intake Policy version, Source settings revision and Feishu binding epoch where applicable. The host rechecks authorization and the mounted repository before registering work. Stage 2 settings and manual Source policy sync are operator operations; explicitly configured automatic Source sync still runs. Reading a chat, joining it, being in an allowlist, mentions and existing Ticket subscriptions never confer topic authority. Stage 1 and legacy installations retain their ordinary Source intake.

The Hub receives `maintenance-candidate` with `event_id` and a `maintenance/<id>` resource. That read gives the author's text, actor and time, the final decision, or `withdrawn`. `maintenance` lists authorized pending references with `offset`, `limit` and `next_offset`. A restart sends one grouped recovery relay for undecided events, even when a candidate relay is already in the Hub history. `orchestrator_maintenance {event_id?, verdict}` takes `ignore` with `reason`, `checked` with `reason`, `existing` with `ticketId`, or `plan` with `scope`, `direction`, `spec` and `draft`. All except `ignore` also require `intentEvidence` and `ruleAssessments`. Omit `event_id` only for the current direct Harness message. `existing` records a reference without delivering a message or waking a Worker.

The host requires a verbatim excerpt from the author, one assessment per enabled rule and at least one match before recording a positive verdict. A `plan` also needs a settled implementation request. Semantic classification belongs to the Hub; the host enforces identity, mode, rule IDs and Plan structure. A new Plan contains one feature: a single node for single-end work or a backend contract and dependent frontend node for cross-end work. Registration and the event receipt are atomic. Dispatch still uses the normal Frontier, worktree, budget, review and delivery gates.

Replaying an adjudicated native event returns its original result. Edits of the same GitHub comment and matching text in the same source conversation (ignoring surrounding whitespace and CRLF) associate to already registered work. Different issues, chats and entrances are not automatically deduplicated against each other. For paraphrases and cross-entrance feedback, the Hub identifies matching work and uses `existing`. Association leaves the Ticket, Plan and delivery evidence unchanged.

## Tests

`tests/handoff.spec.ts` drives a running Runtime through public Hub and planner tools. In GitHub-only projects it covers a confirmed brief surviving restart with one delivered planner task, an observable specification with a selected public test interface, one missing product-intent question with the exact direct user answer delivered once to the same planner, and a completed-spec relay to the Hub. It rejects bare assent, a Hub tool brief that differs from the direct JSON approval, old confirmations reused for changed briefs, invented answers, incomplete specifications, technical or repeated questions, and non-planner publication.

Run `pnpm test tests/handoff.spec.ts tests/topic-binding.spec.ts tests/http.spec.ts` for the Harness flow, Feishu channel contract and project-scoped management routes.

`pnpm test tests/plans.spec.ts` exercises automatic delegation, restart deduplication, graph validation and reads, message isolation, Frontier claims, role/session/action visibility, slot races, formal delivery gating and claim replay through the Hub and splitter tools using a simulated Harness host.

`pnpm test tests/mainline-queue.spec.ts -t 'verifies the integrated package'` drives delivery and Stage 2 through real temporary Git worktrees, simulated GitHub and Feishu sources, direct Harness messages and the controlled local release adapter.

`pnpm test tests/maintenance-recovery.spec.ts` isolates the interruption points at the Runtime boundary. It seeds the saved project milestone; the Git integration cases above establish when that milestone is written.

The [lark-cli 1.0.100 private-chat fixture](../tests/fixtures/feishu-bound-private-lark-cli-1.0.100.json) retains the actual event and history shapes with anonymized values. A standalone text has no parent or root field. A reply to the binding anchor has `reply_to` in the event and `parent_id` in history; both also have `root_id` equal to the anchor. The Runtime check simulates delayed visibility of these history items: the standalone message enters maintenance once, and the reply does not. These samples cover a bot private chat, not a live group topic.

To verify the live Feishu protocol, use a bot authorized for a dedicated test chat. For both an unmentioned standalone text in the bound conversation and a direct reply to its root, capture the `im.message.receive_v1` event and the matching item from the exact-bound history query (`GET /open-apis/im/v1/messages`, using the resolved thread ID for a group or the chat ID for a private chat). Record the CLI version. Before saving a fixture, replace identifiers consistently across the pair and redact text and unrelated data without changing field presence or types. Check native `message_id`, chat/thread identity, live `reply_to` versus history `parent_id`, and the original text message type. A delayed history read must recover the standalone message once and must not put the root reply in the maintenance inbox. Constructed history responses do not verify the live protocol.

## Limitations

- The Feishu entry answers product questions and may carry a separately authorized settings confirmation; it does not turn conversation answers into configuration approvals. Other IM connectors are not part of this contract.
- Specification publication is one-way. Changes within an active Plan use the explicit approval in `018-plan-replanning.md`; a different authorized scope requires a new handoff.
