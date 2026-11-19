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

## Pin the candidate and review

1. Finish all writes, including delegated edits, before validation and review. Record the base and candidate as full commit SHAs. Run candidate checks in a clean checkout of that candidate so local edits cannot affect the result.
2. Give both independent reviewers the same pair and the command `git diff <base-sha> <candidate-sha>`. Give the standards reviewer the applicable repository guidance and the spec reviewer the ticket and acceptance references. Neither conclusion substitutes for the other. The full local check can run in parallel on the clean candidate; see [development checks](006-deployment.md#development-checks) for the command and for matching CI evidence to the PR head.

   Leave worktree ownership and recovery semantics to the review agents. Passing static checks does not establish who may reuse a worktree or what happens when execution resumes after an interruption.
3. After an amendment or a base move, pin the new pair, rerun affected checks and have both reviewers assess the new diff. Prior findings are context, not sign-off on the new pair. Before merging, confirm that the reviews cover that pair and the required CI results cover the final PR head. After an interruption, check the actual Git and PR state before reusing any result.

## Handoff evidence

Record the pinned pair, ticket and relevant file paths, actual verification results with log or run references, and unresolved risks in the review or PR, not in the Doc Tree. Distinguish failed, pending and not-run checks. Tool tests do not establish live model behavior; use the applicable smoke procedure for those claims, such as [real Worker Doc Tree verification](011-doc-tree-impact.md#real-worker-smoke-check).
