# #1604：募集书输出额度耗尽后保留进度（2026-11-18）

[原问题与真实失败证据](https://github.com/ITSophiaXu/BondBuddy/issues/1604)。验证源码 `3b9a811ce0c9842e7ced70d9d7167e05fd48096b`，基线 `8fe1328f`。本次全部新增回放是 **synthetic**，不调用外部模型、不重跑旧客户任务、不部署、不签发发布凭据。

## 修复与边界

- 仅有快照能力的 `file-authoring-v1` 和 `file-authoring-size-repair-*`：最近一条正常接收完成的 `/responses` HTTP 200 SSE 明确 `response.incomplete/max_output_tokens`，且固定 CLI 同条失败、正常退出 1，才记为内部 `MODEL_PROVIDER_OUTPUT_LIMIT`。不会仅凭 HTTP 200、输出计数、stderr、旧终态、断流、压缩或不可解析终态授权新发送。与本地输出字节上限和 HTTP 413 分开。
- 进程退出后、清理前保存这一段实际落盘的工作区。核对完整快照、不可变观测、输入、原截止时间和积分预留后原任务续跑，复用 2 次/逻辑调用、6 次/run 的故障恢复预算。先前未知用量保持 unknown；没有完整本次快照、输入冲突、取消或未知结果不会自动重发，不重新打开历史失败任务。
- 同一逻辑调用后续用小批次续编；受控固定编辑多项 apply 最多 12 项/32 KiB，超限不改已有日志。不拆坏单个原子结构操作：可先分段写入本地片段再组装提交。输入 HTTP 预算、模型输出上限、原材料范围和 Word 质量门禁不变，无 SQL 迁移、新公开枚举或新的计费规则。
- 对账不可安全续跑时保存准确原因；现有编制进度卡展示说明，不新增步骤、按钮、下载或收费行为。参见[网关运维手册](../runbooks/model-gateway-measure.md#预算和失败行为)。

## 定向验证

| 环境与命令 | 结果与范围 |
| --- | --- |
| Linux arm64 / Node 22.23.5，`npm run build`、`npm run check:contracts` | 全仓构建通过；契约 72 通过、0 失败/跳过；182 公共、12 内部及 4 生命周期合成示例通过。 |
| Linux / 隔离 PostgreSQL 16.15，`npm run migrate:api`，`node --test --test-concurrency=1` 执行 worker 的 `file-authoring-payload-recovery.pg.test`、`unified-timeout-recovery.test`、`provider-reconcile-sweep.pg.test`、`file-authoring-format.test`、`file-authoring-recovery.test`、`file-authoring-instructions.test`、`codex-adapter.test`、`codex-file-output-limits.test`、`model-gateway.test`、`codex-exec-log.test` | 163 通过、0 失败/跳过（最后一个同源测试增补前）。包括双并发、共享故障重试额度、与上一段快照混淆、非终态、不一致终态、未授权的续跑确实阻断，以及现有 Word 质量验证。 |
| 最终测试增补：Linux，`npm run build -w @bondbuddy/worker`；`node --test apps/worker/dist/codex-file-output-limits.test.js` | 39 通过、0 失败/跳过；包含真实子进程写入→合成 SSE 输出耗尽→退出后实际保全文件→只有已审计的第二段恢复并读回，旧用量不变。不和上一行重复相加。 |
| Linux `network none`，固定 Codex 0.169.0，`node --test --test-name-pattern 'real Codex: provider 413\|real Codex: HTTP 200 response.incomplete' apps/worker/dist/model-gateway-codex.test.js` | 2 通过、0 失败/跳过；真实 CLI 对本机 synthetic SSE 产生准确 JSONL；真实 CLI 的 413 防护仍只转发一次超限失败请求。CLI 来自官方包，SHA512 对照 Dockerfile，binary SHA256 `3bb41c9a80187773e2a59278d4fc355b1a163c31bb5a79581e37d4fe428af047`。 |
| Linux 断网，`PYTHONPATH=python python -B -m unittest discover -s python/tests -p test_fixed_edit.py` / `-p test_continuation.py` | 59 + 33 通过、0 失败/跳过；超限不改日志，分批后保留旧编辑并重放实际合成清洁版与修订版。 |
| macOS / Chromium（Chrome），`npm test -w @bondbuddy/web -- tests/project-execution.spec.ts --grep 'output exhaustion\|provider timeout explains'` | 2 通过；合成 API，无重复提交、同一 input、出现已知原因或恢复正常进度。 |

Linux 使用已有 worker 的 Node/Python/LibreOffice 环境、当前源码和当前锁文件依赖。初次容器 `npm ci` 在下载完成多数模块后无进展，停止该容器；使用同锁文件在宿主安装的模块配合已经提取的 Linux 原生模块完成构建。不是生产发布镜像检查。macOS 较广适配器套件初次出现 Darwin 自动注入 `__CF_USER_TEXT_ENCODING` 导致既有环境断言失败；同断言在上述 Linux 全通过，未放宽。无真实供应商用量、真实原材料或用户业务验收。

日志 SHA256（完整日志保留在本地）：

- build：`cf0fd1fe2da8993de87115407c6fd4da889514f974bbf96a297a95ee70c93ecd`
- contracts：`6993430fe29d6e0076b5accfd99bfae034aac522c8ba91345e0a4ff4b88ebb82`
- worker/PG：`7eb37fd05bef5ff6824f5adf2ad2b78de878183088c5485135514630764236e3`
- final snapshot：`687cd6584c3a249a587251ec6f082ec53ed2239e8cf9c49025571a8484473799`
- pinned CLI：`4e5b76f8c35f8e757eda873e3bf7f90f85925cf365bafe573fe20dfc236684d7`

## 进度页原型对照

原型：[authoring-live-progress.html](../../product-prototype/public/authoring-live-progress.html) `?state=paused`，commit `8fe1328f`；实现：[project-execution.ts](../../apps/web/src/project-execution.ts)，源码 commit 同本文。均为合成项目。按原型沿用原进度卡、五步编制位置及锁定材料；只新增现有说明区的原因。原型演示的是用户主动暂停（可继续），本修复沿用现有供应商系统暂停（不可手动重发），不增加控件或改动原型。

| 同尺寸 | 原型 | 实现 |
| --- | --- | --- |
| 1440 × 960 | [桌面暂停](1604-screenshots/prototype-desktop.png) | [桌面输出上限](1604-screenshots/output-limit-desktop.png) |
| 390 × 844 | [移动暂停](1604-screenshots/prototype-mobile.png) | [移动输出上限](1604-screenshots/output-limit-mobile.png) |

**最终统一验收待办：** 在已授权、固定发布候选上，用沧州同一锁定的原始材料及实际配置跑完编制；核对续跑后按原任务交付，通过财务/内容/实际分页核查并下载双 Word。未把既有失败 run 标为成功，本次不部署。
