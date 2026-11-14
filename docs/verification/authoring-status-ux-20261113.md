# 募集书任务状态与立即重试（2026-11-13）

状态：开发和自测完成，**代码完成，尚未部署，待统一发布**。用户已指定两张截图的布局方向，**尚未验收实际集成版**。

源码与原型 commit：`40eae5a6b7251b161559d99da6beef0143a960bb`；PR [#1302](https://github.com/ITSophiaXu/BondBuddy/pull/1302)，base `develop`。Refs #994；该 Issue 的其他任务类型恢复仍未全部完成，保持打开。原型登记在 #361。

## 界面范围

- 按用户提供的暂停、完成两张截图调整“募集书全文更新”：白底卡片、顶部状态色条、状态徽标和标题。暂停卡提供“立即重试”“停止任务”；完成卡不显示任务操作按钮，既有成果下载与“继续修改”入口保留。
- 五步保持“等待开始 → 准备材料 → 编制募集书 → 保存文档 → 可下载”。已完成用绿色勾选，当前暂停用橙色暂停图标，后续步骤为灰色；步骤依据实际任务状态及事件显示。
- 费用改为卡外紧凑文字和“计费说明”，沿用任务实际报价、积分及试用规则，不采用截图中的固定金额替代真实账务，也不新增计费规则。
- “处理记录”默认展开，显示实际事件时间、内容与出错／暂停／完成标记；“本次使用的材料”默认折叠，显示本轮锁定的材料版本。展开选择在状态刷新时保留。
- 原型覆盖排队、运行、正在暂停、暂停、恢复、旧任务暂停、完成、失败、停止九种状态；正式界面根据服务端证据选择说明，不把所有模型异常都描述为可自动恢复。

## 手动重试与自动恢复

“立即重试”先读取 `GET /api/v1/runs/:run_id/retry`，提交时由 API 在事务中重新核对当前任务和尝试状态，不以浏览器显示文案决定能否重试。

| 模式 | 用户行为及结果 |
| --- | --- |
| `restore_checkpoint` | 存在有效工作快照时，从保存进度继续。仍使用同一任务、锁定输入和原积分预留；与系统自动恢复协调，不重复创建任务。 |
| `restart_materials` | 符合条件的旧任务没有可续跑快照时，先明确提示“未保存的中间进度无法恢复”，用户确认后才使用锁定原材料重新处理；保留原任务、预留、历史用量及账务。取消确认不提交。 |

既有用户主动暂停仍走“继续本次任务”。模型进程未确认退出、已有成果、证据冲突、账务未就绪、积分暂停或达到重试上限时，返回具体不可重试原因。重复点击和回执丢失复用同一请求标识；不能据此把未知历史用量改为零。

本次状态界面衔接此前的 HTTP 413 有限自动恢复，恢复前保存及校验工作快照、恢复时重建可信原材料。异常根因和恢复限制见 [HTTP 413 自动恢复说明](file-authoring-payload-recovery-20261113.md)。旧生产任务没有的中间快照不能补造；本次开发没有修改或恢复旧生产任务。

## 源码、原型与截图

- 原型：[authoring-live-progress.html](../../product-prototype/public/authoring-live-progress.html)，默认暂停，可用 `?state=succeeded` 查看完成状态。
- 原型与实现共享样式：[authoring-status.css](../../product-prototype/public/authoring-status.css)；新类统一使用 `authoring-status-` 前缀，并覆盖真实页面保留的旧布局类。
- 网页：[状态展示](../../apps/web/src/authoring-status.ts)、[操作及材料接线](../../apps/web/src/project-execution.ts)、[浏览器用例](../../apps/web/tests/project-execution.spec.ts)。
- 服务端：[重试契约](../../packages/contracts/src/run-retry.ts)、[API 路由](../../apps/api/src/server.ts)、[重试判定与事务](../../apps/api/src/queue.ts)、[工作快照](../../apps/worker/src/file-authoring-recovery.ts)。

对照截图已归档至本说明同名目录并逐屏复核。桌面视口 1440×1000、手机视口 390×844，原型与实现使用相同配置，截图保留完整页面。状态区未发现横向溢出、文字裁切或按钮重叠。

| 状态／宽度 | 原型 | 实现 |
| --- | --- | --- |
| 暂停／1440 | [原型](authoring-status-ux-20261113/prototype-paused-1440.png) | [实现](authoring-status-ux-20261113/implementation-paused-1440.png) |
| 暂停／390 | [原型](authoring-status-ux-20261113/prototype-paused-390.png) | [实现](authoring-status-ux-20261113/implementation-paused-390.png) |
| 完成／1440 | [原型](authoring-status-ux-20261113/prototype-completed-1440.png) | [实现](authoring-status-ux-20261113/implementation-completed-1440.png) |
| 完成／390 | [原型](authoring-status-ux-20261113/prototype-completed-390.png) | [实现](authoring-status-ux-20261113/implementation-completed-390.png) |

与截图/原型的必要数据差异：真实页面保留应用导航、项目上下文及成果下载；样例有 2 份锁定材料，原型示例为 3 份。成功后的账务显示服务端实际“已结算”，不继续写“已预留”。处理记录保留之前的出错和暂停，不因最终成功而改写历史。恢复文案按已核验证据显示，旧任务无快照时明确说明不能恢复未保存内容。窄屏将操作按钮放在说明后并排显示。上述为当前截图要求在真实数据及既有应用中的接线，实际集成版仍待用户验收。

## 验证进度与数据边界

正式页面从任务、事件、重试接口、账务及锁定材料中读取数据。原型的时间、记录、文件、步骤与 34,570 积分均为明确标注的合成示例；按钮仅切换演示状态。浏览器测试运行真实网页代码，使用合成任务和 API 路由替身，只证明对应页面及交互，不证明真实模型生成、生产账务或完整后端链路。

| 检查 | 证据 | 最终结论 |
| --- | --- | --- |
| 原型静态验证 | 九状态、重试／暂停／停止、旧任务确认、默认开合及 JavaScript 语法检查通过 | 已完成此范围 |
| 状态、重试及相关浏览器回归 | Chromium + 本地 Vite；5 组日志按用例名去重，最终 **48/48** 通过、0 未解决失败、0 跳过。新增请求确认、受理前/后丢回执、迟到回包、材料锁定、历史准确成果、下载、继续修改、积分与自动恢复。 | 通过 |
| 最终定向复验 | `status-ux-final-regression.log` 19/19；`status-ux-capture-final.log` 3/3。此前已通过的未受影响用例不重复全量执行。 | 通过 |
| 网页状态单测 | TypeScript 测试编译后 `node --test apps/web/dist-test/authoring-status.test.js apps/web/dist-test/authoring-progress.test.js`，13/13。 | 通过 |
| 网页类型检查/构建 | `tsc --noEmit`、`vite build`；保留既有大 chunk 提示，无构建错误。 | 通过 |
| contracts/API/worker 编译 | 对三个包分别执行 `tsc -p .../tsconfig.json`；契约样例 179 + 12 项。 | 通过 |
| API 单测 | `node --test apps/api/dist/file-authoring-recovery.test.js apps/api/dist/provider-run-events.test.js`，5/5。 | 通过 |
| 真 API + PostgreSQL 重试 | `node --test apps/worker/dist/file-authoring-payload-recovery.pg.test.js`，最终 1/1；既有 timeout 子测试此前 1/1 通过。 | 通过，详见下方边界 |
| 同尺寸截图 | 八份原型/实现截图；1440/390 两宽度均检查页面无横向溢出。 | 已归档并视觉复核 |

浏览器精确选择范围保存在测试代码；测试入口分别为 `project-execution.spec.ts`、`authoring-next-layout.spec.ts`、`result-handoff-authoring.spec.ts`，仅运行与本次变更相关的场景。早期失败包括旧文案/材料入口选择器和一个仅改成功状态、未提供成果的旧 fixture；现已按新 UI 更新选择器并提供真实形状的合成成果，原版次、字节和账务断言保留。另补并通过：迟到的 queued 回包不得覆盖更高事件版本的成功状态或移除下载 DOM；已受理后丢回执、下一次尝试再暂停时，核对原请求不得虚称“已安排继续”。账务核对不推定编制完成，待补信息不误标普通暂停。

[后端详细验证记录](authoring-status-ux-20261113/backend-validation.md)包含准确命令、真实 API/数据库与合成供应商的边界，以及测试过程中修复的 Fastify 条件 schema 序列化和 PostgreSQL 微秒时间戳比较问题。专用 PostgreSQL 16 容器应用 178 个迁移，使用 tmpfs 与本机端口；测试 clone 与容器均已清理。旧 timeout 子测试所在的中间整轮曾因新 CAS 缺陷退出 1；修复后只定向重跑受影响的手动/自动 413 套件，不将中间整轮冒称全绿。

本次未调用真实模型，没有验证生成内容质量。完整本地集成版及用户操作验收仍待指定集成 chat 完成。GitHub CI 上一提交因账户付款/支出限制未启动，远程结果与本地测试分别记录在 PR，不据本地通过跳过保护。

## 集成与发布

API、worker、网页及契约需协调更新：网页依赖重试接口，API 依赖新快照证据和恢复规则，旧 worker 不能领取需要恢复工作快照的新任务。此改动本身不要求 SQL 迁移或新增依赖；以最终固定版本的交接核对为准。

本开发 chat 不执行生产部署、迁移或服务重启，不批量修改旧生产任务及账务。交付后由指定集成测试 chat 汇总到独立本地环境，完成真实网页、API、数据库、存储、worker 链路验证，提供用户实际验收；用户验收并明确授权后，由统一发布 chat 上线。
