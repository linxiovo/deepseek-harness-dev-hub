---
name: dsh-worker-implement
description: Implement an authorized coding ticket in its verified worktree and collect reproducible candidate test evidence.
---

1. Read the ticket, its acceptance criteria and the repository guidance. Read `ticket/<id>` with `orchestrator_read` to confirm the worktree and pinned base. Use that worktree for edits and checks.
2. Load `dsh-worker-test-scope` to find the public verification entry and pre-merge coverage. For each behavior change, load `dsh-worker-tdd` and complete one red–green cycle before starting the next.
3. Review the first runnable slice against the request, repository rules and spec. Fix findings before full-suite checks. Review the complete diff against the pinned base and reassess scope. Run the selected checks on the clean committed candidate.
4. Call `orchestrator_test_evidence` with the full candidate SHA, scope and reason, and each check's directory, exact command, status and observed output. Pass each observed red revision with its command, directory and failing assertion. Use `[]` when a required red is missing and `null` for a change with no red required. Retain the result, prerequisites and log or Session references in the `orchestrator_report` summary and PR when one exists. Report ready only after the selected checks ran and passed, red–green evidence is complete, and the evidence covers the declared scope, including actual consumers when their contracts changed.
5. On resumption, check the actual worktree, Git revisions and existing run records. If the candidate or base changed, revisit scope and rerun the checks for the current pair. Reuse a red result only when its exact revision still reproduces the same assertion failure and the candidate contains the same regression check. Report unknown results as unverified.
6. Carry the ticket through self-review, commit, push and PR creation within its authorization. Follow required CI and human review, fix actionable failures and deliver the PR.
