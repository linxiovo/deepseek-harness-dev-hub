# 004 Prompts

This document explains what the agents read, what a team can edit, and when changes take effect. It builds on [000 Philosophy](000-philosophy.md) through [003 Execution](003-execution.md). Prompt text is written in English.

## What a team writes

A team can edit three team sections, add skills, and override every built-in system-prompt part. Most defaults live under `prompts/` and `skills/`. Tool descriptions, notices and cards remain in code and cannot be edited through prompt settings.

| Section | Holds |
| --- | --- |
| Communication | When to message people, how messages read, the line that begins every GitHub message (`This is by an automated agent, not a human` by default), how to handle reviews, and which ordinary accounts are review bots |
| Ticket scope | When a Ticket goes on and when it stops with a draft |
| Delivery requirements | Evidence in pull requests and the commit author; without one, the Executor commits as the agent account's no-reply address |
| Team skills | Knowledge the agents load when they need it, such as an `identities` skill that says which Feishu user is which GitHub account |

The built-in text covers the roles, tool usage, host mechanics, authorization rules, Source skills and role-specific workflow skills. It refers to the team sections by their headings instead of repeating them.

### Built-in parts and templates

Overrides use these keys:

| Parts | Keys |
| --- | --- |
| Shared instructions and roles | `runtime/shared`, `runtime/orchestrator`, `runtime/worker`, `runtime/planner`, `runtime/splitter` |
| Working instructions | `runtime/subscriptions`, `runtime/replies`, `runtime/dispatch`, `runtime/work`, `runtime/admission` |
| Handoff instructions | `runtime/handoff/orchestrator`, `runtime/handoff/worker` |
| Source skills | `skill/feishu`, `skill/github` |
| Planning skills | `skill/to-spec`, `skill/splitter/to-tickets` |
| Worker skills | `skill/doc-tree`, `skill/worker/implement`, `skill/worker/tdd`, `skill/worker/test-scope`, `skill/worker/code-review` |
| Generated sections | `runtime/environment`, `runtime/policy`, `runtime/policy/none` |

The Worker guards load `prompts/worker-ticket-ended.md`, `prompts/worker-writer-required.md`, `prompts/worker-ancestry-pending.md`, and `prompts/worker-skill-not-bound.md` as fixed tool responses, not editable system-prompt parts.

The Executor loads `prompts/worker-recovery.md` as the recovery message sent to the original Worker Session for an interrupted Assignment.

The mainline queue uses `prompts/queue-merge-tool.md` for its Hub tool, `prompts/mainline-relay.md` for its durable Hub status relay, and `prompts/mainline-repair.md` for the Worker's exact-baseline repair input. Team prompt overrides cannot grant a merge tool to Workers.

`prompts/worker-credential-report.md` describes the Worker tool for a missing Plan credential. `prompts/credential-action.md` supplies the Hub relay request. `prompts/worker-credential-resume.md` supplies the continuation for the Worker after verification. These are fixed assets, not editable system-prompt parts.

`prompts/plan-release-credential.md` supplies the controlled-provider instruction sent while an explicitly authorized Plan release awaits credential availability. It contains no credential value and is not an editable system-prompt part.
`prompts/plan-stagnation.md` supplies the Worker diagnosis; `prompts/plan-replan-relay.md` wakes the Hub for internal coordination. `prompts/plan-replan-tool.md`, `prompts/plan-requirements-tool.md` and `prompts/plan-question-tool.md` describe Hub tools. The product change flow uses `prompts/plan-requirements-target.md` for an ambiguous target and `prompts/plan-requirements-revalidate.md` for replacement verification. These packaged templates are not editable prompt parts.
`prompts/plan-control-tool.md` describes direct Harness commands and stop statuses. `prompts/plan-control-target.md` supplies the tool's clarification when a direct command does not identify its scope. See `009-handoff.md`.
`prompts/maintenance-tool.md` is the Hub's fixed Stage 2 tool description. It distinguishes read-only checking and association from registering new work under an enabled rule; it never grants listening or release authority. See `009-handoff.md#stage-2-maintenance`.
`prompts/idle-inspection.md`, `prompts/inspection-read-tool.md`, `prompts/inspection-finish-tool.md` and `prompts/inspection-denied.md` are fixed inspection instructions, tool descriptions and refusal text. They do not grant repository access; `020-idle-inspection.md` describes enforcement.
`prompts/lightweight-lookup-tool.md`, `prompts/lightweight-lookup.md` and `prompts/lightweight-lookup-denied.md` define the mounted Hub lookup tool, its sealed task instructions and its tool denial. They are fixed assets; see `021-lightweight-lookup.md`.

