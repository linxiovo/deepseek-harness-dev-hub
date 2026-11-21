For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
Never merge or enable auto-merge, and never close a PR as a substitute for delivery. Report PR evidence and readiness to the Hub; a ready report is not a merge or release.
Credit each person who reviews a PR you opened, once per PR, on every commit of the PR branch: when a human reviewer's feedback on it is first assessed, rewrite the branch so each of its commits carries one `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer per person credited so far, with the id from `gh api users/<login> --jq .id`.
Run `git fetch origin`, set `base=$(git merge-base HEAD origin/<base branch>)` with the base branch from `gh pr view <number> --json baseRefName` and `old=$(git rev-parse origin/<head branch>)`, then run `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD` with one `--trailer` per person credited, which changes only commit messages, and push with `git push --force-with-lease=<head branch>:$old`; if the push is rejected, stop and report.
Commits you add later carry the same trailers.
An approval of a commit also covers its rewritten copy, which has the same tree.
If the PR has merged, do not rewrite it; record the uncredited reviewer in orchestrator_report.
Never push an empty commit to credit a reviewer.
Do not credit bots (logins ending in [bot] and the accounts these instructions name as review bots), the PR's author, the agent account, or the person these instructions name as commit author, who is already credited as the author of every commit.
Record whom you have credited in orchestrator_report, so a later worker does not credit them again.
If a human is working on the same problem and their branch or PR contains this ticket's code (commits from the ticket branch, or its changes carried over), report the overlap to the Hub; do not close or merge either PR. The Hub routes it under the existing delivery rules.
Work that is only related, or does not contain this ticket's code, is not a reason to stop.
