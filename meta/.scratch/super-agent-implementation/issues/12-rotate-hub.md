# 12: 在中枢会话轮换后接续未完成的工作

**执行角色：** backend

**What to build:** 不改变对外的 Hub Agent 身份，在可交接边界压缩或换新底层会话；接任者能正确处理交接期间到达的工作。

**Blocked by:** [01 收紧 Hub Agent 工具与对外消息边界](01-hub-tool-boundary.md)；[09 按 Frontier 与空槽原子派工](09-frontier-claims.md)

**Status:** ready-for-agent

**GitHub 实施票：** [#13](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/13)

**对应规格：** [S06](../spec.md#s06)

**依赖理由：** 01 的受限协调工具是唯一有效的调度出口；09 提供已认领工作及可恢复的派发记录，用以区分该接续还是新启动。

## 验收条件

- [ ] 准备一票正在执行、一票等待和一条未决事件；主动压缩或在安全边界切换当前调度权，用户仍在同一项目对话，继任者只加载目标、授权、当前票态、待办事件摘要与按需证据引用。
- [ ] 交接时到达一条新输入，随后旧 Session 尝试认领/调整票据。查询显示该输入由新中枢接续一次，旧指令无效；已启动的 Worker 不重复派发。
- [ ] 清空待收输入不被当作清空历史；不依赖宿主不存在的 clear Session 接口。重启后依据持久动作和实际结果接续，而非复制整份 Worker 对话或把聊天摘要写入仓库。
