# 01: 收紧 Hub Agent 工具与对外消息边界

**执行角色：** backend

**What to build:** 从现有双角色会话发起同一项工作：Hub Agent 保留只读代码/图片检视与协调派工能力，严禁执行 Bash/Shell、后台作业或修改仓库；Worker Session 在授权内执行并只向中枢报告。即使提示词要求越权，调用本身也不会生效。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**GitHub 实施票：** [#2](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/2)

**对应规格：** [S01](../spec.md#s01)

**开工依据：** 沿用原型两套会话工具、报告/转递和 outbox；不需要先有 Plan DAG、飞书绑定或新 UI。

## 验收条件

- [ ] 在真实挂载的 Hub Agent 工具上查询一票状态、分配已有执行会话并转递摘要成功，且允许通过只读工具（`read`、`read_image`、`glob`、`grep`、`skill` 及只读评估/仓库资源读取）查看代码、检索与图片；调用 `bash`/`pwsh`、`job_output`/`job_list`/`job_kill` 及 `write`/`edit` 写入工具均不可用（由 preset 与工具白名单硬性拒绝，不只靠提示词）。
- [ ] 从 Worker Session 完成一次授权内的编辑和测试并发回报告；用户只收到经中枢路由的答复。尝试用执行器确认回执、通道命令或代用凭据另发人类消息，消息不出站。
- [ ] 结束票后原 Worker Session 及其仍存的子会话不能继续改仓库；管理端仍可查报告。用会话调用结果、仓库状态和实际收件箱验证，而非匹配提示词。
