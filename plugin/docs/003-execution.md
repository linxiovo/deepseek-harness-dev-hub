# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

A Plan credential pause is separate from these report-based stages. A follow-up or ordinary Ticket retry does not release it; the trusted account check must pass. See `015-scoped-attention.md`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>` and a Git worktree directory named after the Ticket's short name. Ticket directories are created under the configured worktree root, which defaults to `<stateDir>/work`. The worktree's branch, repository and pinned base are part of the Ticket's execution record.

Executor Sessions run commands without approval as the operator's OS user. Their `dsh-superagent-worker` preset contains the tools needed for work and moves foreground shell commands to background jobs after 5 seconds. This lets a worker receive new messages at the next step instead of waiting for a long command to finish.

The main Session uses `dsh-superagent-router`, a read-only preset with inspection and coordination tools and no shell, background jobs or file writes; `010-session-boundaries.md` states that contract. Sessions retain the preset selected at creation. Worker subagents use DeepSeek Harness's `standard` preset.

### Background work and worker slots

When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A completed job or subagent wakes the Executor with its result in the same slot. Once a turn ends with no background work, the Executor reports waiting normally.

After each turn, background work has at most 30 minutes to finish. At that limit, shell jobs are killed and the Ticket is reported waiting. The report includes the Executor's last words and which jobs were killed or subagents remain active. Subagents are allowed to continue. The Executor reads killed-job results on its next turn.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Their completion does not wake the Executor; it reads the results on its next turn.

A person can also start a turn by writing directly in the Executor Session. Its background work follows the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session. Its subagents are released, and any completion turns they wake are dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes.

Stopping or restarting the plugin inside the DeepSeek Harness process uses the same shutdown path. Inputs not yet taken into Session history are retained. Shutdown waits up to 10 seconds for each worker's background work; a process restart ends that work outright. An Assignment interrupted while busy restarts with a recovery note.

A Plan Ticket waiting on credential verification is an exception: restart keeps it suspended, without an interruption note or launch. Successful verification queues continuation of the same Assignment and verified worktree.

Worker subagents at every depth use DeepSeek Harness's `standard` preset with the worker's permissions. They retain only the worker's allowed work tools, and lose them once the Ticket ends, whichever level created them. Under `standard`, a shell command moves to the background after 60 seconds. A subagent's jobs are killed when it ends.
A Worker’s implementation review uses two independent child Sessions: one checks project standards and Doc Tree/API-contract semantics, and one checks the specification, ticket acceptance and test evidence. They receive the same pinned base and committed candidate. Only those child Sessions can call `orchestrator_review_submit`; the tool binds the real child identity, active Assignment, pinned base and clean worktree HEAD. `ticket/<id>/reviews` exposes each axis, reviewer Session, basis, versions and blocking conclusion separately; review evidence is valid only for the live Worker lease generation. A missing axis, mismatched version or blocked conclusion is not a dual-review pass. After restart, reclaim, base change or candidate amendment, stale evidence remains readable as history but aggregate state is pending until both lanes submit for the new live generation.

### Ticket worktrees

A Ticket works in a real Git worktree, not merely in a directory. The Execution settings name the local clone (`executor.repository`) and the ref a Ticket starts from (`executor.baseRef`, such as `refs/heads/main`); `executor.directory` is the root that holds the Ticket's directory, named after its short name. The Ticket's branch is `agent/<short name>`. These facts belong to the Ticket, not to one Session, and they outlive the Ticket's end. Both repository settings must be set before a Ticket can prepare; an empty value fails that Ticket with a reason naming the missing setting and never falls back to an empty directory.

Before the first Assignment, the Executor resolves the configured repository to its canonical main checkout and `baseRef` to a full commit id, then durably reserves the directory and branch for that Ticket. Inspection, Session startup and persistence compare native physical paths, so a Windows 8.3 path cannot disagree with its long spelling or claim a second writer. The reservation is written before the prepare command runs and before a Session is created. The Execution record then carries these facts, all optional on records written before they existed:

| Field | Meaning |
| --- | --- |
| `repository` | Canonical path of the local clone, not the GitHub repository name |
| `worktree` | Canonical absolute path of the verified worktree; `directory` remains the path first allocated |
| `branch` | Branch checked out there, `agent/<short name>` |
| `base` | The configured `ref` and the `sha` it resolved to before preparation |
| `session` | The actual Worker Session bound to the worktree; a legacy started Ticket may show the derived `worker-<ticket id>` |
| `active_writer` | The Assignment and Session currently allowed to write, or null when no writer holds the worktree |
| `preparation` | `unverified`, `reserved`, `verified` or `rejected`, with a readable `reason` when rejected; a legacy record with no stored preparation reads `unverified` |

A record that predates these fields shows only the facts it stores. The Executor never derives a missing base from the worktree's current HEAD, and never treats an existing directory as proof of ownership.

#### Preparing a Ticket worktree

Before it prepares, the Executor checks two boundaries read-only. The configured clone's single local `remote.origin.url` must be a direct github.com HTTPS, SSH or Git URL for the GitHub target configured on the Source (`owner/name`); an unset target, or a missing, duplicated, unsupported or different origin, is refused. The Ticket's directory and the configured worktree root must resolve outside the clone's primary checkout, every linked worktree registered there, and any unrelated Git checkout, including through symlink or junction aliases. Either refusal happens before the prepare command and creates nothing: the files stay as they were, and the Ticket fails with the reason.

Preparation turns the reservation into a verified worktree. The configured repository must name the clone's main checkout, not a subdirectory or another linked worktree. Before preparation runs, the Executor resolves `baseRef` there to a full commit id. Without a prepare command, it creates the worktree itself with `git worktree add -b agent/<short name> <directory> <pinned commit>`. With a prepare command, that command runs once, in the worktree root, with `sh` and the execution variables, including the canonical repository, pinned base ref and commit, and the reserved branch; it has ten minutes to finish and may add repository-specific content. Either way the result must be this Ticket's linked worktree.

Before any Session starts, the Executor verifies the result as the worker sees it: the directory is a linked worktree of the configured clone, not its main checkout; its canonical path, its `--show-toplevel` and the clone's common git directory match the record; the checked-out branch is the Ticket's; and a first preparation has HEAD at the pinned base commit. Only then does `preparation` become `verified`, and only then may the Session start. The command's failure and output, a mismatch, or a directory that is not this Ticket's worktree records `rejected` with the reason; the Ticket fails.

A rejected preparation never deletes, moves or rewrites what it found. An ordinary directory, whether empty or not, another Ticket's worktree, a checkout of another repository, and a worktree of the right repository on another branch or base are all refused with the reason visible on the Ticket. Nothing in them is cleaned up, and no Session is created. Removing or repairing that content is a person's decision.

A retry or a person's message reuses a worktree only when its durable record belongs to this Ticket, was `verified` before the attempt, and its repository and base match. Reuse keeps the Ticket's recorded repository and pinned base, so changing either setting does not repoint an existing claim; those settings select a base for a new Ticket. It still requires `executor.repository` and `executor.baseRef` to stay set, and `executor.repository` to resolve to a main checkout: clearing either fails the Ticket with the missing setting and prevents reuse. The current HEAD may be ahead of the base, because the worker may have committed; the Executor does not reset it and does not require it to equal the base again. Preparation is not repeated for a verified worktree. A record whose ownership or base cannot be proved, including an older Ticket that only stored a directory, has no verified preparation and is refused rather than adopted. A failed prepare command or a rejection is retried only by a new Assignment that reserves the worktree again after the previous writer is confirmed idle. An existing directory by itself never counts as prepared, and content the Executor did not create is left for a person to resolve.

A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

#### Write access

One worktree has at most one writer. `active_writer` names the Assignment and Session allowed to write, and is recorded before that Session starts. A second Ticket, retry or launch that claims the same canonical directory, or a Session that already writes for another Ticket, is refused before it can prepare or start a Session: it records its own rejection and runs no prepare command. The first writer keeps the worktree.

An explicit retry ends the previous Assignment; a host restart keeps the running Assignment in place. Neither proves the old writer is idle. The Executor cancels the old turn, waits for the shell jobs and subagents to stop, and releases `active_writer` only when the Worker Session is truly idle. Before work continues it reacquires write access to the verified worktree with a new fenced generation. If actual idle cannot be established, the old lease remains held and the worktree is not shared.

The reservation stays with the Ticket after it ends, so no other Ticket may claim its worktree.

#### Reading a Ticket's execution

`GET tickets/:id` and `orchestrator_read ticket/<id>` expose an execution block, as do the panel's Ticket details: `name`, `directory`, `repository`, `worktree`, `branch`, `base` with `ref` and `sha`, `session`, `active_writer` and `preparation` with its `reason`. A compact ticket card carries this block only for a Ticket that has a `preparation`; a legacy directory-only Ticket omits the whole block there. Read from the detail routes, nothing is invented for a legacy Ticket: a missing repository, worktree, branch, base or writer stays absent, and its preparation reads `unverified` rather than being filled in. A rejection reason is readable until a later verified preparation replaces it.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a slot is free. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_REPOSITORY`, `DSH_SUPERAGENT_BASE_REF`, `DSH_SUPERAGENT_BASE_SHA`, `DSH_SUPERAGENT_BRANCH` | Executor | The canonical local clone, the configured starting ref, the full commit it resolved to, and the Ticket's reserved branch |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Commands the Executor may not run |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