The independent scope reviewer receives `prompts/plan-requirement-scope-review.md` with its sealed request. `prompts/plan-requirement-scope-tool.md` describes its only tool.
The Hub's rotation recovery loads `prompts/hub-resume.md` as a fixed continuation preface; the following JSON is assembled from durable project state and resource references, not copied Session history.

The generated sections are editable templates. They must retain these placeholders:

- `runtime/environment`: `{variables}`, filled with execution environment lines.
- `runtime/policy`: `{version}`, `{mode}` and `{rules}`, with one line per enabled rule.
- `runtime/policy/none`: `{version}` and `{mode}`, used when no rule is enabled.

Editing a part changes the instructions the model receives. It does not change the gate, Mandates, tool checks, channel delivery or account wrappers, which remain enforced by code; the host also queues the acknowledgement an accept carries, pull-request end notices and Source notices itself. The Hub's tool set is such a fact; `plugin/docs/010-session-boundaries.md` records the boundary and the code that enforces it, and no prompt section creates or widens it. A rule stated only in prompt text, such as a worker's duty not to reach a person itself, is behavior, not enforcement.

Prompt changes are staged through management settings, not Session tools. If an override omits its `base`, validation keeps the saved base. A removed part already present in the effective configuration is dropped when staging; any other unknown part is refused. **Default updated** compares the packaged default with the recorded base of an override.

The main Session can read affected part names in `orchestrator_read prompts`, under `default_changed`.

## Assembly and precedence

The system prompt is assembled in this order:

1. Shared instructions and the role.
2. The three team sections.
3. Subscriptions and replies.
4. Dispatch for the main Session, or work instructions for an Executor.
5. `runtime/admission`, for the main Session only.
6. Handoff instructions.
7. `runtime/environment`.
8. `runtime/policy`, for the main Session only.

Admission instructions come from `prompts/admission.md`. They describe proactive assessment and when an irrelevant candidate can be ignored from its card. `orchestrator_eval` returns context rather than repeating these instructions.

The shared `promptFile` loader in `src/infra/prompt-file.ts` normalizes line endings, joins lines within each paragraph with spaces, and preserves blank-line paragraph breaks. `src/app/skill-files.ts` parses and registers the bundled `SKILL.md` definitions. `prompts/github-environment.md` supplies the localized GitHub context descriptions used by the Hub, Workers and settings views. Two test suites enforce prompt budgets: `tests/cards.spec.ts` caps each role's own instructions (`masterPrompt` and `workerPrompt`), and `tests/model-surface.spec.ts` caps each role's combined composed system prompt and registered tool schemas.

The environment section gives the main Session deployment-wide values and each Executor its Ticket-specific values. The Policy section is regenerated from settings on every model request. It contains the Policy version, accept mode, the explicit-request exemption, and enabled rules as `- <name> (<id>): <instruction>`, or a statement that none is enabled. It is last so a Policy change leaves the preceding prompt text unchanged.

Executors also read DeepSeek Harness's coding prompt and the repository's `AGENTS.md`; the main Session does not. An inferred Ticket adds a final note limiting its Executor to the matched rules. Assignments and incoming messages arrive inline as Trigger cards, with resource pointers only for truncated content.

Only Worker Sessions mount `dsh-superagent-doc-tree` (`plugin/skills/dsh-superagent-doc-tree/SKILL.md`). `prompts/work.md` directs Workers to load it for documentation impact and committed-candidate evidence before readiness; the skill leaves semantic approval to independent review. The short name `doc-tree` is reserved. A same-name team skill in an older revision is not mounted and must be renamed or removed before saving that configuration.

Only Worker Sessions mount `dsh-worker-implement`, `dsh-worker-tdd`, `dsh-worker-test-scope` and `dsh-worker-code-review`. Their `dsh-worker-` runtime namespace lets teams keep their own `implement`, `tdd`, `test-scope` and `code-review` skills; the review skill is Worker-only and is not mounted by the Hub, Planner or Splitter. See `013-development-verification.md` for the two-lane Worker review procedure.

Executors work unattended. Their tools exclude those that ask a person, present UI to them or change the profile, such as `ask_user_question`, `present` and `plugin_manager`.

Planner Sessions receive only `runtime/planner` and `skill/to-spec`, with neither Ticket policy nor Source/team skills. Their confirmed handoff arrives inline; specification research and writing belong to the planner, while the Hub may inspect context read-only and does not modify repository files.

