# #361 预检拒绝与参考稿分类提示

依据 #361 的 2026-09-30 最新交接：已上传募集书的持久化角色可能为 `reference`，旧项目仍为 `update`。用户需要知道如何保留原文件更正分类及核验发行人，不能从通用 `INPUT_REQUIRED` 反复重试，也不能默认把所有参考企业改为本发行人。本切片覆盖原材料步骤的预检与执行失败提示；不实现或模拟材料更正、项目转换、身份批准。

原型为 `product-prototype/public/project-workspace.js`，commit `23fd64fa22185b21015684b885526bc4247e98cd`，布局沿用当前 develop 的原型迁移实现。参考截图使用同一原型源码、合成账号与材料页的“无历史稿”分支。实现代码 commit `c8bae5b96314ab4f51c55bf9a8aadd54f3509191`，以 `develop@bd442bdd971abd4a4f8532d26c75c4f56cf9b3db` 为基线；项目、HTTP 和文件信息均为 **synthetic**。

| 视口 | 原型材料页脚 | 实现预检拒绝 |
| --- | --- | --- |
| 1440×960 | [原型](bb361-errors-reference-materials-footer.png) | [实现](reference-role-desktop.png) |
| 390×844 | [原型](bb361-errors-reference-materials-footer-mobile.png) | [实现](reference-role-mobile.png) |

布局、阶段、材料分区、右侧消息区及“开始更新”的位置保持现有原型迁移。原型演示不触发真实身份预检，故两边比较同一材料页的错误落点，而非声称原型产生了相同错误。错误文案按 #361 已明确的分类交接补齐；“重新检查处理条件”复用 #388 的原位置，只检查相同 input revision/hash，不新增输入、run 或模型请求。没有新增技术审核面板或确认表单；不读取材料正文，不按文件名推断所属发行人。

预检返回 `409 CAPABILITY_NOT_READY` 时仅表示材料或处理条件尚未就绪，不误称当前环境未开放更新；沿同一输入重新检查，不重复锁定或提交。执行入口的未开放仍按执行响应单独提示。

工程验证：Linux、Node 22.23.3、Playwright/Chromium；全仓构建及最终 Web 构建通过；`npm run check:contracts` 验证 156 个 synthetic 公共样例、12 个内部库样例、4 个数据生命周期样例、OCR v2 29/29 和发行人绑定 11/11；Web 单元 43/43；启动流程初轮 Chromium 31/31，后续增加上述预检等待回归。最终完整浏览器结果在关联 PR 中记录。

```sh
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
npm run dev -w @bondbuddy/web -- --port 5361 --strictPort
BB_E2E_BASE_URL=http://127.0.0.1:5361 BB_361_START_EVIDENCE_DIR="$PWD/apps/web/ux-evidence/issue-361-start" npm test -w @bondbuddy/web -- tests/project-execution.spec.ts
BB_E2E_BASE_URL=http://127.0.0.1:5361 npm test -w @bondbuddy/web -- --reporter=dot
BB_UX_EVIDENCE_DIR=apps/web/ux-evidence/issue-361-start BB_UX_EVIDENCE_PREFIX=bb361-errors node apps/web/scripts/capture-prototype.mjs
```

首次使用默认 5173 端口时误用了本机旧工作区的开发服务，出现 4 项失败并中断，不能用于判断本修复；后续全部验证使用从本工作区新启动的独立 5361 服务。新回归覆盖预检阶段的真实 HTTP 409 形状、执行过滤之外仍可见的参考稿、更新/新稿文案区分、同一锁定输入重查、条件解除后一次 generation 提交，以及刷新恢复。

剩余工作：#35 的材料分类更正与发行人审核、既有项目的显式安全转换、批准绑定的浏览器引用，以及同一用户原项目的部署/连续复测；#18 的助手回复与 #34 的完整 Word 交付仍分别待验。本证据不代表真实模型、PG/Blob、用户原材料修复、Word/WPS 或产品逐项验收；#361/#384 保持开放。
