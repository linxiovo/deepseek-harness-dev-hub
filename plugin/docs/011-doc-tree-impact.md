# 011 Doc Tree impact

The Worker keeps documentation and implementation in the same verified ticket worktree. The `dsh-superagent-doc-tree` skill is the Worker procedure for finding the smallest responsibility leaf, updating contracts and routes alongside code, or explaining why current facts do not change. A backend interface leaf describes the path, method, inputs, outputs, errors and verification from the frontend consumer's perspective. The leaf is part of the backend candidate, not a separate handoff copy.

## Worker tool contract

`orchestrator_doc_impact` is a read-only Session tool restricted to the active Worker of that ticket. The caller cannot supply a checkout, repo, branch or base. The executor revalidates the ticket grant and its real linked worktree and reads the pinned base and current candidate from Git. The caller supplies a complete lowercase `candidate` commit hash; a stale or foreign candidate, a mismatched worktree, or a lost writer grant fails the call. It inspects committed objects only, so an uncommitted correction does not repair evidence for a commit.

| Input | Meaning |
| --- | --- |
| `root`, `routes`, `leaves` | Repository-relative Markdown paths for the navigation entry and the relevant expected route and leaf inventory. Use `root: null` and empty lists only for an unchanged result in a repository without navigation. |
| `impact.kind: updated` | `documents` lists changed Doc Tree paths, including removed paths. A path that remains in the candidate needs a route or leaf declaration. `contracts` is the subset that are current interface contract leaves. The tool refuses unchanged paths claimed as updates and changed declared nodes omitted from `documents`. |
| `impact.kind: unchanged` | `reason` is a short, falsifiable explanation; the tool refuses this declaration if a scoped document changed. |

The result contains the resolved `candidate`, pinned `base`, declared `scope` and `impact`, and `structure` (`checked`, `issues`, or `not-applicable`). `issues` gives the kind and path, and the target where pertinent, for broken links, invalid navigation and unreachable declared nodes. A conventional `DOCS.md` in the candidate requires a declared root. The checker reads Markdown links and images, including reference-style destinations, and checks GitHub heading fragments and explicit HTML anchors in Markdown targets. On route pages, list and table links to declared nodes form navigation edges; other links are checked without adding edges. Changed Markdown destinations in those lists and tables must be declared; unchanged out-of-scope siblings are not recursively opened. External links and raw HTML link destinations are not checked. If the scan exceeds 512 distinct local paths, it fails rather than returning partial success.

Structure is not a full inventory or a comparison with source. A well-formed link does not prove it points to the authoritative leaf; `semantic_review` is always `required`.

The Worker records the candidate and base, document diff paths or unchanged rationale, and actual structural results and limits in the internal report and the candidate's PR description. After a restart, amendment or change of base, it checks the actual worktree and repeats evidence for the current revision. A tool result does not approve or merge the candidate, change ticket state, or unlock any successor. Independent reviewers check the scope and compare the stated contract to the candidate code and public verification.

Semantic review is a separate dual-review fact, not a structural checker result. The standards and specification reviewers submit their own conclusions through `orchestrator_review_submit`; `ticket/<id>/reviews` retains each reviewer identity, basis, pinned base, candidate and blockers. A structurally valid link does not pass when the API contract's path, method, inputs, outputs or errors are semantically wrong, and a missing or stale review keeps the candidate non-passing.

## Code and verification

- `src/app/tools/executor.ts` defines the Worker tool; `src/executor/dsh.ts` binds it to the active worktree; `src/executor/doc-tree.ts` reads candidate structure.
- `pnpm test tests/doc-tree.spec.ts tests/tools.spec.ts tests/prompts.spec.ts` exercises Git snapshots, the Worker tool and its role scope. The simulated host does not certify an LLM's traversal or review judgment.

## Real Worker smoke check

Use a separate `superagent` profile with a Harness version supported by `engines.dsh` in `plugin/package.json`, a working model, and a disposable GitHub repository authorized for test issues, branches and pull requests. Follow [deployment](006-deployment.md) and make the test repository the active project. Require [manual merging](003-execution.md#merging), and keep the PR open through the revision check. If a prerequisite is missing, mark the smoke check not run.

1. Seed the repository with a `DOCS.md` route to a small backend API contract leaf, an existing verification test, and a broken local link from the leaf in place of the test link. Record the seed SHA, keep the base branch there, and confirm the Ticket pins that commit as its base.
2. Through normal Hub intake, authorize a Ticket to find and repair the named API's verification link without supplying the leaf path. Ask the Worker to reproduce the issue via `orchestrator_doc_impact` before editing. With the seed still at the Worker worktree's `HEAD`, the call declares the root and scoped leaf and uses `impact.kind: unchanged` because the documents match the base. Expect `structure: issues` and a `broken-link` issue naming the leaf and missing target.
3. In the Worker transcript, confirm it used the Doc Tree skill to find the leaf and reran the tool on the committed repair before reporting `ready`. Expect `structure: checked` and `semantic_review: required` with the leaf declared as an updated contract. Check that the report and PR description record the candidate, base, doc changes and structural result, and that the PR head matches the candidate.
4. While the Ticket and PR are open, send an authorized follow-up on the same Ticket thread requesting a second in-scope correction, such as linking another existing verification case in the leaf. Confirm a fresh tool call and the new report and PR head all refer to the revised SHA. Inspect the final diff and the linked tests: resolving a link does not prove that its target verifies the API contract.

Record the Harness version and model, Ticket or PR reference, base and both candidate SHAs, and references to the tool calls and reports outside the Doc Tree. Mark any unobserved step not run. This check is separate from CI and simulated-host tests.
