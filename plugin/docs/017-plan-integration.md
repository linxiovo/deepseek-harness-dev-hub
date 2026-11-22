# 017 Plan integration delivery

The Plan closes its delivery gate only after every registered node has a matching formal Ticket receipt. `PlanIntegration` then verifies one fresh snapshot of the configured GitHub branch, dispatches the full regression workflow for that exact commit and accepts only that run's configured successful jobs and downloadable artifact. The returned artifact and full commit are the Plan's delivery; no production deployment is part of this workflow.

## Configure a full regression workflow

Add `planVerification` to the `dsh-superagent` Machine configuration. It is optional and selects one verifier per registered project; duplicate project IDs, duplicate/blank job names, invalid or unsafe workflow IDs and invalid artifact/configuration/environment identifiers prevent startup. Each `projectId` is the registered 32-character project ID. `workflowId` is a safe positive decimal GitHub Actions workflow ID, not a display name. `jobs` lists every required full-regression and package job; skipped, missing or failed jobs do not pass. `identityJob` must be one of these jobs, compare `dsh_commit`, `dsh_context`, `dsh_configuration` and `dsh_environment` with the actual commit and test profile, and gate the regression/package jobs. The workflow must accept those four `workflow_dispatch` inputs, set its run name to `dsh-plan-verification:<dsh_context>`, and create an artifact named `<artifactName>-<dsh_commit>-<run_attempt>`.

```yaml
- id: dsh-superagent
  config:
    stateDir: /srv/dsh/state/superagent
    planVerification:
      - projectId: '0123456789abcdef0123456789abcdef'
        identityJob: integration-identity
        jobs: [integration-identity, windows, check, integration-bundle]
        artifactName: plugin-bundle
        configuration: plugin-check-v1
        environment: github-hosted-node22-pnpm11-v1
```

These settings select and version a regression workflow; they do not select or authorize a deployment target. Do not include credentials in the inputs. The supplied repository workflow uses hosted Windows and Ubuntu runners, checks that the requested commit equals the dispatched branch commit and that the configuration/environment identifiers match, runs `pnpm check` (imports, TypeScript, full tests and build), and packages `plugin/lib` as `plugin-bundle-<sha>-<attempt>`. It does not configure a GitHub deployment environment, contact production, or publish a release. Projects use their own workflow, required jobs, configuration and environment identifiers.

The registered workflow is trusted operator configuration: the plugin dispatches it but does not inspect its source or restrict its GitHub permissions. Register only a full-regression workflow that cannot publish or deploy, and do not expose production secrets to it. The configured `gh` identity needs Actions write permission to dispatch and read permission to inspect jobs and artifacts. The artifact URL opens GitHub and also requires the requester's browser account to have Actions read access to this repository; the host verifies its configured service identity, not the requester's browser identity. Missing permission or an unavailable GitHub API leaves the Plan blocked; the Hub does not claim a successful run or substitute a local test.

## Durable verification

Formal Ticket closure stores the integration commit with the node receipt. The Plan gate re-reads the authoritative configured `refs/heads/...` target and proves each recorded integration is an ancestor of the exact observed SHA. It binds repository, project, ref, commit, workflow, sorted jobs, artifact name, configuration and environment into a context digest. A changed target produces a different context and requires a new run; a target change during a run discards that observation and retries against the new tip.

Before dispatch, the host persists the exact context. If GitHub accepts the dispatch but the process dies before recording its response, recovery reads that context and adopts the existing run without another POST. An ambiguous response with no matching run remains blocked without reposting. A definitive 4xx refusal means no workflow run was accepted, so the marker is cleared and the effect is parked; after fixing the permission or workflow configuration, restart the host to rearm it. Pending runs are retried. Only the latest matching run and attempt can pass: the observer rereads Actions after fetching the jobs and artifact and returns pending if a newer run/attempt appeared. Every configured identity and full-regression job must report `completed / success`; the artifact must match the run, commit, attempt, configured name, have a positive size, and not be expired.

The Hub reads `plan/<id>/delivery`; its response carries the state, repository/ref/SHA/context, Actions run and job URLs, artifact URL and verification time. `GET /orchestrator/api/plans/:id/delivery` exposes the same stored response to the selected project under the normal loopback, same-origin and project-scope checks. The route is read-only. Neither GET nor resource reads dispatch or retry work.

| Method and path | Input | Success |
| --- | --- | --- |
| `GET /orchestrator/api/plans/:id/delivery` | No body/query. Send `x-orchestrator-project-id` for the selected project. | `200 PlanIntegrationView` |

The route requires the normal loopback Host, `x-orchestrator-request: 1`, same-origin Origin when present, and the active project ID. It returns `Cache-Control: no-store`. Invalid query is `400`; a non-loopback or cross-origin request is `403`; an unknown Plan or unavailable integration view is `404`; a missing/stale project scope or project transition is `409`; an unexpected operation failure is `500`. The Hub resource is `plan/<id>/delivery`; it is available to the Hub, not Ticket Workers or planning Sessions.

| Status | Meaning |
| --- | --- |
| `awaiting-tickets` | Lists nodes without a formal, versioned Ticket delivery receipt. Worker reports, a closed PR, and a local ready result are not receipts. |
| `verifying` | The exact integrated revision is being checked; `run` appears when an exact-context Actions run exists. |
| `blocked` | Evidence is unconfigured, failed/incomplete, stale, unavailable, or an external dispatch could not be confirmed. The response includes a reason and available version/run evidence. |
| `delivered` | All formal Ticket receipts, full regression jobs and a matching available package passed. One stable `plan-delivered:<planId>` relay points to the version, run, artifact and resource. |
| `awaiting-release-verification` | The handoff explicitly promised release. Integration and regression passed, but production is not deployed and no final-delivery relay is emitted. |

Pure optional retro follow-ups are not Plan nodes and do not delay verification. Configuration and implementation entry points are `src/deployment.ts`, `src/app/plan-integration.ts`, `src/executor/mainline-git.ts`, and `src/sources/actions-evidence.ts`. The GitHub workflow is `.github/workflows/plugin-ci.yml`.

## Code and verification

From `plugin/`, run `pnpm test tests/actions-evidence.spec.ts tests/plan-integration-crash.spec.ts tests/mainline-queue.spec.ts tests/http.spec.ts tests/deployment.spec.ts tests/locales.spec.ts tests/class-docs.spec.ts tests/docs.spec.ts` for latest-attempt binding, SIGKILL after accepted dispatch, waiting versus formal Ticket receipts, branch/project scoping, stored Plan delivery, configuration, notification vocabulary and documentation indexing. `pnpm typecheck` checks the shared contracts. `pnpm check` runs the complete import gate, typecheck, tests, and build; CI's Windows and Ubuntu required jobs use this same full check before the package job.
