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

## Live Worker test evidence smoke check

Use a separate profile, a supported Harness version, a working model and a disposable GitHub repository authorized for test Tickets, branches and pull requests. Follow [deployment](006-deployment.md) and keep [manual merging](003-execution.md#merging) enabled so each PR stays open for comparison. Use separate seed bases for the positive cases so the deliberately failing check stays out of the other runs. Run the smoke cases through normal Hub intake and let the real Worker choose and run commands. Mark a case not run if its prerequisites are missing.

1. Seed an existing public regression check that fails at a named assertion on a local behavior. Provide a focused runner and a full suite. Open a Ticket that names the behavior to fix. In the Worker transcript, confirm the skill loads, the focused check fails at that assertion before the implementation edit, and the same command and assertion pass on the clean committed fix. Confirm the tool call names both revisions, the scope is `focused`, and the returned candidate, report and PR head agree.
2. Seed a provider contract with two real call sites and tests that exercise each consumer through the contract. Open a separate Ticket to change that contract. Confirm the Worker's scope reason names the consumers, the transcript shows their checks ran on the committed candidate, and the `consumers` evidence, report and PR agree.
3. Open a separate Ticket for a change to shared testable behavior whose consumer list is uncertain. Give the repository an existing full-suite command. Confirm the Worker selects `full`, explains the uncertainty, and runs that command on the clean committed candidate before recording evidence. Keep the full-suite output and any required CI references with that candidate.
4. For the restart case, retain an existing candidate report and interrupt the Worker while it is handling an authorized follow-up. Once the host is stopped and the writer and its jobs are idle, advance that Ticket's branch in its own worktree with an authorized commit that changes the test scope. Restart the host. Confirm the old report survives as a record of the old SHA. Check that the resumed Worker reads the new HEAD and diff, re-evaluates scope, reruns the selected checks, and records fresh evidence for the new SHA in the report and PR.
5. For the authorization case, use an active Worker in its clean worktree to request evidence naming a different Ticket's distinct candidate SHA. Expect refusal and keep the call and error. For the classification case, inspect evidence for a contract change with only a passing provider check and known untested consumers. Expect the Worker or reviewer to mark that scope incomplete and withhold readiness until the affected consumer checks run.

Keep the Harness version and model, Ticket and PR references, worktree and branch refs, pinned base and full red and candidate SHAs, including both sides of the restart. Retain Worker transcript references for skill loads, Git state, shell runs and outputs, tool calls and responses, refusals, and the recovery turn. Keep the old and fresh reports, matching PR heads and descriptions, and any CI run links outside the Doc Tree. Mark unobserved steps not run.

## Pin the candidate and review

1. Finish all writes, including delegated edits, before validation and review. Record the base and candidate as full commit SHAs. Run candidate checks in a clean checkout of that candidate so local edits cannot affect the result.
2. Give both independent reviewers the same pair and the command `git diff <base-sha> <candidate-sha>`. Give the standards reviewer the applicable repository guidance and the spec reviewer the ticket and acceptance references. Neither conclusion substitutes for the other. The full local check can run in parallel on the clean candidate; see [development checks](006-deployment.md#development-checks) for the command and for matching CI evidence to the PR head.

   Leave worktree ownership and recovery semantics to the review agents. Passing static checks does not establish who may reuse a worktree or what happens when execution resumes after an interruption.
3. After an amendment or a base move, pin the new pair, rerun affected checks and have both reviewers assess the new diff. Prior findings are context, not sign-off on the new pair. Before merging, confirm that the reviews cover that pair and the required CI results cover the final PR head. After an interruption, check the actual Git and PR state before reusing any result.

## Handoff evidence

Record the pinned pair, ticket and relevant file paths, actual verification results with log or run references, and unresolved risks in the review or PR, not in the Doc Tree. Distinguish failed, pending and not-run checks. Tool tests do not establish live model behavior; use the applicable smoke procedure for those claims, such as [real Worker Doc Tree verification](011-doc-tree-impact.md#real-worker-smoke-check).
