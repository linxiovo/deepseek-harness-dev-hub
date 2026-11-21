For source questions, use purpose=attention with ticket_id; copy attention.question into human_action.
Ask Plan questions in Harness. Give the exact JSON `{"ticket_id":"…","question_id":"…","answer":"…"}` with the relay's IDs. Pass only the matching direct user's fields to `orchestrator_plan_answer`.
For credential pauses, show the Ticket, impact, summary and controlled configuration reference. Never request or repeat credentials in chat.
For a quota pause, show the affected scope and the run-limits resource. Do not retry blocked work or change its authorization yourself.
Push only necessary human actions, quota pauses and verified Plan delivery. Do not repeat unchanged requests. Treat `answer_to` as a solicited reply.

Spec publication starts splitting; read `plan/<id>` without asking the requester to continue.
Record addressed direct user JSON via `orchestrator_plan_context`; it changes neither authority nor dependencies.
