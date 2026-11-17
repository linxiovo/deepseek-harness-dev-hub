# 01: dsh-superagent-prototype 底座能力与扩展点摸底

Type: research
Status: resolved
Blocked by: None

## Question

深入审查 `meta/References/Projects/dsh-superagent-prototype` 源码（`src/core/`、`src/app/`、`src/executor/dsh.ts`、`prompts/`、`skills/`、`src/client/`），查明以下事实以支撑后续架构决策：
1. 当前 `Main Session (orchestrator)` 与 `Executor Session (worker)` 各自暴露了哪些内置工具（Tools），两者之间通过什么数据结构通信（派单、状态汇报、追问、暂停/重试）？
2. 当前 `Ticket`、`Thread`、`Assignment` 的状态存储（`store.ts` / `kv.ts`）是如何组织的？若要引入带 `Blocked-by` 依赖边的 `Plan DAG` 以及多票顺序合入主干（Worktree → Main branch），现有模型缺少哪些字段与钩子？
3. 主会话（`orchestrator`）目前的上下文增长是如何管理的？D-SH 宿主 API 是否原生支持会话压缩（compact）、清理重置（clear）或新开继承会话？
4. Web Panel（`src/client/`）采用什么前端技术栈与宿主通信机制？在面板中新增“可视化 Ticket 树”和“AI 文档树预览”的挂载入口在哪里？

## Answer

> 审查对象：`meta/References/Projects/dsh-superagent-prototype`（实际目录名 `dsh-superagent-prototype`）。D-SH 宿主能力以 `package.json` 锁定的 `@deepseek-ai/dsh-*@0.2.1-alpha.2` 类型声明为准；原型自己的调用点均标到文件与符号。

### 0. 结论速览

- 原型是 D-SH/Cordis bundle：`cordis.patch.yml` 插入 `dsh-superagent`、`dsh-superagent/github-watch`、可选的 `dsh-superagent/feishu-watch` 三个插件，并定义 `dsh-superagent-router`（主会话）与 `dsh-superagent-worker`（执行器）两个 agent preset。
- 主会话有 14 个应用自定义工具，执行器有 6 个；两者都通过 `agent.ctx.tools.register` 挂到各自的 DSH Session，而不是全局工具。
- 所有域状态由 `Engine` 单写：Trigger/Thread/Decision/Ticket/Assignment 进 SQLite（`src/app/store.ts`），外部副作用经 `Effects` 持久化队列执行；主/worker 之间没有直接 RPC，全部通过 `TicketInput`、`Assignment.report`、`Effects` 的 `relay`/`notice`/`launch`/`delivery` 以及 DSH agent inbox 流转。
- 现有模型是一张 Ticket 对应一次 accept，`Assignment` 内嵌在 `Ticket.assignments` 数组里；没有 Plan/节点/依赖边/合并队列字段，也没有内置 `git worktree` 或 merge 实现。worktree 完全由用户在 `executor.prepare` 中写的 shell 命令创建；合并由 worker 的 prompt/`gh` 完成，宿主只通过 GitHub Source 轮询 PR 的 merged/closed 状态来关票。
- D-SH 宿主原生提供 Session 创建/复用、prompt、cancel、`inspect`/`page`/`follow` 历史读取、`fork` 继承会话，以及 `ctx.compaction` 压缩服务；**没有**公开的“clear/delete 当前 Session”API，`Agent.inbox.clear()` 只清待处理输入，不清历史。原型没有在代码里主动调用 compact/fork/clear；它只把 `@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-command-compact` 和 tool-result-pruner 放进了两个 preset，因此压缩由 D-SH 在运行时按策略执行，原型不控制。
- 面板是 React 18 + 自带的 `dt-*` 控件/CSS，无 react-router；用 `usePoll` 轮询 `/orchestrator/api/*`，路由是内存状态 + `sessionStorage`。新增“Plan DAG”和“文档树”最自然的挂载点是各加一个顶层 Tab（`src/client/route.ts` 的 `TABS`/`Route`/`parseRoute` + `src/client/app.tsx` 的 `Pages`），后端分别补 `src/app/api.ts`/`src/app/http.ts` 路由与 `src/app/views/` 视图；`src/client/index.tsx` 的宿主面板注册不需要改。

---

### 1. 两个 Session 各自暴露哪些工具，通信链路如何流转

#### 1.1 工具挂载机制

`Sessions.decorate`（`src/app/sessions.ts`）对每个受管 agent 做三件事：

1. 通过 `agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, complete: master })` 注入动态系统提示；主会话 `complete: true`，即完全替换 DSH 自己的系统提示。
2. 通过 `agent.ctx.tools.register` 注册 `host.tools(agent, ticket)` 返回的工具；`Runtime` 的 `toolHost` 在 `src/app/runtime.ts` 中把它分派到 `mainTools` 或 `executorTools`。
3. 用 `agent.ctx.tools.restrict({ allow })` 限制可用工具集合；主会话还额外安装 `noWait` guard。

工具 schema 是 zod，注册时用 `z.toJSONSchema(schema)` 转成 DSH 工具参数；执行结果统一渲染为 JSON 文本，若结果带 `image` 则附加图片块（`Sessions.registerTool`，`src/app/sessions.ts`）。

提示词与技能同样按 Session 挂载：`src/app/context.ts` 用 `promptFile` 读取 `prompts/*.md`，`Prompts.promptParts` 按 `runtime/shared` → 角色 → 团队三段 → subscriptions/replies → dispatch/work → admission → handoff → environment → policy 的顺序组装；`Sessions.bindSkills` 把 `Prompts.skills`（内置 `skills/dsh-superagent-feishu/SKILL.md`、`skills/dsh-superagent-github/SKILL.md` 加团队技能）注册进 agent 的 skill scope。主会话的 `complete: true` 表示不再叠加 DSH 默认系统提示；worker 仍会读 DSH 的 coding prompt 与仓库 `AGENTS.md`。

#### 1.2 主会话（orchestrator）自定义工具

`mainTools`（`src/app/tools/main.ts`）注册 14 个：

