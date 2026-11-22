# 017 Plan integration delivery

The Plan closes its delivery gate only after every registered node has a matching formal Ticket receipt. `PlanIntegration` then verifies one fresh snapshot of the configured GitHub branch, dispatches the full regression workflow for that exact commit and accepts only that run's configured successful jobs and downloadable artifact. The returned artifact and full commit are the Plan's delivery; no production deployment is part of this workflow.

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

## Durable verification

Formal Ticket closure stores the integration commit with the node receipt. The Plan gate re-reads the authoritative configured `refs/heads/...` target and proves each recorded integration is an ancestor of the exact observed SHA. It binds repository, project, ref, commit, workflow, sorted jobs, artifact name, configuration and environment into a context digest. A changed target produces a different context and requires a new run; a target change during a run discards that observation and retries against the new tip.

Before dispatch, the host persists the exact context. If GitHub accepts the dispatch but the process dies before recording its response, recovery reads that context and adopts the existing run without another POST. An ambiguous response with no matching run remains blocked without reposting. A definitive 4xx refusal clears the dispatch marker and parks the effect even if the project was paused while GitHub replied; after fixing the permission or workflow configuration, restart the host to rearm it. Pending runs are retried. The host downloads and validates the latest attempt, checks the target branch, queries Actions for the exact successful run, then checks the target branch again immediately before recording delivery. A changed target blocks delivery; no asynchronous work occurs between the final branch check, atomic artifact promotion and state update. The identity and every full-regression job must report `completed / success`; the manifest must match the run, commit, attempt, profile and file checksum.

On restart, a delivered integration record with missing or checksum-invalid retained bytes is demoted to `blocked` and its still-queued `plan-delivered:<id>` relay is cancelled before the effect queue starts. A later successful verification can replace a missing or damaged copy from the same pinned run; interruption during replacement is cleaned up and recovered from Actions.

The Hub reads `plan/<id>/delivery`; its response carries the state, repository/ref/SHA/context, Actions run and job URLs, artifact filename, media type, size, checksum and verification time. A successful `plan-delivered` relay includes a Harness deep link to one of the Plan's Tickets, where the person can open the retained artifact without GitHub Actions permission. `GET /orchestrator/api/plans/:id/delivery` exposes the stored view and `GET /orchestrator/api/plans/:id/artifact` streams the retained file under the selected project's normal loopback, same-origin and project-scope checks. Both routes are read-only; neither GET nor resource reads dispatch or retry work.

| Method and path | Input | Success |
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

Pure optional retro follow-ups are not Plan nodes and do not delay verification. Configuration and implementation entry points are `src/deployment.ts`, `src/app/plan-integration.ts`, `src/executor/mainline-git.ts`, and `src/sources/actions-evidence.ts`. The GitHub workflow is `.github/workflows/plugin-ci.yml`.

## Code and verification

From `plugin/`, run `pnpm test tests/actions-evidence.spec.ts tests/plan-artifacts.spec.ts tests/plan-integration-crash.spec.ts tests/mainline-queue.spec.ts tests/http.spec.ts tests/panel-execution.spec.tsx tests/navigation.spec.ts tests/deployment.spec.ts tests/locales.spec.ts tests/class-docs.spec.ts tests/docs.spec.ts` for attempt binding, file identity and checksum, missing/damaged retained file recovery, stale relay cancellation, restart staging cleanup, SIGKILL after accepted dispatch, pause during 403, target movement during the final Actions lookup, branch/project scoping, stored Plan delivery and download, Harness deep links and release hold, configuration, notification vocabulary and documentation indexing. `pnpm typecheck` checks the shared contracts. `pnpm check` runs the complete import gate, typecheck, tests, and build; CI's Windows and Ubuntu required jobs use this same full check before the package job.
