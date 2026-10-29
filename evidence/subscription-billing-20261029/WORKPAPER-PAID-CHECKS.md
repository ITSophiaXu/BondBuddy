# 底稿逐份检查与批量计费验收

2026-10-29。本文记录本地开发与合成验收；不代表已上线收费或真实模型质量评测。

## 交付范围

- 迁移 0138：同一项目内按完整目录身份（sheet/title/path/code-or-title）形成文件 family。跨批次重新生成是独立不可变版本；每个批次项固定绑定原交付版本。维护修订保留原文件和真实 Word pin，库/预览/ZIP 使用该批次分支中实际采用的版本。
- 迁移 0139：`workpapers/check-batches` 的一个父请求包含固定源版本与明确目标清单；每项均有独立 `project_file_v1` run、check scope、reservation 和原 credit-lot allocation。启动事务核验整个总额；任一不足则不留父请求、子 run 或冻结。每份成功交付独立结算，失败独立释放。
- 保留单份与“检查本批底稿”入口，先在原页面列出份数、排除项及积分总额，一次业务点击自动执行。没有逐单金额确认弹窗。
- 新版检查沿用既有 check SKU 与生效的 1.7 价表，不发明底稿检查 SKU。已有有效付费维护、原范围修订及同范围复核沿用既有权益；新来源或新目标版本重新报价。父请求使用当前自动价表，每项保留其历史权益版本，允许旧 0 分项目与新付费项目并存。
- 余额不足通过现有钱包恢复机制保留父请求原 key、版本、报价和总额；支付返回只重放该原请求。历史批次/逐份结果链接可查看原委托范围、检查和修订。
- 默认普通项目文件批量检查不混入底稿。单份底稿历史的“重新检查”明确指向同 family 当前版本；多份底稿必须经逐份独立结算的父请求。
- 未生成/无真实可交付 Word 版本的项不纳入收费。对象存储中的不适用说明没有伪造 artifact pin，继续保留原说明预览和下载。
- 底稿使用完整 Word 提取，包括页眉/页脚/附注。主机核验覆盖全部非空段落及可定位结果后记录不可变 coverage evidence。图片/嵌入内容未能完整读取、空文件或段落覆盖不足均不能成功结算。非正文差异保留人工项，不错误承诺正文修订器可以自动处理。
- 自动计费模式下，原免费目录源差分路由只保留历史幂等重放；它的批次汇总报告不充当收费的逐份一致性成果。

## 验收状态

root 统一构建 API、Worker、Web 成功后，固定产物联跑 **18 通过 / 0 失败 / 0 跳过**，其中 **2 条业务主测试**，另含两份文件各导入的 8 条 catalogue 辅助测试。日志为 `completion/workpaper-worker-final.log`，本次产物 SHA-256 为 `completion/workpaper-build-hashes.json`。

新底稿浏览器 **5/5 通过**（root 的最终 42 条浏览器组内），历史 v1 混合计费 PG **1/1 通过**（经济审核代理独立运行，root 统一编译）。环境为 Node 26.13.0、隔离克隆 PostgreSQL 模板 `bb_billing_complete_20261029`（迁移到 0143）、本机打包 Python；浏览器由 root 使用 Edge 验证。

原 legacy library 之前发生一次 `needs_update` 数量 1/2 的失败，独立复跑及最终固定产物联跑均通过，原因未证实；不将其归因于未经证明的构建状态。

业务主测试：

- `apps/worker/src/workpaper-paid-checks.pg.test.ts`：真实 Word 生成/提取/交付、批量不足原子性、逐份原 lot 冻结、部分成功结算、完整覆盖与未读图片失败释放、原范围维护、修订回写、source CAS 未采用版本保护、换源新价、同 key 重放、同目录跨批次版本及 owner 隔离。
- `apps/worker/src/workpaper-library.pg.test.ts`：原 legacy 库/预览/ZIP/来源变更历史兼容。
- `apps/api/src/workpaper-legacy-checks.pg.test.ts`：合成历史 v1 已结算凭据与新价混合；由另一审阅代理维护测试与验收结果。
- `apps/web/tests/workpaper-paid-checks.spec.ts`：桌面/移动范围总价、独立结果链接、原父请求不足恢复、精确单份、新版本历史重查（共 5 条）。

两份 Worker 文件分别导入 8 条 catalogue 辅助测试，因此联跑总数 18 含 2 条业务主测试与 16 次导入辅助执行；不能报告为 18 个新增计费场景。所有材料和模型结果均为明确合成；未调用实际 DeepSeek 或真实支付渠道。

## 本机恢复的既有运行依赖

本 worktree 最初缺少被忽略的 `knowledge/workpaper-templates/2026-10-27/`，导致旧流程和新流程都在生成不适用说明时因 `catalog.json` 不存在报错。已从本机既有 `C:/Users/lezhai/Downloads/Bondbuddy/template-fidelity-20261029/knowledge/workpaper-templates/2026-10-27/` 复制格式模板，复制前逐份验证 catalog 中 147 个 `Rxxx.docx` 的 SHA-256，未引入原客户材料。

catalog SHA-256：`6cc92386e74373c6f2234294820f082e9b14d8d3adb4fea80fbc73f68d522660`。

部署打包须携带该既有格式模板目录并校验完整性；`deploy/m1/Dockerfile` 已有该目录的 COPY。模板缺失不能靠合成 pin 或假交付绕过。此处本机恢复属于测试与部署依赖准备，不是付费模块业务代码失败。