| 工具 | 作用 |
| --- | --- |
| `orchestrator_read` | 分页读取 `RESOURCES` 中的资源：tickets/triggers/threads/decisions、ticket 子资源、settings、prompts、models、GitHub/Feishu 原始记录等 |
| `orchestrator_route` | 一次 1–20 条路由决策：`accept`/`attach`/`ignore`/`stop`；每条独立执行，返回 `{results}`，失败项不影响其他项 |
| `orchestrator_ticket_retry` | 对 failed/blocked 或输入投递失败的 Ticket 结束旧 Assignment 并启动新 Assignment |
| `orchestrator_ticket_request_status` | 对 `waiting` 的 worker 发一条只说“报告状态”的 text Input |
| `orchestrator_ticket_note` | 给某个 Ticket 的 worker 发一条 note（只给事实，不授权） |
| `orchestrator_trigger_requeue` | 把已存 Trigger 重新排队评估；如果 worker 仍拥有该 follow-up 则拒绝 |
| `orchestrator_eval` | 加载一个主动候选的上下文窗口与同 Thread 的 Ticket |
| `orchestrator_eval_read` | 在评估中按 `trigger_id` 读取 message/root/parent/thread/file/directory/image |
| `orchestrator_eval_decide` | 记录一次评估决定（accept/ignore/unavailable），并转成 `Engine.decide` |
| `orchestrator_reply` | 按 purpose（answer/result/attention）向人类频道发消息 |
| `orchestrator_thread_unsubscribe` | 取消一个 Thread 上所有 Ticket 的订阅 |
| `orchestrator_settings_save` | 保存 settings block（policy/eval/executor/pause/source） |
| `orchestrator_policy_sync` | 重新同步某个 Source 的 Policy 部分 |
| `orchestrator_prompts_save` | 保存完整 Prompt 配置，或 `preview: true` 只组装预览 |

主会话还保留的 DSH 宿主工具（`Sessions.decorate` 中 `tools.restrict` 的 allow 列表）：

`skill`、`bash`、`read`、`read_image`、`job_output`、`job_list`、`job_kill`。

`dsh-superagent-router` preset（`cordis.patch.yml`）只装 `agent-instructions`、`time-context`、shell（前台命令 5 秒后转后台）、只读 `tool-fs`（`write: false`、`edit: false`）、`tool-jobs`、`skill-filesystem`、`tool-skill`、compaction 组（`compaction-basic`、`command-compact`、`tool-result-pruner`）。因此主会话**并没有被硬性移除 Bash/read**；“主会话只路由、不读代码”是 prompt 规则，不是工具权限（`docs/007-architecture.md` 的 “Avoiding code reads is a prompt rule, not a tool restriction”）。`orchestrator_eval_read` 在主动评估期间还能读仓库文件/目录，所以“无代码读取”在评估阶段也不是绝对的。

#### 1.3 执行器（worker）自定义工具

`executorTools`（`src/app/tools/executor.ts`）注册 6 个：

| 工具 | 作用 |
| --- | --- |
| `orchestrator_read` | 只读本 Ticket 可见的资源：ticket、assignment、inputs、result、transcript、自己的 trigger/thread、prompt 版本、GitHub/Feishu 原始记录 |
| `orchestrator_ack` | 对一条人类请求发确认；经 `Engine.reply({ purpose: 'acknowledgement' })` 排队到原消息所在频道 |
| `orchestrator_thread_unrelated` | 把被 attach 的无关 Thread 取消订阅，并把它拥有的 follow-up 交回 |
| `orchestrator_thread_follow` | 把一个相关 Thread 以 context-only 方式订阅；不授予权限、不唤醒已结束 Ticket |
| `orchestrator_trigger_handback` | 把超出本 Ticket 或属于其他 Ticket 的消息交回一次，附一句原因 |
| `orchestrator_report` | 报告 `progress`/`ready`/`blocked`/`failed`/`dropped`，可带 `human_action`、`question_for_trigger_id`、`pr_number`、`reply_to_trigger_id` |

worker 的宿主工作工具由 `WORK_TOOLS`（`src/app/sessions.ts`）限制：

`read`、`write`、`edit`、`read_image`、`glob`、`grep`、`bash`、`pwsh`、`job_output`、`job_list`、`job_kill`、`web_search`、`web_fetch`、`skill`、`todo_write`、`subagent`、`list_subagent_models`、`send_message`、`list_agents`、`interrupt_agent`。

`Sessions.workOnly` 用 `agent.ctx.tools.restrict({ allow })` 只保留该 Session 父 scope 中实际存在的工具，并加 guard：Ticket 一旦结束，所有工具调用被拒绝（“Ticket ended; new work needs a new authorized ticket”）。worker 的子 agent 走 DSH 的 `standard` preset，继承 worker 权限并只保留 `WORK_TOOLS`；Ticket 结束时同样失去工具（`Sessions.limitSubagent`）。

#### 1.4 通信链路

没有主/worker 之间的直接 RPC；一切围绕 `Engine` 和 `Ticket` 状态：

1. **Source → 主会话（候选）**  
   `Runtime.receive` → `Passes.receive` → `Engine.receive` → `Intake`：Trigger 落库、写入 `disposition`、`trigger_thread` 索引、`Thread.pending`，并按订阅扇出到 Ticket。`Passes` 的下一次 pass 调 `Engine.evaluateDue` → `Evals.start` → `Assessor.request`（`MasterAssessor`）→ `Effects.enqueue('assessment', evalId, { triggerId })`。`assessment` handler 调 `Sessions.prompt(masterId, 'candidate:'+evalId, JSON, 'steer')`，把候选卡送进主会话当前/下一 step，然后 `Engine.candidateDelivered` 开始计算 Eval deadline。

2. **主会话 → 派单（accept）**  
   主会话调用 `orchestrator_route` → `route()` → `Engine.decide(triggerId, { kind: 'accept', ... })` → `Evals.decide` → `Evals.accept`：生成 `Mandate`、`Decision`、`ticketId = key('ticket', evaluation.id)`，再 `Tickets.create(...)`：写 Ticket、订阅其 origin trigger 的所有 Thread、排 acknowledgement、`newAssignment`（`pending`）、`Executor.start`。`DshExecutor.start` 只 `Effects.enqueue('launch', assignment.id, ...)`。

3. **Launch → worker 首个 assignment 消息**  
   `launch` handler → `DshExecutor.launch`：若 `ticket.execution.directory` 不存在，先跑 `prepareDirectory`（用户 `executor.prepare` shell，10 分钟超时）；`Sessions.ensure('worker-'+ticketId, directory, title, 'worker')` 创建/复用 worker Session；把 `{ ticket_id, title, assignment, trigger, batch, ... }` 以 `mode: 'queue'` 送进 worker inbox（`Sessions.prompt` → `AgentDelivery.send` → `agent.followup`），随后 `Engine.assignmentStarted` 把 Assignment 置 `running` 并投递等待中的 Inputs。

4. **主会话 → worker 的后续输入**  
   `orchestrator_ticket_note` / `orchestrator_route` 的 `attach` / `orchestrator_ticket_request_status` → `Tickets.addInput`：生成 `TicketInput`（`kind: 'trigger' | 'text' | 'note' | 'policy-changed' | 'resumed'`），放入 `Ticket.undelivered`，再 `Executor.deliver` → `Effects.enqueue('delivery', ticketId, ...)` → `DshExecutor.deliverQueued` → `Sessions.prompt(worker, input.id, text, 'steer')` → `Engine.inputsDelivered`。worker 的 DSH Session 把消息收进 `user/message` 事件后，`DshExecutor.install` 的 `session/event` 监听器调 `Engine.inputsRead`。

