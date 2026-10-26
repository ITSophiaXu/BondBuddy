# 桌面 UX milestone：旧检查准确打开与文件往返

2026-10-26。本轮承接已推送的 PR #745（`8c81e8f1`），该提交已包含核对时最新 `develop@030b0c56`。R1–R44 已有功能不重新实施。工作分支：`codex/desktop-ux-history-20261026`。

## 交付范围与停止条件

此前只有最近 30 轮检查可被页面读取。用户从第 31 轮及更早的检查链接进入时，即使原记录仍存在，也只能看到“指定的检查记录暂时无法读取”。本轮完成一条有限桌面流程：

**带明确 `run` 的旧检查链接 → 查看固定募集书及检查时文件 → 回到对应项目文件核对当前版本 → 返回原检查。**

| 验收项 | 交付行为 |
| --- | --- |
| 准确读取 | 最近列表缺少指定 `run` 时，单独读取该轮；不把最近一轮当作原检查 |
| 原稿与当前稿 | 文件核对保留检查时 V1、当前 V2、准确文件族和返回原检查链接 |
| 读取边界 | 账号、项目、检查类型、原 run 均需匹配；缺失或无权限返回 404；空或重复 `run` 不猜测 |
| 失败恢复 | 可明确重新读取原检查；短暂读取失败保留上次准确快照并显示失败提示，活动记录继续轮询；403/404、错 run 或无效 DTO 不保留可执行旧记录 |
| 只读往返 | 打开、刷新及往返仅 GET；不准备新工作区，不创建检查、更新、报价或积分扣款 |
| 历史标识 | 用时间、状态及“链接指定记录”标识，不从截断列表长度推算绝对轮次 |
| 收口 | 上述桌面行为、定向回归、API/契约验证、类型检查及构建通过后结束本轮 |

手机优化、全历史分页、长期监控、人工事项状态管理以及仅 `update_run` 而无检查 `run` 的旧链接反查不在本轮。已有 `run+update_run` 的准确关联与未知请求恢复守卫保留。

## 实现与界面依据

- API 新增 `GET /api/v1/projects/:project_id/project-files/checks/:run_id`，返回 `{check: ProjectFileCheck}`；DTO 复用公共契约，OpenAPI 同步登记。默认列表仍最多 30 条；无数据库迁移、费用或任务语义变更。
- `consistency-history.ts` 为两个页面共用准确读取及响应 schema 校验；页面保留原有迟到读取、版本、文件族、下载和未知提交守卫。
- 对应现有检查页 `apps/web/src/file-consistency.ts` 与项目文件页 `project-files.ts`。沿用 PR #745 已发布桌面布局、原检查文件核对及版本面板，没有新增页面、步骤或导航；继承 `docs/product-decisions/2026-10-08-global-project-assistant.md` 等当前产品决定。
- 本轮新增的是原检查补读及读取失败反馈；此前交付范围中明确列为后续的“最近 30 轮与旧深链读取”现按上述有限范围实现。变更依据为本轮用户要求继续桌面 UX，并要求有限 milestone。

## 桌面对照与验证

证据使用真实前端与**合成 HTTP/SQL 数据**，视口均为 1440×960。先前完整应用的对照基准为 `8c81e8f1`，独立服务只读运行，不向旧源码注入新组件。

| 场景 | 同尺寸截图 |
| --- | --- |
| 基准：旧链接打不开 | [基准截图](history-baseline-missing-1440.png) |
| 当前：原检查及固定募集书 V2，可辨当前 V3 | [旧检查准确读取](history-old-check-1440.png) |
| 当前：检查时 V1 与当前 V2 文件核对，返回原检查可达 | [文件往返](history-file-return-1440.png) |
| 当前：缺失记录明确提示并可重试，无自动换轮 | [读取失败](history-missing-check-1440.png) |

截图已逐张检查：历史依据和当前版本区分清楚，桌面控件可达，无新增遮挡。原应用布局未改变；对照为此前已发布实现，非新原型或完整业务验收。

最终测试数量、命令和结果见 [verification.json](verification.json)。首次运行中暴露的夹具兼容与提示定位问题保留在独立本地证据目录；最终按完整受影响套件重跑，不把历史通过数累计为单轮结果。

这些验证不调用真实 worker、模型、账务、PostgreSQL 或 Blob，不等于真实 Word/WPS、行业内容或业务用户验收。构建已有的大 bundle 提示保留，本轮不扩展性能重构。

## 运行复验

```powershell
npm run build
npm run check:contracts
node --test apps/api/dist/project-file-check-history.test.js
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/consistency-confirmation.test.js apps/web/dist-test/project-file-status.test.js
```

先启动本工作区 `apps/web` 的 Vite，再配置 `BB_E2E_BASE_URL` 和本机浏览器 channel，运行：

```powershell
npx playwright test tests/consistency-history.spec.ts tests/consistency-originals.spec.ts tests/consistency-reading.spec.ts tests/consistency-confirmation.spec.ts tests/file-consistency-workbench.spec.ts tests/consistency-task.spec.ts --grep-invert "at 390"
```

可选旧版截图 collector `consistency-history-baseline.spec.ts` 仅在 `BB_CONSISTENCY_HISTORY_BASELINE=1` 时运行，必须将 `BB_E2E_BASE_URL` 指向独立的 `8c81e8f1` 服务，不能作为当前产品测试计数。

本轮交付后停止自动扩展；未发布到远程或部署。原 PR #745 核对时仍 OPEN，不能把已推送称为已合并或上线。