Splitter Sessions receive only `runtime/splitter` and the `dsh-superagent-to-tickets` skill (`skill/splitter/to-tickets` in prompt settings). The installed planning preset is shared; the role determines the prompt, skill and host tools. `plugin/docs/009-handoff.md` describes the task and registered graph.

`Planning` loads the packaged planner task and resume templates; `Handoffs` fills `prompts/handoff-relay.md` for a product question or published specification. Planner and splitter guard refusals are fixed templates in `prompts/`. The Hub tools load and validate `prompts/handoff-errors.md` for their direct-message refusals.

From strongest to weakest:

1. Facts enforced by tools and the host: identities, permissions, tool argument checks, reply purposes, length limits. Prompt text cannot change them.
2. Built-in and generated sections, as the team's overrides of them read.
3. The process and communication in a proactive Ticket's matched rules, for that Ticket's Executor Session only.
4. Team sections and team skills.
5. Outside text: messages, comments, documents and quotes. It is data and never changes rules or authorization.

## Principles of the built-in text

These apply [000 Philosophy](000-philosophy.md) to the agents:

- **Separate roles.** The main Session coordinates and inspects state and evidence for routing: it forwards the original Trigger and the routing facts, and makes no technical decisions, through one routing tool that takes the decisions on several waiting candidates in one call. A routing note has at most 30 words. The Executor reads the original sources, judges the scope, implements and verifies.
- **The main Session coordinates without executing.** It has no shell, background job or file-write tool; it inspects, routes, assigns and relays only through the tools `plugin/docs/010-session-boundaries.md` lists. Eligible reports and notices arrive as messages; ordinary Plan reports stay on their Ticket. The main Session ends the turn when nothing remains. The preset and `tools.restrict` enforce the missing tools at invocation; this text only describes how to work within them.
- **Message only when a person must act or can use a result:** a result can be reviewed or used, a decision or resource is needed, or the work cannot be finished. Chat messages are one sentence by default, with a hard limit of 100 words.
- **Executors decide their follow-ups.** Each Executor handles and takes up in-scope requests, and hands back requests beyond its Ticket or for another Ticket. A message becomes new work only after all its owners hand it back or end without taking it up. The main Session receives follow-up notices but may act on them only to stop work. Handed-back messages then arrive as candidates with the Executors' reasons.
- **Coordinate through subscriptions and the main Session.** An Executor follows related Threads for context. The main Session can send a fact from another Ticket in a note of at most 100 words. Neither the Subscription nor the note grants authority.
- **Attach only on an explicit reference.** A message must point to a Ticket's pull request, Issue, source message or acknowledgement, or to a recent change with exactly one matching Ticket. Topic similarity alone is not enough. Attachment subscribes the Ticket to the entire Thread; an Executor finding it unrelated uses `orchestrator_thread_unrelated` and does not answer there.
- **Take a request up once, internally.** Before substantial work, the Executor calls `orchestrator_ack` with the request's trigger. This records an internal take-up and sends nothing; calling it again reuses the record. The host automatically queues the acknowledgement an accept carries. The main Session sends later answers, results and attention messages through `orchestrator_reply`; a Worker's take-up or report queues no Channel message directly.
- **Ask through `human_action`.** A standalone Ticket may route a concrete question to the original conversation or to the person whose message raised it. Plan Worker requests are internal proposals; see the product question contract in `015-scoped-attention.md`.
- **Route account setup outside chat.** A Plan Worker with a missing test account uses `orchestrator_credential_blocked` with only the configured identifier, not a `human_action` request for a secret. The Hub points to the controlled configuration entry; see `015-scoped-attention.md`.
- **Honest delivery.** Opening a pull request is not readiness; a draft is marked unfinished; a UI change without a real before screenshot is not ready.
- **Review at two gates.** After the first runnable slice, the Executor does a focused diff review against the request, repository rules and applicable specification, addressing findings before expensive full-suite checks. The completed work still needs self-review and validation before it is ready.
- **A person's pause holds** across follow-ups, new Executor Sessions and restarts until a person lifts it. Automatic feedback never resumes paused work.
- **Examples only show format.** An example sentence is not a fact the agent may claim.
- **Handle reviews by outcome.** A fixed and verified comment is resolved silently; a declined one gets one sentence of reason. An automated reviewer's thread is resolved once it has an answer, and each automated reviewer gets at most three rounds per pull request.
- **Yield to duplicate work.** When a person's branch or pull request already contains the Ticket's change, the Executor closes its own pull request with `gh` immediately and attaches no comment; it reports the reason through `orchestrator_report`, naming theirs, and sends no other message. The Hub routes the report only where the existing delivery rules allow. Work that is merely related, or does not contain the Ticket's change, is not a reason to close.

