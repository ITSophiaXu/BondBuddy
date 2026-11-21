# BondBuddy 中期超时修复：实施与验收

本切片实现已审阅 F01–F10，保留原 job、供应商调用 journal、租约、账务和 Word 质量门。新协议默认关闭。本轮提交 PR；合入、实际部署、真实业务验收分别记录。

修复对象是整篇单次执行、编辑返工、执行资源与网络收尾耦合、释放／恢复边界和诊断粒度。历史约 90 分钟的全部内部耗时仍未逐项归属，不能把未归属时间算给 DeepSeek，也不能承诺固定节省分钟数。

## 新链路

```mermaid
flowchart LR
  A[原 job 与锁定输入] --> B[解析及材料快照]
  B --> C[冻结章节与批次计划]
  C --> D[有界调用与可信编辑]
  D --> E[私有对象回读及游标提交]
  E -->|未完成| D
  E --> F[收尾清单]
  F --> G[停止并证明原 task 已空]
  G --> H[释放原 token]
  H --> I[收尾取得新 token]
  I --> J[全文质量与私有下载]
  J --> K[原账务结算]
```

每次模型调用另有子 cgroup。调用封闭且原生进程为空后，Node 在同一持久卷封存原字节，再登记原 session 捕获证据并释放物理模型许可。外层 task 保持开放，下一章可以建立新子 scope；整个 pipeline 退出后才永久封闭外层 task。子 scope 证明不能代替 job 释放证明。

## F01–F10 对照

| Fix | 实现入口 | 验收重点 |
|---|---|---|
| F01 | `workflow-authoring*.ts`、`queue.ts` | 冻结 plan；稳定 logical ID；对象提交和游标原子写；累计预算 |
| F02 | `workflow-input.ts`、`unified-input.ts`、`workflow-coverage.ts` | 私有快照；材料／响应／OCR配置与页引用绑定；缓存复用；covered/failed/missing |
| F03 | `fixed_edit.py`、`workflow-controlled.ts`、`committed-editor-files.ts` | 请求 hash 重算；幂等；版本／锚点拒绝；独占锁和唯一 manifest commit；完整对象恢复 |
| F04 | `task-execution.ts`、`codex-adapter.ts`、`durable-spool*.ts` | timeout/cancel/失效保全；sealed-empty；同卷 fsync 接管；补传有界；保留未接管原目录 |
| F05 | `run-pipeline.ts`、`lease-outcome.ts`、`runtime.ts` | handoff/pause 保留释放责任；原 session/token proof；移交不增加失败；无关任务可继续 |
| F06 | `execution-capacity.ts`、`0199`、云 `policy.mjs` | 占槽 phase 持 token 时不变；SQL／旧 consumer 不能绕过；扩大节点须预算 revision |
| F07 | `queue.ts`、worker／ops 恢复调用方 | 五类恢复共用安全门；对象／停止／原输入／取消／费用核对；准备阶段崩溃接续 |
| F08 | `unified.py`、`file-authoring-stage.ts`、新版收尾 | required 批完整；稳定 block ID；PDF可信重建；固定日期；全文质量／下载／账务门 |
| F09 | 原 trace + 新 chapter/call/persist/commit spans | 排队、执行、工具、捕获、上传、提交和收尾可区分；无证据的区间保持未归属 |
| F10 | `0199/0200`、ACL/preflight、restore、Docker/Compose | 追加迁移；最小权限；旧 epoch 隔离；专用恢复；固定 helper/image/tree；持久卷 |

### 计划、上下文与预算

DOCX 从已锁定原稿的有效一级标题划章，前言和附属 story 纳入 stable node 分母。确定性拆批最多 12 个原节点、18,000 字符及 96,000 字节。大表格／行／单元格聚合节点用 scope-only 描述、完整 hash 锚点及行组引用，其全部子段落仍逐批覆盖；编辑器核对当前完整文字 hash 后生成完整 canonical 操作日志。单一超大文本及复杂 OOXML 保留明确资源边界，不截断后冒充读完。模型只输出数据，宿主构造固定编辑请求，支持替换、批注、段落、表、行及报告期列。

