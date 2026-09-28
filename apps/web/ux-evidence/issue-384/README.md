# #384 上传页阶段边界与 UX 证据

用户决定：[2026-09-28 07:53 UTC](https://github.com/ITSophiaXu/BondBuddy/issues/384#issuecomment-5865771819)。原型布局基线：`94e38fba9fcfd4c957fc8c352b69f72bb817c118` 的 `product-prototype/public/project-workspace.js`、`project-workspace.css` 及右侧补充区；本次不修改原型源码。

实现 commit：`7fe55e29ac07a8b127c5dace779ce883da7409ec`，基于 `develop@f2a9be5ed0da63c2a2ab5e18ce58134560d3a1f6`。后续证据提交不改应用代码。所有截图、视频和接口数据均来自本地 Chromium + synthetic HTTP/文件，非客户材料、部署验证或模型/Word 成果。

## 交付与边界

- 四类材料分区、文件选择器、真实字节上传/保存进度、单文件失败重试、页脚开始操作和右侧补充区保留。
- 删除解析详情、原文、证据 ID、英文技术 warning、历史稿校正表单、文件行 OCR 核对入口与页底折叠事实审核组件。普通上传视图不 GET/PATCH source-profile，不读取事实候选；后台证据与 API 不变。
- 处理完成只代表持久化处理任务 succeeded；包括 needs_confirmation，但不改变后端证据状态。排队/运行/暂停/失败/读取错误分别显示真实简短状态；刷新状态仅 GET，不冒充解析重试。
- 用户一次开始操作对 ready/needs_confirmation 继续提交，原始 input revision/hash/幂等键保持；无自动 confirmed/recognized、无内容审核确认卡。blocked 仍如实反馈并由服务端检查。
- 右侧对话不增加必答审核问题；真实多轮补充仍属于 #18。普通产品不另开技术审核页。保留的事实审核组件仅在测试隔离容器验证旧 API 消费行为。

## 同尺寸视口对照与连续走查

| 视口 | 原型（上述原型 commit） | 实现（上述实现 commit） |
| --- | --- | --- |
| 1440×960 | [桌面原型](reference-desktop.png) | [桌面实现](materials-desktop.png) |
| 390×844 | [窄屏原型](reference-mobile.png) | [窄屏实现](materials-mobile.png) |

截图为 fullPage，长页面实际图片高度随内容变化。两边均经过真实文件选择和合成上传接口；文件为合成历史 DOCX 与财务 PDF，不是可交付文档。原型较老的窄屏固定侧栏会遮盖部分内容，实际应用沿用 #361 已有的窄屏菜单；本次没有修改原型来美化对照。实际 390px 页面自动检查无横向溢出。

材料分区顺序、右侧补充区及页脚开始操作保留；与原型的具体状态差异由 #384 最新决定确认：保存和后台处理分开显示，未知不能伪装百分比，后台待核不再显示技术详情或要求内容确认。已有细分类别、项目摘要条和真实保存恢复提示继承 #361/#370，本切片未重新设计。

[桌面连续操作](workflow-desktop.webm)、[桌面关闭重开](reopen-desktop.webm)；[窄屏连续操作](workflow-mobile.webm)、[窄屏关闭重开](reopen-mobile.webm)。录屏覆盖保存等待、财务文件单独重试、历史文件保留、后台 needs_confirmation 下的简洁完成状态、一次开始、刷新和重开恢复同一 run。模拟预检与 run 不代表真实后台已经取消旧门禁或已经调用模型。

## 最终本地验证

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

## 联调与尚未验收

#76（Xuefeng 的源/目标类型与难度依据、Felix 的阶段准入及输入锁消费）仍须与本前端协调，避免旧整张画像确认条件使任务暂停；#31 需提供真实锁定材料/要求进入模型、全文处理、正文待核标记与摘要一致的证据。此记录不关闭 #384，也不宣称已部署、执行真实模型或交付 Word。

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
