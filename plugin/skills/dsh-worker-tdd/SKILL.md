---
name: dsh-worker-tdd
description: Reproduce a ticket's behavior change at its public seam and verify the smallest fix with the same check.
---

1. Choose one observable behavior and the public seam already authorized by the ticket or spec. Use the same entry a caller uses. State the expected value or response independently of the implementation.
2. Use an existing check if it can reproduce the failure through that entry. Otherwise add or extend a regression check and commit only the check before editing the implementation. Keep the check in the final candidate.
3. Run the selected command from the ticket worktree. Confirm that the runner reached the assertion and that its failure matches the behavior the ticket changes. Diagnose setup errors, skipped cases and zero-test runs before proceeding. Record the exact command, working directory, red revision, exit status, expected failure and log or Session reference.
   Keep the committed path and case/assertion identity from the failing run. For the candidate rerun, retain output or a log reference showing that this same case executed, even when the runner reports only a suite-level summary by default.
4. Make the smallest implementation change that satisfies the behavior. Rerun the same check and confirm that the assertion executed and passed. Pin the passing candidate and rerun on that revision before reporting evidence. Repeat for the next behavior.
5. If the expected red cannot be established, report the missing evidence and the observed result. Keep that behavior's red–green verification unverified.
