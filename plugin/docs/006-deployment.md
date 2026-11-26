# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the installation state directory, runtime mode and machine limits. Use the panel for project settings such as Source intake, Policy, and Executor commands. The installation API handles GitHub verification, registration and selection. See `012-project-runtime.md`.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials, and the worker's command shims refuse the ordinary human-facing send commands by name, but neither isolates the process: a worker can run an installed CLI by absolute path, post over HTTP with another credential, and read the operator's home directory. dsh-superagent provides no container, no network isolation and no separate OS user; workers need the network for dependency installs and for the two read-only Context7 MCP tools they may use. Use a dedicated OS account containing only the agent's credentials if you want process isolation; it is optional operator hardening, not part of the agent boundary.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, plus Python 3.8+ and tmux on POSIX hosts for `scripts/dsh-superagent`
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. Keep a local clone of it and name that clone in the Execution settings: the Executor creates one worktree per Ticket there. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: a Feishu or Lark app with a bot. Pin `lark-cli` 1.0.100 for interactive settings approvals. A CLI without `card.action.trigger` can still receive ordinary messages.

### Development checks

Plugin CI (`.github/workflows/plugin-ci.yml`) runs on pushes to `main` and pull requests targeting `main`, uses Node.js 22.19.0 and pnpm 11.7.0, and has read-only repository access. Both jobs are required: native Windows (`windows`) runs `pnpm check` first, and Ubuntu (`check`) waits for it. Unless the workflow itself is cancelled, any Windows result other than `success` makes `check` fail explicitly before checkout, rather than letting GitHub treat a skipped required job as passing.

`pnpm check` runs the import boundary gate (`check:imports`), typechecking, every applicable test, and the build, in that order. Native Windows runs the full Windows-applicable suite: `vitest.config.ts` excludes only `tests/service-script.spec.ts`, which exercises the POSIX service script and requires Python `fcntl`. Linux and WSL run the full suite including those tests. To run the check locally on your platform, use supported Node.js and pnpm 11.7.0 and run from the repository root:

```sh
pnpm -C plugin install --frozen-lockfile
pnpm -C plugin check
```

Enable or refresh the local Git hooks by running `node plugin/scripts/install-hooks.mjs` from the repository root. Install once per clone, including clones with linked worktrees. The shared hooks forward to `plugin/.githooks/` in the worktree where Git is committing. The selected worktree must contain the hook entry points.

Pre-commit runs from the active worktree's `plugin` directory and verifies that pnpm matches the version declared in `package.json`. It then runs the import boundary gate, typechecking, and the focused tests listed in `plugin/.githooks/pre-commit`. The full `pnpm check` runs each stage with the pnpm CLI that started the check.

Before pushing a branch for a pull request, commit your changes and push from a clean worktree checked out at the commit being pushed. The `pre-push` hook runs `pnpm check` once for that commit and stops the push if it fails. If pushing multiple branch updates from different commits, check out and push each commit separately. Tag-only pushes and deletions do not run checks. Run the installer again in existing clones to enable `pre-push`; linked worktrees use their own versioned hook files. The hook runs only the local platform's suite. A PR opened from a branch that was already pushed does not trigger it, so run `pnpm -C plugin check` before opening such a PR if the candidate was not checked locally.

For Ticket and plan evidence, configure two GitHub Source `requiredChecks` rows: `[{"id":"check","workflowId":"<id>"},{"id":"windows","workflowId":"<id>"}]`. Use the same decimal workflow ID (as a string) for both. In this repository, get it with `gh api repos/{owner}/{repo}/actions/workflows/plugin-ci.yml --jq .id`. Installations with name-only rows must fill in the workflow IDs before evidence can pass. Where branch protection is available, require both jobs there too. Those are separate settings; the workflow changes neither, and a job dependency alone does not restrict merging.

#### Verify a committed candidate on Windows

From the repository root in native Windows PowerShell, use supported Windows Node.js, Git for Windows, the Windows `tar.exe`, and native pnpm matching the candidate's `packageManager` (11.7.0 for this checkout). Pin the candidate before running:

```powershell
$sha = git rev-parse --verify HEAD
node plugin/scripts/verify-windows.mjs --ref $sha --output plugin/.artifacts/verify
```

The same entry point is available as `pnpm -C plugin verify:windows --ref $sha`. Without `--ref`, the script resolves `HEAD` in its worktree once; an invalid ref fails without falling back. Use `--repo DIR` to select another local Git worktree root. `--output DIR` is relative to the invocation's working directory and defaults to `plugin/.artifacts/verify` in the selected worktree.

