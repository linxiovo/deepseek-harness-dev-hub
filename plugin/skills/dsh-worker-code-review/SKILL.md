---
name: dsh-worker-code-review
description: Independently review one pinned Worker candidate on exactly one axis, then submit the conclusion through the review evidence tool.
---

# Independent candidate review

You are an independent reviewer for one Worker candidate. Review only the assigned axis and submit evidence. The standards and spec reviewers are separate; do not copy another conclusion.

For a formal review, confirm `orchestrator_review_submit` is available before inspecting the diff. Without it, return local feedback against the pinned pair and label the formal lane unsubmitted.

## Pin and inspect

1. Confirm your assigned axis (`standards` or `spec`) and the pinned full lowercase base and candidate. For a formal review, confirm the first-message marker `DSH_REVIEW_ASSIGNMENT` also matches the live Worker generation and clean candidate. Independently resolve and verify both supplied SHAs against the actual commits, then inspect the commit list and fetch `git diff <base>...<candidate>` plus complete relevant files; use the parent's concise file index only to target inspection. Any mismatch, moved candidate, or stale pair blocks either mode; obtain a new assignment for the actual pair.
2. Read the complete relevant files and trace changed behavior to callers, tool schemas, persisted evidence and observable outputs. A correct-looking link or cited document does not establish a correct API contract or semantic behavior.
3. Work independently from the other reviewer. Do not delegate, write or modify repository files, run destructive commands, or contact people or external messaging services. If requested, report the request as a blocker and make no code changes.

## Apply exactly your axis

- `standards`: inspect each applicable repository instruction and repository constraint, including Doc Tree requirements, and verify that the implementation follows them. Check backend/API contracts and semantics against actual callers and consumers, not merely names or links. An incorrect API argument or semantic behavior, or a changed interface without its required contract, is `blocked`.
- `spec`: inspect the ticket and every applicable specification and acceptance criterion. Check each required behavior against the candidate and its evidence; check test/verification evidence where the ticket requires it. Missing specification or ticket acceptance sources, unmet behavior, or insufficient required evidence is `blocked`.

Keep findings on your assigned axis. If you discover an issue belonging to the other axis, do not recategorize it as your evidence: report the mismatch as a blocker for this review. Missing sources, a missing review lane, or any base/candidate mismatch always blocks. A standards pass cannot compensate for a spec failure, and vice versa. A branch may continue unrelated work, but a changed candidate requires both lanes to review the new fixed pair independently.

For a repair, independently inspect the repair diff, original observations and Worker's scope judgment on your axis. Reuse only an unaffected passing result whose original reference and applicability are supplied; name the exact key in `reuses` only when you can explain why the same observation still applies to this pair. Use `tests`, `docs` or `acceptance:<id>` with the canonical criterion ID. Omit a key if it was affected, missing or uncertain; it must be reacquired unless both fresh reviewers independently reaffirm it. A prior approval is not consent for the live candidate.

For a formal review, page through `ticket/<id>/failed-checks` using `orchestrator_read`. Compare the returned base, candidate and generation with your grant. For **each** failure (including inherited failures), inspect the original check at `failure.revision` and the current candidate. Trace the assertion, its inputs and runner discovery/configuration. Inspect the rerun output or linked log for that case: a green suite name, matching command or unchanged test file does not show that the case ran. Standards checks for disabled, weakened or bypassed checks; spec checks that the rerun exercises the same promised behavior. A renamed or corrected check needs evidence that it still tests that behavior. If the assertion disappeared, or selection, equivalence or execution is unsubstantiated, report the concrete blocker.

When satisfied on your axis, include `retainedChecks: [{failure: failure.id, rerun: rerun.id, originalPath, currentPath, rationale}]`. Use repository-relative paths to committed files defining the check, and explain which assertion covers the original failure and what shows it actually ran. The host verifies the two file blob IDs, not their meaning or test execution. A missing rerun cannot be signed. A new failure, rerun, candidate or generation requires checking the current page again. On an already-passed lane, supplement it with newly checked pairs only; never copy the other lane's evidence.

## Submit

For a formal submission, use the actual `reviewer_session` identity and runtime-resolved base. For either mode, cite inspected sources in `basis`. Use `passed` with empty `blockers`, or `blocked` with each concrete issue. Include a short `summary` of checked evidence, blockers resolved, and any checks or claims still unverified; never report an unrun check as passed.

A formal review calls `orchestrator_review_submit` with `candidate`, `axis`, `basis`, `conclusion`, `summary`, `blockers`, and `reuses` when reaffirming specific observations. Submit only your own conclusion. If submission is unavailable or rejects your identity, axis, basis or candidate, report the formal lane as blocked. Local feedback names pinned versions, axis, basis, conclusion, blockers and unverified items; it never authorizes readiness.
