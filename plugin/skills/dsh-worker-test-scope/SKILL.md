---
name: dsh-worker-test-scope
description: Select tests for fast feedback and candidate verification based on the change, its consumers, and required CI.
---

1. Start with the acceptance criteria and the current base-to-candidate diff. Find the public seams that expose the changed behavior, such as exported APIs, routes, commands, or data formats. Inspect nearby tests, repository scripts, and CI configuration to identify the existing runner, its focused and full-suite entries, and the checks required for merge.
   If the repository documents a focused-check table, select the relevant rows before delegating implementation; give each slice its check entry and assign overlapping checks to one integration runner.
2. For an internal change, run the narrowest existing check that exercises the changed behavior through a public seam first. If there is no narrow entry, use suitable existing coverage at the closest available scope or create a focused entry using the repository's test conventions.
3. For a changed contract, trace real call sites and dependency paths. Select `consumers` to verify the provider, affected modules and actual consumers through the changed contract. Select `full` whenever the change touches shared test infrastructure or the impact cannot be bounded reliably. Use `focused` for a known local change with no affected contract.
4. Keep the repository's required CI checks and their required status. Record why the local checks cover the diff and whether all selected checks ran and passed on the candidate. Track required CI results for that version under the repository's merge rules.
5. After interruption or restart, inspect the actual HEAD and diff, then reassess scope for a changed candidate or base. Before dispatching a test slice that covers recovery, name its exact interruption point and observable state before and after it. Include the failure path where an external operation completed but its local receipt was not recorded; assert that recovery reconciles it without repeating the operation. Include a negative assertion that a misclassified report is not broadcast to a person.
