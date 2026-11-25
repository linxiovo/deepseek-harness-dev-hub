# 017 Plan integration delivery

The Plan closes its delivery gate only after every registered node has a matching formal Ticket receipt. `PlanIntegration` verifies a fresh configured-branch snapshot, the full regression for that exact commit and its attempt-matched artifact. Without release authorization, the verified package is the Plan delivery. With release authorization, the package remains pending until a separate controlled release adapter proves the exact target deployment and environment verification. A missing or mismatched adapter blocks release instead of falling back to package-only completion.

## Configure a full regression workflow

Add `planVerification` to the `dsh-superagent` Machine configuration. It is optional and selects one verifier per registered project; duplicate project IDs, duplicate/blank job names, invalid or unsafe workflow IDs and invalid artifact/configuration/environment identifiers prevent startup. Each `projectId` is the registered 32-character project ID. `workflowId` is a required safe positive decimal GitHub Actions workflow ID, not a display name. `jobs` lists every required full-regression and package job; it must include `identityJob`, and skipped, missing or failed jobs do not pass. The identity job compares `dsh_commit`, `dsh_context`, `dsh_configuration` and `dsh_environment` with the requested commit and test profile, and gates regression and packaging jobs. The workflow accepts these four `workflow_dispatch` inputs, names the run `dsh-plan-verification:<dsh_context>`, and uploads `<artifactName>-<dsh_commit>-<run_attempt>` with exactly one artifact file and its `dsh-artifact.json` manifest (`fileName`, `contentType` and SHA-256 included).

```yaml
- id: dsh-superagent
  config:
    stateDir: /srv/dsh/state/superagent
    planVerification:
      - projectId: '0123456789abcdef0123456789abcdef'
        workflowId: '44'
        identityJob: integration-identity
        jobs: [integration-identity, windows, check, integration-bundle]
        artifactName: plugin-bundle
        configuration: plugin-check-v1
        environment: github-hosted-node22-pnpm11-v1
```

These settings select and version a regression workflow; they do not select or authorize a deployment target. Do not include credentials in the inputs. The supplied workflow verifies the dispatched commit and profile, gates both hosted Windows and Ubuntu `pnpm check` jobs on the identity job, and builds a package from the successful Ubuntu check for that same Actions attempt. It uploads the `.tgz` with a manifest declaring `application/gzip`; it does not deploy or publish a release. Projects may instead attach a safe single-file package, executable or other downloadable artifact with its declared media type. Projects use their own workflow, required jobs, configuration and environment identifiers.

The registered workflow is trusted operator configuration: the plugin dispatches it but does not inspect its source or restrict its GitHub permissions. Register only a full-regression workflow that cannot publish or deploy, and do not expose production secrets to it. The configured `gh` identity needs Actions write permission to dispatch and read permission to inspect and download artifacts. Before reporting delivery, the host downloads the run's artifact with this identity and checks the strict manifest, repository, ref, commit, workflow run, attempt, context, configuration, environment, safe filename, declared media type and SHA-256; it then retains the verified file in the project's state directory. The Harness download route is project-scoped and uses this retained copy, so the requester does not need GitHub Actions access. The separate GitHub run/artifact links still require the requester's browser account to have repository Actions read access. Missing host permission or an unavailable GitHub API leaves the Plan blocked; the Hub does not claim a successful run or substitute a local test.

## Authorized release

The original direct Handoff confirmation must set `authorization.release` to `authorized` and include the exact `releaseTarget { environment, target, scope }`. An authorized legacy record without that target, an execution quota change, or repair-only scope cannot release anything. The configured adapter must match all three target fields and the registered project before the host checks credentials or invokes it.

Add one `planRelease` entry for a project that also has `planVerification`:

```yaml
    planRelease:
      - projectId: '0123456789abcdef0123456789abcdef'
        executable: /opt/dsh-release/bin/adapter
        args: []
        environment: production
        target: storefront
        scope: catalog service
        credentialId: production-deploy
        credentialProviderUrl: https://vault.example.test/projects/storefront
```

The executable and anything it loads must be trusted operator code outside the project's control, not a repository workflow. It runs from the mounted project's state directory through the Harness subprocess service. Keep credentials in their provider, never in the profile, arguments, request or chat. `credential-check --request-stdin` receives `{request}` and must exit successfully with `ready` or `missing` as its only stdout token. Only `missing` exposes the controlled provider URL and identifier in the panel and a deduplicated credential relay. A timeout, process failure or invalid output blocks release without asking the operator for credentials.

