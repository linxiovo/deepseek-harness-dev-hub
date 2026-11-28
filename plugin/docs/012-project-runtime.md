# 012 Project runtime

An installation is one DeepSeek Harness (DSH) instance with a persistent project catalog and **at most one active project**. Desktop and headless use the same runtime. The single mount keeps process-wide `PATH` and Git configuration unambiguous and prevents stale workers or writer leases from crossing project boundaries. Inactive projects retain their data without polling Sources, running Assignments or handoffs, or draining effects. For host configuration and remote access, see [006 Deployment](006-deployment.md).

## Identity and project binding

Onboarding probes the dedicated GitHub CLI profile (`gh api user --hostname github.com`) with prompting disabled and `GH_TOKEN` and `GITHUB_TOKEN` cleared. It verifies a positive numeric GitHub account ID and a login, and derives `<id>+<login>@users.noreply.github.com`. The credential stays in the dedicated CLI profile. The catalog stores only the resolved executable reference and public identity. The installation API accepts only the executable reference and omits executable paths, credentials and raw probe diagnostics from its responses. Startup re-verifies the saved executable and rejects a different account ID with `agentAccountChanged`. Verification of a different candidate CLI does not discard a working identity. Hub and Worker context receives non-secret GitHub facts regardless of GitHub Source polling.

Registration requires GitHub `owner/name`, push access for the verified account, an absolute path on the DSH host and an explicit Git base ref. GitHub supplies the canonical repository name. The workspace resolves to the real root of an independent primary checkout. Its one local `origin` URL must identify the same repository directly on `github.com` over HTTPS, SSH or Git. Matching ignores case and an optional `.git` suffix. The base ref is trimmed, limited to 256 characters, cannot start with `-` or contain whitespace or control characters, and must resolve to a commit locally. The checkout and installation state directory must be disjoint. The catalog refuses duplicate repositories with different bindings and equal or nested checkouts across projects. It saves the resolved path, so a retargeted symlink leaves the saved project pointing at its original checkout.

Registration is reusable for the same canonical binding and initialization. Changing a new project's initial base or policy in a repeated registration conflicts. The first registration selects the project in the same catalog transaction. After that, use the select operation to activate a project. Selecting the already mounted project returns `restarting: false`. Managed settings refuse changes to `source:github`'s `cli` or `repository`, or to `executor.repository` or `executor.directory` (`409 projectBindingImmutable`). The base for future Tickets remains an Execution setting. Existing Ticket claims retain their pinned base.

To configure required GitHub Actions jobs on a newly registered project, update `requiredChecks` in the current `source:github` block. The unused Source CLI stays unset; the operator-verified installation account remains the only account for the managed project.

### Explicit adoption

If a legacy deployment has a GitHub repository configured, adopt it before registering another project. Startup verifies the legacy Source CLI through the same GitHub onboarding check and pins its numeric account ID; later Source CLI changes must verify as that account. Until adoption, the validated legacy repository may still run with a `null` managed project ID. To adopt it, register the existing repository and canonical workspace using its existing `executor.baseRef` and **omit** `policy`. Stored handoffs must match the repository and workspace too. Another binding is refused with `legacyProjectRequired`. An unverifiable legacy identity, mismatched base, explicit policy or mismatched handoff is refused with `legacyProjectMismatch`. Adoption keeps the root Store, existing settings and Hub Session ID in place.

## Development model configuration

After verifying GitHub, read `GET /orchestrator/api/models` for the DSH model catalog and `GET /orchestrator/api/settings` for `blocks.executor.{value,revision}`. Here `value` is the full executor settings object. Send `PUT /orchestrator/api/settings/executor` with `{value, revision}`, preserving other executor settings and adding these fields:

