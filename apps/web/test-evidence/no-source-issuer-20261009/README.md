# 原稿无需手填发行人名称（#361 当日新增）

遵循用户 2026-10-09 决定。移除原型和实现的原发行人输入框及唯一共享缺项校验。API 的输入锁定、执行和报价均使用该共享规则。旧名称与任务快照保留；新数据可为空，目标发行人独立保存。其他原稿字段、版本/hash 绑定与定价分类不变，无迁移。

## 验证
Windows / Node 22.14 / Edge，独立 Vite 5636。API、账号、材料及任务均为 synthetic。
- build、check:contracts 通过（167 公共样例、12 内部样例、4 生命周期样例、29 OCR、11 发行人绑定）。
- node --test packages/contracts/dist/source-prospectus.test.js apps/api/dist/unified-authoring.test.js apps/api/dist/billing-classification.test.js：12/12 通过。
- npm test -w @bondbuddy/web -- project-conversation.spec.ts project-execution.spec.ts --grep "source|authoring materials stay"：13/13 通过。
- 覆盖无名称开始、每份历史/参考稿其余字段缺项、市场品种匹配、源与目标隔离、非标准期间及旧名称保留、替换后版本失效、运行只读。
- 原型定向渲染断言确认无手填名称输入框。

## 同尺寸原型对照
原型 product-prototype/public/project-workspace.js，起点 develop ace97066；原型与实现最终 commit 见本 PR。截图使用同目录 capture-prototype.mjs 渲染真实原型函数及样式，是隔离材料区域的 synthetic harness；实现为浏览器实际合成流程。

| 屏幕 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型](prototype-desktop.png) | [实现](implementation-desktop.png) |
| 390×844 | [原型](prototype-mobile.png) | [实现](implementation-mobile.png) |

已目视核对：双方均无原发行人输入，其余字段顺序及必填行为保留。实现沿用现有侧栏、解析提示及全站助手，未重排页面。此项 UI 变化由用户明确提出并确认，细节见产品决定。#361 其他历史范围不据此宣称完成。

最终统一验收待办：真实账号/原稿的最终统一流程验收；不把 synthetic 当真实供应商或专业验收。尚未在本次 PR 部署生产。
