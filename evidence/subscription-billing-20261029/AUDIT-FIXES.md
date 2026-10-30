# 自动扣费、订阅与补款恢复：追加审计修复

2026-10-29；基于 `2d89ec9` 后工作区变更，最终提交由主任务统一记录。

本次实际运行环境：Windows、Node **v26.13.0**、已安装 Microsoft Edge、Vite `127.0.0.1:5184`。浏览器使用合成 HTTP 回执；API 使用隔离 PostgreSQL 数据库。没有真实商户扣款、模型调用、客户材料或专业质量签认。

## 已修复的入口

1. **支付渠道不可用时仍显示正确的产品模式。** `subscriptions/catalog.enabled` 只表示订阅功能是否开启，渠道是否可用由 `providers` 表示。无渠道时账户和钱包仍显示积分、199/499/999 元订阅档位及有效期，购买按钮关闭。浏览器回归直接使用 `installSubscriptions` 注册的真实 Fastify 路由响应，避免手写 `enabled:true` 掩盖 API 降级问题。
2. **自动版本的回复恢复记录保持积分单位。** v2/v3 待核实的 1,218 积分回复，不再显示为 ¥12.18；原范围补修的零费用也按积分显示。人民币支付记录仍保留人民币口径。
3. **底稿异步缺款可以回到原批次继续。** 仅服务端捕获 `CREDITS_INSUFFICIENT` 的批次返回 `billing_resume` 能力。用户从该批次选择补款后，客户端保存原批次、原版本、原 revision、原剩余积分及幂等请求。付款成功后恢复同一请求；重复回放只产生一个恢复记录，不重建已完成子任务。
4. **手动暂停和取消等待保持有效。** 新迁移 `0136_workpaper_billing_recovery.sql` 保存机器可识别的缺款暂停原因及不可变恢复记录。旧支付返回不能撤销后来的手动暂停。取消等待同步移除客户端恢复意图；异步返回再次核对 owner、request、order 与当前页面。
5. **到账后无需再点刷新。** 页面定时、焦点及积分变动事件读取当前命名订单的服务端状态。只有可信 `paid` 才自动返回原任务；不自动创建另一订单、不自动调用渠道扣款。自动返回有并发防护。
6. **历史报价链接不再丢失。** 订阅页展示 `#/account?quotation=...` 指定的历史范围与报价，自动版本按积分显示。组件在订阅页为只读，不出现新的逐单金额确认。是否已经执行或结算以任务记录和积分明细为准。

## 尚未完成的付费能力：底稿批次变更检查

旧入口 `/workpapers/batches/:batch_id/checks` 直接提交 `workpaper_change_v1`，此前没有报价或扣费。其 worker 仅比较前后募集书及已保存的依赖链接，每项可能返回“未生成／缺关联，需人工核对”；最终交付是一份批次汇总 Word。它没有逐份检查交付凭证或已付范围复用映射，不能直接把整份汇总成功当作多份 check SKU 的全额交付。

**本次仅关闭新版中的新检查执行，未完成付费底稿批检。** API 在原请求幂等回放之后、创建任何新任务或预留之前返回 `BILLING_NOT_READY`。底稿库明确显示“底稿变更检查暂未开放”，检查按钮禁用；旧文件、历史影响信息、预览和下载保留。既有已受理请求可回放，旧模式行为不改。没有以成功状态伪造质量验收来扣费。

后续最短接入路径是复用真正的 `project-files/checks/quote → checks → updates`，每份生成 Word 单独委托：

- 为每份目录底稿建立稳定的文件家族与版本映射。当前底稿只有 `bb_workpaper_items` 和 M4 artifact pin；`bb_project_files` 的 `UNIQUE(project_id,document_type)` 及文种枚举不能直接承载数百份同类底稿。
- 锁定源募集书、目标 Word 及版本后使用现有 check SKU、已付检查覆盖和同范围修订路径。新 source 或新目标版本必须新计费；无已付证据不判为包含。
- 检查后的修订版需回写底稿的版本链及库展示；不能只在关联文件库生成孤立版本。
- 验证逐份失败释放、幂等重放、同源复用、新源新收费、跨账号隔离及精确补款恢复。不要以旧 `workpaper_change` 汇总报告冒充上述交付。

## 验证结果

所有下列通过数均为本次实际运行，0 skipped：

| 范围 | 命令／测试 | 结果 |
|---|---|---|
| 契约、API、Web | `npm run build -w @bondbuddy/contracts`；`@bondbuddy/api`；`@bondbuddy/web` | 通过；Web保留已有大包提示 |
| API路由及资金边界 | `node --test apps/api/dist/subscriptions-catalog.test.js apps/api/dist/automatic-file-billing.pg.test.js` | **8 passed** |
| 精确任务恢复单元 | 编译 `apps/web/tsconfig.test.json` 后运行 `billing-task-recovery.test.js` | **8 passed** |
| 订阅与自动业务任务 | `subscription-account.spec.ts` + `automatic-task-billing.spec.ts` | **22 passed** |
| 底稿批次 | `workpaper-batch.spec.ts` 筛选异步缺款、原暂停/恢复和单击自动扣费 | **3 passed** |
| 底稿库收费边界 | `workpaper-library.spec.ts` 筛选禁用新版检查与旧模式幂等重试 | **2 passed** |

补充：异步缺款截图滚动位置调整后，单项复跑 **1 passed**。项目文件区提示改为“按已选募集书与文件版本检查；查看结果后可选择需要同步的文件。”后，重跑检查未开放截图用例 **1 passed**，并完成最后一次 Web 构建；未追加其他测试。API 编译过程中修复了新增测试载荷的 TypeScript 类型，最终编译通过。最初底稿支付 UI 测试因合成 fixture 缺 `/account/sessions` 而不能加载账号页，补全 fixture 后通过；不将该失败计作产品错误。

## 截图及原型差异

截图在 `audit-fixes/`：

- `subscription-account-1440.png`、`subscription-account-390.png`：无支付渠道仍显示订阅与积分，购买关闭。
- `subscription-account-prototype-1440.png`、`subscription-account-prototype-390.png`：同尺寸既有原型对照。
- `subscription-full-review-v3-1440.png`、`subscription-full-review-v2-protected-1440.png`：任务目录和原价保护。
- `workpaper-shortage-1440.png`：两个暂停批次中，只有缺款批次出现补款入口。
- `workpaper-check-unavailable-1440.png`：真实前端组件显示检查未开放，预览、下载和既有变更信息保留；内容及 API 回执为合成 fixture。

已查看账户 1440/390、缺款批次、检查未开放截图；账户窄屏测试无横向溢出。原型账户整体布局保留，新增历史报价折叠区承接原有深链接。旧原型中可执行的底稿批检查，在新版真实界面明确禁用：这是未完成能力的如实标记，**不代表与旧原型功能等同或付费批检通过验收**。
