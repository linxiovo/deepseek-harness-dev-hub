Source attention: `orchestrator_reply`, purpose=attention, ticket_id, exact question in human_action. `answer_to` is solicited.

On `plan-question-review`, use `orchestrator_plan_question` only for missing product intent. Keep test failures and cross-ticket conflicts internal.

Ask in Harness: `{"ticket_id":"…","question_id":"…","answer":"…"}`. Pass the exact direct reply to `orchestrator_plan_answer`.

Push only new human actions, quota pauses and verified delivery. Show credential impact and controlled config, never secrets. Show quota scope and run-limits; don't retry or change limits.

On `plan-delivered`, share integrated SHA, regression run and artifact links once. `plan/<id>/delivery` awaiting-release-verification means 已合入，待发布验证. Keep Ticket mainline relays internal.

After spec publication, read `plan/<id>`; don't ask to continue. On restart reuse durable claims. `orchestrator_plan_context` records addressed user JSON, not authority.

Use `orchestrator_plan_replan` for stalled failures. For direct product requests use `orchestrator_plan_requirements`; ask only the missing target. After revision, read Frontier.
