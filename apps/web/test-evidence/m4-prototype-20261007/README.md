# 材料生成原型对照

输入均为 synthetic；截图未使用客户材料、凭据或真实模型生成成果。

原型来源：`product-prototype/public/material-studio.js` / `project-workspace.css`，基线 `15405ab`，按[当前产品决定](../../../../docs/product-decisions/2026-10-07-material-studio-prototype.md)加入交易所和单输入框。页面通过原型自己的 `app.js` 启动，接口使用明确的合成数据。实现为 `apps/web/src/material-workspace.ts`；两侧源码与截图在本 PR 同一提交。

| 同一 viewport | 原型 | 实现 |
| --- | --- | --- |
| 1440 × 960 | [原型](prototype-desktop.png) | [实现](implementation-desktop.png) |
| 390 × 844 | [原型](prototype-mobile.png) | [实现](implementation-mobile.png) |

两侧均为 fullPage 截图，因此内容总高度可以不同。另有 320px 无横向溢出自动检查。

一致项：材料卡片、来源上传/关联、文种模板、支持资料、底部说明和生成操作、页面配色/字号/主区域宽度。按用户确认变化：交易所选择、表单末尾单输入框、无右侧对话。

既有生产边界：仅开放已实现的四种材料，推荐函注明未开放；立项私有模板仍限 DOCX；项目关联明确选择授权材料版本；保留既有任务/成果恢复和报价确认；账号沿用生产入口。项目问答页面依用户最后指令不实现。

验证：Edge 13 项材料页回归通过；额外原型/实现截图 1 项通过。`npm run build`、`npm run check:contracts`、web unit 83 项通过。原型材料相关单测 7 项通过。Linux API/worker 回归以 PR 的 `M4 core integration` 实际结果为准，不以本地合成浏览器结果代替。
