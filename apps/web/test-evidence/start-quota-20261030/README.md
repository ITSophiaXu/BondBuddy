# 开始更新：临时拒绝后的原请求重试

## 改动与复现

基线为 `c6cc55c8521f31323d806744cf559351f3ad35fd`（develop）。浏览器按项目及固定输入生成稳定请求标识；API 曾把限额拒绝记录当作永久结果。合成账号的其他任务结束后，使用原请求重试仍返回 429。

新增的 PostgreSQL 回归在修改实现前失败：预期 202，实际 429 / `TRIAL_QUOTA_EXCEEDED`。修复后，精确匹配的限额、服务暂停、账号临时拒绝重新执行当前准入检查。原拒绝 job 保留，新的尝试追加 operation。已接受的请求仍返回同一任务，改变请求内容仍返回幂等冲突。

通过现有 `Error.field_errors` 的 `trial_limit` 字段传递白名单原因；页面在原提示区说明等待已有任务、稍后重试或次日再试，不展示服务端原始错误文字。无迁移、新依赖、费率或限额配置变更。

## 验证

- Node 24.22.1；独立 PostgreSQL 16 / Azurite 3.35.0，仅合成用户、材料和账务。
- `zz_trial_guard.test`：限额未解除时仍拒绝，释放后原请求可启动；并发重试只建立一个任务；原拒绝证据不变；服务暂停/账号限制解除前后均核验；变更请求内容仍冲突。
- `execute-quota-billing.pg.test`：拒绝没有目标 run 或新计费记录；余额不变；容量恢复后的并发重试仅一份任务计费记录，材料和输入版本复用。
- 相邻 API 测试：`direct-execute-admission.pg`、`billing.pg`、`billing-safety-integration.pg`。
- Web 单测 `api`、`execution-request`、`billing-task-recovery`：32 项通过。
- 公共契约测试：72 项通过；171 个公开及 12 个内部合成示例、4 个数据生命周期示例通过。
- Web TypeScript 与生产构建通过；沿用现有大包体积提示。
- 浏览器：桌面 1440×960 与手机 390×844 的限额拒绝→手动重试，以及暂时启动失败提示共 3 项通过。相同请求重试，输入仅保存一次。

浏览器使用合成 HTTP 响应，只验证前端交互；数据库测试验证真实 API 事务，不调用真实模型。没有把两者称为生产或模型端到端验收。

## 原型与画面

原型：同一基线提交的 `product-prototype/public/authoring-materials-entry.html`。

| 尺寸 | 原型原始开始区 | 修复后的拒绝状态 |
| --- | --- | --- |
| 1440×960 | [原型](prototype-start-1440.png) | [实现](quota-rejected-1440.png) |
| 390×844 | [原型](prototype-start-390.png) | [实现](quota-rejected-390.png) |

原型没有限额错误示例。改动使用既有 `#execution-message` 和“开始更新”按钮，不增加页面、步骤、确认弹窗或样式。手机提示自然换行，文字和按钮可见，浏览器点击重试通过。原型为无材料禁用状态，实现为已保存材料且被限额拒绝状态；余额、导航文字、自动保存提示和助手入口差异来自基线实现及合成状态，不是本次布局变更。用户要求修复启动失败；尚未获得本地集成版或生产验收。

## 复跑

先配置独立 `BB_TEST_DATABASE_URL`、`BB_TEST_AZURITE_CONNECTION_STRING` 并迁移测试数据库，再构建 contracts/API。执行：

```text
node --test --test-concurrency=1 apps/api/dist/zz_trial_guard.test.js apps/api/dist/execute-quota-billing.pg.test.js
node --test apps/web/dist-test/api.test.js apps/web/dist-test/execution-request.test.js apps/web/dist-test/billing-task-recovery.test.js
```

浏览器在 `apps/web` 启动 Vite，设置本地 `BB_E2E_BASE_URL`、可选 `BB_E2E_BROWSER_CHANNEL=msedge`、截图目录 `BB_START_QUOTA_EVIDENCE_DIR`，执行：

```text
node ../../node_modules/@playwright/test/cli.js test tests/project-execution.spec.ts --grep "quota rejection keeps|temporary start failure"
```

## 交付边界

这是已证实的启动重试缺陷。原生产错误编号尚未取得对应后端日志，不能将本次复现直接认定为该线上事件的准确原因。生产诊断命令仍只有 Accepted 状态，未为了取日志改变网络或服务。未在生产点击开始、改变材料或创建任务。

代码完成后交给开发集成及统一发布流程；尚未部署，线上原项目恢复情况仍待发布后核验。
