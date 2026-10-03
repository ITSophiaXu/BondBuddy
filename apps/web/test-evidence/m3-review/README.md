# M3 #47 复核工作区：浏览器验收记录

2026-10-02。实现位于本提交的 `apps/web/src/review-*`，接入共享 M3 API；未引用演示数据、未修改用户原型或其浏览器存储。

## 对照版本

- 实现分支 `codex/m3-47-workspace`，基线 `744791a07bc53d7d899c33f79f8a46d2100a8e7a`（已合并 M3 需求）；实现版本为包含本记录的 PR head。
- 交互依据：用户确认的 `prototype-preview/product-prototype/public/review-v2.html/.css/.js` 及 `dashboard-v2.*` 本地补充。该原型工作区 HEAD 为 `19918c66500d5078781b553613d237da6b3e708c`；补充文件尚未进入该 HEAD，以如下 SHA-256 精确标识，不能把 HEAD 当成已含补充的提交。
- `review-v2.html`：`1a503afc1c8746e711318d081de19adc0fb31df5cc9ed12a6ac0e66f04c1cd7d`
- `review-v2.js`：`973ae71d51a35e437400b4891a8a8b60bb043662e8684ee176f427570f5d08c6`
- `review-v2.css`：`1bbdaf4d29224fdc0e5c4a661848d0d2ba8ae235d53c1980b8cbf52e30dd2bac`

## 逐屏核对

| 页面 / 行为 | 实现与对照 | 生产数据适配 |
| --- | --- | --- |
| 复核结果、项目助手展开 | [原型桌面](prototype-desktop.png) / [实现桌面](desktop.png)，均为 1440 × 1000 viewport、整页截图 | 保留现有 M1 公共导航宽度；复核路由隐藏收费占位。结果条数、证据、任务状态、消息均来自 API，本测试使用明确标记的 synthetic HTTP 数据。 |
| 窄屏助手抽屉 | [原型窄屏](prototype-narrow.png) / [实现窄屏](narrow.png)，均为 390 × 844 viewport | 抽屉、遮罩、关闭与键盘焦点保留；草稿由服务器和账号/项目分区的浏览器恢复缓存共同保存。 |
| 版本记录 | [实现工作台版本记录](history-desktop.png) | 工作台复核项目卡片与全部项目列表可打开相同记录；复核页只有材料与要求、复核结果两个 tab。停止/失败记录有独立执行版本、输入快照和范围。 |
| 调整助手提议与来源追溯 | [调整后的修订计划](proposal-adjusted-desktop.png)，1440 × 1000 viewport | 用户可取消或新增具备依据的问题；原提议、要求、说明仍可核对。缺少依据的原提议项显示排除原因，不静默消失；调整后再次打开计划仍能看到原提议。 |
| 项目资料补充入口 | [复核页资料入口](project-details-entry-desktop.png)，1440 × 1000 viewport | 顶部明确显示发行人、市场、品种待填写及“补充项目信息”。沿用既有项目详情路由，带回当前报告 ID 和 tab。 |
| 项目资料编辑与返回 | [复核项目资料表单](project-details-form-desktop.png)，1440 × 1000 viewport | 仅显示名称、发行人、市场与品种；保存失败保留填写并允许重试。返回原报告及实际选中的 tab，材料要求与未发送的上下文消息仍可恢复。 |

原型与实现均使用隔离的测试浏览器上下文截图，没有读取、清空或写入用户正在体验的浏览器存储。截图文字/条数差别来自测试材料与实际 API 状态；不预填原型的助手回复、不把未执行的检查显示为通过。

## 已验证行为

- 不经过聊天即可查看解释/证据、加入修订、核对范围、明确执行、下载带哈希校验的成果；解释窗口不生成聊天记录。
- 助手默认收起。每个项目、报告、问题、材料版本保留精确引用；多个未发送草稿可切换并在刷新后恢复。云端保存失败时保留本地草稿；另一个账号不能显示这些草稿。
- 发送说明只保存消息/等待真实回复；查看提议不改计划，明确采纳只改计划，执行需单独确认。发送中继续输入的内容不被清空。
- 核对助手提议时，可以取消原选问题或加入其他具备修订依据的问题。未选及不可修订问题保留原结论；不可修订的原提议项同时保留具体排除原因。采纳以用户本次核对后的选择为准，可保存空选择以取消范围，但不能执行空修订任务。
- 已采纳计划保存原提议及其 SHA-256、来源报告和采纳方式（沿用原提议／用户调整），后续手动保存仍保留来源；原助手消息不被改写。重新打开调整后的计划会说明“当前计划经用户调整，原提议未改变”。来源追溯不构成执行授权，查看、采纳与保存均不启动任务。
- 采纳提议或保存计划失败时，仍打开的弹窗内部与页面状态同时显示失败提示；弹窗中的当前勾选保留，服务器原计划不被覆盖，也不创建任务。原位重试成功后才更新计划并关闭弹窗。
- 复核页可从“补充项目信息／编辑项目信息”进入既有详情页，补充发行人、市场与品种；保存失败保留字段并可重试。返回链接固定原报告和 tab，实际标签选中与对应面板可见已验证；没有有效显式 tab 的直接报告链接仍默认打开复核结果。材料要求草稿、带原报告／问题引用的未发送消息均保留，补充信息不创建消息或任务，不改写旧报告、历史记录及已运行任务的输入快照。
- 问题展开状态、正在编辑的内容和光标在轮询时保留。差异报告明确标记本轮核验与沿用先前结果。
- 补证锁定原报告/问题。上传完成响应丢失后重用原上传会话，不重复上传字节；保存补证不启动任务，差异复核仍需明确确认。
- 同一项目活跃任务、空修订被阻止；网络响应丢失时保留同一执行请求。停止后的新一轮产生新请求，不复用已停止版本。
- 输入冲突同时展示服务器与本地草稿，明确选择后才保存，不自动覆盖。
- 复核成果与修订成果按 `artifact_run` 标明执行版本/来源报告；生成修订版、清洁版不改变原复核发现，也不表示复核通过。历史链接精确带 `report_id`。
- 修订成果旁可直接打开“处理清单”，按成果 ID/版本、任务、来源报告核对后展示已修改/未修改/待补证、原因、原文位置、依据记录与本轮限制。工作台入口绑定该次历史执行及其已采纳计划/源稿；返回时仍保留版本记录。缺少清单、关联不一致或非法“已通过”数据不会展示为成功，可以原位重试。新增[桌面](handling-desktop.png)与[窄屏](handling-narrow.png)截图；弹窗内部滚动，保留关闭/返回操作。
- M3 不调用报价、积分、支付、充值、预占或结算接口。现有 M1 用户说明组件未改为多轮助手。

