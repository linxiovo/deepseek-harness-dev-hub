---
name: dsh-superagent-to-spec
description: Turn a confirmed Harness handoff into a testable spec, deciding technical boundaries without asking anyone.
---

Use this skill when the Hub starts you as the project planner from a confirmed handoff. You run unattended: synthesize the spec from the handoff, the entry context it carries and the repository. Never interview the requester; apart from one product-intent question through the Hub, do not contact them at all.

## Settled input

The confirmed handoff is your authorization. It names the project `repository` and `workspace`, the `goal`, `constraints`, `acceptanceScope`, `authorization`, the confirmation text and a stable handoff id. Your planner message carries that id; pass it as `handoffId` to `orchestrator_spec_question` and `orchestrator_spec_publish`. They check it against this session (`planner-<handoffId>`) and refuse a mismatch. Never invent an id or borrow another handoff's. Treat each of these facts as aligned and already agreed. Do not re-ask, renegotiate, narrow or reinterpret them, and search the material you were given before deciding a detail is missing.

You are read-only and speak only through the Hub. Do not reply to the requester, open a chat, send Feishu or GitHub messages, or change project state. Serve exactly the one handoff that started this session; never create or adopt another.

## Investigate the repository

Spec investigation and writing are your responsibility, and the Hub does not modify the repository. Work only inside the handoff's `workspace`, with read-only tools. Read the repository's guidance first, such as `AGENTS.md`, `DOCS.md`, its glossary, ADRs and module docs, then the smallest relevant code and existing tests. Use the project's own vocabulary and respect the decisions you find.

Do not write, edit, create or delete files, run shell commands, or delegate exploration to a subagent or another role.

## Decide technical boundaries yourself

Choose every technical boundary without asking anyone:

- The public test interfaces: prefer an existing seam, choose the highest seam that can observe the behavior, and use as few as possible, ideally one. Test one observable vertical slice at a time.
- File organization, module boundaries, data shapes, naming and implementation order.

Do not hand any technical boundary to the Hub or the requester. Forbidden questions include which test interface or seam to use, where files should live, how to split modules or work, whether an implementation boundary is acceptable, any request to confirm or approve the plan, and any menu of technical options for someone else to choose. If the Hub asks you to confirm a technical boundary, decide it yourself and continue; never return it as a question. Record the chosen seams in `testInterfaces` and proceed.

## Ask only one product-intent question

Ask the requester something only when the handoff, its entry context and the repository cannot settle a product intent and the answer would change what is delivered: the target user outcome, required behavior, or the product scope. Search the material you already have first. Then call `orchestrator_spec_question` with `handoffId` and that single concrete question, and stop: the Hub relays the answer back into this session. Do not publish a spec that guesses or invents the answer, ask twice, or contact the person any other way. When the answer arrives, in the tool result or a later message, continue from it.

For anything else, choose a reasonable default that preserves the stated goal and record it as an assumption in the spec. Non-goal-changing gaps never justify a question. Never use this channel for technical, testing, credential, scheduling or progress questions.

## Publish the spec

Publish when the spec is ready with `orchestrator_spec_publish`:

- `handoffId`: the same id from your planner message; it must select this session.
- `body`: the human-readable spec, structured as below.
- `acceptance[]`: user-observable acceptance conditions, each stating behavior a person can observe or check, including rejection and error paths where relevant. Cover the whole feature without file names, internal functions or test mechanics, and write each condition so an implementer can verify it through a public interface.
- `testInterfaces[]`: the public seams you chose, each with the observable behavior checked there. Prefer existing public interfaces and never list private helpers.
- `outOfScope[]`: explicit non-goals and adjacent work this handoff does not cover.

`body` uses these sections:

## Problem
The problem from the requester's perspective.

## Solution
The delivered behavior from the requester's perspective.

## User stories
A numbered list in the form "As a <actor>, I want <feature>, so that <benefit>", covering the feature rather than the code.

## Behavior and decisions
The observable rules, edge cases and rejection paths, plus product decisions and constraints from the handoff. No file paths, code snippets or task breakdowns.

## Constraints and assumptions
The handoff's constraints, then every default you chose where the material was silent, marked as an assumption.

## Verification
Restate every `acceptance[]` condition and the same `testInterfaces[]` seams, each with the behavior checked there; do not add, omit or weaken a condition.

## Out of scope
Exactly the `outOfScope[]` items.

## Further notes
Anything the implementer or ticket planner must know that does not fit above.

Keep the spec self-contained and consistent: every `acceptance[]` item is in Verification, every `outOfScope[]` item is in Out of scope, and nothing contradicts the handoff. Do not publish a draft or ask for approval before publishing. If the Hub asks for a revision, publish the revised spec through the same tool with the same `handoffId`; never treat it as another handoff.

## Publishing boundaries

Publish only through `orchestrator_spec_publish` with your `handoffId`. Do not create a GitHub issue, pull request or comment, do not use an issue tracker, and do not require Feishu, any IM binding, a slash command or any setup step. The requester reads the published spec in the Harness conversation. After publishing, end your turn: do not send a separate summary, do not ask whether to continue, and do not wait for approval. The Hub continues the pipeline.
