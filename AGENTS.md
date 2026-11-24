## 目录与代码位置

- **`meta/` 为本地历史资料，不纳入 Git**：`meta/` 下存放编码前的历史思路、初始规划及外部参考资料（其中 `meta/References/` 为本地只读参考子模块），已整体加入 `.gitignore`，不提交、不纳入代码索引，与当前实际代码实现无关。禁止向 `meta/` 新增、迁移或回写任何代码实现文档；历史背景（如 `meta/docs/architecture.md`、`meta/GLOSSARY.md`、`meta/.scratch/`）仅供参考，不作为当前代码事实维护。
- **实际产出落入实际代码库与对应工作树**：基于原型演进的实际可交付代码、配置（`cordis.patch.yml`）、提示词、Skill、测试及面向当前代码实现的文档，一律落在当前工作树/分支内 `plugin/` 的对应位置，并纳入根目录 `DOCS.md` 文档树。
- **全局规则与模块文档分离**：`AGENTS.md` 只记录全仓库所有开发 Agent 通用的工作约定，禁止写入特定模块或切片的运行期实现细节（如特定角色或模块的配置、接口契约与边界规则）。

## 提示词管理

- **统一存放于 `plugin/prompts/`**：所有写给 Agent（含 Hub、Worker、Planner、评估/审查/复盘及各类子会话）的提示词、角色指令、工作流说明、模板片段（含 `{placeholder}` 占位符模板）及运行期引导、纠偏与恢复文案，统一存放在 `plugin/prompts/` 目录（独立 Skill 定义按 DSH 规范存放在 `plugin/skills/<skill-name>/SKILL.md`）。
- **统一加载、拒绝硬编码**：通过 `plugin/src/app/skill-files.ts` 等统一加载层从 `plugin/prompts/` 读取文本，代码中仅保留文件引用、结构化上下文组装与占位符插值逻辑；禁止在源码（`.ts`/`.tsx`/`.js`）或配置脚本中以字符串常量、模板字面量或拼接文案硬编码提示词。
- **同步配套与渐进迁移**：新增或拆分提示词文件时，同步核对加载注册入口、`plugin/package.json` 的 `files` 打包清单及受影响文档（如 `plugin/docs/004-prompts.md`）；若改动触及历史遗留的内联提示文本，应一并迁入 `plugin/prompts/`，避免继续新增内联文案。

## 编码与全局设计