5. **worker → 主会话（报告）**  
   `orchestrator_report` → `Engine.report` → `Assignments.report`：更新 `Assignment.report`、`Ticket.attention`、`Ticket.answers`；`reportRelay` 决定是否 relay：
   - 有 `question` → `worker_attention`（`{ kind:'worker_attention', ...ticketCard, state, read }`）；
   - `ready`/`blocked`/`failed`/`dropped`/带 `reply_to_trigger_id` 的 answer → `worker_report`（`{ kind:'worker_report', ...ticketCard, trigger_id, state, summary|chars, read, answer_to? }`）；
   - 普通 `progress` 且无 answer → 不 relay，只留在 Ticket。
   relay 经 `Sessions.relay` → `Effects.enqueue('relay', id, { text })` → `Sessions.prompt(masterId, id, text, 'steer')`。

6. **人类 follow-up 与 handback**  
   人类在已订阅 Thread 上发消息 → `Intake` 扇出为各 Ticket 的 trigger Input。若 Ticket 仍 live，worker 拥有该消息，主会话只收到 `follow_up` relay（`followupNotice`），只能按人物要求 stop；若 Ticket 已结束且不是 human stop，`Tickets.wake` 用同一 Mandate 恢复并启动新 Assignment。worker 认为消息超出本 Ticket 时调 `orchestrator_trigger_handback` → `Engine.handback` → `Evals.handback`；当没有其他 Ticket 拥有它时重新排队 Eval，之后作为候选回到主会话。`attach` 则是把某条 Trigger 直接挂到指定 Ticket，`Tickets.attach` 订阅其 Thread 并生成 Input，并结束持有它的 Eval（`Evals.routed`）。

7. **stop / retry / pause**  
   - stop：主会话 `orchestrator_route kind=stop` 或面板 `POST tickets/:id/stop` → `Tickets.stop` → `end`，结束未完成 Assignment；`DshExecutor.stop` 在 `Store.afterCommit` 里 `agent.cancel({ kind:'user' }, { keepInbox:false })` 并 `stopBackground`（杀 shell jobs、释放 subagents）。  
   - retry：`Tickets.retry`（`canRetry` 为真时）结束最新 Assignment（`endedReason: 'retried'`）、把未读 Input 放回队首、新建 Assignment，再 `executor.stop` + `executor.start`。  
   - pause：`Settings.pause` 把 `paused` 写进 Policy；`Effects` 的 `assessment`/`launch`/`delivery`/`reply` handler `limit()` 返回 0，`Passes` 不跑 `evaluateDue`，`DshExecutor` 在 launch 时抛 `Later`。已运行的 worker turn 不中断；恢复后效果队列继续。Eval 的 deadline 会按暂停时长顺延（`Evals` 的 `pausedAt`）。

对应到问题里列的四类交互：

| 动作 | 落点数据结构 | 关键路径 |
| --- | --- | --- |
| 派单 | `Decision(kind: 'accept')` + `Mandate` + `Ticket` + `Assignment(state:'pending')` | `Engine.decide` → `Evals.accept` → `Tickets.create` → `launch` effect → worker assignment message |
| 状态汇报 | `Assignment.report`（`WorkerReport`）+ 可选 `Ticket.attention`/`Ticket.answers` | `orchestrator_report` → `Engine.report` → `Assignments.report` → `reportRelay` → `relay` effect |
| 追问 | `WorkerReport.question` → `Ticket.attention` → `worker_attention` relay | `orchestrator_report human_action` → main `orchestrator_reply purpose=attention` → `Replies`/`Outbox` |
| 暂停 | `Policy.paused` / `settings.paused` | `Settings.pause` → effect `limit()=0`；`Passes` 停止 `evaluateDue` |
| 重试 | 新 `Assignment(state:'pending')`，旧 Assignment `endedReason:'retried'` | `Tickets.retry` → `executor.stop` + `executor.start` |
| 停止 | `Ticket.ended` + `Assignment.state:'ended'` | `Tickets.stop`/`end` → `DshExecutor.stop` → cancel + kill jobs |
| 人类插话 | `TicketInput(kind:'trigger', human:true)` + `follow_up` relay | `Intake` fan-out → `Tickets.addInput`/`wake` → `delivery` effect；主会话只收到 follow-up 通知 |

#### 1.5 承载状态的数据结构

| 结构 | 关键字段 | 作用 |
| --- | --- | --- |
| `Trigger` | `id, source, threads, actor, human, addressed, at, text, channel, url, meta` | Source 的不可变事件；`threads[0]` 是评估主 Thread |
| `TriggerDisposition` | `filtered, evalId, decisionId, fanout, context, requeued, handbacks, acked, at` | 一条 Trigger 去过哪里；决定 follow-up 归谁 |
| `Thread` | `key, ref, createdAt, lastAt, subscriptions, context, correlated, pending, evaluating, expired, meta` | 订阅/评估/决策的聚合边界 |
| `Evaluation` | `id, threadKey, triggerIds, primary, strength, actor, basis, policyVersion, startedAt, delivered, deadline, pausedAt` | 一次 Eval 的批次与期限 |
| `Decision` | `id, evalId, threadKey, triggerIds, policyVersion, at, kind, reason, strength, ticketId, mandate, audit, dismissed` | ignore/accept/reopen/stop/unavailable 的审计结果 |
| `Mandate` | `strength, policyVersion, basis, actor, scope` | 不可变授权；决定 worker 能做什么 |
| `Ticket` | `id, title, decisionId, mandate, channels, ended, attention, assignments, inputs, undelivered, follows, answers, createdAt, updatedAt, origin, execution, delivery` | 一个授权工作单元；`origin.triggerId/triggerIds` 只表示触发批次 |
| `Assignment` | `id, state(pending\|running\|ended), createdAt, startedAt, endedAt, endedReason, report, deliveredAt, idleAt` | Ticket 与一次 Executor 实例的绑定，内嵌在 Ticket 中 |
| `TicketInput` | `trigger / policy-changed / reopen / resumed / text / note` 的判别联合；trigger 变体含 `triggerId, note, human, context, readAt, deliveredTo` | 主会话/人类/策略变化送给 worker 的输入 |
| `WorkerReport` | `state(progress\|waiting\|ready\|blocked\|failed\|dropped), summary, question, askedBy, answers` | worker 向 Ticket 的结构化报告 |
| `PolicyEffect` | `rules, proactive, requesterAllowed, requester` | Policy 变化对某 Ticket 的影响 |
| `DomainEvents` | `trigger.received, trigger.followup, eval.started, decision.recorded, ticket.created, ticket.resumed, ticket.ended, assignment.started, assignment.ended, thread.subscribed, thread.unsubscribed, trigger.requeued, policy.changed` | Engine 变更通知 |
| `EffectPayloads` | `assessment, launch, delivery, relay, notice, reply` | 持久化副作用队列的封闭 kind 集合 |

