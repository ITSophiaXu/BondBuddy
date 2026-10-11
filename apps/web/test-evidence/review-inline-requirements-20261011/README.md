# 复核页补充要求与悬浮助手

用户于 2026-10-11 纠正：复核页不能继续显示右侧常驻项目助手，补充复核要求应直接用输入框；项目助手统一为可收起的悬浮 BondBuddy。

基线：`ad29bd53`（develop，含 PR #663 的材料页简化与右侧主操作）。本次代码和原型：`cfe81913`，最终截图在本目录后续证据提交。原型：`product-prototype/public/review-requirements.html`；实现：`apps/web/src/review-workspace.ts/css`。旧 `review-v2.html` 的常驻侧栏不再作为该区域的验收基准。

同尺寸对照：`prototype-1440.png` / `implementation-1440.png`（1440×960）；`prototype-390.png` / `implementation-390.png`（390×844）。截图全部为 synthetic API 数据。

对照结果：两者均为单列、材料末尾的要求输入框、保存状态及右侧开始按钮；只保留全站悬浮助手。原型用简化示例材料，正式界面保留现有上传、文件状态、积分区和应用导航；未按旧原型缩小应用字号或改变实际上传流程。这些沿用行为及本次布局变更由用户当前要求和 PR #663 确定。

验证（Windows / Microsoft Edge）：

- 全仓库 TypeScript 包构建、Vite web 构建通过。
- `node packages/contracts/dist/check-examples.js`：171 个公共及 12 个内部示例；生命周期 4 个示例；OCR 与发行人绑定 40 个测试通过。
- `playwright test tests/review-workspace.spec.ts tests/project-assistant.spec.ts`：65 passed，5 skipped。跳过项为其他历史原型截图的可选开关，本次新增桌面/手机原型对照均执行通过。
- 验证已有要求显示、自动保存和清空、保存失败不执行、刷新恢复、开始前保存、固定任务输入不被后续编辑污染、上传同时编辑不丢失、冲突保留、问题返回输入框、主页面任务记录，以及全站助手展开/收起不改变内容宽度。

旧侧栏中的两项“聊天消息采用为更新要求”界面测试随其生产入口移除；服务端聊天/提议协议未改动。旧已保存要求继续显示，旧聊天记录不擅自转换为执行输入。此次未调用真实模型、创建真实复核任务或扣除积分。