## 验证命令与结果

环境：Windows、Node 24.14.0、npm 11.9.0、Playwright + 已安装 Microsoft Edge（Chromium），Vite 本地服务。

```powershell
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/web
npm run test:unit -w @bondbuddy/web
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npm test -w @bondbuddy/web -- review-workspace.spec.ts prototype-workflow.spec.ts project-conversation.spec.ts
```

结果：contracts / web build 通过；web 单元测试 48/48；浏览器 23/23（M3 8、M1 项目说明 13、原型工作流程 2）。`git diff --check` 通过。更新了旧原型回归脚本中已被 M1 产品决定取消的“有无历史稿”选择及创建页补充说明断言，未改变 M1 实现。

处理清单补充验证：contracts / web build 通过，单元测试 48/48，`npm test -w @bondbuddy/web -- review-workspace.spec.ts` 11/11（原 M3 8 项 + 处理清单 3 项）。新增验证覆盖两处入口、三种处理状态与原因、历史来源版本、缺失/错配/非法数据及重试；此轮未重复未改动的 M1/原型浏览器测试。

提议调整与项目资料补充验证（同日后续修复，未重跑完整套件）：

```cmd
set BB_E2E_BROWSER_CHANNEL=msedge
npm.cmd test -w @bondbuddy/web -- review-workspace.spec.ts --grep=proposal
npm.cmd test -w @bondbuddy/web -- review-workspace.spec.ts --grep=missing.review.project
npm.cmd test -w @bondbuddy/web -- review-workspace.spec.ts --grep=direct.report.links
npm.cmd test -w @bondbuddy/web -- review-workspace.spec.ts --grep=plan.failures
```

- `proposal`：4/4，包含 1 个既有上下文草稿／明确采纳用例，以及取消原选、新增选择、排除不可修订原提议项这 3 个新增用例；覆盖再次打开、再次保存时保留来源且没有执行请求。
- `missing.review.project`：1/1，覆盖活跃任务期间补充资料、保存失败重试、返回精确报告及材料 tab、实际面板可见、输入与未发送消息草稿恢复，以及旧报告／历史／任务不变。
- `direct.report.links`：1/1，覆盖没有 tab 与无效 tab 参数的报告链接均打开复核结果；修复返回材料 tab 被报告 ID 覆盖的问题后通过。
- `plan.failures`：1/1，在同一用例中分别验证采纳提议与保存计划返回 503 时弹窗内错误可见、页面反馈仍保留、当前选择及服务器原计划不变、没有新任务，以及原位重试成功后保存正确范围。
- 上述为 **7 个不同的定向浏览器用例**（6 个新增、1 个既有），不与前述 11/11 或早期 23/23 累加为完整套件结果。最终截图检查重复执行 `--grep=unrepairable` 1/1 和 `--grep=missing.review.project` 1/1，后者在 tab 修复后再次通过；这些复验不另计用例数。三张新增截图均已目视核对，提议弹窗复选框的全宽继承问题已修复。
- 独立后端验证：设置 `BB_TEST_DATABASE_URL` 指向可克隆的本地合成测试数据库后，`node --test apps/api/dist/review-workspace.test.js` 为 1/1、零跳过。该真实 PostgreSQL 用例覆盖调整选择的提议来源与哈希、重排同一范围、非法提议／问题拒绝、原消息不变、无新增运行，以及补充项目字段不改写既有任务 manifest；不与浏览器用例数合计。
- contracts / API / Web build、`npm run check:contracts` 和 `git diff --check` 通过；tab 与弹窗错误反馈修复后的 Web build 另行通过。本轮没有重复未改动的完整单元测试、M1／原型浏览器套件或真实供应商验收。

首次运行缺少 Playwright 默认 Chromium，改用本机 Edge 后执行成功；`BB_E2E_BROWSER_CHANNEL` 为可选环境参数，CI 默认行为保持不变。

## 验收边界

本记录的截图与交互是**真实浏览器 + synthetic API**验证；上述独立 PostgreSQL 验证仅证明列明的后端持久化与边界行为。测试中的助手回复、Word 下载字节和材料均为 synthetic，不证明真实供应商调用、Word 业务质量、专业签认或部署环境通过。最终统一验收仍需合并公共契约/API/worker 后，以授权材料执行真实三维复核、差异复核、修订及实际文件下载。公共 M3 DTO 和后端实现由协调分支提交，不包含在原 Web 提交中。