`publish --request-stdin` receives `{request, artifactPath}`. The request binds the project, exact approved target, integration SHA/context, regression run and artifact filename/size/SHA-256. Immediately before transfer, the adapter must verify the file checksum and deploy only the requested scope. The stable `request.id` is its idempotency key: repeats must return the same deployment rather than create another release. `observe --request-stdin` receives the same request and is read-only. Each successful command writes one JSON `PlanReleaseObservation` to stdout; stderr is private and never relayed.

Before each `publish`, the host rechecks the local package, current target commit, regression profile and latest successful run attempt. If the evidence moved before any write started, regression verification starts again rather than publishing the old package.

`missing` means no conclusive answer and never authorizes a write. `not-started` means an authoritative check of the actual target proved that this request has not written and cannot still write in the background; an absent, delayed or unreadable receipt alone is not that proof. Only this status allows retry after rechecking the same request and target, credentials and regression, and only if no deployment was already observed. `publishing` is in progress; `not-published` is a definitive failed attempt with no target write. When a write occurred, return `published` with the deployment ID, SHA, artifact SHA-256, timestamp and verification (`pending`, `failed` or `passed`). A passed check binds that ID, SHA and checksum and cannot predate deployment. Never report a partial deployment as `missing`, `not-started` or `not-published`. A pause stops new writes without discarding facts already returned.

The host records release intent before calling the adapter and serializes releases to each project/environment/target. `release-failed` means the adapter proved publication did not occur: the panel says 已合入，未上线. `released-unverified` records an actual deployment but not a matching successful environment verification; it is not complete and is never reported as rolled back. Only `released` closes the Plan delivery state and emits the final relay with artifact, deployment and verification evidence.

## Durable verification


Formal Ticket closure stores the integration commit with the node receipt. The Plan gate re-reads the authoritative configured `refs/heads/...` target and proves each recorded integration is an ancestor of the exact observed SHA. It binds repository, project, ref, commit, workflow, identity job, sorted jobs, artifact name, configuration and environment into a context digest. A changed tip or verification profile produces a different context and requires a new run. Change the configured profile identifiers when the tests or a relevant runner/toolchain environment changes.

Before dispatch, the host persists the exact context. If GitHub accepts the dispatch but the process dies before recording its response, recovery adopts the matching run without another POST. If the host cannot tell whether the request reached GitHub, it keeps checking for a matching run and shows `dispatch_unconfirmed` without reposting. A definitive 4xx refusal clears the dispatch marker and parks the effect even if the project was paused while GitHub replied; after fixing the permission or workflow configuration, restart the host to rearm it.

To recover a `dispatch_unconfirmed` with no run, an operator with Actions access reads `version` from the delivery view. In that workflow, confirm there is no run titled `dsh-plan-verification:<context>` for the recorded branch and SHA. If the branch still points to `version.sha`, manually run the workflow on that branch with `dsh_commit=version.sha`, `dsh_context=version.context`, `dsh_configuration=version.configuration` and `dsh_environment=version.environment` (use the actual values). The host checks and adopts that run. If the branch moved, the host handles the new SHA separately; do not dispatch the old context.

The host polls pending runs. Before accepting a package, it samples the target, downloads and checks the exact attempt, then checks Actions, the target and Actions again. These observations reject a target move during the first Actions check or a superseded attempt during the target recheck. Git and Actions are separate services; evidence covers the observed revision and attempt, not later branch movement or reruns. The identity and every full-regression job must report `completed / success`; the manifest must match the repository, commit, attempt, profile and file checksum.

If the retained package is missing or unreadable before release, restart blocks delivery, cancels any pending success relay and rearms verification. With a release intent, reconcile the external write without waiting for a readable local file. If the deployment and environment verification were confirmed, only the original run/attempt and exact package may be restored; local loss never allows redeployment. `released-artifact-unavailable` preserves the existing receipt but withholds Plan completion until verified bytes are available again. Relay delivery checks the file and reuses the same request ID after recovery.

The Hub reads `plan/<id>/delivery`; its response carries the state, repository/ref/SHA/context, Actions run and job URLs, artifact filename, media type, size, checksum and verification time. A successful `plan-delivered` relay includes a Harness deep link to one of the Plan's Tickets, where the person can open the retained artifact without GitHub Actions permission. `GET /orchestrator/api/plans/:id/delivery` exposes the stored view and `GET /orchestrator/api/plans/:id/artifact` streams the retained file under the selected project's normal loopback, same-origin and project-scope checks. Both routes are read-only; neither GET nor resource reads dispatch or retry work.

