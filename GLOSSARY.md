# Super-agent Domain Glossary

本词表定义“全自动 AI 研发中枢系统”的统一领域模型。所有中枢与 Worker 会话在规划、实现与复盘中统一采用以下术语。

## 核心术语

**Hub Agent（中枢 Agent）**:
对外保持同一身份、负责用户沟通与跨票协调的角色，具体执行工作由 Worker Session 承担。运行事实独立于聊天上下文，底层会话可按需压缩或轮换。
_Avoid_: Team Lead, Master Agent, 主控脚本

**Worker Session（执行会话）**:
上下文相互隔离、绑定独立 `git worktree` 的具体执行会话（对应 `dsh-superagent` 的 `Executor Session`）。拥有完整编码与测试工具，在受控生命周期内完成单张 Slice Ticket 的实现、局部测试、代码审查与复盘修复，不直接向人类发送外部消息。
_Avoid_: 子线程, 普通子 Agent

**Plan DAG（计划票据树）**:
由需求规格自动拆解出的有向无环图（DAG）。图中的每个节点是一张可独立验证的切片票据（Slice Ticket），有向边表示前置阻塞依赖（Blocked-by）。涉及前后端协同的需求拆分为「后端 + 接口文档票」与依赖它的「前端页面票」；日常单点小任务视为仅含 1 个节点的退化 Plan DAG。
_Avoid_: 任务列表, 待办清单

**Slice Ticket（切片票据）**:
Plan DAG 中的最小调度与交付单元，带有执行角色标签（`backend` / `frontend` / `general`），可在单个新鲜上下文窗口内完成并独立验证。前置依赖全部合入关票后即进入可并发派发的 Frontier（前沿）。
_Avoid_: 子任务, Issue（泛指时易与 GitHub 原生概念混淆）

**Doc Tree（AI 文档树）**:
面向 AI 按需阅读的代码库知识结构，以分层路由连接各最小职责模块的当前状态说明（含后端接口契约叶子）。只保留当前有效内容，不保存讨论过程或历史沿革；各工作树拥有各自的文档版本，默认预览主干文档。
_Avoid_: Wiki, 传统开发手册, 变更日志

**Human Handoff Boundary（人类交棒边界）**:
人类参与的终点线。人类完成首次引导配置并仅参与入口处的需求对齐（`grill-with-docs` 或 `wayfinder`）；一旦确认交棒，后续从生成规格、拆解 Plan DAG、并发编码、审查复盘到合入关票全流程无人值守运行。
_Avoid_: 人工审批节点
