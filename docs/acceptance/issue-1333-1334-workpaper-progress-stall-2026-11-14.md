# 底稿试生成进度与续租恢复修复

对应 [页面进度 #1333](https://github.com/ITSophiaXu/BondBuddy/issues/1333) 与 [执行恢复 #1334](https://github.com/ITSophiaXu/BondBuddy/issues/1334)。首次发现为 2026-11-13，本报告日期为 2026-11-14；下列时间均为北京时间。

**代码完成，尚未部署，待统一发布。** 本地验证不代表用户已验收，也不代表生产模型生成速度已改善。实现及最终 UI 回归版本为 `67671b7b`，已 rebase 至 `develop` 的 `ba7ec636`，保留 #1332 的最新章节选择与成果列表。

## 实际问题与生产观察

批次 `9b967d4a-012b-4e2b-a6f8-6e0c2275b879` 的页面长期只有文件完成数，未显示读取资料、模型编制和交付中的实际动作；后台进入长时间交付后又反复恢复同一文件，进一步放大等待时间。

| 只读观察对象 | 已确认事实 |
| --- | --- |
| 批次及首份文件 `27bbe4ae…` | 11 月 13 日 21:19 提交批次；首份文件于 22:00:32 成功 |
| 第二份文件 `e7d4f3e6…` | 22:04 领取；22:07–22:21 只有一次模型调用；22:29 起进入交付；累计 32 次 `lease_recovered`、33 次执行尝试，至 11 月 14 日 02:01 成功 |
| 试生成结果 | 8 份试生成于 11 月 14 日 03:51 全部结束 |
| 后续复用计划的文件 | 观察到约 3 分 20 秒完成的文件；这是单份观察，不是全部文件的耗时承诺 |
| 实际执行容量 | 生成执行槽为 1；页面允许同批最多两份在途，不等于两份同时占用生成执行槽 |

第二份的长等待主要发生在模型返回后的交付阶段，不能把 33 次执行尝试解释为 33 次模型调用。已定位的恢复缺陷是交付 SQL 事务占用 run/job 行锁，续租等待锁时跨过原租约期限；旧逻辑既会把有效期内已经开始的续租判为失效，又使用事务开始时刻的 `now()` 计算新期限，导致长等待后拿到的期限可能已经过期，进而反复回放。

## 修复行为

- API 为活动文件增加可选的安全进度字段：当前业务阶段、任务创建时间、最近进展时间及执行租约是否失效。未知原始 stage、prompt、checkpoint 和事件 payload 不进入新字段；历史响应仍可不含该字段。
- 模型活动更新最近进展时间，同时保留最近可识别的业务阶段。进度轮询标识随事件及租约失效/恢复变化；正常续租不会仅因期限变化而重新加载整份清单。文件完成数继续只表示真实完成结果。
- 续租仅对原租约有效期内已开始、随后等待锁的请求保留恢复机会，重新核对相同 token、任务状态及既有停止和计费保护。过期后才开始的请求、其他 token 和终态任务不能据此恢复；其他业务写入仍执行原有严格租约检查。
- 新租约使用取得锁并完成续租处理后的实际时钟计算期限，并同步动态计费游标。超过旧租约的未确认空档不计费，旧租约内尚未结算的有效时长保留，暂停计时保持冻结。worker 同时只保留一个续租请求，避免锁等待期间堆叠续租。

本修复不增加数据库迁移或第三方依赖，不修改用户选定的文件范围、试生成确认关卡和成功成果。

## 验证与证据边界

本地环境为 Windows、Node.js 24.22.1、TypeScript 5.9.3、PostgreSQL 16.14。测试 PostgreSQL 使用本工作区独立数据目录并仅监听 `127.0.0.1:55479`；模板完整迁移至 0177，各测试从模板创建独立数据库，不使用生产或原验收库。

| 验证 | 结果与范围 |
| --- | --- |
| contracts / API 编译 | `node node_modules/typescript/bin/tsc -p packages/contracts`、`node node_modules/typescript/bin/tsc -p apps/api`，均退出 0 |
| 新增契约及 API 纯测试 | `node --test packages/contracts/dist/workpaper-item-progress.test.js apps/api/dist/workpaper-item-progress.test.js`；5 通过、0 失败、0 跳过。覆盖安全阶段、时间回退、静默模型不误判中断、终态/旧数据兼容和额外字段拒绝 |
| 真实本地 PostgreSQL 回归 | `node --test apps/api/dist/generation-progress.pg.test.js apps/api/dist/workpaper-progressive.pg.test.js`；9 通过、0 失败、0 跳过，进程退出 0，测试数据库清理完成 |
| 进度查询的具体覆盖 | 同一原始 stage 下的业务阶段变化、活动时间刷新、阶段不被普通活动覆盖、正常续租不刷新整表、租约失效及恢复可见、owner 隔离、无私有 payload 泄露。248 项/120 文件/25,997 条引用的样本中，清单响应 233,777 字节，轮询响应 94 字节 |
| 原渐进流程兼容 | 章节顺序、双在途限制、试生成确认、失败重试、停止及受阻恢复、固定报价、余额不足和恢复后不重复预留，均在上述本地 PG 套件内验证 |
| worker / 续租 SQL 定向回归 | API、worker 编译退出 0；`node --test apps/worker/dist/run-lease-heartbeat.test.js`：4 通过、0 失败、0 跳过。真实 PG 的续租锁等待、三类动态余额、账务隔离回归：17 通过、0 失败、0 跳过，进程退出 0；命令见下文 |
| UI 自动化与截图 | `BB_E2E_BASE_URL=http://127.0.0.1:5189`、`BB_E2E_BROWSER_CHANNEL=msedge`，在 `apps/web` 执行 `node ../../node_modules/@playwright/test/cli.js test tests/workpaper-progressive.spec.ts --workers=1 --reporter=line`：19 通过、0 失败、0 跳过，退出 0，含上游 250 份目录测试；真实前端 + synthetic API，只证明界面与交互 |
| 前端构建与复核 | `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`、`node node_modules/vite/bin/vite.js build apps/web` 均退出 0；保留既有大 bundle 警告。独立代码复核无阻断项；`git diff --check origin/develop` 通过 |

续租与计费命令：`node --test apps/api/dist/queue-renewal-locks.pg.test.js apps/api/dist/authoring-dynamic-balance.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js apps/api/dist/review-dynamic-balance.pg.test.js apps/api/dist/billing-safety-integration.pg.test.js`。所有测试数据库变量均指向上述独立本地模板库。

日志：[API/进度](issue-1333-1334-workpaper-progress-stall-2026-11-14/api-progress-tests.log)、[续租/计费](issue-1333-1334-workpaper-progress-stall-2026-11-14/queue-renewal-regression.log)、[整合后 UI](issue-1333-1334-workpaper-progress-stall-2026-11-14/browser-regression.log)。API PG 套件总耗时约 15 分钟，包含本机并行数据库克隆、检查点及清理等待，不能用作产品生成速度数据。本任务的独立测试 PostgreSQL 已停止。

首次 UI 运行出现 Vite 冷启动导航超时及旧用例把合成排队状态断言为“正在生成”；已按真实 queued 状态修正文案和断言，重跑原版 17/17、整合最新版 19/19 均通过。续租测试首次冷连接错过 2 秒合成租约，先预热连接后重新验证；没有放宽过期请求的拒绝条件。

## 界面对照

页面依据为既有“生成文件 → 查看成果”页面、用户本次反馈，以及 `ba7ec636` 中已合入 #1332 的界面。实现源为 `apps/web/src/workpaper-progressive-view.ts`，没有新建页面、导航或确认步骤。独立复核确认保留章节粒度选择、失败摘要、待处理入口和仅列试生成成功成果的结构。

桌面对照使用相同 1440×960 视口，均为全页截图（页面高度随内容变化）：[修改前，ba7ec636](generation-compact-ui-20261113/trial-1440.png) → [修改后，67671b7b](issue-1333-1334-workpaper-progress-stall-2026-11-14/trial-1440.png)。变化仅为现有状态卡加入当前文件和真实动作，并纠正排队/恢复提示；视觉最终确认仍待用户验收。

新增真实阶段示例：[桌面 1440×960](issue-1333-1334-workpaper-progress-stall-2026-11-14/progress-1440.png)、[手机 390×960](issue-1333-1334-workpaper-progress-stall-2026-11-14/progress-390.png)、[中断恢复 1280×720](issue-1333-1334-workpaper-progress-stall-2026-11-14/interrupted-1280.png)。已逐图检查状态卡内容，未发现新增内容裁切或横向溢出；手机断言同时验证页面宽度不超过视口。图中项目、日期、材料和成果均为 synthetic。

上述 PG 回归执行真实 API 和数据库操作，但资料、模型结果及部分终态为受控合成数据。生产时间线来自既有任务的只读观察；本次没有为回归重新调用真实模型，也没有据此验证生产输出质量。

## 剩余范围与统一验收

本 PR 解决进度不可见与交付期间错误续租造成的反复回放。单次模型编制耗时、只有一个生成执行槽、交付阶段串行 SQL 往返仍是独立性能成本，不在本 PR 中解决，不能承诺试生成或全套底稿的固定完成时间。

最终统一验收待办：在固定集成版本上检查等待/编制/交付/恢复提示、已有成果保留与下载、暂停续跑和积分一致性；按实际范围另行验证真实模型生成质量与耗时。用户验收和生产部署状态分别登记，不能以本地测试通过替代。