ID 由 `key()`（`src/core/ids.ts`）确定性生成：`ticket:<evalId>`、`assignment:<ticketId>:<n>`、`input:<ticketId>:<kind>:...`、`attention:<ticketId>:<question>:<at>`。这让同一个 accept/重试/重投递天然幂等。

---

### 2. Ticket/Thread/Assignment 持久化、worktree/merge 现状，以及 Plan DAG 的切入点

#### 2.1 SQLite 组织

`Store`（`src/app/store.ts`）只开一个 SQLite 文件 `<stateDir>/orchestrator.sqlite`；`SCHEMA_VERSION = 11`，`OLDEST_SCHEMA = 10`，`migrateTo11` 在启动时一次性迁移。

| 表 | 内容 | 写入者 |
| --- | --- | --- |
| `trigger` | `id, value(JSON), at` | Engine |
| `disposition` | `id, value(JSON)`（TriggerDisposition） | Engine |
| `trigger_thread` | `thread, id, at, human` 复合主键 | Store（随 Trigger 保存） |
| `thread` | `key, value(JSON)` | Engine；Source 只改 `meta` |
| `ticket` | `id, value(JSON)` | Engine |
| `decision` | `id, thread, value(JSON)` | Engine |
| `effect` | `kind, key, value, seq, generation, attempts, error, due, since` | Effects |
| `outbox` | `id, value(JSON)`（Receipt） | Outbox |
| `kv` | `key, value(JSON)` | 各记录所有者 |

`SETS` 定义生成列和部分索引：`ticket.open`（`ended` 为空）、`ticket.active`（`undelivered` 非空或最后一个 Assignment 是 pending/running）、`thread.active`（`pending` 非空或 `evaluating` 存在）、`thread.subscribed`、`outbox.pending`、`outbox.dropped`。`Store.addColumns` 在打开旧库时对齐这些列。

`Ticket` 是一个 JSON 聚合：`assignments`、`inputs` 都是内嵌数组，**没有独立 assignment 表**。`Thread` 同样是 JSON 聚合，`subscriptions` 是 Ticket id 数组，`context` 是 context-only 订阅的 Ticket id 数组；没有独立 subscription 表。

`KV`（`src/kv.ts`）保存非聚合状态：schema、settings 版本、prompt 版本、`master-id`、`session-prompts:<sessionId>`、Source 游标/缓存、display names 等。`KV` 的每个 key family 都声明了 owner 和 value 类型。

#### 2.2 Worktree 准备现状

- `DshExecutor.prepare(ticket, outcome)` 调 `ticketExecution`（`src/executor/dsh.ts`）：
  - `name = WorktreeNameSchema.parse(outcome.name) + '-' + ticket.id.slice(0, 12)`；
  - `directory = join(executionRoot(settings, stateDir), name)`；
  - `execution.assignment` 保存接受时的 assignment 文本（inferred 工单会附 matched rules 与 scope）。
- `executionRoot`（`src/app/execution-environment.ts`）= `settings.executor.directory || join(stateDir, 'work')`。
- 首次 launch 时若目录不存在，`prepareDirectory` 在 `dirname(directory)` 下执行 `sh -c <executor.prepare>`，环境变量来自 `ticketEnvironment`；超时 10 分钟；失败抛 `PrepareFailed`，失败的空目录会被删除，非空目录保留；Ticket 被标记 failed，等待人工消息或 retry。
- 目录已存在就视为“已准备”，不会重复执行 prepare；因此重试不会重新建 worktree，除非目录不存在。
- `verifyDirectory` 检查该目录的 local/worktree git config 没有 `credential.*`/`http.*extraheader`，避免 worker 的 git 读取仓库自带的凭据配置。
- **宿主没有内置 git 操作**。典型配置是用户在 Execution settings 写：
  ```sh
  git -C /path/to/clone fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
  git -C /path/to/clone worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
  ```
  （`docs/006-deployment.md` 的 Execution 节。）`agent/` 前缀只是示例/约定，代码并不强制；`ticketBranch`（`src/sources/github-pull.ts`）只比较分支最后一段是否等于 `ticket.execution.name`。

#### 2.3 合并现状

- `orchestrator_report` 的 `pr_number` → `readPull` + `claimPull`（`src/sources/github-pull.ts`）→ `bindThread(ticketId, { source:'github', id:String(pr.number) }, own)`；`Ticket.follows` 记录 `{ thread, own, closed? }`。
- `claimPull` 只接受两类 PR：Ticket 起源 Trigger 本身就是该 PR，或 PR 由部署的 agent 账号从“最后一段等于 `ticket.execution.name`”的分支开出；一个 PR 最多绑定一个 open Ticket。
- GitHub Source 轮询 PR（`observePull`）发现 `state === 'closed'` 或 `merged` 时调 `ctx.tickets.threadClosed(...)` → `Tickets.threadClosed` 写 `follow.closed={at,outcome}`；`followsDone` 成立且没有未完成工作时 `Tickets.end`，outcome 为 `merged`/`closed`。
- **没有合并队列、没有顺序合入、没有 base SHA/branch 字段、没有冲突处理**。`docs/003-execution.md` 明确“The host has no merge-specific decision logic”；自动合并只由 worker 按 `Delivery requirements` prompt 里的条件执行 `gh pr merge --auto --merge --match-head-commit`，并且默认不以 agent 账号开启 auto-merge（需要另一个人账号的 merge CLI）。`Merge` 的“顺序”目前只能靠 GitHub 分支保护/人工或 prompt 约定，不是宿主保证。

#### 2.4 现有模型缺少什么

要支持 `Plan DAG`（依赖边 + 顺序合入），至少缺：

1. **Plan 聚合**：`planId`、节点 key、标题、创建者、base branch、merge policy（`serial`/`parallel`）、plan 级状态。当前 `Ticket` 只有 `origin.triggerId/triggerIds`（一次 accept 的 Trigger 批次），没有“同一计划的多张 Ticket”这个概念。
2. **依赖边**：`Ticket.dependsOn: string[]`（或 `PlanNode.dependsOn`），以及反向 `blocks` 的查询；当前 `Thread.subscriptions` 只是消息订阅，不是执行依赖。
3. **节点状态**：`planned/ready/running/merged/failed/blocked`。现有 `TicketStage` 只有 `person|working|idle|ended`，`TicketOutcome` 只有 `completed|merged|closed|dropped|stopped`；无法表达“等前置合入”“合并冲突”“顺序排队中”。
4. **合并元数据**：`mergeOrder`、`mergeState`、`baseRef/baseSha`、`prNumber`（现在只能从 `follows` 反推）、`mergedSha`、`conflict` 原因。
5. **多 Ticket 的 Decision 语义**：`Decision.ticketId` 是单值，`Evals.accept` 只创建一个 `ticketId = key('ticket', evaluation.id)`；一个计划节点对应一个 accept 时，需要 per-node Decision 或 `Decision.ticketIds`。
6. **按节点隔离订阅**：`Tickets.create` 会把 accept 批次里的每个 Trigger 的每个 Thread 都订阅给该 Ticket；如果同一计划的多张票共享根 Trigger，所有票都会收到根 Thread 的所有后续消息。需要区分“根 Thread 只作 context”与“节点自己的 PR Thread 作 own”。
7. **调度钩子**：`Tickets.create` 现在直接 `newAssignment` + `executor.start`，没有“依赖未满足先不 launch”的闸门；`Tickets.end` 没有“释放后继节点”的钩子；`Engine.evaluateDue` 只推进 Eval，没有 DAG frontier 推进。
8. **合并执行者**：没有 `merge` effect kind，也没有 host 侧合并服务；`Effects` 只有 `assessment/launch/delivery/relay/notice/reply` 六种。
9. **worktree base**：`Execution` 只有 `name/directory/assignment`；prepare 命令只能从环境变量推 base，缺少 `base_ref`/`depends_on` 的显式变量。
10. **面板/API**：`TicketListView`/`TicketSummaryView` 没有依赖字段；`src/app/api.ts` 没有 Plan 路由；`src/client/route.ts` 没有 Plan Tab。