| Field in `value` | Input and effect |
| --- | --- |
| `backendModel` | Required `{provider: string, model: string, reasoningEffort?: string}`. Routes backend Plan Workers. |
| `frontendModel` | Required, same shape. Routes frontend Plan Workers. It may select a different model or provider. |
| `lightweightModel` | Optional, same shape. Omit or pass `null` to use the DSH profile default for read-only lookup and idle inspection. |
| `model` | Optional general Executor override, same shape or `null`. It is not a substitute for either required route. |

Model fields accept nonblank strings and no extra keys. Changed non-null routes are resolved through the live DSH provider before the save. `200 {saved, revision, policy_changed, restarting, context_delivery}` confirms persistence; `context_delivery` is `injected` or `pending`. When `restarting` is true, wait for remount before submitting another write. A missing required route returns `400 {error, code:'developmentModelsRequired'}`; an invalid shape returns `400 {error, issues}`; an unavailable route returns `400 {error, code:'modelUnavailable', values:{block,error}}`, with `block` naming the executor field. A stale block revision returns `409 {error}` without applying any of the update. Only the operator can change `backendModel`, `frontendModel` or `lightweightModel` through management; Hub settings tools cannot change them.

Without a project, the executor block is saved in the installation's root Store. A new project copies the three project routes from the current block at registration, then owns its settings independently. Registering an existing binding again does not change its routes. Legacy adoption uses its existing Store, and older settings remain readable while missing a route. After GitHub verifies, onboarding reports `models-required` with exactly the missing roles; until both are configured, registration and new-work operations refuse with `409 developmentModelsRequired` and background dispatch is held. Read-only state remains available. Plan claims, initial Worker calls and recovery are described in [003 Execution](003-execution.md). The Hub can read the active routes in `orchestrator_read models` under `roles.backend`, `roles.frontend` and `roles.lightweight`.

Focused verification: `tests/runtime.spec.ts`, `tests/plans.spec.ts`, `tests/settings.spec.ts` and `tests/role-models.spec.ts`.

## Mount and recovery

The runtime acquires the installation directory lock before opening SQLite. `<stateDir>/projects.sqlite` stores project bindings, the selected ID, verified identity metadata and per-project suspension records. For a new project, `<stateDir>/projects/<id>/orchestrator.sqlite` stores its settings, work, Source cursors and effects. The adopted project keeps `<stateDir>/orchestrator.sqlite`. The mounted project's state directory also holds its worker shims and Git configuration. DSH keeps Session history in the host profile, and each mount uses its own Hub and work Sessions.

Selection commits the requested ID before asking DSH to remount the plugin. `activeProjectId` and `projectId` keep reporting the **mounted** project until remount. During remount the API can be temporarily unavailable. Shutdown cancels owned turns, drains in-flight work, stops worker jobs, flushes DSH Session persistence, restores the process environment and closes databases before releasing the lock.

Startup rechecks the stored checkout path, origin and current base ref, then reconciles open tracked PRs and looks up PRs matching each open Ticket's reserved branch and worktree HEAD. A failed check pauses recovery. A merge recorded on or after the current Assignment was created also pauses recovery while the Ticket is open and the Assignment is pending or running. That pause survives another restart even if GitHub no longer reports the old branch head. Restore access or resolve the open Ticket, then use `POST /orchestrator/api/setup/check` with the mounted scope to retry. External work with no tracked PR or matching reserved branch and head is outside this check. Writer leases stay with their original project. For Assignment reconciliation, see [003 Execution](003-execution.md).

If the host dies after selecting B but before remounting it, restart mounts B from the catalog. A's Tickets, handoffs, effects and worktrees stay isolated under A. Reselect A to recover its work. Recovery metadata describes the project being mounted, so a first mount can have `resumedFrom: null` even if the previous project's stop was interrupted.

This isolates plugin-managed state, workspace assignments and Source activity. It does not give the Worker an operating-system sandbox; see [010 Session boundaries](010-session-boundaries.md).

## Installation API

