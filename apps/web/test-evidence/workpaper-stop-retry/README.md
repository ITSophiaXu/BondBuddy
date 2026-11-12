# #958 底稿结束排队与重试恢复验证

代码基线：`0c533ffc17cbca6b2fb6cf064339b0e115b4558d`（develop）。实现代码：`12e03d6a`。日期：2026-11-11。

## 问题与修复

“结束后续排队”只停止尚未开始的文件，当前 run 继续。此前批次立即显示“已结束排队”，同时开放“重试未完成项”；后端因当前 run 仍未结束返回 409，前端又把具体原因替换成笼统来源任务占用提示。

本次保留队列控制语义，展示当前文件仍在处理或待处理；非终态时禁用重试并提供原 run 入口。409 通过公共 `field_errors` 标记区分 `current_item_active`、`other_batch_active` 和 `source_task_active`，页面只使用本地安全文案；状态冲突刷新最新数据，不自动重发。重试 API 在原有当前项和版本保护之外检查来源项目占用，成功项/旧尝试不重建。`settlement_pending` 纳入前后端轻量进度轮询。无数据库迁移，不改变计价。

## 验证结果

环境：Windows、Node 22.14.0、Edge、独立 Vite 5388；PostgreSQL 16 独立容器 `bb-issue958-pg-20261111` / 55958，迁移模板及每个测试进程的克隆数据库。未使用生产数据库、模型或付费生成。

| 检查 | 结果 |
| --- | --- |
| contracts/domain/rule-pack-registry/rule-applicability-context/api/web build | 全部通过 |
| `npm run check:contracts` | 73 passed / 0 failed / 0 skipped；另校验 179 个公共、12 个内部、4 个生命周期样例 |
| web `api.test.js` | 33 passed / 0 failed / 0 skipped |
| `workpaper-stop-retry.pg.test.js` | 1 passed / 0 failed / 0 skipped |
| `generation-progress.pg.test.js` | 1 passed / 0 failed / 0 skipped |
| `workpaper-batch.spec.ts` 定向七项回归 + 两项原型 | 9 passed / 0 failed / 0 skipped |
| 同尺寸截图补充运行（上述九项中的四项） | 4 passed / 0 failed / 0 skipped |

数据库回归覆盖取消后 running/paused/awaiting_input/settlement_pending 的真实读取与 409、终态重试、其他批次/来源任务占用、外部账号 404、并发重复请求只接受一次、成功 run 与 immutable attempts 保留、请求不新增 run 或积分预留。合成成功项具有配套交付证据，未关闭数据库交付校验。

浏览器覆盖刷新后保护仍在、running → settlement_pending → failed 的自动刷新与重试开放、当前项暂停后的安全入口、三类安全冲突提示、旧 revision 刷新、请求在途按钮禁用和重复点击不重复提交。实际点击“查看当前文件”通过 main.ts 的材料路由打开准确 `run`，并看到该 run 的“继续生成”和“结束本次生成”。

复现命令（先完成上述 workspace build，数据库使用独立迁移模板）：

```powershell
$env:BB_TEST_DATABASE_URL='postgresql://postgres:issue958-local@127.0.0.1:55958/issue958_template'
node --test apps/api/dist/workpaper-stop-retry.pg.test.js apps/api/dist/generation-progress.pg.test.js
node --test apps/web/dist-test/api.test.js
npm run check:contracts
$env:BB_E2E_BASE_URL='http://127.0.0.1:5388'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npm test -w @bondbuddy/web -- workpaper-batch.spec.ts --grep 'current-file recovery|stopped queue|retry conflict|stale retry|direct generation prototype'
```

初轮失败均已查明并修正测试夹具：旧准备入口已转统一准备页、轮询实际为十秒、补齐合成成功 run 的交付证据及文种草稿。上表为最终验证结果；没有将这些早期失败记成通过。

## 原型对照

原型：`product-prototype/public/workpaper-batch.html`，commit `0c533ffc17cbca6b2fb6cf064339b0e115b4558d`。实现：`apps/web/src/workpaper-panel.ts`，commit `12e03d6a`。使用相同视口：1440×960 与 390×960，另保留实现完整页面。全部为 synthetic，原型示例 349 项、实现验证 3 项，不代表实际生产任务。

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型](prototype-viewport-1440.png) | [实现](implementation-viewport-1440.png) |
| 390×960 | [原型](prototype-viewport-390.png) | [实现](implementation-viewport-390.png) |

[完整桌面](stopped-1440.png) · [完整手机](stopped-390.png)

逐屏核对：保留批次卡、完成数、来源、积分、操作区和逐份状态折叠结构；移动端按钮换行，无横向溢出。新增差异为“当前文件处理中／待处理”提示、原 run 链接、禁用重试与刷新入口，直接对应 #958 的验收要求。原型的单页准备区与现有实现独立结果页/四步导航差异属于基线已有行为，本 PR 没有重组导航。

这些截图和浏览器测试证明本次状态恢复交互；没有声称产品负责人已逐屏验收。最终统一集成与用户验收仍待完成；代码完成，尚未部署，待统一发布。原始生产任务的服务器 409 响应未提供，本次修复经合成状态和真实数据库复现验证，不推断生产锁损坏。