- **先全局设计、拒绝局部最优**：编码前先梳理完整状态机、数据流、调用链、跨端/跨模块契约及后续演进场景（如多项目隔离、多来源扩展、前后端分离、角色路由与配置版本演进），采用可扩展的统一抽象与清晰边界；拒绝只应付当前单点用例的临时特判、复制逻辑或兼容垫片（shim）。
- **全量迁移与单一事实**：调整共享数据结构、接口契约、配置形状或状态流转时，同步迁移所有上下游调用方、测试与文档，并清理过时分支与死代码，保持单一事实来源（Single Source of Truth）。
- **充分考虑边界与异常情况**：主动覆盖并验证非 Happy Path 场景，包括：空值与超长截断、并发竞态与重入、事件/回执重复或乱序、部分失败与超时重试、进程重启或会话轮换后的状态恢复（先持久化意图再执行外部动作，恢复时先对账真实外部状态）、跨平台差异（Windows / POSIX 路径、换行符与 Shell）以及权限与资源额度边界。
- **如实暴露问题、拒绝掩盖**：前置缺失、能力受限或执行异常时，按契约明确报错或挂起等待处理；拒绝静默吞错、填零或编造默认值及掩盖缺陷的假回退（fake fallback），并为关键边界、并发与恢复路径提供对应验证。
- **代码导航分工**：同一工作树内的定义、引用、实现与重构以 LSP 为准；跨文件查符号、调用链、影响面或受影响测试时用 CodeGraph。LSP 或 CodeGraph 明确报告索引项目与当前 checkout/worktree 不一致时，不把其跨文件结果当作当前事实，改用限定搜索和文件读取继续导航并注明来源受限；停止或重启后以具体外部事实核验状态，不凭旧索引或进程缓存宣告就绪。
- **CodeGraph 索引**：仓库根目录已建立索引，`.codegraph/` 由工具本地生成、不入库，禁止手工修改或提交。查询前先 `codegraph status` 核对 Project 与 `Pending Changes`，有改动先 `codegraph sync`；在辅助工作树内工作时，先在该工作树执行 `codegraph init`，不要套用主工作树的索引结果。常用入口为 `codegraph explore "<问题>"`、`codegraph context "<任务>"`、`codegraph node <符号>`，以及 `callers`/`callees`、`impact`、`affected` 下钻；`explore` 的源码按磁盘重读，调用关系取自索引。
- **先跑快检、再跑全量**：改动可运行后，按[开发验证](plugin/docs/013-development-verification.md#locate-and-test-the-change)选择快检，修复失败后再跑全量。

## 子代理交接

- **先交代工作树**：派发任务时必须先向子代理说明当前工作树的绝对路径与所属分支，避免其在主工作树或其他任务的工作树上操作。
- **共享契约由集成者维护**：派发前明确持久化归属、共享类型和导出入口。只有集成者改动这些约定；生产方与调用方接通后，由集成者统一跑类型检查。
- **派发时给出反例**：每次派发子代理任务，除目标、边界和验收条件外，必须各给出一个中断或重启场景的反例，以及一个错误授权或错误分类场景的反例，并说明这些路径的预期处理；本节只写通用交接规则，不写特定模块的实现细节。
- **回报短而可核验**：子代理回报只包含改动路径、已运行的验证及其结果、尚未验证的风险；未运行的验证必须明确标出，不用泛化结论替代证据。

## Git 提交

所有提交必须使用中文标题，包括普通提交、合并提交和回滚提交；正文说明也使用中文。提交类型、作用域、代码标识符和必要的专有名词可保留英文。

## 工作树

辅助工作树必须使用独立分支并放在 `worktrees/<任务名>`。

## 文档树

采用类 MDN 的树形文档结构维护实际代码模块的文档；所有针对当前代码实现的文档与约束说明，必须直接写在当前分支或对应工作树已实现的对应位置（不得写入 `meta/` 或 `AGENTS.md`）。如根目录尚未建立 `DOCS.md`，自首次新增代码或模块起创建并持续维护：

- **唯一根节点**：仓库最外层只设一个总文档导航（`DOCS.md`）作为代码文档树的唯一根节点（以 Markdown 表格呈现下级代码模块入口，只收录与实际代码相关的文档，不体现 `meta/` 下的非代码资料；宿主加载的 `AGENTS.md` 等引导文件除外，不在根目录平铺零散文档），由此向下逐级延展子节点。
- **节点与叶子粒度**：根节点和中间子节点只保留当前层级职责概述与下级入口（名称、职责摘要、相对路径），不复制下级正文；最末端、无子节点的叶子节点只写当前位置的最小功能（该最小单元的职责、当前生效行为与接口契约、约束、代码/验证入口及必要依赖），同一事实只写一处。
- **随改随更**：对代码或代码模块进行增添、修改、移动或删除时，必须同步检查并更新当前分支/工作树内对应的模块文档（如 `plugin/docs/` 编号文档或叶子文档）；代码模块路径或结构变化时同步更新上级节点直至 `DOCS.md`。
- **只写最新现状**：文档只记录当前最新有效状况，不写历史沿革、用户拍板、讨论过程或废弃方案。发现历史内容有错或与当前实际不符时，直接删除错误内容并原地改写为当前状态。

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。可靠认知建立后，默认以它作为仓库级系统上下文，只读取当前任务直接需要的源码、测试、配置与契约，只有某个缺失的具体事实可能改变回答或验证结论时才扩大证据范围；AOCI不能替代修改对象与验证行为所需的直接源码证据。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。若该请求返回 `delivery_mode=capacity_stop`，说明Whole-Index装不进本Host的上下文：不得重试或调小 `chunk_tokens`；该停止消费本generation，任务按source-bound继续，且不作无保留的完整系统认知声明。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文；唯一例外是待处理压缩刷新的上述容量停止。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。每块单独一次工具调用；不得在一个脚本里连取多块或合并其输出。缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。未达通过（全对的序号不足80%，或对象身份错超过一题）即记为不确定回执，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断某一块时，用同一cursor重取一次并核对 `chunk_sha256`，服务端返回完全相同的字节。仍被截断才停止，提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项路径与对应domain批次身份；`source_sha256` 与 `candidate_id` 可以省略，由服务端按签发的批次取得。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->