The verifier exports the pinned commit's tracked files, including repository-level offline test inputs, into a fresh Windows temporary directory. It does not copy the checkout, its `node_modules`, or the contents of submodules. It runs `pnpm install --frozen-lockfile` and then `pnpm check` there without WSL. The install may use the normal pnpm store and network. Only verify commits whose scripts you trust; the snapshot is not a sandbox.

Each run gets a new evidence directory with `manifest.json` and logs for the stages that started. Accept a result only if `sha` matches the expected full commit ID, `status` is `passed`, `exitCode` is `0`, and `snapshotCleaned` is `true`. A forced termination may leave an incomplete manifest and a disposable snapshot; neither is reused by a later run. Use [the CI evidence](#ci-build-and-commit-evidence) separately for required jobs.

#### CI build and commit evidence

After both platform checks pass, the Ubuntu job uploads `plugin-check-<github.sha>` from `plugin/lib` and `plugin/ci-evidence`. The evidence directory contains the workflow YAML and `commit.json`, which records `repository`, `sha`, `ref`, `run_id`, `run_attempt`, `workflow`, and, for pull requests, `pull_request_head_sha`. On a push, `sha` is the pushed commit. On a pull request, `sha` and the artifact name identify the synthetic merge commit that CI built, while `pull_request_head_sha` identifies the candidate commit used for the Actions evidence lookup.

When using the build as evidence, match the manifest to the expected repository, commit and run attempt. A successful rerun replaces the artifact; a rerun that fails before upload can leave the previous attempt's artifact available. An artifact alone is not proof that both required jobs passed for the candidate commit.

#### Owner PR auto-merge

In `linxiovo/deepseek-harness-dev-hub`, `.github/workflows/owner-auto-merge.yml` automatically enables GitHub auto-merge for ready PRs opened by `linxiovo` (account ID `220323999`) and targeting `main`. GitHub still requires `windows` and `check` to pass and blocks merges with conflicts. The workflow does not enroll PRs from other authors or re-enable auto-merge after someone other than the owner pushes to the PR. To take a PR out of automatic merging, mark it as a draft before the checks pass.

Keep repository **Allow auto-merge** enabled and restrict the `owner-auto-merge` Actions environment to the `main` branch. Store `OWNER_AUTO_MERGE_TOKEN` in that environment, not as a repository-wide secret. Use a fine-grained token for this repository with **Contents**, **Pull requests**, and **Workflows** write access (the last allows merging changes to workflow files). The built-in `GITHUB_TOKEN` would not trigger the post-merge `push` CI on `main`. The merge job never checks out or runs PR code.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.
   The shell wrapper above is a POSIX example. On Windows, use an absolute path to a native executable or a `.cmd`/`.bat` wrapper, or a command name available on `PATH` via `PATHEXT`. Give onboarding the executable reference only, not a token or the contents of the GitHub CLI configuration.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

   On Windows, the live event consumer also accepts `.cmd` and `.bat` wrappers. Use a path without `cmd.exe` metacharacters; paths containing them are rejected.

3. For native settings approvals, grant the bot `im:message:send_as_bot` to send and reply, and `im:message:readonly` for the card event consumer. Under **Events & Callbacks → Callback Configuration**, select the long connection and add **Card action trigger** (`card.action.trigger`). Keep the ordinary message event subscription separately. Publish the updated version and ensure the bot is in the bound group or has a DM relationship with the recipient. Card 2.0 buttons require Feishu/Lark client 7.20 or later.

   Check that the pinned wrapper supports `lark-bot event schema card.action.trigger`. The host starts a separate bot-only consumer for that event. Its ready marker confirms the CLI stream, **not** the console subscription: a missing callback subscription can produce no clicks even though the stream appears ready. Never collect raw event lines in logs or support tickets; they may contain a temporary update token, form data and the fetched card body.

   Cards go only to the bound DM or as a reply in its exact group topic. Only a designated participant's native button click on the original receipted card is eligible; typing “approve”, quoting the card or forwarding a message never approves. **Check current status** requests the effective value from the same project record; the printed card is a snapshot. When callbacks are unavailable, use the project-scoped management API. Any fallback text is guidance, not an approval channel.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm -C plugin install --frozen-lockfile && pnpm -C plugin build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD/plugin"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute installation path (a drive or UNC path on Windows). Holds the lock, project catalog and project state; keep it outside project checkouts and back it up before upgrades |
| `runtimeMode` | no | `desktop` (default) or `headless`. Reports how the DSH instance is deployed; both modes mount at most one active project and use the same loopback management API |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |
| `credentialChecks` | no | Project-scoped trusted test-account verifiers, empty by default; see `015-scoped-attention.md` for the entry schema and deployment example |
| `planVerification` | no | Full regression workflow and artifact identity for a registered project; see `017-plan-integration.md` for its dispatch, job and artifact contract |
| `planRelease` | no | Separate operator-managed release adapter, exact authorized environment/target/scope and controlled credential-provider URL; see `017-plan-integration.md`. It is not the full-regression workflow and receives no credentials in arguments |

After the first start, edit volatile machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Limits apply without restart. Set `stateDir`, `runtimeMode`, `credentialChecks`, `planVerification` and `planRelease` in the profile configuration; they are not volatile. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

Run the native host with `dsh --profile superagent` and stop it through the host's normal shutdown (for a foreground process, Ctrl+C). On a server, set `runtimeMode: headless` on the `dsh-superagent` entry and run the same DSH profile under the server's usual process supervision. DSH handles plugin startup, shutdown and remount on project selection. No separate project daemon is needed. Use a dedicated profile and state directory for each DSH instance.

In desktop mode, closing the DSH host or shutting down or suspending the computer pauses work and Source listening. Start the same profile again to continue from its state. `GET /orchestrator/api/runtime` reports the mode, any pause reason, and the recoverable work recorded at startup. Use headless mode if listening must continue while the operator's computer is off.

The optional POSIX helper supervises this same native DSH process. Run its `scripts/dsh-superagent` commands from `plugin/`:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`scripts/dsh-superagent` is a POSIX-only script (it uses Python `fcntl`, `ps`, and `tmux`). `start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

During a local Harness UI smoke check, if the UI reports `dsh web authentication required; reopen the URL printed by dsh web`, the operator must reopen and authenticate through the exact URL printed by the current launch before starting the task. The agent pauses instead of bypassing authentication; never continue a task unauthenticated. A restart invalidates an earlier login URL, and a project or repository link does not grant or replace authentication. Do not paste the authentication query string into a task, transcript, log or ticket.

### Headless access over SSH

Keep the server profile's `webserver.host` at `127.0.0.1`. From the operator machine, forward the same port on local loopback to server loopback through an authenticated SSH connection:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3082:127.0.0.1:3082 operator@server
```

While the tunnel is open, use `http://127.0.0.1:3082` from the operator machine. If you change the server port, match it at both ends so the HTTP `Host` and browser `Origin` use the configured port. Keep HTTP private to loopback and use SSH for authentication and encryption. Treat local access to either end of the tunnel as privileged.

#### Live headless connection smoke check

Use a dedicated DSH Web profile on a real server with `runtimeMode: headless`, the candidate bundle installed, and a verified GitHub account and test project already selected. Start that profile on the server as described above and leave the SSH tunnel open. From a separate operator machine, check the live API through the forwarded port:

```sh
curl --fail --silent --show-error --max-time 10 -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/runtime
curl --fail --silent --show-error --max-time 10 -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state
```

Pass only if both return HTTP 200, `runtime` reports `mode: "headless"`, `status: "ready"` and the expected `projectId`, and `state` reports the same project and its expected repository in `setup.accounts.repository`. Record the actual responses (omitting private paths), candidate and server profile in the verification evidence. Without a reachable server and tunnel, mark the smoke check **not run**; no simulated DSH or GitHub result substitutes for it.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **GitHub onboarding and project.** Verify the dedicated `gh` executable via `POST /orchestrator/api/onboarding/github/verify`, then register the server-local checkout, `owner/name` and explicit base ref via `POST /orchestrator/api/projects`. On an existing installation, adopt its original binding first (see Upgrade). Register additional projects without moving the active mount; explicitly select when switching. Check `GET /orchestrator/api/runtime` for the intended `projectId` and setup status before operating on a project.
2. **Sources.** Set intake for the active project. GitHub requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
3. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
4. **Execution.** Registration supplies the local clone and starting ref, such as `refs/heads/main`. Review the base for new work, optional prepare command and blocked commands. An empty repository or base ref leaves existing settings readable but prepares no new worktree; it does not fall back to an empty directory. Before a Ticket's first Assignment, the Executor resolves the ref to a pinned commit and exposes `DSH_SUPERAGENT_REPOSITORY`, `DSH_SUPERAGENT_BASE_REF`, the pinned `DSH_SUPERAGENT_BASE_SHA` and the reserved `DSH_SUPERAGENT_BRANCH` to the preparation. With no prepare command, the Executor creates each Ticket's worktree itself with the same `git worktree add` call at the pinned commit. A non-empty prepare command takes over that creation and must use the pinned variables:

   ```sh
   git -C "$DSH_SUPERAGENT_REPOSITORY" worktree add -b "$DSH_SUPERAGENT_BRANCH" "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_BASE_SHA"
   ```

   The Executor then verifies the created worktree: it must be a linked worktree of that clone, at that path, on that branch, with its first HEAD at the pinned commit. It records those facts on the Ticket. An ordinary directory, another Ticket's worktree, a checkout of another repository, or a wrong branch or base is rejected with the reason on the Ticket; the Executor deletes nothing and starts no Session. A retry reuses only this Ticket's verified worktree, whose current HEAD may already be ahead of its base, and only after the previous writer has stopped. Its recorded repository and base stay pinned even if these settings change; a changed setting selects the base for new Tickets, not for an existing claim.

   The clone's origin must identify the GitHub Source's repository: exactly one `origin` URL, over direct github.com HTTPS, SSH or Git, for that `owner/name`. Keep the worktree root outside the clone's main checkout, every worktree registered in it, and any other Git checkout; a symlink alias counts as its resolved path. A Ticket whose clone origin or destination crosses these boundaries is refused before its prepare command runs, with the reason on the Ticket, and no file is created or changed.

   List personal CLIs, such as one signed in to your own account, as blocked commands. A blocked name fails only when called by that name; an absolute path still runs.
5. **Prompts.** Set the team sections: the GitHub disclosure line, review bots and the commit author.

### Management API

The panel uses a local HTTP API that agents can also call. The service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`. If `Origin` is supplied, it must be exactly `http://<Host>`. A mismatch or missing required header receives `403 {error: "Same-origin management request required"}`. The server itself must bind to `127.0.0.1`. Use the SSH tunnel on a remote host.

API saves have the panel's permissions, including execution settings the main Session cannot edit. Managed GitHub identity and project binding are not editable through settings saves. See `012-project-runtime.md` for the installation routes, project-scope contract, and error shapes.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | Host startup and mounted-project health: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET topic-binding`, `POST topic-binding`, `POST topic-binding/unbind` | Inspect, bind or disconnect the selected project's Feishu destination. These routes always require the mounted project scope; `009-handoff.md` describes the request, participant grants and reply format. |
| `GET attention/summary`, `GET attention/credentials/<id>`, `POST attention/credentials/<id>/verify` | Read scoped Plan attention and invoke a trusted test-account verification. All three require the mounted project header; verification accepts only `{}`. See `015-scoped-attention.md`. |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `GET tickets/<id>` | The Ticket page: stage and actions, Mandate, Inputs, Threads and Assignments, and its `execution` with `name`, `directory`, `repository`, `worktree`, `branch`, `base` (`ref` and `sha`), `session`, `active_writer` and `preparation` with its `reason`. A legacy Ticket omits the facts it never recorded |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Retries setup or pending project recovery by restarting dsh-superagent: `{restarting: true}`. Refused when there is nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts`, `POST prompts/preview` | Read rule history, stage a maintenance proposal, or preview without writing. See [Prompt versions](004-prompts.md#versions) for the request, response and publication rules. |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision or a project/transition refusal (`code`); see `012-project-runtime.md`.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository`, `cli`, [`requiredChecks`](#development-checks) (`[{"id":"<exact job name>","workflowId":"<decimal workflow ID>"}]`, empty by default), and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `repository`, `baseRef`, `directory`, `prepare`, `blockedCommands` and optional `runLimits` (see `016-run-limits.md`). Processing pause is a separate setting that `POST executor/pause` sets.

Account settings that can still change (Feishu, or the legacy GitHub Source before adoption) run their setup check first. A legacy GitHub CLI change must verify as the same installation account. A failed check returns 400 with details in `setup`. A save that needs setup to run again returns `restarting: true`; the API is temporarily unavailable during remount.

```sh
api=http://127.0.0.1:3082/orchestrator/api
curl -sS -H 'x-orchestrator-request: 1' -H 'content-type: application/json' "$api/onboarding/github/verify" \
  -d '{"cli":"/home/operator/.local/bin/gh-agent"}'
# Continue only when onboarding returns status "ready". The workspace is on the DSH host.
curl -sS -H 'x-orchestrator-request: 1' -H 'content-type: application/json' "$api/projects" \
  -d '{"repository":"acme/widgets","workspace":"/srv/checkouts/widgets","baseRef":"refs/heads/main"}'
curl -sS -H 'x-orchestrator-request: 1' "$api/runtime"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

For a managed project, installation onboarding verifies the configured CLI account on `github.com` before project setup. Setup requires that verified binding, rechecks push access to the bound repository, and uses the canonical name GitHub returns. It does not fall back to the GitHub Source's CLI or repository settings. Hub and Worker prompts receive the repository, account login and no-reply email even if GitHub polling is disabled; they do not receive the CLI path or credentials.

Before adoption of a legacy single-repository deployment, the installation verifies and pins the GitHub Source account through the same onboarding probe, and setup checks that account's access to the legacy repository. In either case, setup writes the worker environment and checks that git selects the agent's credential helper for `github.com`. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in the mounted state directory's `worker-bin`, first on `PATH`: `gh` runs the agent's CLI with `github.com` as the default host; `lark-cli` runs the bot's CLI; blocked commands fail. The forwarding shim removes its own directory from `PATH` before running its target to avoid wrapper recursion. The CLI policy, platform entry points and limits are specified in `010-session-boundaries.md`.
- **git configuration** in the mounted state directory's `worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

### Mainline write permissions

The Plan merge queue uses the configured GitHub account to fast-forward the configured `refs/heads/...` directly, not to merge a PR. Configure branch rules that allow the intended fast-forward write, deny branch deletion and force pushes, and disable any independent auto-merge for the protected target. A server rejection leaves the attempt waiting; the plugin does not fall back to PR merge or silently override a rule.

The queue uses an isolated Git configuration: it does not copy the operator's `git config http.proxy`. Where GitHub Git transport needs a proxy, set `HTTPS_PROXY` in the DSH host process environment before startup (with `NO_PROXY` for any endpoints that must connect directly). Keep TLS verification enabled.

Mainline CI or branch rules that demand signatures or checks on the integration commit itself may reject this write. The queue does not synthesize signatures or rerun candidate checks as if they had run on the integration commit. Remove direct-merge advice from any saved team prompt overrides; they cannot grant merge authority.

The packaged Worker tools and ordinary `gh` command cannot start an alternate merge. This deployment runs the host and Worker shell under the same OS user and account, so it cannot prevent an arbitrary Worker shell with usable credentials from writing remotely. Enforcing queue-only writes against untrusted shell commands requires isolation of the merge identity from Workers and GitHub rules granting the target write only to that identity; the default deployment is a cooperative workflow, not that security boundary.

#### Verify queue-only writes on GitHub

Use an operator-authorized disposable GitHub repository and an isolated profile, with the same branch protections and identity separation as the intended deployment. Use a test branch as the configured mainline; keep write probes off the deployment's real branch. Register and dispatch a Plan Ticket for that target. Configure GitHub Source `requiredChecks` with the disposable repository's workflow IDs and job names, and verify the workflows run for the test branch. See [Merging](003-execution.md#merging) for the candidate contract.

1. **Inspect without writing.** Record the repository, full target ref and tip SHA. In GitHub, inspect the target's effective rulesets and branch protection, including push restrictions and bypass actors. Review enabled workflows and apps that can advance the branch or enroll a PR in auto-merge. Confirm that the configured queue identity can advance the target, that its credentials are unavailable to Workers, and that the Worker identity can publish a candidate branch but cannot advance the target. Record identity names or IDs, never credentials. A shared identity does not satisfy this prerequisite.
2. **Verify GitHub refuses the Worker identity.** Publish a harmless fast-forward candidate from the Ticket's worktree and open its test PR. Satisfy its delivery checks and the PR's normal merge requirements so the probe isolates permission. As the operator, confirm both Git transport and the PR request use the recorded Worker identity, not a personal or substitute account. Attempt both a direct push to the disposable target and a merge of that PR. Require GitHub to deny both for lack of permission or an applicable branch rule, with the target SHA unchanged. A local shim refusal, conflict, unmet required check, network error or sign-in failure does not prove server enforcement. Stop if either probe advances the target.
3. **Verify the queue identity succeeds.** Queue that same candidate through the Hub. Find the returned intent ID in `ticket/<id>/mainline` and independently read the target tip from GitHub. Require the expected target, base and candidate, plus `verified` with `integration` and `actual` both matching that tip. Record the intent ID, SHAs and evidence for both outcomes. Mark unexecuted checks **not run** if a prerequisite is unavailable; local Git fixtures do not substitute for this check.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and verified worktree, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn, then stop the DSH profile cleanly.
2. Back up the installation `stateDir` (catalog, root Store if present, and all project directories), the DSH profile configuration and Session persistence, and any worktrees outside the state directory. Take the backup while stopped, not from a live SQLite file alone.
3. From the repository root, update the checkout with `git pull`, then run `pnpm -C plugin install --frozen-lockfile` and `pnpm -C plugin build`.
4. Start the profile again (for example, `scripts/dsh-superagent start`) and inspect its status.

To adopt an existing deployment, keep `stateDir` at its original path. Verify its dedicated agent CLI, then register its current repository, workspace and base ref with `policy` omitted. After remount, confirm the original Hub ID, settings and Tickets before registering other projects. See `012-project-runtime.md` for the exact adoption checks and errors.

Ticket recovery retains the persisted rule revision. Existing installations without Ticket pins import the last recorded Worker revision when available; otherwise they bind the effective revision at upgrade. See [Prompt versions](004-prompts.md#versions).

Tickets accepted before this version stored only a directory. They keep that directory and its record, but have no verified worktree, branch or base; the Executor does not adopt an existing tree or infer a base from its current HEAD. A legacy Ticket whose earlier worker's idle state cannot be proven refuses a retry with that reason, and an existing directory is never reused. A legacy Ticket that never started can prepare under the new rules when its directory does not already exist.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker preset moves shell commands to the background after 5 seconds; the router preset has no shell, background jobs or write tools. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Verification

Run `pnpm -C plugin verify:linux` from the repository root (`pnpm verify:linux` inside `plugin/`, passing script flags after `--`, or `node scripts/verify-linux.mjs --help` for all options) to execute `pnpm install --frozen-lockfile && pnpm check` on a committed Linux snapshot, natively or through WSL from Windows.

To run directly inside WSL, use a clone on the distribution's native Linux filesystem (for example `~/src/dsh-superagent`, not `/mnt/c` or `/mnt/d`). Make the commit to verify available in that clone, then run `pnpm -C plugin verify:linux` from its repository root with native Linux Node.js and pnpm 11.7.0. Commit the changes first: the verifier checks `HEAD`, not the working tree. Use `node plugin/scripts/verify-linux.mjs --ref <commit>` from the repository root to select another committed revision.

- **Committed snapshot and Linux/WSL isolation.** The script resolves `HEAD` from its own checkout, clearing inherited Git location variables. It exports committed `plugin/` and the root `DOCS.md` into an isolated Linux `mktemp -d` directory. It never reads uncommitted changes, untracked files, or Windows `node_modules`. On Windows it invokes `wsl.exe` directly (`WSL_UTF8=1`) and requires native Linux Node.js and pnpm (or native Corepack / an explicit Linux `--pnpm` path); it rejects a Windows tool instead of falling back silently.
- **Evidence, failure and cleanup.** Each run writes a separate directory under `plugin/.artifacts/verify/` containing full per-stage logs and `manifest.json` (recording CI identity, environment versions, stage exit status and snapshot cleanup), and prints a concise summary to standard output. Any failed stage stops subsequent stages and exits non-zero while preserving the logs and manifest; cleanup deletes the temporary Linux snapshot after the run and fails non-zero (marking the snapshot uncleaned in the manifest and summary) if removal fails.

## Manual Plan handoff smoke check

**Manual verification with a real model.** Run this checklist against a real DeepSeek Harness `superagent` profile and model. It is not part of `pnpm check`; neither this flow nor its results are claimed as CI coverage. The automated `tests/plans.spec.ts` path uses a simulated Harness host.

1. Start the `superagent` profile with `scripts/dsh-superagent start` and open its panel.
2. Confirm setup before creating a handoff: the GitHub Source is ready, the configured agent account can read and push the repository, and the model provider and model are available without a setup or health error.
3. In the Hub, confirm a new handoff with the required direct approval, then wait for its specification to be published.
4. Observe `splitter-<handoff-id>` receive its scoped task. Confirm that it can read only the handoff/spec resources and is the Session that invokes `orchestrator_plan_register`.
5. Before registration, invoke/read `plan/<handoff-id>` from the Hub and verify that it reports the documented pre-registration status, not a registered DAG. Verify there is no Worker Session, Ticket, Assignment or worktree for this handoff.
6. Restart the `superagent` profile while the splitter task is received but before registration succeeds. Verify that the persisted splitting intent produces exactly one continuation delivery, not a duplicate task or a loop.
7. Let the splitter register the Plan through `orchestrator_plan_register`. Invoke/read `plan/<handoff-id>` again and verify the registered DAG is visible and the splitting continuation has disappeared. Registration must still leave no Worker Session or Ticket.

This is an operator-run real-model check, separate from automated tests and CI; do not report `pnpm check` or CI as covering it.

For a real-host Plan credential pause and verification, use the separate operator smoke check in `015-scoped-attention.md`.

## Run-limit live/model smoke check

**Manual verification with a real model.** Use a one-off DSH profile, managed project and disposable repository that contain no production work. Configure a real provider credential with a strict, explicitly authorized spend/quota limit; model calls can incur real supplier charges, including a call interrupted locally. Do not use production model traffic, exceed the credential's authorization, or put credentials in commands, logs or evidence. A simulated host/provider is not a live-model check, and `pnpm check` does not include this smoke.

Before starting, confirm the mounted `projectId` with `GET /orchestrator/api/runtime`. Use the same model adapter for both Workers and let `B` be its declared combined input/output context bound in tokens. Give each Ticket an independent strict cap that initially covers a full bound (`>= B`), and save `maxWorkers: 2` as the operator so both Workers can run. Keep every phase—including setup, Hub turns and restart recovery—within the supplier credential's authorization. In the Ticket-isolation phase, disable the project token cap while retaining the supplier-side spend/quota limit.

Use the operator-only loopback headers and scoped run-limit endpoints in `016-run-limits.md#read-contract`. Before every operator cap edit, reread `blocks.executor.value` and `blocks.executor.revision` from `GET /orchestrator/api/settings`; submit the whole block with `{revision, value}` to `PUT /orchestrator/api/settings/executor`. Use these scoped reads:

```sh
api=http://127.0.0.1:3082/orchestrator/api
scope='<mounted project ID>'
curl -sS -H 'x-orchestrator-request: 1' -H "x-orchestrator-project-id: $scope" "$api/project/run-limits"
curl -sS -H 'x-orchestrator-request: 1' -H "x-orchestrator-project-id: $scope" "$api/tickets/<URL-encoded ticket-id>/run-limits"
```

For dispatch, inspect each registered Plan node's `orchestrator_plan_dispatch` result and its `limits`; compare `maxWorkers`, project/Ticket caps and stagnation values with the effective configuration returned by the scoped run-limit read. Use the exact mounted scope on the HTTP reads. Confirm that the selected node's Ticket cap matches the resolved override/default rather than assuming the project's default applies to every Ticket.

1. **Project contention.** Use two independent, dispatchable Plan nodes for Tickets A and B. Configure the disposable project with an operator-owned prepare wrapper that runs normal worktree setup, then blocks each Worker before Session/task creation at its own external release gate. Keep the wrapper and gate outside the checkout and do not expose them to Worker tool instructions; they are timing controls, not an OS security boundary. If this gate or a provider-supported delay holding A's real response before settlement is unavailable, mark this phase **not run**. Keep project cap `null` while dispatching A and B in separate Hub turns, and let those turns settle. Confirm both Plan claims and trusted wrapper-ready signals; the Executor verifies each worktree only after its gate is released. Record settled project usage `S` with no missing usage or in-flight calls. Set `runLimits.projectTokens` to `S + floor(1.5 × B)` (or `floor(1.5 × B)` on an unused ledger), where `B` is the adapter's combined input/output context bound. Release A's gate only, wait until its request reaches the real supplier and hold its response. Then release B's gate without another Hub turn.
   - Before release, the prepare wrappers have not returned, so the Executor has not yet verified either worktree; require only the durable Plan claims and the trusted wrappers' ready signals. Once a gate is released, require that Ticket's normal prepare completes and the host verifies its worktree before its Worker Session receives a task. For B, confirm its Session meter shows a model attempt and the supplier has not received B's request. The project read must show only A `inFlight`, `reservedTokens: B`, and `availableTokens: floor(B / 2)`; B's Ticket read must show no admitted request. Public status has no waiter field: claim B reached the admission wait only if a trustworthy time-correlated host trace proves its admission attempt preceded A's settlement. Otherwise mark it not demonstrated. `S + 2 × B` admits both and is not contention.
   - Release A's response. Require an observed valid `totalTokens` receipt `U <= floor(B / 2)`, so after settlement the project balance is `floor(1.5 × B) − U >= B`. Correlate A's usage settlement and reservation release with B's admission and supplier receipt of B's request, in that order. B must resume the same waiting stream without redispatch. Record authoritative `totalTokens` only; never substitute bounds, estimates or component sums. Missing or contradictory usage is unknown, not zero. If the usage bound, response hold or ordering cannot be observed, do not claim contention passed.
2. **Ticket-local exhaustion.** Drain contention, remove the temporary gate wrapper, restore the normal operator prepare command, and use fresh independent Plan nodes/Tickets A and B. Verify that A's normal prepare completes before expecting its Worker Session or supplier request. As operator set `runLimits.projectTokens: null`; verify both `projectBudget.state: unlimited`. Keep strict Ticket caps. Dispatch A alone and wait for valid supplier usage plus durable settlement. If A did not naturally exhaust its cap, ensure it has no reservations or missing usage, then set its exact Plan-node override to observed `budget.accountedTokens` (no fabricated usage). Verify A is exhausted and emits exactly one `quota-paused` push, then confirm B reaches the supplier under its own cap.
3. **Wrong authority.** With operator-saved `maxWorkers: 2` and a finite Ticket cap, ask the Hub to raise `maxWorkers` to `3`, omit it (default `3`), raise the cap, or omit `runLimits`. Each must refuse with `panelOnlyRunLimits`; values remain unchanged.
4. **Wrong classification.** A Ticket-local hold for A must not suspend B only when B's own cap and the project balance both admit B's full bound. A separate Ticket cap never bypasses an aggregate project hold. A PR close, Worker report or `quota-paused` dispatch status alone does not close a Plan Ticket. A standalone Ticket may complete on PR close under its normal rules.
5. **Interruption.** Use a fresh, independent Plan node/Ticket with no prior Ticket usage, retain `projectTokens: null`, and set its operator-owned Ticket cap to at least the model bound `B` so the first call can be admitted. Stop the host after the real supplier request is observed but before usage settlement commits. Restart the same profile and inspect the fresh Ticket/project readings before any retry. Require the call to appear in `missing` with `interrupted` incremented—not in `inFlight` or as a zero-usage receipt. The strict Ticket pool must fail closed as `usage-missing`; the uncapped project pool may show the gap without blocking. The request may have reached the supplier and incurred a charge; never blindly retry.

Keep redacted scoped status, Session meter and dispatch responses, Ticket state, notification evidence, and timestamps/identifiers that correlate reservations, usage receipts and supplier request arrivals. Record the supplier-reported cost when the supplier provides it (with its currency and reporting scope); otherwise mark cost **unavailable**. Token usage is not billing cost. Do not record API credentials, authentication URLs, private local paths or request secrets. Mark unavailable prerequisites and unobserved outcomes **not run**; neither `pnpm check` nor a simulated host/provider substitutes for this live check.


## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Verify the dedicated CLI through onboarding; for a legacy deployment before adoption, check the GitHub Source's CLI setting |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `Set a GitHub repository as owner/name.` | Check the registration input or, before adoption, the legacy GitHub Source's repository |
| A Ticket fails with `The prepare command failed…` | The message names the cause, such as a wrong clone path, and says its files were preserved; fix the command, then retry the Ticket |
| A Ticket's preparation is rejected because the directory is not this Ticket's verified worktree | The path holds an ordinary directory, another Ticket's worktree, a checkout of another repository, or a worktree of this repository on another branch or base. Nothing was changed. Move that content away or change the directory root, then retry |
| A Ticket fails with `Configured repository … origin …` | The clone's single `origin` URL must name the GitHub Source's repository. Check `git -C <clone> remote get-url origin`, remove extra origin URLs, and point origin at that `owner/name` over direct HTTPS, SSH or Git |
| A Ticket fails because its directory or worktree root is inside a checkout | Move `executor.directory` outside the clone's main checkout, every worktree registered in it, and any other Git checkout; a symlink alias counts as its resolved path. Nothing was created or changed |
| Every new Ticket is rejected while the clone and base ref are set | Check that the base ref resolves in the clone (`git -C <clone> rev-parse <baseRef>`) and that the prepare command creates a linked worktree at `$DSH_SUPERAGENT_DIR` on `$DSH_SUPERAGENT_BRANCH` from `$DSH_SUPERAGENT_BASE_SHA`, not a copy or the clone's own checkout |
| A Ticket fails naming `executor.repository` or `executor.baseRef` | Both settings are required for a real worktree. Set the local clone and a ref it can resolve; an empty value is not an empty-directory fallback |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `Unsafe Feishu bot batch CLI path` | Rename or move the Windows `.cmd`/`.bat` Feishu CLI wrapper so its path contains no `"`, `&`, `\|`, `<`, `>`, `^`, `%`, `!`, or newline characters |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
