# 材料一键生成与成功后积分变化

原型与实现源码 commit：`248f682e3a705e3ddd16d1edcedf75efe8590c43`，基于 develop `51ea9b67`。对应 #361，产品决定见 [固定价及一键交互](../../../../docs/product-decisions/2026-10-08-m4-fixed-document-price.md)。确认人：本会话用户（2026-10-08），明确要求取消生成前报价与二次确认，点击生成直接执行，成功后扣费并看到余额减少。

原型：`product-prototype/public/material-studio.js`；实现：`apps/web/src/material-workspace.ts`。常驻余额口径同步至 `credit-wallet.ts`、`credit-visibility.html` 和原型 `credit-account.js`。

| 对照状态 | 桌面 1440×960 | 手机 390×844 |
| --- | --- | --- |
| 原型表单 | [完整表单](prototype-desktop.png) / [生成按钮](prototype-footer-desktop.png) | [完整表单](prototype-mobile.png) / [生成按钮](prototype-footer-mobile.png) |
| 实现表单 | [完整表单](implementation-desktop.png) / [生成按钮](implementation-footer-desktop.png) | [完整表单](implementation-mobile.png) / [生成按钮](implementation-footer-mobile.png) |
| 已保存文件 | [桌面](saved-file-desktop.png) | [手机](saved-file-mobile.png) |

真实浏览器交互、合成 API 账务状态证据：桌面 1440×1100 的 [生成前](ready-1440.png) / [成功后](success-1440.png)，手机 430×932 的 [生成前](ready-430.png) / [成功后](success-430.png)。余额从 10,000 变为 5,500。截图与自动化均为 synthetic，不代表真实供应商生成、Word 内容质量或真实用户扣款。

核对结果：

- 原型与实现页尾均只有交付内容说明和“生成…”主按钮，无价格区、“确认并生成”或确认弹窗。
- 单次点击连续完成保存、内部报价和执行，提交期间按钮禁用；响应丢失、刷新后重试保留同一执行请求 ID 与准确输入，只预留一次。
- 报价等待期间修改要求不能误提交旧输入。余额不足在按钮旁提示充值，原输入保留；充值到账不会自动执行。
- 常驻主数字为可用＋预留，进行中不减少；小字如实列出可用及任务预留。任务状态变化立即刷新服务端余额，成功减少固定 4,500，失败或取消不减少。
- 桌面和手机无横向溢出。实现保留生产中的常驻余额、真实状态、草稿恢复及即时上传；原型仍保留旧账号入口、部分未开放文种和模拟上传，这些既有差异不在本次变更内。此次交互差异以用户明确要求为准。
- 终态提示不再被提交后的自动保存提示遮蔽；完成后明确显示“本次制作已完成”。

验证（Windows / Node 22.14 / Edge / 独立 Vite 5198）：

- `npm run build`、`npm run check:contracts` 通过；最终源码的 web build 通过。
- `M4_UX_EVIDENCE=1`，材料工作区 25/25，无跳过；最终完成提示调整后定向再验桌面/手机 2/2。
- 账号与项目执行回归 56/56，含共用钱包的预留、结算、释放、手机、刷新和退出隔离。
- 视觉核对了手机原型/实现页尾、桌面直接生成和手机成功后余额。

无 API、公共契约、数据库迁移或 worker 修改，固定 4,500 与双 Word 交付结算沿用已部署 0099。仅需更新 web；后台容器与正在执行的任务保持原版本。
