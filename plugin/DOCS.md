# Cordis 研发中枢插件

`plugin/` 是独立于参考子模块的 Cordis bundle，源码、配置、提示词、Skill、测试与编号文档均在本目录维护。本节点只索引下级源码模块与随包文档入口，行为、接口与验证事实以各叶子为准。

## 源码模块

| 模块名称 | 职责摘要 | 相对路径 |
| --- | --- | --- |
| 核心领域 | Engine、Ticket/Assignment/Eval/Thread 生命周期、领域模型与存储端口 | [src/core/](src/core/) |
| 应用装配 | Runtime 组合根、Store/Effects、设置与提示词、视图、HTTP API、会话工具与卡片 | [src/app/](src/app/) |
| Worker 执行 | DSH Executor：每票的持久 Worker Session、经校验的真实 Git 工作树与唯一写权、槽位与后台作业 | [src/executor/](src/executor/) |
| 来源接入 | GitHub/Feishu Source、轮询、Trigger 转换、Channel 与只读上下文 | [src/sources/](src/sources/) |
| 基础设施 | CLI 传输、进程环境与 git 配置、路径、健康板、命令与文本限制 | [src/infra/](src/infra/) |
| 面板客户端 | DSH 侧边栏入口、管理面板、设置页与插件管理页 | [src/client/](src/client/) |
| 顶层入口与共享配置 | 插件入口、Config/Machine、Setup 问题、Policy、准入表、限制、KV 键族与会话导航 | [src/](src/) |

## 随包文档

| 文档名称 | 职责摘要 | 相对路径 |
| --- | --- | --- |
| 000 设计原则 | 注意力成本最小化原则及其对代理行为与设计的要求 | [docs/000-philosophy.md](docs/000-philosophy.md) |
| 001 领域模型 | Source/Trigger/Thread/Ticket 等概念、工作流转与术语表 | [docs/001-domain.md](docs/001-domain.md) |
| 002 授权 | Eval 与工单两条触发路径、准入矩阵、Policy 版本与恢复 | [docs/002-authorization.md](docs/002-authorization.md) |
| 003 执行 | 票据阶段、Worker Session、工作树占有与准备基线、合入、结束与失败恢复 | [docs/003-execution.md](docs/003-execution.md) |
| 004 提示词与 Skill | 团队可编辑提示、片段组装优先级、内置文本原则与版本 | [docs/004-prompts.md](docs/004-prompts.md) |
| 005 面板 | 侧边栏入口、三类问题、标签页、设置分组与搜索 | [docs/005-panel.md](docs/005-panel.md) |
| 006 部署 | 安装、账户、机器配置、启停、设置、升级、验证与排障 | [docs/006-deployment.md](docs/006-deployment.md) |
| 007 架构 | 类与胶水层、依赖规则、源码与测试索引、持久化及模型接口 | [docs/007-architecture.md](docs/007-architecture.md) |
| 008 扩展手册 | 新增 Source 的逐步实现示例 | [docs/008-cookbook.md](docs/008-cookbook.md) |
| 009 交棒 | Harness 交棒确认、只读规格与拆票会话、Plan DAG 登记和查询；[交付后维护](docs/009-handoff.md#stage-2-maintenance) | [docs/009-handoff.md](docs/009-handoff.md) |
| 010 会话边界 | Hub Agent、Worker Session 及任意深度子会话的工具与对外消息边界契约、代码与测试入口 | [docs/010-session-boundaries.md](docs/010-session-boundaries.md) |
| 011 文档影响 | Worker 候选的 Doc Tree 结构检查、接口契约与独立审查证据 | [docs/011-doc-tree-impact.md](docs/011-doc-tree-impact.md) |
| 012 项目运行时 | GitHub 身份验证、项目目录与切换恢复、安装 API 和项目作用域 | [docs/012-project-runtime.md](docs/012-project-runtime.md) |
| 013 开发验证 | 候选验证、双审、复盘、验收与可排队证据 | [docs/013-development-verification.md](docs/013-development-verification.md) |
| 014 项目计量接口 | 项目、计划与票的 HTTP 和 Hub 查询、归属与共享开销、采样范围及错误契约 | [docs/014-project-metering.md](docs/014-project-metering.md) |
| 015 计划注意力 | 计划与项目待处理摘要、测试账号验证、单票暂停及原工作树恢复 | [docs/015-scoped-attention.md](docs/015-scoped-attention.md) |
| 016 运行限额 | 生效预设、在途准入、独立工单额度及管理与 Hub 查询接口契约 | [docs/016-run-limits.md](docs/016-run-limits.md) |
| 017 计划集成交付 | 正式票据关闭后的主干验证、Actions 全量回归、产物契约和 Harness 查询接口 | [docs/017-plan-integration.md](docs/017-plan-integration.md) |
| 018 计划重排 | 停滞时保留承诺的技术恢复、产品变更预览与授权、替代节点和验收重验接口 | [docs/018-plan-replanning.md](docs/018-plan-replanning.md) |
| 019 配置确认 | 受信 Feishu 与管理 API 共用的项目设置提案、审批、版本、状态和拒绝契约 | [docs/019-confirmed-settings.md](docs/019-confirmed-settings.md) |
| 020 空闲巡检 | 独立检查授权、限定版本只读会话、额度、发现待办与独立修复批准 | [docs/020-idle-inspection.md](docs/020-idle-inspection.md) |
