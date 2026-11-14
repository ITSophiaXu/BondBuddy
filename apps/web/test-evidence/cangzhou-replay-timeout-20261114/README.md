# 同材料 Copilot 回放：真实超时暂停页

这是实际本地 API / PostgreSQL / Azurite / Copilot 任务的状态证据，不是 synthetic API。运行候选 `ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1`，不含其后 #1343/#1344/#1345 补修；当前交付产品代码仍为 `b1cb4528dc8cbe540befe82dc8dbc7b5f625d3e0`。两者不能混作同一版本的真实模型验收。

- Run：`33985bce-0891-44df-b734-0186b0ca842c`；原三份材料和业务目标未改变。
- 2026-11-14 20:26:13 北京时间进入 `paused/provider_reconcile`，本轮 `MODEL_TIMEOUT` / `SIGTERM`，18,000,329 ms；无正式 Word、无可恢复快照、自动恢复 0。用量保留 `unknown`，重试预算使用 0，积分预留 `held`。
- 20:29–20:30 北京时间，Microsoft Edge / Playwright，1440×1100 浏览器视口，截图为真实状态卡区域。初次及刷新后同 run/input/state；5 步停在“编制募集书”，“保存文档”“可下载”尚未开始。
- “立即重试”可见且可用。另一次同源登录后的只读 `GET /api/v1/runs/{id}/retry` 返回 `mode=restart_materials`、`reason_code=restart_confirmation_required`，表示从原材料重新处理的确认入口，不能称为断点续跑。
- 页面验证：刷新 1 次，任务操作 0，拦截请求 0，页面错误 0；预登录 `/me` 的预期 401 单列。另行读取 retry DTO 的首次 PowerShell 登录漏 Origin 被拒绝，第二次会话未携带本地 Cookie 而 GET 401；均未发任务 POST。按现有验证器的同源 Cookie 方式读取后成功，不能把前两次调用错误算作产品缺陷。
- 根代理已逐张实际查看两图，标题、原因、按钮和步骤均完整可读，复制前后 SHA-256 一致。原型对照及新补修的 synthetic 四原因截图另见相邻 `recovery-capture-20261114/README.md`，这里不冒充原型验收或最新代码真实验收。

| 文件 | SHA-256 |
| --- | --- |
| initial-status.png | `e09f63705cad816b3d905680a30e3a848b162e2b6990684c9f170b808d89db07` |
| after-refresh-status.png | `e09f63705cad816b3d905680a30e3a848b162e2b6990684c9f170b808d89db07` |

客户正文、原件、完整模型日志、账号和私有数据库审计未进入 Git。此证据说明本次真实回放仍暂停；没有生成 Word，因此没有运行成功成果的质量/实际页数/下载验收。未点击重试、未回灌诊断副本、未重置账务或预算。
