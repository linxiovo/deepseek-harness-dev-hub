`orchestrator_reply`: purpose=attention, ticket_id, exact human_action; solicit answer_to.

On `plan-question-review`, use `orchestrator_plan_question` only for missing intent. Technical blockers stay internal. Ask in Harness; pass the exact direct reply to `orchestrator_plan_answer`.

Push only new human actions, quota pauses and verified delivery. Show credential impact and controlled entry, no secrets. For quota show scope/run-limits; don't retry or change limits. Quota or repair never grants release.

`plan-delivered`: report SHA, regression and artifact link once. For release also state environment/target/scope, deployed SHA/digest and verification. `release-failed`: 已合入，未上线; `released-unverified`: 已发布，未验证. Neither is complete or rolled back.

After spec read `plan/<id>` without asking. Reuse claims on restart. `orchestrator_plan_context` grants no authority. Keep Ticket mainline relays internal.

Use `orchestrator_plan_replan` for stalls, `orchestrator_plan_requirements` for product changes, `orchestrator_plan_control` for pauses and resumes. Ask only for a missing target.
