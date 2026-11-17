# 17: 凭真实交付证据关票并释放后继

**执行角色：** backend

**What to build:** 后继票只在所有前置正式交付以后可领；从票据能解释是哪项证据缺失，或哪一条真实关票使其就绪。

**Blocked by:** [09 按 Frontier 与空槽原子派工](09-frontier-claims.md)；[16 在同一主干队列上合入并核验实际基线](16-merge-baseline.md)

**Status:** ready-for-agent

**GitHub 实施票：** [#18](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/18)

**对应规格：** [S13](../spec.md#s13)

**依赖理由：** 16 提供主干实际合入及核验结果；09 提供真正受 Frontier 限制的派发出口。只有同时贯通才能验证「关票释放，而不是报告释放」。

## 验收条件

- [ ] 构造 C 依赖 A 和 B：自报 ready、Worker 声称 delivery-check 通过、PR 关闭未合入、未交付即关、停止/失败/取消分别尝试，C 均未派工。
- [ ] 逐项拿掉或换旧候选的验收结果、规范/规格任一路审查、相关测试/必需 CI、Doc Tree 一致性与合入路由核对、必要复盘修复或实际主干验证；程序拒绝正式关票并指出哪项证据不成立。
- [ ] 所有有效证据与实际交付版本匹配，A 关票时 C 仍等 B；B 正式关票后 C 才可被认领一次。重复到达 A/B 的回执或重启恢复不再关票、不重复派发。
