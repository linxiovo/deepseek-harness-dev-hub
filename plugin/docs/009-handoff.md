# 009 Handoff

This document follows a confirmed Harness handoff from the conversation to a published specification and registered Plan DAG. It builds on [001 Domain model](001-domain.md), [003 Execution](003-execution.md), [004 Prompts](004-prompts.md) and [007 Architecture](007-architecture.md).

A handoff is one product brief a person confirmed in the main Session ("the Hub") conversation. It is not a Source Trigger and not a Ticket: it carries the project, goal, constraints, acceptance scope and authorization, and a read-only planner Session turns it into a specification. The Hub confirms, relays and reads the result; repository investigation and specification writing belong to the planner, and the Hub does not modify the repository.

## Records

| Record | Fields | Rules |
| --- | --- | --- |
| Project | `id`, `repository`, `workspace` | `workspace` is resolved to an absolute path. `id` derives from the repository and that path, so one checkout keeps one identity |
| Handoff | `id`, `project`, `goal`, `constraints`, `acceptanceScope`, `authorization {scope, release}`, `confirmedBy {sessionId, messageId, text}`, `status`, `question?`, `spec?` | The brief is written once. A confirmation receipt binds one direct user message to one brief; a project has at most one handoff that is not `specified`. Earlier records stay readable |
| Question | `id`, `text`, `why`, `affectedAcceptance`, `status`, `answer?` | At most one per handoff. Its status is `awaiting` or `answered`; every `affectedAcceptance` item is one of the handoff's `acceptanceScope` items |
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

After grill-with-docs or wayfinder aligns a request, the Hub shows its complete project, goal, constraints, acceptance scope and authorization in the Harness conversation and asks the requester to approve those exact fields in one direct message. That message must be exactly a JSON object `{"confirmed": true, "brief": {...}}` with no extra keys, whose `brief` holds `project {repository, workspace}`, `goal`, `constraints`, `acceptanceScope` and `authorization {scope, release}`, all complete. This one confirmation is the flow's only human approval: the Hub asks no technical-boundary question and uses no IM.

`orchestrator_handoff_confirm` is a main Session tool. It takes the same five fields separately plus `confirmation`, the verbatim latest direct Hub user message. Only the current Hub Session may call it; `confirmation` must equal the latest direct user message exactly, and that message must be an explicit approval rather than a task, quoted content, a relay or silence. The tool parses the message as that JSON approval object and requires `confirmed: true` and the complete five-field `brief` with no extra keys, so a bare yes cannot authorize an independently supplied scope. It compares every parsed field with the separately supplied brief and refuses a mismatch: the message must approve the exact brief being confirmed. The refusal messages for the Hub-only confirmation and answer, the latest direct-message match and a malformed or mismatched JSON approval come from `prompts/handoff-errors.md`, whose keys `src/app/tools/main.ts` validates at module load, so no such text is written inline in the tool code.

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

The same state transaction queues a relay to the Hub naming the project, question, reason and affected acceptance; no Outbox reply is written. Its text comes from the `prompts/handoff-relay.md` template, which fills the project, kind, content, resource and handoff id; the publication relay uses the same template. The Hub presents the question in Harness and calls `orchestrator_handoff_answer` (`handoffId`, `questionId`, `answer`) only with the exact latest direct user's answer. `Handoffs.answer` accepts the matching first answer, repeats that answer idempotently and rejects a changed answer, unknown question or handoff not awaiting an answer. The first answer resumes `planning` and enqueues a planning effect for the same Session.

`orchestrator_spec_publish` requires `handoffId`, a non-empty `body`, observable `acceptance` entries, at least one selected public `testInterfaces` entry of kind `existing` or `proposed`, and a required `outOfScope` list. `outOfScope: []` is accepted only as the explicit statement that there are no confirmed exclusions; each non-empty entry names an actual excluded item, and a caller neither omits the field nor fabricates entries. Only a `planning` handoff may publish. The immutable revision `1` and `specified` status are stored together with a Hub relay containing the `spec/<id>` read resource; the requester sees that result in Harness without IM. A second publication is refused.

Each acceptance entry includes `delivery: backend | frontend | cross-end`, decided during specification planning and immutable after publication. A spec published without those classifications remains readable (`unclassified-spec` in the plan read) but cannot start splitting; the host does not guess execution roles for it.

## Reads

The main Session reads the flow with `orchestrator_read`:

| Resource | Returns |
| --- | --- |
| `handoff/<id>` | The whole handoff record: project, brief, confirmation, status, question and answer |
| `spec/<id>` | The published specification, or `{handoffId, status: 'pending'}` before publication |
| `plan/<id>` | The Plan DAG with roles, acceptance references, blocked-by edges, role totals and delivered counts, plus root background. `offset` and `limit` page the nodes and background in parallel. Before registration the status is `awaiting-spec`, `pending`, or `unclassified-spec` |
| `plan/<id>/node/<node-id>` | One registered Slice Ticket with a page of its addressed instructions, without root background or other nodes' instructions |