| Method and path | Input | Success |
| --- | --- | --- |
| `GET /orchestrator/api/plans/:id/delivery` | No body/query. Send `x-orchestrator-project-id` for the selected project. | `200 PlanIntegrationView` |
| `GET /orchestrator/api/plans/:id/artifact` | No body/query. Send `x-orchestrator-project-id` for the selected project. | `200` with the manifest's validated media type, attachment filename, length and SHA-256 headers |

The routes require the normal loopback Host, `x-orchestrator-request: 1`, same-origin Origin when present, and the active project ID. Delivery returns `Cache-Control: no-store`. Artifact streaming holds the mounted-project fence until the response completes, so project selection and project writes cannot replace its scope mid-download. Invalid query is `400`; a non-loopback or cross-origin request is `403`; an unknown Plan or unavailable integration view is `404`; a missing/stale project scope or project transition is `409`; an unavailable or checksum-mismatched local file is `404`; an unexpected operation failure is `500`. The Hub resource is `plan/<id>/delivery`; it is available to the Hub, not Ticket Workers or planning Sessions.

| Status | Meaning |
| --- | --- |
| `awaiting-tickets` | Lists nodes without a formal, versioned Ticket delivery receipt. Worker reports, a closed PR, and a local ready result are not receipts. |
| `verifying` | The exact integrated revision is being checked; `run` appears when an exact-context Actions run exists. |
| `blocked` | Evidence is unconfigured, failed/incomplete, stale, unavailable, or an external dispatch could not be confirmed. The response includes a reason and available version/run evidence. |
| `delivered` | All formal Ticket receipts, full regression jobs and a matching available package passed. One stable `plan-delivered:<planId>` relay points to the version, run, artifact and resource. |
| `awaiting-release-verification` | The handoff explicitly promised release. Integration and regression passed, but production is not deployed and no final-delivery relay is emitted. |
| `release-blocked` | Release is blocked by missing authorization, an absent or mismatched adapter, contention with another release or unavailable release prerequisites. Read `reason` for the specific hold. |
| `awaiting-release-credentials` | The authorized target matched and `credential-check` reported `missing`. The panel links to the controlled provider and shows its identifier, not a credential value. |
| `releasing` | A durable release request is being published or reconciled by the same request ID. `release_dispatch_unconfirmed` means its write outcome is unknown. |
| `release-failed` | The adapter proved publication did not occur; the Plan remains incomplete and no rollback is implied. |
| `released-unverified` | Deployment occurred, but artifact identity or environment verification has not passed. The deployment and the adapter's reported check remain visible; a `passed` check with `release_evidence_mismatch` is not accepted. |
| `released-artifact-unavailable` | The deployed package passed environment verification, but the original regression package cannot currently be downloaded from Harness. This is not Plan completion. |
| `released` | The environment verified the exact deployment of the regression SHA and checksum, and the verified package is available. The final relay separates package, deployment and environment verification. |

Pure optional retro follow-ups are not Plan nodes and do not delay verification. Configuration and implementation entry points are `src/deployment.ts`, `src/app/plan-integration.ts`, `src/app/plan-release.ts`, `src/app/release-adapter.ts`, `src/app/plan-artifacts.ts`, `src/executor/mainline-git.ts`, and `src/sources/actions-evidence.ts`. The repository regression workflow is `.github/workflows/plugin-ci.yml`.

## Code and verification

From `plugin/`, run `pnpm test tests/plan-release.spec.ts tests/actions-evidence.spec.ts tests/plan-artifacts.spec.ts tests/plan-integration-crash.spec.ts tests/mainline-queue.spec.ts tests/http.spec.ts tests/panel-execution.spec.tsx tests/navigation.spec.ts tests/deployment.spec.ts tests/locales.spec.ts tests/class-docs.spec.ts tests/docs.spec.ts`. These checks cover release authorization, target/scope rejection, missing credentials, interrupted release recovery, exact artifact and environment receipts, integration dispatch recovery, package loss, Harness downloads, and the release panel. `pnpm check` runs the complete import gate, typecheck, tests, and build; CI's Windows and Ubuntu required jobs use this same full check before the package job.
