# 23: 在授权的飞书话题接续同一项目对话

**执行角色：** backend

**What to build:** 将指定私聊或群话题绑定为同一项目中枢的第二入口：有权限的人能在飞书接续对话，不绑定的人仍能用 Harness。

**Blocked by:** [01 收紧 Hub Agent 工具与对外消息边界](01-hub-tool-boundary.md)；[02 在 Harness 交棒并自动取得规格](02-harness-handoff-spec.md)

**Status:** ready-for-agent

**GitHub 实施票：** [#24](https://github.com/linxiovo/deepseek-harness-dev-hub/issues/24)

**对应规格：** [S23](../spec.md#s23)

**依赖理由：** 01 把用户出站收口给中枢；02 提供不依赖 IM 的既有项目对话与确认交棒记录。在原型可选飞书 Source 上扩展，不重造独立中枢。

## 验收条件

- [ ] 授权者选项目和目标话题，收到一次绑定确认；从飞书按真实身份回复一个 Harness 中的问题，两处读回同一状态。送出的结果只到指定话题，并能链接回项目。
- [ ] 群成员仅凭入群或绑定不能代行项目操作；私聊内容不会自动出现在群里。Worker Session 不另行联系用户，未绑飞书的 Harness 仍可启动、答问和查看验收。
- [ ] 对不具可信确认卡的通道能力，退化为文本摘要及受权限控制的设置链接；文本「同意」不会生效。用通道契约验证，不实现个人微信或企业微信连接器。