The six installation-wide routes under `/orchestrator/api/` are available before project setup completes. Installation reads ignore the project scope header except `GET onboarding`, which reads model readiness for the current mount and rejects a supplied stale project ID or a switch in progress. Installation writes do not require a scope but reject a supplied stale ID with `409 staleProject`. JSON success responses are HTTP 200, including `blocked` and `models-required` onboarding results. POST bodies, where specified, are strict JSON objects up to 131,072 bytes. `cli`, `repository`, `workspace` and `baseRef` must be nonblank strings with no NUL, CR or LF. For required headers and loopback access, see [006 Deployment](006-deployment.md#management-api).

| Method and path | JSON request body | JSON response |
| --- | --- | --- |
| `GET /orchestrator/api/onboarding` | None | `OnboardingView` |
| `POST /orchestrator/api/onboarding/github/verify` | `{cli: string}` with a command on the host's `PATH` or an absolute executable path. Worker shims are rejected. | `OnboardingView`. On successful verification, DSH remounts a project that needs setup or whose verified executable changed. |
| `GET /orchestrator/api/projects` | None | `{activeProjectId: string \| null, projects: ProjectView[]}` |
| `POST /orchestrator/api/projects` | `{repository: string, workspace: string, baseRef: string, policy?: PolicyConfig}` | `{project: ProjectView, reused: boolean, restarting: boolean}` |
| `POST /orchestrator/api/projects/:projectId/select` | None. URL-encode the ID as one path segment. | `{project: ProjectView, restarting: boolean}` |
| `POST /orchestrator/api/hub/rotate` | None | `{hubSessionId: string}` for the newly active physical Hub Session. The mounted project identity remains unchanged; the rotation drains the old turn and recovers its queued inputs before reporting success. |
| `GET /orchestrator/api/runtime` | None | `RuntimeView` |

- `PolicyConfig` is the `policy` settings block with `rules` and `sources` optional on input. Omitting it uses the default rules and no allowed accounts for a new project. See [006 Deployment](006-deployment.md#management-api).
- `ProjectView` has `{id: string, repository: string, workspace: string, hubSessionId: string}`. Repository and workspace are canonical, and the ID is opaque. `hubSessionId` is the current physical Hub Session; the project ID remains the stable conversation identity when a Hub Session rotates. The list is ordered by registration.
- `OnboardingView` is `{status: "unconfigured"}`, `{status: "ready", identity}`, `{status: "models-required", identity, missing: ("backend" | "frontend")[]}`, or `{status: "blocked", identity?, problem?}`. `identity` is `{id: number, login: string, noreply: string}`. `problem` has `{place, code, values, detail}`. `place` is `deployment`, `github` or `feishu`, `code` is a `SetupCode`, `values` is a string map, and `detail` is a rendered message. The installation API retains only safe `account` and `repository` diagnostic values.
- `RuntimeView` has `{mode, status, reason, projectId, resumedFrom}`. `mode` is `desktop` or `headless`. `status` is `starting`, `ready` or `paused`. `projectId` is the mounted ID or `null`. A `starting` or `ready` status has `reason: null`. The `paused` reasons in priority order are `switching`, `githubSetupRequired`, `recoveryPending`, `developmentModelsRequired`, `noProject`, `projectSetupRequired`, `operatorPaused`.
- `resumedFrom` is `null` or `{reason, at, recoverable: {assignments: number, handoffs: number, effects: number}}`. `reason` is `hostStopped` after clean stop, `projectSwitched` after clean unmount to another project, or `interrupted` when the previous mount did not record a clean stop. `at` is the prior record's ISO timestamp. Recoverable counts reflect the newly opened Store before it resumes. Use `GET state` for full startup and component health.

### Errors

| Status and shape | Conditions |
| --- | --- |
| `400 {error, code}` | `invalidRequest` for a wrong JSON shape (including extra fields) or an invalid base ref format. `invalidProject` for a missing usable base or a workspace that fails local checkout verification. |
| `400 {error, setup}` | Registration cannot verify repository access (`repositoryUnset`, `repositoryUnreadable`, `repositoryUnreported` or `repositoryReadOnly`). `setup` has the shape of `problem`. |
| `400 {error}` | Malformed JSON, oversized body or malformed path escape |
| `403 {error}` | Same-origin management check failed |
| `404 {error, code}` | `projectNotFound` for an unknown selection ID or `installationUnavailable` if the host does not provide installation management |
| `404 {error}` | Unknown path or method under the API prefix |
| `409 {error, code}` | `githubSetupRequired` for create/select without a verified account; `developmentModelsRequired` for registration or new work without both routes; `switching` during a mount transition; `projectConflict` for conflicting registration or an active project write; `projectScopeRequired` for a managed-project rotation without the mounted project header; `operatorPaused` when new work is paused; `legacyProjectRequired` or `legacyProjectMismatch` for adoption refusals. |
| `500 {error}` | Unexpected failure with the message `Installation operation failed.` |

Identity check failures such as `agentCliMissing`, `agentCliSignedOut`, `agentCliNoAccount` or `agentAccountChanged` return HTTP 200 with `OnboardingView` and `status: "blocked"`.

### Project scope

Project operations resolve records against the mounted Store. Send `x-orchestrator-project-id: <mounted ID>` on every mutation when a managed project is mounted. Missing scope returns `409 {error, code: "projectScopeRequired"}`. A mismatched scope returns `409 {error, code: "staleProject"}` even if the referenced record exists in the new project. The same mismatch check applies to GET requests and the read-only `POST /orchestrator/api/prompts/preview` when they supply a scope. With no managed mount, legacy operations do not require a header and a supplied scope is stale. The header checks whether the client is targeting the current mount.

`GET settings` and `GET prompts` remain usable before a project is selected. During project selection or remount, these reads and prompt preview return `409 switching` instead of exposing settings or a revision from the outgoing mount. Fetch again with the active project ID before saving.

Under `/orchestrator/api/`, scoped writes are `PUT settings/:block` and `PUT prompts`, plus `POST` to `sources/:id/labels`, `threads/:key/unsubscribe`, `triggers/:id/requeue`, `decisions/:id/dismiss`, `tickets/:id/retry`, `tickets/:id/stop`, `executor/pause`, `policy-sync/:id` and `setup/check`.

`GET topic-binding`, `POST topic-binding` and `POST topic-binding/unbind` require a registered mount and its explicit scope, including for reads. Binding uses the local operator's management authority, not a Feishu credential; the header prevents wrong-project writes, not access by other programs running as the operator. See [the Feishu handoff contract](009-handoff.md#optional-feishu-entry).

`POST project/inspection/:id/repair` also requires the registered mount and explicit project scope. It verifies the checkout and rechecks authorization under the project write lock before recording approval. See `020-idle-inspection.md` for the repair request contract.

`GET /orchestrator/api/sessions/:id/meter` reads Sessions owned by the mounted project in managed mode, including verified lookup and inspection Sessions. An unowned or missing Session returns `404 {error: "Session not found"}`. A new handoff must match the mounted repository and canonical workspace before persisting its approval.

The write check runs after body parsing and before applying the mutation. An installation write or ongoing remount blocks concurrent writes with `409 switching`. An active project write blocks another write, including selection, with `409 projectConflict`. Retrying a Ticket or requeueing a Trigger also checks GitHub, project setup, development routes and operator pause (`githubSetupRequired`, `noProject`, `projectSetupRequired`, `developmentModelsRequired` or `operatorPaused` as applicable). A correctly scoped pause change remains available when setup is pending. After a switch, refresh the mounted ID and confirm the operator's intent before resubmitting a refused mutation.

The verified legacy runtime may still accept an operation into its queue during operator pause, but does not start queued work until processing resumes. Managed projects reject new-work requests while paused.

Registering A with B's checkout returns `400 invalidProject` before registration or selection changes. A request with A's project header after switching to B returns `409 staleProject` without mutating B, even if the record ID is valid there.

### Hub Session rotation

`POST /orchestrator/api/hub/rotate` takes no body. It requires the same-origin management headers and the explicit scope of a mounted managed project. No managed mount returns `409 noProject`; missing or stale scope is refused without invoking rotation. A host without rotation support returns `404`. This is a management operation, not a model tool.

`GET /orchestrator/api/hub/conversation?sessionId=<id>` is a read-only scoped route. It publishes a completed retired Hub root of the mounted project as `{target: null | {projectId, sessionId}}`, naming its active successor. It requires the mounted project scope; no mount is `409 noProject`, and a missing or stale scope is refused without resolving anything. Non-member, active or unfinished identities return `target: null`. This route exposes no operation.

For an adopted legacy deployment, the first physical Hub keeps the adoption-era state-directory working directory, while a generation created by rotation is verified in the mounted project workspace. After a restart following a completed rotation, the successor is still sampled in that workspace rather than reinterpreted from the legacy directory.

Rotation uses the project write lock: a concurrent project selection is refused with `409 projectConflict`, and selection already in progress prevents rotation with `409 switching`. Success is `200 {hubSessionId: string}` with the new physical Hub Session ID. The project ID and its durable work stay unchanged. If rotation fails, HTTP returns an error without confirming a new Session. On restart, Runtime recovers any persisted in-progress rotation; the HTTP adapter does not retry it.

### Confirmed settings

Confirmation reads also require the managed project scope. The proposal and approval POSTs use the same exclusive write gate as other project mutations. See `019-confirmed-settings.md` for the API contract.

## Code and verification

| Entry | Evidence |
| --- | --- |
| [Installation API](../src/app/installation-api.ts), [HTTP adapter](../src/app/http.ts) | Request/response types, error codes, route dispatch and safe projections |
| [Catalog](../src/app/projects.ts), [installation service](../src/app/installation.ts), [runtime](../src/app/runtime.ts) | Catalog transactions, checkout/adoption checks, mounted Store and DSH lifecycle |
| [projects.spec.ts](../tests/projects.spec.ts) | Durable first and explicit selection, independent suspension records, checkout conflicts and alias retargeting |
| [project-work.spec.ts](../tests/project-work.spec.ts) | Hub → Planner → Splitter isolation across remounts and repeated headless polling of authorized events through the GitHub Source with simulated responses |
| [deployment.spec.ts](../tests/deployment.spec.ts), [github-onboarding.spec.ts](../tests/github-onboarding.spec.ts) | Runtime modes, token-free identity and canonical repository probes, and managed setup without a legacy identity fallback |
| [http.spec.ts](../tests/http.spec.ts) | Same-origin transport, typed lifecycle and installation responses, private-field redaction, missing and stale scope, concurrent selection, owned Session meters, Hub rotation responses and write exclusion, and scoped retired-Hub conversation resolution |
| [runtime.spec.ts](../tests/runtime.spec.ts) | Simulated DSH host with real local Git worktrees, mode and project scope checks, same-Assignment resume, and persistent PR reconciliation across repeated graceful restarts |
| [runtime-crash.spec.ts](../tests/runtime-crash.spec.ts) | Real OS process termination and restart against the same SQLite and local Git state. IPC barriers stop the old process after selection commits, after the DSH substitute stores the assignment but before confirmation, and after the GitHub substitute merges but before the runtime observes it. Assert the mounted project, exactly one Worker delivery (verify its message ID in the persisted Session before recovery, and retain the writer lease), and exactly one merge attempt with a reconciled Ticket outcome. Only DSH and GitHub boundaries are simulated. |
| [Live headless connection smoke check](006-deployment.md#live-headless-connection-smoke-check) | Separate check against real DSH over SSH; the process tests do not verify this connection. |

The crash suite builds its child entry with the plugin's ES2024 target before forking, so it runs as plain JavaScript on Node 22 and newer supported runtimes.
