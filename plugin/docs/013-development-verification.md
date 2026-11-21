# 013 Development verification

## Locate and test the change

Start with the ticket's acceptance criteria and prerequisites. Follow the repository's `DOCS.md` to the owner of the changed behavior. Read the cited spec sections and the related source and tests; broaden the search only if those references cannot answer a question.

Before dispatching implementation slices, select their focused checks from this table and name the commands in the handoff. For recovery or retry work, name the exact interruption point before dispatch and the observable result on each side of it; cover an external side effect completed before its local receipt was recorded. The integration owner runs the union from `plugin/` as soon as each affected surface is runnable. On Windows, use one `pnpm test` runner for overlapping checks across independent checkouts; the wrapper serializes them through a named pipe shared by the current Windows account.

| Change | Existing checks |
| --- | --- |
| New class or source module | Run `pnpm test tests/class-docs.spec.ts tests/docs.spec.ts` before the full check. Fix missing class JSDoc and missing module or test index entries before proceeding. |
| Source imports or import boundary gate | `pnpm check:imports` on the current sources; when changing the gate itself, also run `pnpm test tests/import-boundaries.spec.ts`. |
| Session tool, resource or model-facing schema | Run `pnpm test:session-tools` as soon as the first changed tool or prompt is callable, then before the full check. It exercises public behavior, role boundaries, response and prompt budgets, and prompt contracts. |
| Bundled skill or prompt registration | `tests/prompts.spec.ts`, `tests/model-surface.spec.ts`, `tests/tools.spec.ts` and `tests/panel-prompts.spec.tsx` for role scope, resource inventory and settings labels |
| Prompt text or built-in delivery guidance | `tests/cards.spec.ts` for prompt contracts and budgets, plus the registration checks above when the mounted surface changes |
| Doc Tree routes, numbered documents or committed-candidate inspection | `tests/docs.spec.ts` for navigation and source/test indexing; also `tests/doc-tree.spec.ts` when changing the candidate checker |
| Pause, retry or recovery | Run `pnpm test:recovery` for Plan, runtime-concurrency and runtime-crash behavior; for a deployed headless host, record the [live connection smoke check](006-deployment.md#live-headless-connection-smoke-check) separately. |

Run `pnpm check` once at the end. Vitest still limits concurrent Git fixtures within a Windows run. Local verification and CI use the same command and test coverage.

When changing the test runner, verify cross-checkout exclusion, nonzero exits, and interrupted-run release with `node --test tests/probes/test-runner.mjs` from `plugin/`. Run this standalone probe while no other test runner is active, not inside Vitest.

In recovery tests that use real Git worktrees, wait for the controlled teardown to start and for the Runtime to become idle after release; assert delivery without a separate short polling deadline.

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

Use the Web profile from [deployment](006-deployment.md), isolated from normal Sessions, with a working model, Git and Node in the Worker environment, and a disposable GitHub repository per case. The operator needs authorization to create those repositories or seed their default branch, submit implementation Tickets via normal Hub intake, and read the Worker Sessions in the profile. The host's GitHub identity needs the disposable repository permissions described in deployment for normal Ticket execution and PRs. Keep [manual merging](003-execution.md#merging) enabled. Only an authorized operator publishes the seed; the script never contacts a service, pushes, opens a PR, or starts the host. Mark unavailable steps **not run**.

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
3. The standards lane checks repository constraints, Doc Tree requirements and actual backend/API contracts and semantics. The spec lane checks the specification, ticket acceptance criteria, required behavior and verification evidence. Each remains independent and reports only its assigned axis; a correct citation or link does not excuse a wrong API argument or semantic contract. Wrong semantics or arguments, missing interface contract or specification, mismatched revisions or identity, an absent lane, or any blocked conclusion prevents a dual-review pass. Report blockers and whether they are closed, and list every check or claim still unverified; an unrun check is never a pass.
4. Inspect the aggregate in `ticket/<id>/reviews` after both submissions. The first-slice review is a focused gate before broader checks. Repeat both lanes for the complete candidate after committing it and recording the selected local verification and doc impact, providing a fresh concise name-status index and necessary evidence references. A blocked review stops the gate; correct the blocker and dispatch both lanes on the new pair. Keep each candidate fixed during its review round; a moved candidate or restart invalidates stale reviews and requires new independent reviews on the actual pair. Unrelated branch work may continue without changing the pinned candidate.

   When the change concerns worktree ownership or recovery, review the actual runtime paths. Passing static checks alone does not establish who may reuse a worktree or what happens after interruption.
5. Begin the first retro only after both independent submissions pass for the same live base, candidate and writer generation. Start another matching review round whenever a repair changes the candidate. A prior approval is not approval of the new pair.

## Delivery-check

The delivery-check gate applies to Tickets linked to an immutable registered Plan and its specification. A missing Plan or specification for a Plan Ticket leaves the gate incomplete. Tickets without a Plan keep their own acceptance criteria, candidate verification, required CI and ordinary report/PR handoff; they do not receive canonical Plan IDs or a `ready_to_queue` result.

### Retro and acceptance

The active Worker writes `orchestrator_retro_evidence` for the full lowercase `candidate` SHA at the clean worktree HEAD. Read `ticket/<id>/delivery-check` through `orchestrator_read` for the evidence order, current gaps and canonical criteria. A Plan criterion ID is the decimal string of the node's one-based Spec acceptance reference; use exactly the IDs returned, not local numbering or replacements.

| `kind` | Required payload and order |
| --- | --- |
| `first-retro` | `findings: [{id, category, summary, evidence, affects?}]` after observed execution evidence and matching dual review of the complete candidate. Inspect the execution and review observations; record `[]` if there are no findings. |
| `repair` | `fixes: [{id, evidence}]` after committing the correction on a clean new SHA. Use the finding ID, or the canonical criterion ID for an acceptance failure, and cite the fix and its observable result. |
| `acceptance` | `results: [{id, status, evidence}]` after the first retro and any required repairs and renewed review. Use `passed`, `failed` or `not_run` and cite the actual result or why it is missing. Account for every canonical criterion with a current result or eligible reaffirmed evidence. |
| `final-retro` | The same `findings` shape after all canonical criteria pass. Inspect the accepted candidate and its evidence. A mandatory finding returns the candidate to repair, fresh dual review and acceptance before a new final retro. |

`evidence` cites openable observations, not the delivery-check package itself. The test and Doc Tree tools return a `read` resource for the exact durable observation; command results, Session events, diffs and CI runs can also be cited. Finding IDs are stable. Classify defects as `correctness`, security issues as `security`, and current quality-standard violations as `standard`; each requires repair. Use `optional` only when all required behavior and standards remain satisfied. The Hub reads `retro-followups` for independent backlog items; these do not block this Ticket or dispatch work. Keep Doc Tree leaves and routes about current facts, not retro discussions.

An acceptance result that cites a durable observation must cite this Ticket and the same base, candidate and writer generation. The gate refuses a missing observation or one from a prior candidate. Reaffirmed evidence retains its original reference and is carried by both independent reviews, not copied into a new acceptance result.

### Repair and evidence reuse

1. In each mandatory finding, name the affected `tests`, `docs` and `acceptance:<id>` keys. Omit `affects` if the scope is uncertain; that invalidates all keys. Fix every mandatory finding and record it on the new commit. Compare the old and new pairs, including actual consumers, and treat any additional impact identified in the repair diff as affected. A base change requires reassessing the entire scope.
2. Reacquire affected test, document and acceptance evidence. For any unchanged passing result proposed for reuse, provide both review lanes its key, original reference and why the repair leaves that observation applicable. Both fresh reviewers must independently check the claim and include the exact key in `orchestrator_review_submit.reuses`; without both affirmations, obtain a fresh observation. Never copy an old approval or claim an affected result under a new SHA. After a repair, start both lanes on the fixed pair, with a concise `git diff --name-status <base>...<candidate>` index, any necessary source or changed evidence references, and no full diff. Each reviewer verifies the exact SHAs and independently obtains the repair diff and complete relevant files on its axis. A changed or stale candidate invalidates that round and any prior approval. Report blockers as closed or open and list unresolved verification explicitly. After a repair record at least one fresh acceptance result; if the timeline does not retain the first retro for the live pair, complete it again after matching dual review and before acceptance.
3. On restart, read the live verified worktree, its clean HEAD, pinned base, writer generation and any PR head, then reconcile them with the durable review and delivery-check records. A stale read or old HEAD cannot support a pass for evidence touched by the repair. Incomplete or stale review is not approval; reacquire invalid or uncertain evidence for the real candidate before continuing. Wait only for an unresolved contract clarification that materially changes the required behavior, and keep independent work moving.

### Read the candidate package and CI

The Hub and the Ticket's active Worker can read `ticket/<id>/delivery-check`. Follow the Ticket detail pointer and continue through the paginated evidence for the pinned base and candidate, canonical criteria and per-criterion results, both review lanes, recorded tests and doc impact, and the first retro, repairs and final retro in order. Follow the evidence references to confirm the observations and use the package's `missing` list to identify gaps.

Required CI is separate from local evidence. Configure the required workflow IDs and jobs; an empty or incomplete configuration does not verify CI. The package includes the version-scoped Actions result and available run, job and artifact references. An associated PR must still match the pinned base and candidate after querying Actions. A failed, cancelled, pending, missing or wrong-version required run does not pass. See [CI build and commit evidence](006-deployment.md#ci-build-and-commit-evidence).

`ready_to_queue` is candidate readiness; `return_for_recheck` lists unmet gates. `mainline.status: pending_merge` means this package does not verify the result on mainline. It does not release a version, close a Ticket, record formal delivery or unlock a successor; those effects do not follow from a Worker report or PR closure. See [Frontier dispatch and claims](009-handoff.md#frontier-dispatch-and-claims) for the separate receipt boundary.

## Handoff evidence

Record the pinned pair, ticket and relevant file paths, actual verification results with log or run references, and unresolved risks in the review or PR, not in the Doc Tree. Distinguish failed, pending and not-run checks. Tool tests do not establish live model behavior; use the applicable smoke procedure for those claims, such as [real Worker Doc Tree verification](011-doc-tree-impact.md#real-worker-smoke-check).
