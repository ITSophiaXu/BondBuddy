# #544 上传回执丢失恢复验收

2026-10-04，源码 `438ccd804711fedd720e9541cb4865be4302772a`，基线 develop `f4fa160275ce450517fe515b875540ecc7261296`。所有截图和自动化材料均为 synthetic。

## 问题与修复

保存响应丢失后，本地行保持 `uncertain`。旧版即使读回同一份已保存材料，也没有清除该行，因此继续阻断“开始编制”。本次在不确定响应后只读恢复一次，并以当前账号、项目、SHA-256、字节数、分区和媒体类型唯一匹配持久化材料。文件名不同、服务器去重生成不同 upload ID 均不影响正确恢复；只同名或 hash/分区/大小/类型不符时不伪造保存成功。不重传字节、不重复完成请求，不自动提交任务或扣费。

真实项目检查仅证明服务器已有材料、原稿信息完整、重新打开时开始按钮可用；最初保存响应丢失的网络原因未确认。此次新模型调用和 Word 不属于该修复验收。

## 原型与实现

沿用已确认的材料页原型 `5b8de087984438b9729adb710b79cdc534d915ce`（`product-prototype/public/project-workspace.js`、`project-conversation.js`、`project-workspace.css`）。原型截图复用 [compact-notes](../compact-notes/README.md) 中的固定版本，原型源码未改。实现来源为上面的 `438ccd8`。下面两侧均为原始截图顶部的同尺寸视口裁剪，未修改页面内容。

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型](prototype-desktop.png) | [恢复后](implementation-desktop.png) |
| 390×844 | [原型](prototype-mobile.png) | [恢复后](implementation-mobile.png) |

恢复全页：[桌面](recovered-desktop.png)、[手机](recovered-mobile.png)。保存状态和启用的开始按钮真实来自合成 HTTP 保存成功、完成响应连接中断后的只读恢复。

本次没有改变布局、文案、材料分区、补充说明或原稿必填规则。原型为空材料，实现有合成材料及原稿信息，属于状态差异；合成 parser 未配置时如实显示处理状态暂不可用，仍可开始统一编制。既有材料分区/留白/API 状态差别沿用 compact-notes 的记录，不称为本次已完成的人工交互验收。需求依据和确认人：当前用户关于上传后可以开始编制的要求；目标环境实际状态另在 #544 记录。

## 验证

- 用相同的新回归临时恢复基线 `main.ts`，桌面回归在“服务器已确认保存”断言失败，页面保留 `uncertain` 并禁用开始。之后恢复修复代码；基线失败记录仅为合成数据，保存在任务本地，不提交运行目录。
- `project-execution.spec.ts` + `project-conversation.spec.ts`：**61 passed / 0 failed / 0 skipped**。
- `upload.spec.ts` 定向七项（丢失回执、延迟恢复、不匹配、取消重试、授权刷新、乱序读、账号隔离）：**7 passed / 0 failed / 0 skipped**。扩大回归时先发现既有账号隔离测试引用过期分区标题，按当前原型更新一个标题选择器后七项通过；没有删除用例或跳过断言。
- 此前新修复定向五项 **5 passed**；桌面/手机均验证一次 create/PUT/complete、零 input/execute。
- 根 build 脚本等价的各包 TypeScript 顺序构建、Web TypeScript/Vite 生产构建通过。公共契约 **166 synthetic + 12 internal** 示例、生命周期 **4** 示例通过；OCR 与 issuer binding 契约测试 **40 passed**。
- 环境：Windows、Node、Playwright Microsoft Edge，独立工作区 Vite `http://127.0.0.1:5177`。无真实模型、付款或客户正文上送。

命令：在 `apps/web` 设置 `BB_E2E_BASE_URL=http://127.0.0.1:5177`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node ../../node_modules/@playwright/test/cli.js test project-execution.spec.ts project-conversation.spec.ts --workers=1`；上传回归筛选 `lost completion response|server refresh reconciles|uncertain completion|cancel before byte|authorization expires|late material refresh|three independent files`。截图另设 `BB_UPLOAD_RECOVERY_EVIDENCE_DIR=test-evidence/upload-reconcile`。

本记录不代表已部署；master 发布、线上 web hash、原项目只读页面核验与回滚证据随后在 #544 登记。最终统一验收中的真实编制/Word/专业结果仍按原 Issue 追踪，不因本修复关闭父单。