These are main-Session resources, so a Worker Session is refused. A planner's own `orchestrator_read` accepts only its two matching resources while its handoff is `planning`.

## Durable planning

`Planning` (`src/app/planning.ts`) handles the `planning` effect. It ignores `awaiting` and `specified` handoffs, rejects a payload whose id differs from its key, and defers while processing is paused or the Runtime is stopping. For a `confirmed` handoff it calls `begin` before creating the Session.

It ensures `planner-<id>` in `project.workspace` and sends the full persisted brief (handoff id, project, goal, constraints, acceptance scope, authorization and confirming message) with the unattended to-spec task under request id `handoff:<id>:task`. When the handoff has an answered question, it also sends that question and answer under `handoff:<id>:answer:<question id>`. The first delivery's task text is `prompts/planner-task.md`; the answer delivery's task text is `prompts/planner-resume.md`. Both are built-in prompt files loaded through `promptFile`, so the code carries no inline prompt copy. The stable request ids let `AgentDelivery` deliver each of these at most once across retries and restarts, and the same Session is reused.

At startup, before effects and passes start, `Planning.resume` enqueues planning for stored handoffs in `confirmed` or `planning`. A missing or disposed Session is retried through `Later`. Shutdown cancels planning Sessions, including ones created while stopping.

## Automatic Plan registration

Publication also persists a `splitting` effect for the exact handoff and spec. The effect starts `splitter-<handoff id>` in the handoff workspace with the read-only planning preset and sends `prompts/splitter-task.md`, the two IDs and scoped resource pointers under `handoff:<id>:plan:<specId>`. The splitter loads `dsh-superagent-to-tickets`, reads only that handoff and its immutable spec, and calls `orchestrator_plan_register`. Stable delivery IDs prevent duplicate queue deliveries on restart. The Hub does not read or write the draft to continue the pipeline, and no user approval is needed.

The effect remains parked after a successful prompt until registration cancels it in the same transaction as the Plan write. On restart the host rearms only persisted splitting intents, checks for the last message in the Session history or inbox, and either delivers it once or steers an idle splitter with a new, persisted continuation ID. No continuation is enqueued for a registered Plan. An idle unfinished turn is not retried in a loop on the same Runtime.

The registration takes `handoffId`, `specId`, `features[]` and `nodes[]`. A feature declares its `id` and `kind` (`backend`, `frontend`, `cross-end`); its nodes hold stable `id`, `featureId`, `title`, one execution `role`, one-based `acceptance` indices into the spec, a `demonstration` and explicit `blockedBy` IDs. A cross-end feature needs one backend node with a repository-relative `interfaceContract {path, requirements}` deliverable and one frontend node explicitly blocked by it. A single-end feature gets one matching node. The splitter judges fit to the prose and the demonstrations; the registry validates the submitted roles, graph and acceptance coverage before writing. An identical replay reuses the registered graph; malformed submissions and attempts to replace it do not mutate the old graph.
Every backend predecessor explicitly referenced by a frontend node needs an interface contract, including when the two nodes belong to different features.
The registry compares each acceptance reference with its immutable delivery classification. A `cross-end` criterion must be referenced by both an interface-contract backend node and a frontend node explicitly blocked by that node, even if the draft labels the feature as single-end. Role labels in a draft cannot weaken a specification.

Only `blockedBy` creates an edge. A node without predecessors is `waiting-for-slot`; a node with predecessors is `blocked`. Registration creates no executable Ticket, Worker Session, Assignment, or worktree. `stats` reports registered and delivered counts separately for `backend` and `frontend`; none are delivered at this stage.

For an already registered plan, `orchestrator_plan_context` takes the verbatim latest direct Hub user message as `message`. That message is JSON with `planId`, `target: {"kind":"background"}` or `target: {"kind":"node","nodeId":"…"}`, and `text`. The tool parses the plan and target from the message itself, records the event once, and stores root background separately from the addressed node's instructions. Neither record, message visibility nor Thread subscription creates authorization, alters the graph, or starts work.

## Tests

`tests/handoff.spec.ts` drives a running Runtime through public Hub and planner tools. In GitHub-only projects it covers a confirmed brief surviving restart with one delivered planner task, an observable specification with a selected public test interface, one missing product-intent question with the exact direct user answer delivered once to the same planner, and a completed-spec relay to the Hub. It rejects bare assent, a Hub tool brief that differs from the direct JSON approval, old confirmations reused for changed briefs, invented answers, incomplete specifications, technical or repeated questions, and non-planner publication.

Run it with `pnpm test tests/handoff.spec.ts`.

`pnpm test tests/plans.spec.ts` exercises automatic delegation, restart deduplication, graph validation and reads, and message isolation through the Hub and splitter tools using a simulated Harness host.

## Limitations

- No IM or Feishu: the question, answer and publication notice travel only through the Harness Sessions. No Feishu binding, chat message or Outbox reply is created.
- One immutable specification: revision `1` is the only revision and publication is one-way. A changed brief is a new handoff after the prior one is `specified`.