PDF／兼容无原稿路径先执行一次 journal 记录的 outline 调用，核验已 pin 目标结构后冻结。outline 是结构计划，不是事实确认。新任务参考稿必填和不可变输入规则保持。PDF 原字节及 hash 保留；可编辑重建稿不声称保留 PDF 版式或伪造历史修订。

材料及知识正文保留在私有 hash 快照和有界只读工具中。计划存 corpus 指针，引用验证使用快照内真实记录集合，避免每批复制全库引用。corpus 指针不能作事实证据。OCR failed 只来自明确失败结果；没有明确结果的未成功页是 missing。局部缺项在工作稿中保留具体待确认标记，DOCX 用宿主批注呈现。

单调用初值 20 分钟，实际取其与原 run 剩余 deadline 的较小值。run 配置初始化前固定，切章／重启／转收尾不归零。显式 token 上限叠加原账户／供应商／收费许可；未知用量阻止继续调用。修补每批最多 2 个 revision，整个 run 累计 5 分钟；预约和 deadline 同事务保存，耗时按 logical call 幂等累计。初值需真实金样校准。

### 槽位、安全恢复与发布

新版 mixed authoring service 开两个循环：1 个编制、1 个收尾。登记同时包含 authoring/postprocess 及 protocol 1，数据库 phase policy 为准入权威。旧任务继续旧协议，不能在已有旧模型执行时半途切换。

提交下一 phase 时原 token 和原占槽 phase 仍保留；原 task 封闭、renewal 退出且真实 release proof 通过后，收尾才能领新 token。pause/cancel/fail/success 同样不提前清旧责任。移交不算失败，真实失败按 phase 累计。

数据库恢复隔离旧 epoch／账户，保留 token/holder 和未知调用，不自动启动 worker。普通 evidence resume 不能解除隔离。专用恢复核对独立调用／账务证据、原环境停止收据、精确 node/epoch/job/token 和私有对象，再逐账户、逐 job CAS 接续。lost intent 不能改成 not_sent。详见恢复 runbook。

弹性 authoring-state volume 承载 attempts/spool/workflow，镜像初始化 UID1000 私有 0700 目录。补传每次最多 120 秒，每轮最多 3 条、累计 5 分钟，失败持久退避。低磁盘、未封存和未接管阻止该容量新领取；已安全封存的待补传不停止其他 job。drain 等待未履行的持久化责任，不能删除 volume；远端核验前仍存在物理磁盘丢失窗口。

新版正常链路的解析缓存、prompt、调用 journal、章节、Word 和质量报告也经过统一有界对象 IO。SDK 在最小凭据的独立子进程中运行，每次最多 120 秒；超时后强制终止并等待进程退出，才向调用方返回失败。该边界防止存储请求卡住后继续无界占用执行任务。私有对象写入仍须读回核对字节和 hash，失败不提交章节游标或成功终态。

开启顺序：固定 tree 构建并验质量门 → 追加迁移／ACL → 核对宿主 helper/profile、镜像、登记收据 → 配置真实预算与持久卷 → 启用匹配 DB phase policy → `BB_WORKFLOW_V1=1`、`BB_WORKFLOW_PHASE=mixed`。不一致即拒绝启动或领取。回滚先关闭新准入并排空新版任务，保留 checkpoint/spool，不能让旧 consumer 接新版任务。

## 验证与发布边界

定向验证覆盖 B01–B05、Python 编辑／长稿／授权原稿、V2事务／性能、writer、phase SQL、恢复隔离、原生 scope、补传和真实 PG 合成章节链路。实际命令、计数、独立审查、未执行项见 PR 验收报告。

合成模型和本地对象 fixture 只证明工程链路。发布仍需固定镜像实际 enforce profile、真实 DeepSeek 金样、完整渲染／私有下载／账务、混合负载与 canary。1000 付费用户不是 1000 并发任务；以到达率、实测占槽时长、queue p95 和尾部时长算供给。

本地旧 file sandbox 镜像为 Codex 0.167.0，与生产 0.169 基线不同；原 5 例和新增例均在 named permission prerequisite 处拒绝。不得冒充业务红／绿或生产安全验收，也未修改生产安全配置来通过测试；该限制在 PR 中保留。