#### 2.5 建议的切入顺序（按现有代码结构）

**最小可行切法（先不改核心表）**

- 在 `Ticket` 上加 `plan?: { id: string; node: string; dependsOn: string[]; mergeOrder?: number; baseRef?: string }`，以及 `merge?: { state: 'queued'|'merging'|'merged'|'failed'; pr?: number; at?: string }`（`src/core/model.ts`）。
- 在 `orchestrator_route` 的 `RouteItemSchema` 增加 `plan_id`、`depends_on`（或新工具 `orchestrator_plan_create`），`Engine`/`Evals.accept` 把字段带进 `Tickets.create`。
- 在 `Tickets.create` 的 `newAssignment` 后、`executor.start` 前加 `if (!this.ready(ticket)) return`；`ready` 读取 `Ticket.plan.dependsOn` 对应 Ticket 是否已 `merged/completed`。
- 在 `Tickets.end` 写库后调用 `this.options.plans?.released(ticketId)`；`EngineOptions` 增加可选 `plans` 钩子（`src/core/part.ts`），由 `Runtime` 注入。
- 在 `Engine.evaluateDue` 增加 `this.options.plans?.advance()`（或在 `Passes` 里调用），把依赖已满足的 pending Assignment 逐个 `executor.start`。
- 把 `depends_on` 放进 `ticketCard`/`ticketSummary`（`src/app/cards.ts`、`src/app/views/records.ts`），面板即可从 `GET tickets` 直接画 DAG，不必先加 Plan 表。
- 顺序合入先用 `Effects` 的新 `merge` kind：`EffectPayloads` 加 `merge: { planId; ticketId; prNumber }`，`Effects.handle('merge', ..., { ordered: true, retry: [5000, 300000] })`，handler 用 app 层的 `Commands.git`/`Commands.gh` 一次只合一个 PR，成功后让 `GitHub Source` 的 `threadClosed`/`Tickets.end` 释放后继；失败则 `Later` 或记录 `merge.failed`。
- 但 `EffectPayloads` 是闭合 union，新增 kind 必须同时改 `src/app/effects.ts` 的接口与 handler；core 不能直接 I/O，所以 merge handler 应放在 `src/app/` 或新 `MergeQueue` 服务，由 `Runtime` 注册。

**完整切法（新增 Plan 聚合）**

- 新增 `Plan`/`PlanNode` 类型与 `Repositories.plans`（`src/core/ports.ts`），`Store` 加 `plan` 表或 `KV.plans` family；`MemoryRepositories` 同步；`SCHEMA_VERSION` 升到 12，`migration.ts` 加迁移；`tests/migration.spec.ts`、`store.spec.ts` 覆盖。
- 新增 `Plans` Engine part（`src/core/plans.ts`）或把 DAG 逻辑并入 `Tickets`；必须遵守“每个状态一个 writer”：Plan 边/状态由 `Plans` 写，Ticket 只保留 `planId/node` 与派生展示字段。
- `Evals.accept` 改为可返回多个 `ticketId`（或新增 `Engine.createPlan`），`Decision` 增加 `ticketIds`；`Tickets.create` 接受 `id` 与共享 `Mandate`，避免一张 Ticket 只能来自一个 Eval。
- `Tickets.threadClosed`/`Tickets.end` 只在 `outcome === 'merged' || outcome === 'completed'` 时释放后继；`closed/stopped/failed` 应把后继置 `blocked` 并通知 Hub，而不是继续 launch。
- `prepare` 环境增加 `DSH_SUPERAGENT_BASE_REF`/`DSH_SUPERAGENT_PLAN_NODE`/`DSH_SUPERAGENT_DEPENDS_ON`（`src/app/execution-environment.ts` 的 `EXECUTOR_VARIABLES`/`environmentOf`），让用户的 `git worktree` 命令从正确 base 建分支；如果采用“每次只从 main 建 worktree + 串行合入”，则只需 base 变量，不需要跨节点分支。
- 面板加 `GET plan`/`GET plans` 与 `GET docs` 路由；`src/client/route.ts` 加 `plan`/`docs` Tab，`src/client/app.tsx` 的 `Pages` 加分支；`src/client/plan.tsx` 用纯函数布局 + SVG，`src/client/docs.tsx` 用树 + `MarkdownLite`。

**关键约束**：现有 `Decision.ticketId`、`Ticket.origin.triggerId`、`Evals.accept` 的 1:1 语义，以及 `Tickets.create` 的“整个批次订阅”是最深的三个改造点；只加 `depends_on` 而不同时处理这三者，会出现“多节点共享 Decision/订阅”或“无法为节点生成独立 Ticket”的问题。

---

### 3. D-SH 宿主 Session API 与主会话上下文管理

#### 3.1 宿主 API（`@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`）

