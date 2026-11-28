# 021 Read-only lightweight lookup

The current Hub of a mounted project can use `orchestrator_lookup` for repository search, Doc Tree navigation and status summaries. The tool returns a model-generated **advisory**, not a decision, delivery receipt, review or permission to act. Use an exact read to verify a claim. Ordinary reads do not spend a lookup call.

| Input example | Facts sent to the model |
| --- | --- |
| `{"kind":"code","path":"src/widgets.ts","query":"Where is the widget count capped?"}` | One page of the exact committed file or directory. The model searches that page, not the whole repository. |
| `{"kind":"doc-route","query":"Where is the widget API documented?"}` | One committed Markdown navigation page. `path` defaults to `DOCS.md`; choose another local Markdown route to continue. Links are data, never automatically followed. |
| `{"kind":"status"}` | Snapshot of the mounted project's open Ticket count and counts by stage. No Ticket bodies, human messages, credentials or settings are sent. |

`code` and `doc-route` accept `offset` (default `0`) and a single-line `query` of up to 200 characters. The host pins the project's configured base ref, verifies the checkout and origin and uses the [immutable object reader](020-idle-inspection.md#read-and-report). Paths are literal, repository-relative names, not filesystem aliases, URLs, Git revisions or resource IDs. Objects must be local regular blobs or trees. Files must be UTF-8 text. Each page contains at most 8,000 UTF-16 units or 100 directory entries; offsets use the same units. The serialized model input is limited to 32,000 characters. Each call pins its own commit: compare `source.commit` when following `source.nextOffset` across calls.

A successful result contains `{advisory:true, sessionId, model:{provider,model}, source, summary}`. `model` is the actual admitted route. For repository queries `source` contains `{projectId,commit,path,offset,nextOffset}`; `nextOffset:null` ends the object. For status it contains `{projectId,sampledAt}`. `summary` is the completed model turn's visible text, at most 2,000 characters; it may report that the supplied page did not answer the question.

## Model, permissions and interruption

The operator selects `executor.lightweightModel` (`provider`, `model`, optional `reasoningEffort`) in management settings; it is the same selector used for idle inspection. Omission or `null` uses the DSH host default, not `executor.model` or a development role. An unavailable configured route fails rather than trying the default. A lookup does not enable or use an idle-inspection grant.

Each invocation uses a fresh, unseeded native DSH root with an empty preset, no tools and one sealed user message. The Hub is its business parent for [project metering](014-project-metering.md), not a fork parent. The selected model event (for an override), request route and response are observable in the Session. One provider attempt must pass the normal project [run limit](016-run-limits.md). A refusal or interrupted turn returns no summary. This tool cannot start a Ticket, change files or contact another channel.

The host must support native Hub tool-call identities, Session persistence and agent-loop streaming. A profile that injects extra model-facing messages or tools into the lookup request is refused rather than leaking that context. A strict project token cap also requires the provider's verified request bound.

Changing projects, retiring the Hub or stopping the host invalidates the invocation. The host reserves the native Hub call and creation token before reading the snapshot or opening the lookup root, then records the verified native creation time before waking it. Reopening a log restores neither authority nor a pending task. The same call cannot be replayed after interruption, even on the same Hub; a fresh invocation gets its own Session and budget admission.

Implementation: [Hub tool](../src/app/tools/main.ts), [lookup dispatch](../src/app/lightweight-lookup.ts), [provider admission](../src/app/model-admission.ts). From `plugin/`, run `pnpm test tests/lightweight-lookup.spec.ts` for configured/default routing, committed input, metering, refusal and project switching. The fixture replaces remote provider I/O; it does not establish availability of a live provider.
