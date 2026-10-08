# 全站项目助手界面对照（#612）

用户于 2026-10-08 确认悬浮助手及对话卡片，并要求实现。批准的两个原型按原文件保存到 `product-prototype/public/global-project-assistant.html` 和 `assistant-conversations.html`；原型与实现同在本提交。

- 桌面对照统一 1440×960：`prototype-global-project-assistant.png` / `implementation-1440.png`。
- 对话卡片：`prototype-assistant-conversations.png` / `implementation-confirmed.png`。
- 实现另测 1024、390、320 宽度与展开宽屏。收起不占业务页面布局。
- 保留原型的悬浮入口、明确项目上下文、最近对话、宽屏、输入区和任务确认卡。实现使用实际项目材料、季度字段、原稿信息及积分报价；原型示例项目、模拟进度和示例费用未接入运行时。
- 截图全部为 synthetic browser fixtures，不包含客户材料、真实账号、真实扣费或真实模型结果。

浏览器验证覆盖导航／关闭／刷新恢复、付费问答二次确认、连续附件队列、旧卡失效、明确执行、任务恢复和下载 hash 校验。真实模型调用、部署版本与原账号验收在 #612 发布记录单独登记。
