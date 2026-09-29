# #384 上传页阶段边界与 UX 证据

用户决定：[2026-09-28 07:53 UTC](https://github.com/ITSophiaXu/BondBuddy/issues/384#issuecomment-5865771819)。原型布局基线：`94e38fba9fcfd4c957fc8c352b69f72bb817c118` 的 `product-prototype/public/project-workspace.js`、`project-workspace.css` 及右侧补充区；本次不修改原型源码。

首轮实现原 commit：`7fe55e29ac07a8b127c5dace779ce883da7409ec`，原基线 `develop@f2a9be5ed0da63c2a2ab5e18ce58134560d3a1f6`。2026-09-29 接续已重基线 `develop@35900e3`：首轮实现为 `44c1afa`，B05/B10 修正为 `889f460`、`c349fd4`、`fe0b6f7`，截图测试为 `b35a23e`。下列首轮材料截图/录屏来自首轮实现；新增阻断/暂停截图来自修正代码。所有截图、视频和接口数据均来自本地 Chromium + synthetic HTTP/文件，非客户材料、部署验证或模型/Word 成果。

## 交付与边界

- 四类材料分区、文件选择器、真实字节上传/保存进度、单文件失败重试、页脚开始操作和右侧补充区保留。
- 删除解析详情、原文、证据 ID、英文技术 warning、历史稿校正表单、文件行 OCR 核对入口与页底折叠事实审核组件。普通上传视图不 GET/PATCH source-profile，不读取事实候选；后台证据与 API 不变。
- 处理完成只代表持久化处理任务 succeeded；包括 needs_confirmation，但不改变后端证据状态。排队/运行/暂停/失败/读取错误分别显示真实简短状态；刷新状态仅 GET，不冒充解析重试。
- 用户一次开始操作对 ready/needs_confirmation 继续提交，原始 input revision/hash/幂等键保持；无自动 confirmed/recognized、无内容审核确认卡。blocked 保留服务端门禁，不再展示多项后台诊断为待办或继续提交注定暂停的 run；可针对已锁输入重新检查。
- 能力暂缓的 run 按同一锁定输入复查后才可尝试恢复。材料等待/试用限制和模型对账继续按后台状态处理；恢复后同一条件再次暂停时不让用户无限继续，保留 run 和事件，提示联系支持。
- 右侧对话不增加必答审核问题；真实多轮补充仍属于 #18。普通产品不另开技术审核页。保留的事实审核组件仅在测试隔离容器验证旧 API 消费行为。

## 同尺寸视口对照与连续走查

| 视口 | 原型（上述原型 commit） | 首轮实现（`44c1afa`） |
| --- | --- | --- |
| 1440×960 | [桌面原型](reference-desktop.png) | [桌面实现](materials-desktop.png) |
| 390×844 | [窄屏原型](reference-mobile.png) | [窄屏实现](materials-mobile.png) |

截图为 fullPage，长页面实际图片高度随内容变化。两边均经过真实文件选择和合成上传接口；文件为合成历史 DOCX 与财务 PDF，不是可交付文档。原型较老的窄屏固定侧栏会遮盖部分内容，实际应用沿用 #361 已有的窄屏菜单；本次没有修改原型来美化对照。实际 390px 页面自动检查无横向溢出。

材料分区顺序、右侧补充区及页脚开始操作保留；与原型的具体状态差异由 #384 最新决定确认：保存和后台处理分开显示，未知不能伪装百分比，后台待核不再显示技术详情或要求内容确认。已有细分类别、项目摘要条和真实保存恢复提示继承 #361/#370，本切片未重新设计。

新增阶段状态沿用同一材料页布局与 #85 `46764161565027f332bdf28f8b335620bd035018` 的同页暂停区（可对照 [#18 暂停原型截图](../issue-18-trial/README.md#同尺寸证据)）。原型没有后台五项诊断的用户审核步骤；按 #384 最新用户决定，合成状态对照为：

| 视口 | 服务端 blocked：单条平台状态，无第二次 execute | 同一 run 首次暂停：先复查条件 |
| --- | --- | --- |
| 1440×960 | [阻断](blocked-desktop.png) | [暂停](paused-desktop.png) |
| 390×844 | [阻断](blocked-mobile.png) | [暂停](paused-mobile.png) |

这两组 fullPage 截图同样使用 1440×960 与 390×844 视口，合成材料处理任务已完成、仍保留 `needs_confirmation`；实现列出错原因时不含原始规则码、证据 ID 或五项审核列表。测试验证 blocked 重查只发预检、不发 execute；同一 run 恢复后再次遇到相同暂停原因，刷新恢复也不提供重复继续，包括超过展示上限的事件历史。截图不能证明用户报告的原项目属于哪个真实后台子原因。

[桌面连续操作](workflow-desktop.webm)、[桌面关闭重开](reopen-desktop.webm)；[窄屏连续操作](workflow-mobile.webm)、[窄屏关闭重开](reopen-mobile.webm)。录屏覆盖保存等待、财务文件单独重试、历史文件保留、后台 needs_confirmation 下的简洁完成状态、一次开始、刷新和重开恢复同一 run。模拟预检与 run 不代表真实后台已经取消旧门禁或已经调用模型。

## 首轮本地验证

环境：Ubuntu 24.04，Node 24.21.0，Chromium 153.0.8010.12；服务为本工作区独立 Vite 端口 5194。接口/文件明确为合成数据。

| 检查 | 结果 |
| --- | --- |
| 构建 | contracts/domain/rule-pack-registry/rule-applicability-context/API/worker 已编译通过；最后前端 `npm run build -w @bondbuddy/web` 通过 |
| Web 单元 | 28/28，0 失败、0 跳过；保留 API If-Match 校验，新增不读取/伪造后台确认与状态/版本隔离 |
| 完整 Chromium 回归 | 101 通过、14 既有 live 条件跳过、0 失败，3.6 分钟；独立输出目录 `/tmp/bb384-full-browser-results` |
| 连续操作录屏 | 2/2，桌面和窄屏均覆盖上传、保存等待、单文件重试、不强制内容确认、启动及刷新/重开 |
| 规格合订与校验 | 19 模块、214 本地链接、193 验收标识，0 错误；04/05/16/17及架构/迁移说明同步 |
| diff | `git diff --check origin/develop...HEAD` 通过 |

跳过项包括未启用的真实 API/数据库/Blob/OCR/账号专项；本次没有把改写后的 live 解析用例算作执行通过。实际后台仍保留源画像，由既有接口和真实环境专项验证；本地前端只证明不再读取/校正它及不新增审核步骤。

接续修正于 macOS / Node 24.14.0 / Playwright 1.63.0 的独立本工作树 Vite `5194` 端口复测：`npm run build` 全依赖包通过、`npm run check:contracts` 通过、Web unit 28/28、完整 Chromium 102 通过/15 条 live 条件跳过/0 失败，规格 19 章/214 链接/194 验收标识、0 错误。完整浏览器用例包含前述 blocked、ready/needs_confirmation 一次提交、同一 run 的暂停→阻断→条件变化→继续，以及同因暂停/超过 12 条事件/重开后抑制重复继续；仅覆盖合成边界。

## 联调与尚未验收

#76（Xuefeng 的源/目标类型与难度依据、Felix 的阶段准入及输入锁消费）仍须与本前端协调，避免旧整张画像确认条件使任务暂停；#31 需提供真实锁定材料/要求进入模型、全文处理、正文待核标记与摘要一致的证据。用户报告 B05/B10 的原项目、run、部署版本与实际阻断分类仍需 #35/#76 以脱敏记录定位，在原项目连续复测；合成状态截图不代表现场修复/产品 UX 验收。#361 的 B02 上传错误细分、B04 泛化启动错误由独立前端切片处理，本 PR 不修改 `apps/web/src/api.ts` 的错误映射。此记录不关闭 #384，也不宣称已部署、执行真实模型或交付 Word。

已有原型差异继承 #361/#370：PDF 支持、60份/500MB容量、真实服务端恢复与可选细分角色，以及当前补充说明自动保存和未接通多轮回复提示。它们不是本次新设计，详见 [迁移说明](../../PROTOTYPE-MIGRATION.md)。本次仅按用户决定调整材料行状态与技术审核入口，截图单列可对照差异。

## 复现

```sh
npm ci --include=dev
npm run build
npm run test:unit -w @bondbuddy/web
npm run dev -w @bondbuddy/web -- --port 5194 --strictPort
# 另一个终端，锁定此工作区服务
BB_E2E_BASE_URL=http://127.0.0.1:5194 npm test -w @bondbuddy/web -- --workers=1
BB_UX_EVIDENCE_PREFIX=bb384 BB_UX_EVIDENCE_DIR=/tmp/bb384-reference node apps/web/scripts/capture-prototype.mjs
BB_E2E_BASE_URL=http://127.0.0.1:5194 BB_UX_EVIDENCE_DIR="$PWD/apps/web/ux-evidence/issue-384" npm test -w @bondbuddy/web -- --config playwright.material.config.ts
node product-prototype/product-specs/build-spec.mjs
```
