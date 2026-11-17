# 02: 在 Harness 交棒并自动取得规格

**执行角色：** backend

**What to build:** 需求方在 Harness 的「与中枢对话」确认交棒后即可取得规格；不用绑定 IM，也不用回答技术边界确认（原生对话栏状态条与交互卡前端由 [34 前端微调原生对话与工作区角标](34-frontend-chat-workspace.md) 承接）。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**GitHub 实施票：** [#3](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/3)

**对应规格：** [S02](../spec.md#s02)

**开工依据：** 已有主会话、会话委派/投递机制、持久化项目状态设施及面板壳可以承载这个入口；本票不要求已有拆票器。

## 验收条件

- [ ] 给定经 grill-with-docs 或 wayfinder 对齐的需求，从 Harness 确认后可查目标、约束、验收范围、授权及其项目归属。重新打开项目仍能查到；同次交棒不产生两份独立委托。
- [ ] 观察到受托规划会话运行无人值守版 to-spec；无需中枢修改仓库，在对话里可打开规格、检查用户可观察的验收条件、选定的公开测试接口及范围外事项。
- [ ] 在未配置飞书的项目测试两例：目标完整直接出规格；故意省去会改变交付目标的产品意图则只问该点，用户在 Harness 回复后接续。测试边界、文件组织不触发人工确认。