Ticket-specific values come from its execution claim, directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings; text sent to the main Session cannot change the configured shell command.

Workers reach GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`. Blocked commands fail when invoked by name.

These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path.

## Merging

Only the Hub can call `orchestrator_queue_merge({ticket_id, candidate})` for a registered Plan Ticket. `candidate` is the full lowercase SHA. The host requires the verified clean worktree and its pinned base, current delivery-check evidence including required CI, and the configured target `refs/heads/...`. A PR used for CI must still be open and point to that candidate and target. The queue never requests a GitHub PR merge or enables auto-merge.

The host persists the intent and FIFO position before starting Git. One write at a time runs for a GitHub repository and branch. The queue creates an intent-specific `integration` commit whose only parent is the reviewed candidate and whose tree is identical. The host persists its SHA before advancing the actual remote branch from the exact reviewed base. Ticket detail (`GET tickets/:id` and `orchestrator_read ticket/<id>`) shows `mainline` once queued; `ticket/<id>/mainline` pages attempts newest first. Each attempt names `id`, `status`, `target`, `candidate`, the reviewed `base`, the prepared `integration`, and `actual` once observed. A `verified` attempt means the integration commit was observed on the target, which is **not** formal delivery or permission to dispatch successors.

If the target moved forward before the candidate could be applied, the intent records `repair` and the host sends a durable input to that Ticket's Worker with the new pinned base. Resolve code and Doc Tree conflicts in the Ticket worktree, preserve the earlier candidate's lineage, and obtain fresh dual review, acceptance, test, Doc Tree and CI evidence on the new pair. The Hub queues the new candidate; failed or unavailable repair and recheck remain visible. A rewritten target, a candidate already on the branch before the queued write, or a rejected Git write without matching verification is `waiting`, not success.

After interruption, a queued intent can continue at the original base if the exact pair still passes the gate and the previous Worker is confirmed idle or still holds the valid lease. An `applying` intent checks actual Git before authorizing any write: if its integration commit is present, it records the missing observation without pushing again. A branch containing only the candidate, not the intent-specific commit, does not prove a queue write. Processing pause prevents new writes but does not erase a completed write. See `006-deployment.md` for repository permissions.

A current Plan credential blocker prevents a new mainline write or a new repair dispatch for that Ticket. It does not erase an integration already observed on the target.

## Formal Plan closure

The host records the verified merge and enqueues closure in the same transaction. The closing check uses the same Ticket, Assignment, writer generation, base, candidate and target as the verified intent. The host rechecks acceptance, both reviews, tests, required repairs, Doc Tree and required CI (see `plugin/docs/013-development-verification.md`). It fetches the target and requires the intent's integration commit, which has the exact candidate tree. A later tip qualifies only if it contains the integration and preserves the reviewed Doc Tree paths; changes there report `mainline_docs`. After reading the target, the host rechecks that the worktree is still clean and on the same candidate. An unrelated write that only puts the candidate on the branch does not qualify.

The host ends the Ticket (`by: delivery`, `outcome: merged`) and records the Plan receipt atomically. It revokes the Worker grant and stops its work on commit. The Ticket cannot reopen on a later Thread message. Closure is internal; it neither closes a GitHub issue nor sends a per-Ticket external notice.

If the evidence no longer passes, the Ticket stays open and `mainline.delivery_missing` names the blockers on the verified attempt. Restart resumes pending checks. Replaying the same SHA rechecks closure without advancing Git; a fresh checked SHA can enter the queue after a refused closure and follows the normal actual-baseline repair flow. After closure, replay returns the existing intent without closing or claiming again.

## How a Ticket ends

- **Standalone ready without a pull request:** a `ready` Report ends a non-Plan Ticket as completed. Plan ready reports remain open.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a person's later message on its Threads resumes it.
### Pull requests

A Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

A standalone Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it. For Plan Tickets, PR close or merge facts do not end the Ticket or establish mainline verification.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor took up a follow-up it owns (by recording it internally) or answered it but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels receive one final pull-request notice for eligible non-Plan Tickets only. Plan closure stays queryable. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request.

### Follow-ups and context Threads

The Executor decides human follow-ups on its Ticket's own Threads. It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

An Input counts as read after the Session takes it into a step and subsequently reports or ends a turn. When a Ticket ends, unread messages that its Worker did not take up or answer and did not hand back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx or a refused, reset or timed-out connection, is tried again first, three times with a growing backoff: a launch runs again, and a worker whose turn failed is told to go on; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

Its tools stay available, so a person can continue in the Session directly.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.
### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, verified worktree, branch and pull request. The new Assignment gets the worktree only after the previous writer is confirmed idle; if that cannot be established, it stays refused rather than sharing the tree.

The Executor model applies only when a Session is created; an existing Session keeps its model.
### Restart

Interrupted work resumes the same running Assignment, Worker Session and verified worktree. The recovery note is a durable Input; a restart before its delivery reuses that pending note. It asks the worker to inspect its worktree, Git history and GitHub before repeating an external operation. See `012-project-runtime.md` for project startup reconciliation.

Assignments that are waiting, ready, blocked or failed stay as they are, unless an Input reached them after that Report, in which case they start again too.

Sessions, worktrees, Subscriptions, pending messages and the stored work below survive a restart, and so does the record of which messages each Executor Session took into its history, which a step does once it claimed them and before its model call: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one a step claimed but a cancel or error cut off before the history counts as unread.

A retry returns unread Trigger Inputs to the new Assignment; a restart returns them to the interrupted Assignment after the recovery note. Recovery removes any pending inbox copy before replaying the same Input ID. Session delivery does not replay a copy already in history.
### Stored work

What dsh-superagent does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.
### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.
### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300. The main Session sends an answer, a result or an attention message; the host itself queues the acknowledgement an accept carries and eligible legacy pull-request end notices and Source notices. All are outgoing messages; neither a Worker's take-up nor its report queues one directly. Plan Ticket closure stays internal; see `015-scoped-attention.md`.

A Ticket's messages to one conversation go out in the order they were queued, so the acknowledgement an accept carries comes before the Ticket's later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement of an accepted Ticket, which only the host queues, reads as dropped, not sent.
### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.
### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.