`src/index.ts` 的 `inject` 明确依赖：`agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、`permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm`、`subprocess`。类型声明里的 `SessionController` 提供：

| 能力 | 方法 / 类型 | 说明 |
| --- | --- | --- |
| 创建/复用 | `create({ workspaceId?, cwd?, sessionId?, agentPreset? })` | 按显式 id 创建或幂等 adopt 一个普通 Session；原型在 `Sessions.ensure` 中先用 `resolveAgent`，`session/not-found` 时 `workspaceRegistry.create(cwd)` + `create({ sessionId, workspaceId, agentPreset })` |
| 解析/恢复 | `resolveAgent(sessionId)` | 返回 live `Agent` 或 `session/not-found`；原型用它确保主/worker Session |
| 发消息 | `prompt({ requestId, sessionId, mode:'queue'\|'steer', content, clientTimeZone? }, signal)` | 宿主 RPC 入口；**原型没有用它**，而是用 `Agent.inbox` + `AgentDelivery`（见下） |
| 取消 | `cancel({ sessionId })` | 取消当前 active turn，保留 pending inbox；原型直接用 `Agent.cancel(cause, { keepInbox })` |
| 历史读取 | `inspect(sessionId, signal?)` → `SessionInspection { meta, inheritedEventCount, events }` | 读完整事件日志；`resources.ts` 的 `transcript` 用它读 worker transcript |
| 分页历史 | `page({ address, throughSeq, beforeSeq, ... }, signal)` | 冷安全、按消息对齐的历史页 |
| 流式历史 | `follow({ address, maxMessages?, turnWindow?, assistantStream? }, signal)` | 先 opening snapshot 再增量帧 |
| 列表/搜索 | `list`, `search` | 不激活 Agent 读取 Session 摘要/内容 |
| 重命名 | `rename({ sessionId, title })` | 原型在 `Sessions.ensure` 里重命名主/worker |
| 选择模型 | `selectModel({ sessionId, ... })` | 原型在 `role-models.ts` 里初始化角色模型 |
| 继承会话 | `fork({ sessionId, atSeq?, allowMigration? })` | 从源 Session 的精确事件前缀创建新 Session；省略 `atSeq` 取最近 completed-turn 前缀；开放 cut 会补 synthetic closers；返回新 `sessionId` |
| 压缩 | `ctx.compaction` (`CompactionEngine`) | `compactIfNeeded(agent, trigger, signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal?)`；`@deepseek-ai/dsh-compaction-basic` 实现 pressure/overflow 策略，`@deepseek-ai/dsh-command-compact` 提供 `/compact` |
| 清理/重置 | 在 0.2.1-alpha.2 的 `SessionController` 类型声明中未见 `clearSession`/`deleteSession`/`replaceSession` | `Agent.inbox.clear()` 只清 `nextTurn/nextStep` 待处理输入；要重置上下文只能新建 Session（`create` 新 id）或 `fork` 一个继承前缀的新 Session |

`SessionPersistence` 还提供 `open(sessionId, 'read'|'write')` → `SessionHandle.read(offset, length)`/`flush()`/`close()`，以及 `stat`/`list`。`Agent` 侧提供 `status`、`session`、`inbox`（`nextTurn`、`nextStep`、`clear/append/prepend/replace/remove/splice`）、`cancel`、`whenIdle`、`runMaintenance`、`send`、`followup`、`steer`、`inject`。原型的 `AgentDelivery` 正是用 `followup`（queue）、`steer`（当前 step）、`inject`（不唤醒）三种模式，并用 `sessionPersistence.open` 全量读历史做幂等去重；这也是 `tests/fixtures/host.ts` 明确“Plugin delivery must not use user RPC”的原因。

#### 3.2 原型实际怎么用

- 主会话：`Runtime.initialize` 里 `sessions.ensure(masterId, machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')` 只创建一次；`masterId` 从 `KV.runtime.masterId` 读取，缺省为 `orchestrator-${key(stateDir)}`。`Sessions.ensure` 用 `ROUTER_PRESET`、`danger-full-access` 权限，并 `rename`。
- worker：每个 Ticket 一个 `worker-${ticketId}` Session，`Sessions.ensure(workerSessionId(ticket.id), ticket.execution.directory, ticket.title, 'worker')`；Ticket 结束后工具被 guard 拒绝，但 Session 本身保留。
- 主会话消息全部由 `Sessions`/`AgentDelivery` 注入：
  - 候选：`MasterAssessor` 的 `deliver` → `Sessions.prompt(masterId, 'candidate:'+evalId, json, 'steer')`；
  - relay：`Sessions.relay` → `Effects('relay')` → `Sessions.prompt(masterId, id, text, 'steer')`；
  - notice：`Sessions.notify` → `Effects('notice')` → `Sessions.prompt(masterId, name, json, { inject: summary })`，不唤醒主会话；
  - `AgentDelivery` 用 `MessageId('dsh-superagent:'+requestId)` 去重，消息 source 是 `{ kind:'dsh-superagent', form:'relay'|'notice' }`，不是 `user` RPC。
- 主会话 prompt：`Sessions.decorate` 注册 `complete: true` 的 `systemPrompt.section`；每次模型请求重新 `Prompts.compose`，最后附 `runtime/policy`（Policy version/accept mode/规则），所以 Policy 改动无需重启；`promptFor` 把当前 revision 记录到 `KV.sessions.prompts(sessionId)`。
- 上下文控制手段：
  - 所有卡片/消息都有硬上限：候选窗口 4000/1200/400/50 字符，worker trigger 600 字符，assignment 1500 字符，report summary 600 字符后给 `read` 指针；
  - `orchestrator_read` 分页（文本 4000 默认/8000 上限，列表 20 默认/50 上限），大内容不进 prompt；
  - `notices` 按 name 合并，避免重复注入；`relay` 按 id 幂等；
  - 主会话没有 `sleep`/长等待：`noWait` guard 拒绝 `sleep`、`timeoutMs > 30s`、`job_output` wait > 5s，router preset 的 shell 5 秒转后台；
  - **但没有主动 compact/fork/clear 调用**；`cordis.patch.yml` 的 router preset 包含 `compaction-basic`、`command-compact`、`tool-result-pruner`（阈值 8192/head 4096/tail 1024），所以压缩由 D-SH 运行时策略处理；`prompts/dispatch.md` 甚至写了 “Check ticket summaries after compaction to avoid duplicate work”，说明原型预期宿主会压缩，但自身不控制时机。
  - `AgentDelivery.history` 在首次给某个 Session 发消息时会 `sessionPersistence.open` 全量读日志（每次 512 事件）来建立已见 id 集合；主会话历史越长，这一步越贵，但只在每个 `Session` 对象首次发送时做一次。

#### 3.3 对 Hub Agent 的直接含义

- 如果新插件要求 Hub Agent **硬性**移除 Bash 与写入权限（仅保留 `read`/`read_image`/`glob`/`grep` 只读检视），不能只靠 `prompts/orchestrator.md`；必须改 `Sessions.decorate` 的 `tools.restrict` allow 列表（去掉 `bash`/`job_*`，按需补入 `glob`/`grep`）和 `ROUTER_PRESET`（去掉 `shell`/`tool-jobs`，保留 `tool-fs` 的 `write: false, edit: false` 并按需挂载 `@deepseek-ai/dsh-tool-fs-search`），否则主会话仍能调用 Bash。
- 需要长期常驻时，最稳的是“**SQLite/Plan 状态是事实源，主会话历史只是缓存**”：定期用 `ctx.compaction.compactNow`/`compactIfNeeded`，或在阶段边界用 `sessionController.fork`/`create` 新主会话并把 `KV.runtime.masterId` 指向新 id（后者原型未实现，需要重启 Runtime 才生效）。
- D-SH 没有“清空当前 Session 历史”的公开 API；不要把 `Agent.inbox.clear()` 误当成 clear。若产品要求“新开继承会话”，应显式用 `fork`，并把 `masterId` 迁移逻辑写进 Runtime 启动路径。

---

### 4. Web Panel 的技术栈、状态同步、Tab 结构，以及两个新视图的挂载点

#### 4.1 技术栈

- React 18.3.1 + `react-dom` 18.3.1，JSX（`tsconfig.json` 的 `jsx: react-jsx`）；客户端入口 `src/client/index.tsx`，构建为 CJS bundle，由 DSH 的 `window.__ModuleLoader__` 加载（`tsdown.config.ts` 的 client 配置）。
- 没有引入外部 UI 库或图表库；`src/client/controls.tsx` 是 DSH 控件的本地副本，`src/client/widgets.tsx`/`rows.tsx` 是共享组件，样式集中在 `src/client/client.css`（以 `?raw` 文本注入 `<style>`），使用 DSH 的 `--dsh-*` design tokens。
- 没有 react-router；路由是 `src/client/route.ts` 的判别联合 + React state。
- 面板通过宿主 slots 注册：`src/client/index.tsx` 的 `ctx.slots.inject('main', ...)`、`sidebar.panellist`、`plugins.row.config`；内部 Tab 完全由 panel 自己管理。

#### 4.2 状态同步

- `PanelProvider`（`src/client/provider.tsx`）创建 `call`（`src/client/api.ts` 的 `caller`）并 `usePoll(() => call('GET state'), ..., 5000)`；页面再各自 `usePoll` 自己的端点（如 `ExecutionStatus` 的 `GET tickets`、`TicketPage` 的 `GET tickets/:id`、`OverviewPage` 的 `GET overview`）。
- `usePoll` 按 5 秒轮询，页面隐藏时退避 6 倍；保留上一次成功数据；请求串行化；数据 JSON 相同则跳过 `setState`；错误保留旧数据。没有 WebSocket/SSE。
- 变更通过 `call` 发 `fetch('/orchestrator/api/...')`，带 `x-orchestrator-request: 1`；服务端 `sameOrigin`（`src/app/http.ts`）要求 Host 是 `127.0.0.1:<port>` 或 `localhost:<port>`，且 `Origin` 同源。
- 设置页有乐观草稿：`useBlockDraft`/`draftReducer`（`src/client/draft.tsx`）、`merge3` 三方合并、`SaveBar` 显示合并/冲突；`useAction` 防重入。
- API 类型由 `src/app/api.ts` 的 `Api` 映射定义，客户端只 import type；HTTP 路由表在 `src/app/http.ts` 的 `routes()`，`registerHttp` 挂在 `/orchestrator` 前缀。

#### 4.3 Tab 与路由结构

- `src/client/route.ts`：
  - `TABS = ['overview','source','trigger','eval','execution','settings']`；
  - `Route` 判别联合：`overview`/`source` 无 id；`trigger` 有列表 filter 或 detail id + `query.trigger`；`eval` 有 filter/window；`execution` 有列表 filter 或 detail id；`settings` 有 group/source/version；
  - `parseRoute` 做白名单校验，丢弃未知 filter/旧 Tab；`initialLocation`/`remember` 用 `sessionStorage` key `dsh-superagent/route` 保存 route + 最多 20 层 stack。
- `src/client/app.tsx`：
  - `Pages` 的 `switch (route.page)` 渲染 `OverviewPage`/`SourceStatus`/`TriggerStatus`/`ThreadPage`/`EvalStatus`/`ExecutionStatus`/`TicketPage`/`SettingsPage`；
  - `SegmentedTabs` 根据 `TABS` 生成 Tab，`openTab` 清空 stack；`navigate`/`back` 维护内存历史。
- `src/client/settings.tsx` 是 Settings Tab 内部的分组导航（`SETTINGS_GROUPS = ['source','eval','execution','prompts','deployment']`），不是顶层 Tab。

#### 4.4 Plan DAG 的最佳挂载点

推荐**新增顶层 Tab**，而不是塞进 Settings：

1. `src/client/route.ts`：
   - `TABS` 加 `'plan'`（放在 `overview` 之后或 `execution` 之前）；
   - `Route` 加 `{ page:'plan'; id?: string; query?: { plan?: string } }`；
   - `parseRoute` 加 `case 'plan'`；`routeLabel` 自然走 `tab.plan`。
2. `src/client/app.tsx` 的 `Pages` 加 `case 'plan': return <PlanPage />`；`SegmentedTabs` 自动出现新 Tab；`PageHead`/`Section`/`LoadState`/`Hint` 复用 `widgets.tsx`。
3. 新建 `src/client/plan.tsx`：`usePoll(() => call('GET plan', { query: { plan: id } }))`；纯函数 `layoutDag(nodes, edges)` 计算分层坐标（避免引入图形库；client bundle 只 externalize React），用 SVG/绝对定位 + `dt-*` class 绘制节点和边；节点点击 `navigate({ page:'execution', id: ticket.id })`；可选 filter（open/ended/blocked）和 plan 选择器。
4. 后端：
   - `src/app/api.ts` 加 `'GET plan': { query?: { plan?: string }; response: PlanView }`（以及可选的 `'GET plans'`）；
   - `src/app/http.ts` 的 `routes()` 加 handler，数据从 `store.tickets.list()`/`store.threads`/新的 `Ticket.plan` 字段读取；
   - 新建 `src/app/views/plan.ts`（或扩展 `views/tickets.ts`）输出 `{ plan, nodes:[{ticketId,title,stage,dependsOn,mergeOrder,...}], edges:[...] }`；
   - 如果暂时不加 Plan 表，可直接在 `ticketSummary`（`src/app/views/records.ts`）加 `plan`/`depends_on`，客户端用现有 `GET tickets` 组装图，但分页/全量节点不如专用 `GET plan` 稳。
5. 如果不想新增 Tab：可把紧凑 DAG 作为 `OverviewPage` 的一个 `<Section title={t('plan')}>`，点击进入 `Execution` 过滤；或在 `TicketPage` 的 `Details` 里显示该 Ticket 的前置/后继链。但完整可视化建议独立 Tab，符合面板“一个概念一个地方”的原则。

#### 4.5 AI 文档树浏览器的最佳挂载点

同样推荐**新增顶层 Tab `docs`**：

1. `src/client/route.ts`：`TABS` 加 `'docs'`；`Route` 加 `{ page:'docs'; id?: string; query?: { path?: string } }`；`parseRoute` 处理 path（或把 path 作为 id）。
2. 新建 `src/client/docs.tsx`：左侧树（`<ul className="dt-tree">` 递归，节点点击更新 route/query），右侧用已有的 `MarkdownLite`（`src/client/widgets.tsx`）或 `markdown.ts` 渲染正文；上方 `PageHead` 显示路径，`LoadState`/`Hint` 处理加载/空状态。
3. 后端：
   - `src/app/api.ts` 加 `GET docs`（树）与 `GET docs/content?path=`（正文）；
   - `src/app/http.ts` 加 handler；
   - 数据源两种：
     - 走 GitHub API：复用 `src/sources/github-read.ts` 的 `readRepositoryPath(commands, path, 'file'|'directory')`（已限制非隐藏、非 `node_modules`，返回目录条目名或原始文件文本）；
     - 走本地文档根：新增 `docsRoot` 设置（`SettingsSchema`/`src/app/settings.ts`），因为 `deployment.repository` 只是 `owner/name`，`executor.directory` 是工单 worktree 根，不是稳定的文档根。原型的 Settings 没有本地 repo path；`docs/006-deployment.md` 把 `repositoryPath` 移到了 prepare 命令，不能直接读。
   - 如果文档树是“每个 Ticket 的 AI 文档”，则改为 `GET tickets/:id/docs/tree` + `GET tickets/:id/docs/content`，在 `TicketPage` 的 `Details` 中挂载；全局文档树才用顶层 Tab。
4. 侧边栏入口不需要改：`src/client/index.tsx` 的 `main` panel 已经注册；新 Tab 只是 panel 内部路由。若希望从 DSH 侧边栏直接打开文档树，则再在 `sidebar.panellist` 注册第二个入口，但原型目前一个 panel 足够。

#### 4.6 面板扩展的注意事项

- 所有新文案要走 `src/client/locales.ts`（中英双语 `DshSuperagentKey`），否则 `tests/locales.spec.ts`/`tests/styles.spec.ts` 会失败。
- 新 CSS class 用 `dt-` 前缀并写入 `client.css`；`tests/styles.spec.ts` 会校验样式表。
- 新 HTTP 路由必须在 `src/app/api.ts` 的 `Api` 中出现，`http.ts` 的 `Routes` 类型才会强制 handler 完整；客户端 `call` 依赖该类型。
- 如果新 Tab 需要 query 过滤，`parseRoute` 必须白名单化，避免 `sessionStorage` 注入未知值；`initialLocation`/`remember` 已做容错。
- 面板没有 D3/ELK；若要复杂自动布局，建议先在 `src/client/plan.ts` 内做简单分层/Sugiyama-lite，避免把大依赖打进 `client.js`（client bundle 只 externalize React，其他依赖会被打包）。

---

### 5. 对后续架构决策的直接影响

- **可复用底座**：`Engine` 的事务单写、`Effects` 的持久化重试、`Sessions`/`AgentDelivery` 的 Session 装饰与幂等投递、`Store` 的 JSON 聚合 + generated column、以及面板的 stage/tab 骨架，都适合直接演进，不需要重写调度内核。
- **必须新增而非 prompt 约定**：Plan DAG 的依赖边、节点状态、按依赖 gate 的 launch、顺序 merge queue，都需要领域字段 + Engine/Effect 钩子；现有 `Decision.ticketId` 单值、`Evals.accept` 单票、`Tickets.create` 整批订阅是三个必须先解决的模型约束。
- **Hub 上下文**：宿主已给 `compact`/`fork`，但没有“清空当前 Session”；常驻 Hub 应把 Plan/票状态放 SQLite，主会话只做摘要与路由，阶段边界用 compact 或 fork；若要硬性收紧 Hub 工具边界（去掉 `bash`/`job_*`，只留只读检视与协调），必须改 `Sessions.decorate` 的 allow 列表和 `ROUTER_PRESET`，不能只改 prompt。
- **面板**：Plan DAG 与 Doc Tree 各加一个顶层 Tab 最干净；DAG 需要新 `GET plan`（或先给 `ticketSummary` 加 `depends_on` 复用 `GET tickets`）；Doc Tree 需要新 `GET docs` 路由，且当前 deployment 只有远端 `owner/name`，没有稳定本地 docs root，必须先决定文档树数据源（GitHub API 还是新增 `docsRoot` 设置）。

---

### 6. 证据索引

- 插件与 preset：`cordis.patch.yml`、`src/index.ts`、`package.json`、`tsdown.config.ts`
- 工具：`src/app/tools/main.ts`（`mainTools`、`RouteItemSchema`、`routeTool`）、`src/app/tools/executor.ts`（`executorTools`）、`src/app/tools/tool.ts`（`readTool`、`Tool`）、`src/app/sessions.ts`（`WORK_TOOLS`、`decorate`、`workOnly`、`registerTool`）
- 通信/引擎：`src/core/engine.ts`、`src/core/evals.ts`（`accept`）、`src/core/tickets.ts`（`create/attach/end/retry/wake`）、`src/core/assignments.ts`（`report`）、`src/app/notices.ts`（`eventNotice/reportRelay/followupNotice`）、`src/app/delivery.ts`（`AgentDelivery`）、`src/app/effects.ts`（`EffectPayloads`/`Effects`）
- 存储：`src/app/store.ts`（`SETS`、`triggers/threads/tickets/decisions`、`receipts`）、`src/kv.ts`、`src/app/migration.ts`（`SCHEMA_VERSION=11`、`migrateTo11`）、`src/app/store-read.ts`
- Worktree/merge：`src/executor/dsh.ts`（`ticketExecution`、`prepareDirectory`、`launch`、`stop`）、`src/app/execution-environment.ts`、`src/infra/environment.ts`（`verifyDirectory`、`agentVariables`）、`src/sources/github-pull.ts`（`claimPull`、`observePull`、`ticketBranch`、`pullsOf`）、`docs/003-execution.md`（Merging）、`docs/006-deployment.md`（prepare 示例）
- 主会话上下文：`src/app/sessions.ts`（`ensure`、`decorate`、`prompt`、`relay`、`notify`、`promptFor`）、`src/app/prompts.ts`（`compose`、`promptParts`、`policySection`）、`src/app/assessment.ts`（`MasterAssessor` 的 `assessment` handler）、`src/app/resources.ts`（`transcript`/`RESOURCES`）、`src/app/runtime.ts`（`initialize`、`masterId`）
- D-SH 宿主类型：`@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2` 的 `lib/types/index.d.ts`/`types.d.ts`（`SessionController.create/resolveAgent/prompt/cancel/inspect/page/follow/fork/rename`）、`@deepseek-ai/dsh-agent@0.2.1-alpha.2` 的 `lib/types/runtime-types.d.ts`（`Agent.cancel/inbox/whenIdle/runMaintenance/followup/steer/inject`）、`@deepseek-ai/dsh-session-persistence@0.2.1-alpha.2` 的 `SessionPersistence.open/read`、`@deepseek-ai/dsh-compaction@0.2.1-alpha.2` 的 `CompactionEngine.compactIfNeeded/compactNow/compactRegion`
- 面板：`src/client/index.tsx`、`src/client/app.tsx`、`src/client/route.ts`、`src/client/provider.tsx`、`src/client/api.ts`、`src/app/api.ts`、`src/app/http.ts`、`src/app/views/tickets.ts`、`src/app/views/records.ts`、`src/client/ticket.tsx`、`src/client/execution.tsx`、`src/client/widgets.tsx`、`src/client/controls.tsx`、`src/client/client.css`
