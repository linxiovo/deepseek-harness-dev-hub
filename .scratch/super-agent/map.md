Status: resolved

## Destination

产出一份完整、无未决歧义、可直接移交 `to-spec` 与 `to-tickets` 拆票开发的《D-SH 全自动研发中枢插件架构与工作流规范》，明确：D-SH 原型底座改造方案、Hub Agent 调度与上下文控制机制、无人值守版工程 Skills 链路、AI 文档树（Doc Tree）协议、分层测试与 CI/CD 守卫机制，以及 IM + 可视化 Plan DAG 面板交互设计。

## Notes

- **Domain**: 全自动 AI 软件研发与长线维护系统（基于 DeepSeek Harness 插件体系，演进自 `References/Projects/dsh-superagent-prototype`）。术语见根目录 [`GLOSSARY.md`](../../GLOSSARY.md)，当前架构约束见 [`docs/architecture.md`](../../docs/architecture.md)。
- **Skills every session should consult**: `wayfinder`, `grilling`, `domain-modeling`。
- **Standing preferences**:
  1. 人类参与入口处的需求对齐（`grill-with-docs` / `wayfinder`），交棒后在授权范围内自主推进至正式关票，再转入 Stage 2 常驻监听。资源额度耗尽时暂停受影响工作并报告真实状态，不用无限消耗换取表面完成。
  2. Hub Agent 不配备代码读写/Bash 执行工具，仅通过会话调度、状态检视与事件路由掌控全局；技术冲突与测试/审查失败一律由 Hub Agent 自主仲裁。
  3. 核心工作流、AI 文档树协议与测试分层设计保持编程语言无关；代码与 CI 首期默认打通 GitHub + GitHub Actions，预留 Jenkins 等扩展槽位。
  4. 本项目覆盖 Skills 中的历史归档惯例：所有文档只保留当前有效内容，失效内容原地替换或删除；不保存讨论过程、历史沿革、废弃方案或历史决策归档。地图的 `Current decisions` 只索引当前有效结论，决策票只保存当前问题或当前结论。文档树协议见[AI 文档树协议](./issues/02-ai-doc-tree-protocol.md)。

## Current decisions

- [架构与工作流规范](../../docs/architecture.md): `to-spec` 的交接入口，包含统一的中枢、计划依赖图、独立工作树及各项交付约束的索引。
- [底座能力与扩展点摸底](./issues/01-dsh-prototype-capabilities-audit.md): 原型以未硬性移除 Bash/read 的主会话 + 每票独立 worker Session/目录运行，靠 Engine/SQLite/Effects 队列通信；无 Plan DAG 依赖、合并队列与内置 worktree/merge，宿主提供的会话能力与面板扩展点详见调研票。
- [AI 文档树协议](./issues/02-ai-doc-tree-protocol.md): 仅保留当前有效内容，按职责组织并按需读取；每票核对文档影响，各 Worktree 隔离维护，默认预览 main。
- [中枢调度与上下文控制](./issues/03-hub-agent-dag-and-context-control.md): 中枢自主协调、程序检查真实交付条件；按后端/前端模型及可选检索小模型路由；必要复盘修复完成后关票，可选优化分流；支持多项目隔离、会话轮换、计量接口及默认/自定义运行预设。
- [会话 token 与上下文计量能力](./issues/06-session-metering-capabilities.md): 固定版本宿主提供可选用量与上下文元数据；插件需补充去重归集和查询接口，分别标记权威、估算与未知数据，不把模型重试状态当作项目预算。
- [全自动工程 Skills 与测试／CI 守卫](./issues/04-autonomous-skills-testing-and-ci.md): `to-tickets` 采用「前后端分离、后端与接口文档先行、前端依赖后端契约」拆票；实现按影响选测、集成版本完整回归；共享与自定义 Skills 独立审查并按版本锁定，默认交付已验证产物，只有明确授权才自动上线。
- [IM 交互与可视化面板](./issues/05-im-channel-and-visual-dag-panel.md): DSH 左侧顶栏挂载「研发中枢」入口（不替换原生工作区），含 3 步首次引导（强制连 GitHub + 配前端/后端/小模型）、多项目切换与微调原生对话；支持本地桌面（关窗暂停）与可选服务器 24h 模式；飞书可选，授权者可在 IM 确认卡内批准配置变更。依赖图默认聚焦正在推进和待处理的票，并统计前后端分端进度。
- [没有新任务时的仓库巡检](./issues/07-idle-maintenance-scope.md): 首版可选、默认关闭；只授权检查就只产生待办，另有修复授权才可发起独立修复计划。

## Not yet specified

无未决规划项。

## Out of scope

- **脱离 DeepSeek Harness 从零自研底层 Agent Runtime**: 本项目定位为大型 D-SH Bundle 插件，不重复造底层 LLM 调用、工具沙箱与基础进程守护轮子。
- **人工逐票审批代码或手动解决 Git 冲突的工作流**: 与“零代码理解、交棒后全自动关票”的核心目标相悖，明确排除。
- **个人微信／企业微信连接器实现**: 首发通道为可选飞书；微信保留[通道契约与纯文本退化规则](./issues/05-im-channel-and-visual-dag-panel.md)，不作为首发交付条件。
- **部署或联调某个具体 Jenkins 实例**: 首期验证 GitHub Actions；[CI 结果和产物的共同约定](./issues/04-autonomous-skills-testing-and-ci.md)仍在设计范围内，不需要选定某台 Jenkins 的通知方式。