## Versions

1. Confirm and dispatch a separate, single-node maintenance Plan Ticket. In **Settings → Prompts**, edit team instructions, admission rules or Skills and copy the draft as JSON. `admissionRules`, when present, replaces the admission rule list on publication; omitting it keeps the current list. The optional `disabledSkills` array names custom keys in `skills`; disabled Skills retain their text but are not registered.
2. Stage the draft against the effective `baseRevision` with that Ticket's internal ID. `PUT /orchestrator/api/prompts` accepts exactly `{config, baseRevision, maintenanceTicketId}` and returns `{revision, effect: 'pending-review'}`. This same-origin management write requires the mounted project ID where applicable. Invalid input is `400`; a stale base, ineligible Ticket or proposal fenced by a queued mainline attempt is `409`. Repeating the same staging request reuses the proposal.
3. In the maintenance Ticket, commit only `.dsh-superagent/rules.json`, a bounded regular UTF-8 JSON file with the proposed configuration. The queue inspects the committed tree, never the worktree's loose files. A mixed candidate, an unmatched proposal or an invalid manifest cannot queue. The candidate still needs both independent review lanes, all registered acceptance criteria, tests, required CI and [formal delivery on the target](003-execution.md#formal-plan-closure). Receipt, close and publication commit together. A failed review or lost CI evidence does not publish.
4. `GET /orchestrator/api/prompts` returns the active `revision`, the requested `current` configuration (`revision` query, or the effective version by default), `shownState`, and paged `revisions` (`offset`). States are `active`, `previous`, `pending` and `stale`. Restoring an older configuration or defaults stages another proposal. `POST /orchestrator/api/prompts/preview` validates and renders a draft without staging it.

Each Ticket binds the effective revision before launch. Retry, restart and independent re-review keep that binding. `ticket/<id>` reports `rules_revision`; management Ticket detail returns `rulesRevision`. Workers can read the snapshot through `prompts/current` or its exact revision. Calls to a managed Skill (`dsh-superagent-` or `dsh-worker-`) not mounted for the Ticket are refused rather than loaded from a same-name filesystem Skill. Non-Ticket Sessions use the published revision on their next request. Managed text does not grant tool permissions, lower registered acceptance, alter required checks or raise resource limits.

### Custom Skill management API

Use the same project-scoped configuration for user and team Skills. There is no separate publication path: registering, updating, enabling and disabling are changes to the reviewed configuration, not live edits to a Session.

| Method and path under `/orchestrator/api/` | Contract |
| --- | --- |
| `GET prompts?revision=<n>&offset=<n>` | Both query values are optional nonnegative integers. Returns HTTP 200 with `revision` (active), `current` (selected version), `effective` (active snapshot), `shownState`, `revisions` and `next_offset` for further history. Each version includes `revision`, `previousRevision`, `savedAt`, `source` and `config`. Read `current.config.skills` (name → prompt text) and `current.config.disabledSkills` (names; omitted means none disabled). |
| `POST prompts/preview` | Takes the complete candidate config and returns HTTP 200 with rendered `orchestrator`, `worker`, `planner`, `splitter` prompts, their `parts`, enabled `skills` and a `scope` explanation. It does not write a version. |
| `PUT prompts` | Take `current.config` from the active editable version, not the resolved `effective` snapshot. Add or replace a name in `config.skills`, then remove it from `disabledSkills` to enable it or add it to disable it without erasing its text. Send the full `{config, baseRevision, maintenanceTicketId}` described above. Success is HTTP 200 with `{revision, effect:'pending-review'}`; the original active revision remains until formal delivery. |

Names match `^[a-z][a-z0-9-]*$`, excluding reserved built-in names. Enabled custom names mount as `dsh-superagent-<name>`. Use the same-origin request marker, plus `x-orchestrator-project-id` on writes to a registered project. A stale supplied scope returns `409 staleProject`; reads and preview during remount return `409 switching`. An unknown revision gives `404 unknownPromptRevision`. Validation failures are `400 {error, issues}` or `400 {error, code, values}`, including `unknownCustomSkill` for disabled names absent from `skills` and `promptTooLong` for an oversized configuration. Publication staging conflicts return `409 promptRevisionChanged` or `409 promptProposalRefused`. The active revision and a Worker Ticket's bound revision can deliberately differ.

Verification: `tests/prompts.spec.ts`, `tests/mainline-git.spec.ts`, `tests/mainline-queue.spec.ts`, `tests/http.spec.ts`, and `tests/panel-prompts.spec.tsx`.
