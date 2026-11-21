# 013 Development verification

## Locate and test the change

Start with the ticket's acceptance criteria and prerequisites. Follow the repository's `DOCS.md` to the owner of the changed behavior. Read the cited spec sections and the related source and tests; broaden the search only if those references cannot answer a question.

Run focused checks from `plugin/` as soon as the change is runnable. Pass the relevant paths to `pnpm test`, taking the union when a change spans rows. For example, run `pnpm test tests/docs.spec.ts tests/doc-tree.spec.ts` when a change affects both the documentation routes and the candidate checker.

| Change | Existing checks |
| --- | --- |
| New class or source module | Run `pnpm test tests/class-docs.spec.ts tests/docs.spec.ts` before the full check. Fix missing class JSDoc and missing module or test index entries before proceeding. |
| Source imports or import boundary gate | `pnpm check:imports` on the current sources; when changing the gate itself, also run `pnpm test tests/import-boundaries.spec.ts`. |
| Session tool or model-facing schema | `tests/tools.spec.ts` for public behavior and role boundaries; `tests/model-surface.spec.ts` for the registered surface and prompt budget |
| Bundled skill or prompt registration | `tests/prompts.spec.ts`, `tests/model-surface.spec.ts`, `tests/tools.spec.ts` and `tests/panel-prompts.spec.tsx` for role scope, resource inventory and settings labels |
| Prompt text or built-in delivery guidance | `tests/cards.spec.ts` for prompt contracts and budgets, plus the registration checks above when the mounted surface changes |
| Doc Tree routes or committed-candidate inspection | `tests/docs.spec.ts` for this repository's navigation and source/test index; `tests/doc-tree.spec.ts` for Git snapshots and target-repository navigation |
| Project selection or crash recovery | `pnpm test tests/runtime-crash.spec.ts`; for a deployed headless host, record the [live connection smoke check](006-deployment.md#live-headless-connection-smoke-check) separately. |

## Worker implementation and test evidence

For an authorized implementation Ticket, the Worker loads `dsh-worker-implement` before editing. Read `ticket/<id>` with `orchestrator_read` to confirm the verified worktree and pinned base. Keep edits and checks in that worktree.

1. Load `dsh-worker-test-scope`. Start with the Ticket's acceptance criteria and the diff from the pinned base. Locate the public entry that exposes the behavior, the existing runner and its focused and full-suite commands. Identify required CI separately.
2. Load `dsh-worker-tdd` for each changed behavior. Reproduce the expected failure through the authorized public entry on a reproducible red revision. Use an existing regression check when it already reaches the failing assertion. Otherwise add or extend a check and pin its test-only red commit. Confirm that the runner reached the assertion and record the revision, working directory, exact command, failure output and exit status. A setup failure, skipped case or empty run leaves red unverified.
3. Make the smallest change that satisfies the behavior. Run the same check and confirm that the same assertion passes. Keep the regression check in the candidate. Complete one red–green cycle before starting the next.
4. Finish writes and review the complete diff. Select the verification scope using the table below. Run the selected checks on the clean committed candidate and retain actual command outcomes. Include any required CI and independent review under the repository's delivery rules.
5. Call `orchestrator_test_evidence` for the candidate. Keep the returned evidence in the existing `orchestrator_report` summary and the candidate's PR description when there is a PR. Include prerequisites, the red assertion and matching green run, and links or references to logs or Session events. Check that the report and PR name the same base and candidate as the evidence.

| Scope | When to select it |
| --- | --- |
| `focused` | A local change with a known public seam and no affected consumer contracts. Use the narrowest existing check that exercises the behavior or the closest suitable coverage. |
| `consumers` | A contract change with known affected consumers. Trace real call sites and dependency paths, then check the provider and its affected consumers through that contract. |
| `full` | Shared infrastructure, an uncertain consumer list or dependency cycles make the impact unclear. Run the repository's full suite. |

On resumption, read the actual worktree HEAD, base-to-candidate diff, prior reports and PR state. Evidence remains tied to the observed pair. If HEAD or the base changed, re-evaluate scope and reacquire evidence for the current pair. Reuse a red observation only when its recorded revision still reproduces the same assertion failure and the same regression check is present in the current candidate. Record unknown outcomes as unverified.

### Worker test evidence tool

Only the active Worker for the Ticket can call `orchestrator_test_evidence`. It revalidates the writer and resolves the worktree and pinned base. The candidate must equal the worktree's HEAD. The worktree must have no staged, unstaged or untracked changes reported by Git. Each red revision must descend from the pinned base or equal it, and be a strict ancestor of the candidate.

| Input | Meaning |
| --- | --- |
| `candidate` | The full lowercase commit SHA of the candidate. |
| `scope` | `focused`, `consumers` or `full`. |
| `reason` | Why the selected scope covers the current diff and its affected consumers. |
| `checks` | A list of `{directory, command, status, observed}` records. Give the working directory relative to the worktree, the exact command, and what was observed. Use `passed`, `failed`, `not_run`, `pending` or `cancelled` for `status`. |
| `red` | An array of `{revision, directory, command, observed}` records for reproducible red runs. Use `[]` if a required red is unavailable and `null` if the change requires no red. Name the full revision, worktree-relative directory, exact command and observed assertion failure. |

The result identifies the candidate and pinned base and has `source` set to `worker`. It returns `failed` when a check is reported as failed. It returns `reported_passed` when the Worker reports at least one check and all listed checks passed, and either no red was required or a nonempty red list has a matching candidate check for each command and directory. All other cases return `unverified`. The tool verifies Git identity. The Worker supplies run observations and scope rationale. Report ready only when the evidence covers the selected scope, including actual consumers for changed contracts. Apply required CI and review gates before delivery.

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

1. Finish writes for the first runnable slice, commit it, and pin the actual full lowercase base and candidate SHAs. In the same round, dispatch two independent `code-review` subagents in parallel. Give them the identical pair, and load `dsh-worker-code-review` in each. The `standards` reviewer receives repository guidance and Doc Tree sources; the `spec` reviewer receives the ticket, specification and acceptance sources. A reviewer that must wait still starts in that parallel dispatch.
2. Each reviewer independently runs `git diff <base>...<candidate>` and inspects the commit list, then submits its own evidence through `orchestrator_review_submit`; the implementer never writes a review conclusion for either lane. The submission identifies reviewer Session, axis, basis, base, candidate, conclusion, blockers and summary. The runtime binds the actual reviewer Session and ticket base and exposes both lanes and aggregate state in review evidence.
3. The standards lane checks repository constraints, Doc Tree requirements and actual backend/API contracts and semantics. The spec lane checks the specification, ticket acceptance criteria, required behavior and verification evidence. A correct citation or link does not excuse a wrong API argument or semantic contract. Wrong semantics or arguments, missing interface contract, missing specification, mismatched revisions, an absent lane, or any blocked conclusion prevents a dual-review pass.
4. Wait for both submissions and inspect the aggregate review state before reporting ready. The first-slice review is a focused gate before broader checks; repeat the two-lane process for the complete candidate after committing it and running selected checks. After any fix, amendment or base move, pin the new actual pair and restart both reviewers together; prior prose is context, never approval for a new pair.

   Leave worktree ownership and recovery semantics to the review agents. Passing static checks does not establish who may reuse a worktree or what happens when execution resumes after an interruption.
5. On resumption, read the actual HEAD/base and review records. If a reviewer did not finish before Worker restart, discard any old candidate's text as approval and launch both reviewers again for the current pinned pair. Never report ready while either lane is missing, blocked or tied to another version. Confirm required CI results cover the final PR head before merging.

## Handoff evidence

Record the pinned pair, ticket and relevant file paths, actual verification results with log or run references, and unresolved risks in the review or PR, not in the Doc Tree. Distinguish failed, pending and not-run checks. Tool tests do not establish live model behavior; use the applicable smoke procedure for those claims, such as [real Worker Doc Tree verification](011-doc-tree-impact.md#real-worker-smoke-check).
