# 013 Development verification

## Locate and test the change

Start with the ticket's acceptance criteria and prerequisites. Follow the repository's `DOCS.md` to the owner of the changed behavior. Read the cited spec sections and the related source and tests; broaden the search only if those references cannot answer a question.

Before dispatching implementation slices, select their focused checks from this table and name the commands in the handoff. For recovery or retry work, name the exact interruption point before dispatch and the observable result on each side of it; cover an external side effect completed before its local receipt was recorded. The integration owner runs the union from `plugin/` as soon as each affected surface is runnable. On Windows, use one `pnpm test` runner for overlapping checks across independent checkouts; the wrapper serializes them through a named pipe shared by the current Windows account. While a runner waits, it reports its own waiter PID, the gate identifier, and elapsed wait time at entry and about once a minute, always marked `Vitest has not started`, so an outer task timeout is not mistaken for Vitest startup. At 30 minutes it exits nonzero without starting Vitest; that diagnostic establishes only that another test run for the same Windows account holds the gate, because the named-pipe API does not expose the holder PID.

Set the command timeout using the most recent duration for that check on the platform, with room for slower runs. Count a red only when the runner reaches the expected failing assertion; a compile or setup failure means the seam has not run.

| Change | Existing checks |
| --- | --- |
| New class or source module | Run `pnpm test tests/class-docs.spec.ts tests/docs.spec.ts` before the full check. Fix missing class JSDoc and missing module or test index entries before proceeding. |
| Source imports or import boundary gate | `pnpm check:imports` on the current sources; when changing the gate itself, also run `pnpm test tests/import-boundaries.spec.ts`. |
| Session tool, resource or model-facing schema | Run `pnpm test:session-tools` as soon as the first changed tool or prompt is callable, then before the full check. It exercises public behavior, role boundaries, response and prompt budgets, and prompt contracts. |
| Management HTTP route, Ticket detail or shared view | `pnpm test tests/http.spec.ts`; include affected panel checks for visible changes. For `mainline` in the Ticket response, also run the Mainline queue check below. |
| Bundled skill or prompt registration | `tests/prompts.spec.ts`, `tests/model-surface.spec.ts`, `tests/tools.spec.ts` and `tests/panel-prompts.spec.tsx` for role scope, resource inventory and settings labels |
| Prompt text or built-in delivery guidance | `tests/cards.spec.ts` for prompt contracts and budgets, plus the registration checks above when the mounted surface changes |
| Doc Tree routes, numbered documents or committed-candidate inspection | `tests/docs.spec.ts` for navigation and source/test indexing; also `tests/doc-tree.spec.ts` when changing the candidate checker |
| Pause, retry or recovery | Run `pnpm test:recovery` for Plan, runtime-concurrency and runtime-crash behavior; for a deployed headless host, record the [live connection smoke check](006-deployment.md#live-headless-connection-smoke-check) separately. |
| Mainline queue or write permissions | `pnpm test tests/mainline-queue.spec.ts tests/mainline-git.spec.ts`; verify live server enforcement separately with [Verify queue-only writes on GitHub](006-deployment.md#verify-queue-only-writes-on-github). |
| Plan integration and artifact delivery | Run `pnpm test tests/plan-integration-crash.spec.ts tests/actions-evidence.spec.ts tests/plan-artifacts.spec.ts tests/mainline-queue.spec.ts tests/http.spec.ts tests/panel-execution.spec.tsx tests/navigation.spec.ts`; cover SIGKILL before and after dispatch, a 4xx during pause, exact-attempt manifest and checksum binding, branch movement and reruns during verification, package loss before the Hub relay, restart with a damaged run directory, project-scoped download, Harness Ticket deep links and the release-verification panel state. |

Run `pnpm check` once at the end. Local verification and CI use the same command and test coverage. On Windows, Vitest caps parallel test files at two to limit contention between native Git fixtures and allows 45 seconds per test by default. The multi-project desktop and headless restart case has a 60-second deadline.

When changing the test runner, verify cross-checkout exclusion, nonzero exits, and interrupted-run release with `node --test tests/probes/test-runner.mjs` from `plugin/`. Run this standalone probe while no other test runner is active, not inside Vitest.

In recovery tests that use real Git worktrees, wait for the controlled teardown to start and for the Runtime to become idle after release; assert delivery without a separate short polling deadline.

The scoped Plan credential acceptance case launches three real Git worktrees and restarts the Runtime three times. It has a 60-second deadline and fails immediately if the interrupted verification returns before invoking the verifier. For fixture cleanup after shutdown, use bounded retries for transient Windows file locks; a directory that remains locked still fails the test.

After restart, a replayed Hub notice does not imply the Worker has reclaimed its writer. Before testing a replan that requires a confirmed writer, wait for the pending Worker delivery and check verified preparation and active writer identity on the Ticket.

## Worker implementation and test evidence

For an authorized implementation Ticket, the Worker loads `dsh-worker-implement` before editing. Read `ticket/<id>` with `orchestrator_read` to confirm the verified worktree and pinned base. Keep edits and checks in that worktree.

1. Load `dsh-worker-test-scope`. Start with the Ticket's acceptance criteria and the diff from the pinned base. Locate the public entry that exposes the behavior, the existing runner and its focused and full-suite commands. Identify required CI separately.
2. Load `dsh-worker-tdd` for each changed behavior. Reproduce the expected failure through the authorized public entry on a reproducible red revision. Use an existing regression check when it already reaches the failing assertion. Otherwise add or extend a check and pin its test-only red commit. Confirm that the runner reached the assertion and record the revision, working directory, exact command, failure output and exit status. A setup failure, skipped case or empty run leaves red unverified.
3. Make the smallest change that satisfies the behavior. Run the same check and confirm that the same assertion passes. Keep the regression check in the candidate. Complete one red–green cycle before starting the next.
4. Finish writes and review the complete diff. Select the local verification scope using the table below and run those checks on the clean committed candidate. For the full plugin check, use the [Windows](006-deployment.md#verify-a-committed-candidate-on-windows) or [Linux](006-deployment.md#verification) snapshot verifier with `--ref <candidate>`; retain its manifest and stage logs, which must name the exact candidate reviewed. A run against changing files is feedback, not candidate evidence. Required CI is a separate gate.
5. Record actual runs with `orchestrator_test_evidence` and the committed Doc Tree observation with [`orchestrator_doc_impact`](011-doc-tree-impact.md#worker-tool-contract). Both tools accept an optional `reference` for an openable log URL or Session resource. Use it to bind the observation to the durable result, not instead of recording what happened. Preserve prerequisites, red assertions, matching green results, document paths or unchanged rationale, and references in `orchestrator_report` and any candidate PR. Check all name the same base and candidate.

| Scope | When to select it |
| --- | --- |
| `focused` | A local change with a known public seam and no affected consumer contracts. Use the narrowest existing check that exercises the behavior or the closest suitable coverage. |
| `consumers` | A contract change with known affected consumers. Trace real call sites and dependency paths, then check the provider and its affected consumers through that contract. |
| `full` | Shared infrastructure, an uncertain consumer list or dependency cycles make the impact unclear. Run the repository's full suite. |

Reuse a red observation only when its recorded revision still reproduces the same assertion failure and the same regression check is present in the current candidate. Report unknown outcomes as unverified. For changed or interrupted candidates, follow [repair and evidence reuse](#repair-and-evidence-reuse).

### Worker test evidence tool

Only the active Worker for the Ticket can call `orchestrator_test_evidence`. It revalidates the writer and resolves the worktree and pinned base. The candidate must equal the worktree's HEAD. The worktree must have no staged, unstaged or untracked changes reported by Git. Each red revision must descend from the pinned base or equal it, and be a strict ancestor of the candidate.

| Input | Meaning |
| --- | --- |
| `candidate` | The full lowercase commit SHA of the candidate. |
| `scope` | `focused`, `consumers` or `full`. |
| `reason` | Why the selected scope covers the current diff and its affected consumers. |
| `checks` | A list of `{directory, command, status, observed}` records. Give the working directory relative to the worktree, the exact command, and what was observed. Use `passed`, `failed`, `not_run`, `pending` or `cancelled` for `status`. |
| `red` | An array of `{revision, directory, command, observed}` records for reproducible red runs. Use `[]` if a required red is unavailable and `null` if the change requires no red. Name the full revision, worktree-relative directory, exact command and observed assertion failure. |

The result identifies the candidate and pinned base and has `source` set to `worker`. It returns `failed` when a check is reported as failed. It returns `reported_passed` when the Worker reports at least one check and all listed checks passed, and either no red was required or a nonempty red list has a matching candidate check for each command and directory. All other cases return `unverified`. The tool verifies Git identity; the Worker supplies run observations and scope rationale. A reported pass does not establish adequate coverage or replace required CI.

## Worker test evidence smoke check

### Create a disposable seed (offline)

From `plugin/`, use Node and Git on `PATH`. Pass an explicit **nonexistent** destination whose parent exists and is outside any Git checkout. Make a separate seed for each case. No dependencies, remote, credentials, model, or host are needed for this step.

```sh
pnpm worker:smoke seed focused '/absolute/disposable-parent/new-focused-seed'
pnpm worker:smoke self-test
```

The seed command in [scripts/worker-smoke.mjs](../scripts/worker-smoke.mjs) creates one local `main` commit and prints its base SHA, candidate verification scope, plain `node:test` runner, and exact foreground Bash and PowerShell commands as JSON. Run the plain `runner` from the seed directory: the seed should exit `1` at the named assertion, not fail to start or discover tests. The independent check passes wherever the runner includes it. The `self-test` command checks export selection, redaction, and rejection cases using in-memory event fixtures; it does not exercise Harness or a model.

| Seed case | Ticket acceptance and expected selection |
| --- | --- |
| `focused` | Clamp a negative seat count to zero, leaving positive counts unchanged. `clamp seats at zero` fails through `seats()`. Use the seat check only (`focused`); a separate full runner is available. |
| `consumers` | Replace `quote().total` with `quote().cents`. Update Checkout and Invoice to use the new contract while preserving their public results. `quote exposes cents` fails at the seed; the existing Checkout and Invoice assertions must also pass at the candidate through their real imports. Use the combined provider and two consumer checks (`consumers`). |
| `full` | Trim whitespace as well as lowercasing in shared key normalization. `all discovered adapters normalize keys` fails through the runtime adapter registry. Consumers are discovered from a directory that can be supplied by callers, so the known static imports are not a complete list. Use the full runner (`full`), including the independent check. |
| `fallback` | Make the local base charge nonnegative through `charge()`. `base charge is nonnegative` fails at the seed. There is no `package.json` or specialized entry: use the existing generic `node --test --test-reporter=tap` convention. The change is still `focused`; explain why the existing broader discovery command is the closest usable coverage. |

### Run through a real Worker (manual)

Use the Web profile from [deployment](006-deployment.md), isolated from normal Sessions, with a working model, Git and Node in the Worker environment, and a disposable GitHub repository per case. The operator needs authorization to create those repositories or seed their default branch, submit implementation Tickets via normal Hub intake, and read the Worker Sessions in the profile. The host's GitHub identity needs the disposable repository permissions described in deployment for normal Ticket execution and PRs. Do not queue the candidate during this smoke check. Only an authorized operator publishes the seed; the script never contacts a service, pushes, opens a PR, or starts the host. Mark unavailable steps **not run**.

1. Publish the selected seed unchanged as the disposable repository's default branch and bind it to the isolated project. Submit the behavior change through the Hub. Keep a record of the exact project, Ticket ID (not the GitHub issue number), Worker Session, pinned base, worktree and PR. Do not grant a Session extra tools or writer rights to make the smoke pass.
2. For the exportable run, use the foreground `bash` or `pwsh` command printed by `seed`, with explicit `workdir` set to the absolute Ticket worktree. These wrappers preserve the Node runner's exit and print it into the recorded shell result; they exit the shell, so do not use them with persistent shell tools. Watch the Worker load all three Worker skills, reproduce the named assertion on the untouched seed base, then make the change. A dirty green feedback run is fine but does not substitute for rerunning on the clean committed candidate. Use the exact same wrapper for the pinned green check. Keep the fixture tests and revision stamp unchanged.
3. Confirm `orchestrator_test_evidence` names the full candidate and expected scope. For this smoke, record the single canonical command in both `red` (seed base) and `checks` (candidate), with directory `.`. Inspect the scope rationale, the Worker's report and PR description, the matching PR head, and any required CI and independent reviews separately. Do not treat a `reported_passed` result as proof of coverage.
4. **Restart negative:** Keep the old report and snapshot. Interrupt an authorized follow-up; once the host and writer jobs are stopped, advance the Ticket branch in its own worktree with an authorized commit. Exporting the old snapshot under the new SHA must fail. On restart the Worker must read the new HEAD and diff, reconsider scope, run the applicable checks again and bind a fresh report and PR to the new revision. A follow-up that changes the fixture or uses different coverage must be reviewed manually rather than forced through this seed-specific exporter.
5. **Authorization and classification negatives:** With two Tickets on distinct candidates, asking one active Worker to record the other Ticket's SHA must be refused. Trying to export the other Ticket's Session under the first Ticket ID must also fail. On the contract case, provider-only coverage (even if its check passes or the Worker tool says `reported_passed`) is incomplete. Withhold readiness and expect the `consumers` export to refuse it until both real consumer assertions run on the candidate.

### Export the recorded Worker evidence (offline)

Use the Session header's **Download session log** action in the authorized Harness Web profile, selecting the exact Worker Session for the Ticket. In the deployment-pinned Web host **0.2.1-rc.3**, [`@deepseek-ai/dsh-session-log-export`](https://www.npmjs.com/package/@deepseek-ai/dsh-session-log-export/v/0.2.1-rc.3) produces a ZIP with a canonical root `session.v4.jsonl`: one Session header followed by ordered durable events. `/export` in that Session also starts the browser download. Extract **only the root** `session.v4.jsonl` into a private disposable directory, not a descendant log or a Markdown transcript. The raw archive and JSONL can contain unrelated history, attachments, and sensitive data; do not share or commit them.

```sh
# From plugin/; substitute the recorded Ticket ID, base, candidate and JSONL file.
node scripts/worker-smoke.mjs export consumers "$TICKET_ID" "$BASE_SHA" "$CANDIDATE_SHA" "$SESSION_JSONL"
```

The script reads the supplied file (up to 64 MiB), writes only the filtered JSON to standard output, and never connects to the host. It requires the exact unforked `worker-<ticket-id>` Session and Worker preset, call/result links from the durable events, and one matching successful candidate binding. It requires one clean red run at the seed base and one clean green run on the candidate SHA, both after any preceding successful evidence call and before the selected binding. It rejects missing, mismatched, incomplete or ambiguous evidence rather than selecting a likely substitute. This contract supports these four seeds and direct foreground tool calls on the pinned Web snapshot format; background jobs, other commands, test-only red revisions, forked Sessions and changed formats are not accepted by this exporter.

The output keeps skill names and call/result sequence references, fixture assertion outcomes, revision stamps, runner exits, and the candidate tool's separate `worker_reported` fields. `runner_exit` comes from the shell wrapper recorded in the result; the pinned host emits a separate nonzero exit marker on red and no exit marker on success. A missing marker is not an observed zero. No raw stdout/stderr, Worker rationale or observations, paths, model prompts, or unrelated history are included. This is a filtered record supplied by the operator, **not attestation**, proof of active authorization now, or independent proof that commands were truthful or a diff is adequately tested. Keep the Harness version/model, scope reason, recovery/refusal references, reports, matching PR heads and required CI links in the private smoke record or PR as appropriate, outside the Doc Tree.

## Pin the candidate and review

1. Finish writes for the first runnable slice, commit it, and pin the actual full lowercase base and candidate SHAs. Choose evidence mode before dispatch. For a Worker Ticket, delegate both lanes in one parallel round to native Worker child Sessions eligible for `orchestrator_review_submit`; give both the same pair and require each to load `dsh-worker-code-review`. Give `standards` the repository guidance and Doc Tree sources; give `spec` the ticket, specification and acceptance criteria. The parent supplies a concise index from `git diff --name-status <base>...<candidate>`, plus only necessary source files or changed evidence references, never the full diff.
2. Each reviewer independently verifies the exact base and candidate SHAs against the commits, confirms the candidate is still current and clean for the review, inspects the commit list and fetches the necessary `git diff <base>...<candidate>` and complete relevant files. A mismatch or candidate movement blocks the review. The exact first-message marker for each Worker lane remains `DSH_REVIEW_ASSIGNMENT: {"axis":"standards|spec","base":"<base>","candidate":"<candidate>","generation":<generation>}`, using that reviewer's assigned axis and actual values. A native reviewer submits its own conclusion with `orchestrator_review_submit`, which binds the actual Session and ticket base. A local reviewer without this tool returns the pinned pair, axis, basis, conclusion, blockers and unverified items as text; label it local feedback, not a submitted lane. Local feedback never replaces either Worker submission.
3. Keep the standards and spec lanes independent and report only the assigned axis. Wrong semantics or arguments, a missing interface contract or specification, a revision or identity mismatch, an absent lane, or any blocked conclusion prevents a dual-review pass. Report blockers and whether they are closed, and list every check or claim still unverified; an unrun check is never a pass.

   **Standards:** Check repository constraints and compare Doc Tree claims with the actual backend/API contract. In the pinned candidate, start at the scoped routes and leaves and resolve each local Markdown link relative to its source. Open the actual target, check any fragment, and follow links in Markdown targets in turn, visiting each page once. Include targets outside the diff and the declared `root`, `routes` and `leaves`; a [structural result](011-doc-tree-impact.md#worker-tool-contract) is not a substitute. If the language server identifies a reference in another checkout, discard it and read the source by absolute path in the verified worktree, confirming it matches the pinned candidate.

   **Spec:** Map every Ticket acceptance criterion to evidence through a public entry. For each criterion, cite at least one observable success and one observable rejection. For external writes, also check recovery from interruption after the write but before the local receipt. Restart must read the actual target and record the missing receipt for the verified write without issuing it again.

   For [formal closure](003-execution.md#formal-plan-closure), record the actual target ref and HEAD SHA alongside the reviewed base and candidate. Prove the intent's integration commit is reachable from that HEAD and repeat the scoped link walk there. A closed PR or completed checks without that commit are not delivery. Before signing off, reread the target ref and recheck the live worktree's identity, candidate, writer generation and cleanliness. If a link is broken, the worktree is dirty, or the candidate, target HEAD or worktree state changed during the check, block rather than reusing a prior pass.
4. Inspect the aggregate in `ticket/<id>/reviews` after both submissions. The first-slice review is a focused gate before broader checks. Repeat both lanes for the complete candidate after committing it and recording the selected local verification and doc impact, providing a fresh concise name-status index and necessary evidence references. A blocked review stops the gate; correct the blocker and dispatch both lanes on the new pair. Keep each candidate fixed during its review round; a moved candidate or restart invalidates stale reviews and requires new independent reviews on the actual pair. Unrelated branch work may continue without changing the pinned candidate.

   When the change concerns worktree ownership or recovery, review the actual runtime paths. Passing static checks alone does not establish who may reuse a worktree or what happens after interruption.

   For replay of an external write, the spec lane checks attribution on the first runnable slice: what distinguishes this intent's result from the same outcome caused by another writer? Test both a lost receipt after this intent's write and an interruption followed by an outside write. Require recovery to recognize its own result without writing twice and to withhold proof for the outside result.
5. Begin the first retro only after both independent submissions pass for the same live base, candidate and writer generation. Start another matching review round whenever a repair changes the candidate. A prior approval is not approval of the new pair.

## Delivery-check

The delivery-check gate applies to Tickets linked to a registered Plan and the acceptance contract of their active or superseded node. A missing Plan contract leaves the gate incomplete. Tickets without a Plan keep their own acceptance criteria, candidate verification, required CI and ordinary report/PR handoff; they do not receive canonical Plan IDs or a `ready_to_queue` result.

### Failed-check continuity

`ticket/<id>/failed-checks` lists the recorded failures, including declared red runs, and their most recent matching Worker reruns on the active candidate and writer generation. An authenticated independent review child can read this paginated resource for its own Ticket, without seeing the other lane's decisions. `ticket/<id>/delivery-check` adds each confirmed axis in `local.failed_checks`.

For each failure, both reviewers inspect the original assertion, its counterpart in the new commit, and the actual rerun of the same command. Submit `retainedChecks: [{failure, rerun, originalPath, currentPath, rationale}]` with `orchestrator_review_submit`. Use the exact IDs from the resource and repository-relative committed file paths. The host resolves both paths to Git blobs; the review rationale must establish that the assertion still runs and the criterion has not been weakened. Blob identity and a matching command do not prove assertion equivalence or execution. Unknown proof blocks rather than granting readiness. A previously passing lane may append a confirmation for a new pair, but cannot replace a blocked review or use the other lane's signer.

Queue, replay and formal closure require both current confirmations; a new failure or different rerun needs new confirmations. Replacements inherit failed observations and the identities of completed external checks. Separate failures from the same run remain separate obligations; changing one criterion does not waive checks on unchanged commitments. For the same directory and command, repeating an external run reference is not a fresh rerun, even if the earlier result came in a mixed report or on a replaced Ticket. An identical unlinked result after a distinct failure has a new local observation ID, but still needs independent proof of execution. Standalone Tickets have no Plan retained-check obligations.

### Retro and acceptance

The active Worker writes `orchestrator_retro_evidence` for the full lowercase `candidate` SHA at the clean worktree HEAD. Read `ticket/<id>/delivery-check` through `orchestrator_read` for the evidence order, current gaps and canonical criteria. A Plan criterion ID is the decimal string of the node's one-based Spec acceptance reference; use exactly the IDs returned, not local numbering or replacements.

| `kind` | Required payload and order |
| --- | --- |
| `first-retro` | `findings: [{id, category, summary, evidence, affects?}]` after observed execution evidence and matching dual review of the complete candidate. Inspect the execution and review observations; record `[]` if there are no findings. |
| `repair` | `fixes: [{id, evidence}]` after committing the correction on a clean new SHA. Use the finding ID, or the canonical criterion ID for an acceptance failure, and cite the fix and its observable result. |
| `acceptance` | `results: [{id, status, evidence}]` after the first retro and any required repairs and renewed review. Use `passed`, `failed` or `not_run` and cite the actual result or why it is missing. Account for every canonical criterion with a current result or eligible reaffirmed evidence. |
| `final-retro` | The same `findings` shape after all canonical criteria pass. Inspect the accepted candidate and its evidence. A mandatory finding returns the candidate to repair, fresh dual review and acceptance before a new final retro. |

`evidence` cites openable observations, not the delivery-check package itself. The test and Doc Tree tools return a `read` resource for the exact durable observation; command results, Session events, diffs and CI runs can also be cited. Finding IDs are stable. Classify defects as `correctness`, security issues as `security`, and current quality-standard violations as `standard`; each requires repair. Use `optional` only when all required behavior and standards remain satisfied. The Hub reads `retro-followups` for independent backlog items; these do not block this Ticket or dispatch work. Keep Doc Tree leaves and routes about current facts, not retro discussions.

An acceptance result that cites a durable observation must cite this Ticket and the same base, candidate and writer generation. A passing result cannot cite failed or unrun tests, a Doc Tree check with issues, an absent observation, or one from a prior revision. The host applies this rule on submission and when re-reading the ledger. Reaffirmed evidence retains its original reference and is carried by both independent reviews, not copied into a new acceptance result.

### Repair and evidence reuse

1. In each mandatory finding, name the affected `tests`, `docs` and `acceptance:<id>` keys. Omit `affects` if the scope is uncertain; that invalidates all keys. Fix every mandatory finding and record it on the new commit. Compare the old and new pairs, including actual consumers, and treat any additional impact identified in the repair diff as affected. A base change requires reassessing the entire scope.
2. Reacquire affected test, document and acceptance evidence. For any unchanged passing result proposed for reuse, provide both review lanes its key, original reference and why the repair leaves that observation applicable. Both fresh reviewers must independently check the claim and include the exact key in `orchestrator_review_submit.reuses`; without both affirmations, obtain a fresh observation. Never copy an old approval or claim an affected result under a new SHA. After a repair, start both lanes on the fixed pair, with a concise `git diff --name-status <base>...<candidate>` index, any necessary source or changed evidence references, and no full diff. Each reviewer verifies the exact SHAs and independently obtains the repair diff and complete relevant files on its axis. A changed or stale candidate invalidates that round and any prior approval. Report blockers as closed or open and list unresolved verification explicitly. If all criteria retain an unaffected passing result reaffirmed by both reviews, no new acceptance submission is needed. If the timeline does not retain the first retro for the live pair, complete it again after matching dual review and before acceptance.
3. On restart, read the live verified worktree, its clean HEAD, pinned base, writer generation and any PR head, then reconcile them with the durable review and delivery-check records. A stale read or old HEAD cannot support a pass for evidence touched by the repair. Incomplete or stale review is not approval; reacquire invalid or uncertain evidence for the real candidate before continuing. Wait only for an unresolved contract clarification that materially changes the required behavior, and keep independent work moving.

### Read the candidate package and CI

The Hub and the Ticket's active Worker can read `ticket/<id>/delivery-check`. Follow the Ticket detail pointer and continue through the paginated evidence for the pinned base and candidate, canonical criteria and per-criterion results, both review lanes, recorded tests and doc impact, and the first retro, repairs and final retro in order. Each timeline event and review has a `read` resource for its durable record, including the original revision of any reaffirmed observation. Use those references to inspect the records and the package's `missing` list to identify gaps.

Required CI is separate from local evidence. Configure the required workflow IDs and jobs; an empty or incomplete configuration does not verify CI. The package includes the version-scoped Actions result and available run, job and artifact references. An associated PR must still match the pinned base and candidate after querying Actions. A failed, cancelled, pending, missing or wrong-version required run does not pass. See [CI build and commit evidence](006-deployment.md#ci-build-and-commit-evidence).

Without an associated PR, the delivery gate accepts only `push` or `workflow_dispatch` runs from the verified candidate branch at the exact candidate SHA. A PR run from a different branch or base does not substitute for it.

`ready_to_queue` is candidate readiness; `return_for_recheck` lists unmet queue gates. `mainline` is the independent queue observation, or `pending_merge` before the first attempt. The Plan-only `formal_delivery` field separately reads `pending` while a verified attempt awaits closure, `blocked` with `missing` codes, or `delivered` with the durable receipt. Use that field for formal delivery, not `ready_to_queue`, a Worker report, PR state or `mainline.status` alone.

At the Git write, the queue pins which CI lookup passed: the associated PR number on the reviewed base or the candidate's branch. [Formal closure](003-execution.md#formal-plan-closure) re-reads Actions for that same candidate and lookup, under the required-check configuration. It does not require the PR to still be open after the actual merge and does not use PR closure as merge evidence.

## Handoff evidence

Record the pinned pair, ticket and relevant file paths, actual verification results with log or run references, and unresolved risks in the review or PR, not in the Doc Tree. Distinguish failed, pending and not-run checks. Tool tests do not establish live model behavior; use the applicable smoke procedure for those claims, such as [real Worker Doc Tree verification](011-doc-tree-impact.md#real-worker-smoke-check).
