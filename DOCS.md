# Super Agent 文档树

「DeepSeek Harness 全自动研发中枢」的规格、架构与领域模型文档入口。本页只列当前层级的子节点，正文在各节点的叶子文件内。

## 子节点

- **领域词表**（`GLOSSARY.md`）：Hub Agent、Worker Session、Plan DAG、Slice Ticket、Doc Tree、Human Handoff Boundary 的统一术语定义与禁用别名。
- **架构与工作流规范**（`docs/architecture.md`）：当前设计基线、设计要求，以及「从交棒到持续维护」主流程与按需读取的规格输入索引。
- **规划地图**（`.scratch/super-agent/map.md`）：当前有效的架构结论与 7 张专题调研票（底座能力、文档树协议、中枢调度、Skills/CI、IM 与面板、会话计量、空闲巡检）的入口。
- **实现规格**（`.scratch/super-agent-implementation/spec.md`）：交棒到持续维护的 S01–S35 验收契约，配套 35 张实现票据（`.scratch/super-agent-implementation/issues/`）。
- **参考仓库**（`References/`，Git 子模块）：上游底座原型 `Projects/dsh-superagent-prototype` 与技能集 `Skills/mattpocock`，按固定提交锁定，仅作只读参考。
