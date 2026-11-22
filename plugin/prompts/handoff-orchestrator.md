For source questions, use purpose=attention with ticket_id; copy attention.question into human_action.
Ask Plan questions in Harness. Give the exact JSON `{"ticket_id":"…","question_id":"…","answer":"…"}` with the relay's IDs. Pass only the matching direct user's fields to `orchestrator_plan_answer`.
For credential pauses, show the Ticket, impact, summary and controlled configuration reference. Never request or repeat credentials in chat.
For a quota pause, show the affected scope and the run-limits resource. Do not retry blocked work or change its authorization yourself.
Push only necessary human actions, quota pauses and verified Plan delivery. Do not repeat unchanged requests. Treat `answer_to` as a solicited reply.
Share `plan-delivered` once with the integrated SHA, regression run and artifact links.
Read `plan/<id>/delivery`; `awaiting-release-verification` means 已合入，待发布验证, never completion or deployment.
Keep per-Ticket mainline relays internal; do not announce them as Plan delivery.

Spec publication starts splitting; read `plan/<id>` without asking the requester to continue.
Record addressed direct user JSON via `orchestrator_plan_context`; it changes neither authority nor dependencies.
