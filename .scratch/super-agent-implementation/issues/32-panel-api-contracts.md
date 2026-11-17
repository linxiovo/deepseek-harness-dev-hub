# 32: 后端 · 汇总面板前后端分离读/写接口并交付权威 API 契约

**执行角色：** backend

**What to build:** 为前端面板与对话增强提供统一、稳定、含完备接口契约文档的 HTTP API：整合多项目列表、新手引导校验、Plan DAG（含前后端分类统计、阻塞原因与节点详情证据）、Doc Tree 主干/工作树隔离读取、去重计量及受版控设置确认写入接口。

**Blocked by:** [07 随候选改动交付 Doc Tree 影响判定](07-doc-impact.md)；[14 按生效预设和在途用量限制新工作](14-run-limits.md)；[15 完成两次 retro 并重新取得失效证据](15-retro-evidence.md)；[27 通过可信 IM 卡或设置页批准配置变更](27-confirmed-settings.md)；[30 后端 · 支持多项目隔离、强制 GitHub 引导状态与双运行模式](30-multi-project-onboarding-runtime.md)；[31 后端 · 落地前后端与小模型角色路由及自定义 Skills 管理](31-model-routing-and-custom-skills.md)

**Status:** ready-for-agent

**GitHub 实施票：** [#33](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/33)

**对应规格：** [S24](../spec.md#s24)、[S25](../spec.md#s25)、[S26](../spec.md#s26)、[S30](../spec.md#s30)、[S31](../spec.md#s31)、[S33](../spec.md#s33)

**依赖理由：** 汇集各后端模块交付的状态投影与写操作，统一收口为可版本化、可直接交给前端模型按契约开发的前后端边界。

## 验收条件

- [ ] 完整暴露并测通以下只读与写入端点：初始化引导状态与 GitHub 连通校验、多项目清单与新建、Plan DAG 节点/边/分端统计（`backendCount` / `frontendCount` / 完成进度）与单票证据详情、Doc Tree 主干与单票工作树隔离读取、去重计量汇总、模型/自定义 Skills/预设/运行模式保存与并发版本确认。
- [ ] 面板 API 与 Hub Agent 工具读取完全同一份状态与计量口径；局部阻塞时计划摘要返回「进行中 + 待处理计数」，不误标全计划停止；未合入文档接口严格按票据工作树隔离，不混入主干。
- [ ] 在仓库 Doc Tree 对应叶子交付完整权威接口契约文档（请求路径、方法、参数/响应结构、错误码及校验测试入口），满足双路审查中关于接口文档一致性的要求。
