# 05: 从 GitHub Actions 取得指定版本的检查证据

**执行角色：** backend

**What to build:** 中枢按票或计划和提交查询 GitHub Actions，得到能定位原始运行的核查结果，而非把 PR 已关闭当成检查通过。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**GitHub 实施票：** [#6](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/6)

**对应规格：** [S11](../spec.md#s11)

**开工依据：** 复用原型 GitHub Source / 管理查询，用已存在的票和测试仓库的提交即可接通；计划关联使用提交的归属引用，不要求能自动拆计划。

## 验收条件

- [ ] 在 GitHub 测试仓库针对已知候选跑一项必需检查并产生可下载产物；在插件中按工作与提交查到必需集合、各项状态、运行链接、版本和产物引用，能打开指向该提交的实际运行。
- [ ] 在同一查询边界重放失败、取消、等待和未运行结果，以及另一提交的绿色结果；都不能满足本版本的必需检查，缺项不可默认为成功。
- [ ] 以同一结果约定关联单票候选或计划的集成版本；中枢只读摘要/引用，不吞整段 CI 日志。本票不实现 Jenkins，也不执行合入、发布或关票。
