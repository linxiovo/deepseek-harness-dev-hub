# 34: 前端 · 微调原生对话界面的项目状态条、交互卡与工作区角标

**执行角色：** frontend

**What to build:** 在复用 DSH 原生聊天框（保留模型选择、`Oh My DSH`、权限与 `@` 引用）的基础上做定向微调：顶部加项目阶段状态栏与直达 Plan DAG 按钮，对话内渲染交棒确认卡与缺凭据/额度受控入口卡；并在原生「工作区」会话行挂状态角标与悬停卡片。

**Blocked by:** [32 汇总面板前后端分离读/写接口并交付权威 API 契约](32-panel-api-contracts.md)；[33 前端 · 搭建左侧研发中枢入口、3 步向导与多项目台](33-frontend-hub-shell-onboarding.md)

**Status:** ready-for-agent

**GitHub 实施票：** [#35](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/35)

**对应规格：** [S02](../spec.md#s02)、[S21](../spec.md#s21)、[S22](../spec.md#s22)、[S31](../spec.md#s31)

**依赖理由：** 32 提供对话关联项目状态、确认交棒与配置入口后端 API 契约；33 提供多项目工作台与跳转目标路由；本票由前端模型专注实现 DSH 原生槽位微调。

## 验收条件

- [ ] 打开某个项目的 Hub 对话或从工作台发起新流程进入对话时，对话顶部显示当前项目名、阶段（如对齐中 / 2 执行中 · 1 待你处理）与「打开右侧 Plan DAG」快捷按钮，原生输入框及插件工具栏功能完整可用。
- [ ] 对话流内可渲染交互式交棒确认卡片（展示目标、预设与授权范围，确认即越过交棒边界），以及局部卡点/缺凭据提示卡（只给受控配置入口，不索要明文密钥）。
- [ ] 通过 `sidebar.session.row.leading` / `trailing` / `hover` 公开槽位为原生「工作区」下的 Hub 与 Worker 会话行挂状态圆点及悬停进度卡（含跳转 DAG 入口），不修改或替换 `WorkspaceBrowser` 组件。
