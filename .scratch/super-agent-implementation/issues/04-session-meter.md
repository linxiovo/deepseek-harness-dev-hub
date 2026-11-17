# 04: 查询单个 Session 的上下文与累计用量

**执行角色：** backend

**What to build:** 通过会话查询取得一份带来源的上下文快照和另一份累计用量；压缩让窗口变小不等于退还已经消耗的 token。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**GitHub 实施票：** [#5](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/5)

**对应规格：** [S16](../spec.md#s16)

**开工依据：** 固定版本宿主已有可选事件/模型元数据和持久化入口；从已存在的任一 Session 即可验证，不等计划模型或预算控制。

## 验收条件

- [ ] 输入带容量与不带容量的模型样本，快照分别显示模型、请求加响应的容量、占用、采样时间/范围、来源与实测/估算/未知。加入工具结果或压缩后，不把上次输入量或 shadowedTokenCount 当实时精确占用。
- [ ] 重放同次调用的消息与流、压缩摘要的两次观测，以及失败/中断/重试/取消的尝试：有 usage 的唯一调用各入账一次；无 usage、在途或覆盖不全返回缺失范围而非零。
- [ ] 非缓存输入、缓存读、缓存写和输出各列。保留权威 totalTokens（若有）并与已知分项和区别显示；推理细分不再叠加。压缩调用本身的已报告消耗计入累计。
- [ ] 重启后重放游标边界的事件，查询不重计；fork 的继承前缀不算为子 Session 自身调用。查询不会把 RetryHealth 当用量或宣称等于最终账单。
