# 06: 会话 token 与上下文计量能力

Type: research
Status: resolved
Blocked by: 01

## Answer

### 核对范围

核对原型声明的 `@deepseek-ai/dsh-session`、`dsh-agent`、`dsh-compaction`、`dsh-api-session-controller`、`dsh-llm` 的 `0.2.1-alpha.2` 发布包类型，以及本地原型的接口声明与模型重试投影。以下是源码与类型层面的结论，不代表插件已实现计量接口，也不是实机计费验证。

### 可用数据来源

- `dsh-session/lib/types/types.d.ts` 的 `assistant/message` 事件包含可选 `usage: TokenUsage`；流中断后的消息带 `interrupted`。未提供 usage 时没有权威用量，不能记作零。
- 同文件的 `assistant/attempt` 保存未提交为可见消息的失败、重试或取消尝试的流；流中有 usage 才能恢复相应的已报告消耗，不能只统计成功消息。
- `dsh-compaction/lib/types/types.d.ts` 的 `compaction/summary` 带模型、provider、可选 usage 与压缩范围；生成压缩摘要本身也可能产生模型消耗。
- `dsh-session/lib/types/index.d.ts` 暴露 `session/event`、事件序号及 `ownEvents()` / `isOwnSeq()`；可以据此增量收集、幂等处理并区分本会话新增事件和 fork 继承前缀。

### Token 口径

- `dsh-llm/lib/types/types.d.ts` 的 `TokenUsage.inputTokens` 是非缓存输入；`cacheReadTokens`、`cacheWriteTokens` 与其互斥，输出单列 `outputTokens`。不能把原始 provider 的总 prompt 数直接当成这个字段。
- `totalTokens` 是可选的权威整次调用总量；宿主在来源缺失或不一致时省略它。接口须区分权威总量与已知分项合计，不能把不完整分项包装成精确总数。
- `reasoningTokens` 作为细分项展示，不在未确认其独立性时再次加到输出或总量上。
- 同一次调用只能入账一次：不能同时累计消息的 usage 与该消息流内相同的 usage，也不能重复计入压缩调用的多种观测记录。

### 上下文信息

- 会话请求元数据及模型元数据提供可选 `contextWindow`，含义是请求与响应合计容量，不是仅输入容量；缺失表示未知。
- 最近一次调用已报告的输入量可以作为该次请求的观测值，但不能等同于加入新消息、工具结果或压缩之后的实时上下文占用。
- 压缩事件中的 `shadowedTokenCount` 等数值不等于压缩后精确占用。当前上下文接口必须携带采样时间、模型、来源与精确/估算/未知标记；若以当前投影内容估算，须明确估算性质。

### 归属、汇总与持续运行

- 插件需要持久记录 Session 与票据、计划、角色及子会话的归属。会话头的 `parentSession` 表示 fork 来源，不能单独用它推断业务派工父子关系。
- 每个 Session 的自身用量与包含子会话的汇总分开；项目总量基于唯一调用记录汇总，不把父级合计与子会话再次相加。
- fork 继承的已发生用量不在子会话重复入账；轮换或压缩不清零项目累计消耗。增量收集游标与去重信息需要持久化，重启不能重复结算。
- 数据未报告、调用仍在途或取消后无用量时，返回覆盖范围和缺失状态；不能声称已掌握供应商最终账单。

### 原型缺口与接入要求

- 本地 `src/app/retry-health.ts` 的 `RetryHealth` 只投影模型预算错误后的重试等待状态，不累计 token，也不实施项目资源上限。
- 本地 `src/app/api.ts` 的公开接口没有专用 Session 用量或项目 token 汇总接口，需要新增计量归集、持久化投影、查询接口及默认/自定义运行策略，并向中枢工具与面板提供同一份数据。
- 严格限额所需计量缺失时，不能继续把缺失当作额度充足；应按生效策略暂停相关新派发并报告。预算检查还需考虑并发在途请求，不能仅在完成后结算。

### 证据入口

- 发布包 `@deepseek-ai/dsh-llm@0.2.1-alpha.2`：`lib/types/types.d.ts` 的 `TokenUsage`、`StreamChunk`、`LlmModelContext`。
- 发布包 `@deepseek-ai/dsh-session@0.2.1-alpha.2`：`lib/types/types.d.ts` 的 `SessionHeader`、`SessionEventMap`，及 `lib/types/index.d.ts` 的事件和自有事件接口。
- 发布包 `@deepseek-ai/dsh-compaction@0.2.1-alpha.2`：`lib/types/types.d.ts` 的 `compaction/summary` 与 `compaction/prune`。
- 本地原型：`References/Projects/dsh-superagent-prototype/src/app/retry-health.ts`、`src/app/api.ts`、`src/app/sessions.ts`。
