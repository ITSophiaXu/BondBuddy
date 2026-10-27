# 内部采用补料后的 V2 Word 执行与交付

本轮基于 `5d1f3795d4ecd9c55bb924510dbcc719a0743392`，只实现 0135 精确测试授权之后的 worker/Word 闭环。原 goal 仍为降低学习成本和使用门槛、贴合文书专业人员的工作习惯、简化体验、降低流失并提高粘性；仅桌面端、跳过既有优化，整体业务场景至少 90%、主要场景和功能 100%。本记录不增加历史 15/15 旅程通过数，G03 和整体 goal 继续 active。

## 本轮行为

- 当前 V2 租约凭不可变采用记录读取原 V1 输入和保存工作，重新编译候选并核对准确输入、业务快照和 basis hash；普通当前输入读取仍拒绝历史 V1。
- 原 Word、模型结果和 prompt 保留既有内容锁、tombstone、purge_started 及长度/hash 核对；I/O 后再次检查准确新授权、实时时钟租约和材料可见性。已有完整工作与尚未调用模型的暂停分开处理。
- M1/M3/M4 实际 stage 和 collector 共用完整请求 bundle，保留原工作的来源以及 M4 linkedSource accessor。M4 先核对原保存方法再写 V2 checkpoint。逻辑调用名保持不变，调用编号沿整个 job 递增。
- 0136 要求新 prompt/artifact 显式携带执行身份。V2 artifact 身份包含执行输入，相同 Word 字节不会误占 V1 的成果身份。canonical 复核/M4 登记不覆盖 V1 legacy 行。
- 内部最终交付保存准确执行、完整成果成员和采用记录的新授权。历史来源读取不依赖当前 head；授权下载仍核对准确交付权限。
- 历史工作文件 inventory 与真实新写入的授权分开：已存在的准确结果可在撤权/删除后清理，新写入仍要求活动执行和有效新授权。
- 修复实际 M4 测试交付缺陷：正文和编制说明加测试标记后，使用同一份实际成品字节进行 promotion 与长度登记，避免原始长度和交付证据不一致。

## 验证记录

最终选集与采用方式见 [selection.json](selection.json)，完整命令在归档的 `verify.mjs` 和各轮 `summary.json` 中。

| 选集 | 最终采用 | 冻结 |
| --- | --- | --- |
| API 纯测试，6 文件 | 36 pass / 0 fail / 0 skip | 1,401 项一致 |
| API PG，17 文件 | 其余 16 文件的 151 pass，加修正后 6 项成果拒绝测试，共 157 pass / 0 fail / 0 skip | 两轮各 1,401 项一致；之间仅改该测试的 TS 和编译 JS |
| Worker 纯测试，8 文件 | 57 pass / 0 fail / 2 skip | 最终轮 2,171 项一致 |
| Worker PG，6 文件 | 31 pass / 0 fail / 4 skip | 同一最终轮 2,171 项一致 |

API 初始 PG 整轮实际为 **156 pass / 1 fail / 0 skip**，不冒称该轮全部通过。失败是旧非法 V2 写入测试期待 `bb_artifact_execution_exact`，0136 实际先以 `bb_test_successor_write_authority` 拒绝。只修该项准确约束名，保持 SQLSTATE 23514 和其余拒绝断言；该文件 6/6 复验后替换原来的同文件结果，重复通过不相加。两个 API 冻结之间只变化该测试 TS/JS；最终 API 冻结内容与最终 Worker 冻结中的相同路径全部一致，最终现存 2,171 项再核对无差异。

Worker 的 3 个新增跨平台 synthetic-provider 用例实际执行 M1/M3/M4 stage、请求构建器、collector、持久 journal、Word promotion 与 HTTP 下载：V1 Word 后暂停，保存并采用补料为同一 run 的 V2，在模型检查点后模拟崩溃，重新 claim 后交付新版。逐项核对新输入、job-wide attempt 1→2、无第三次 CLI、旧成果不变、最终 receipt 全部角色与新 grant、每个成员的下载字节/hash/文件名、异账号拒绝及撤权行为。M1 另以相同 V1/V2 Word 字节验证成果身份不会混用，续做基线为原 saved clean。

六项 skip 分别为新增的 3 个真实 Linux-contained provider 用例、既有 M3/M4 各 1 个 Linux symlink 用例，以及缺少 Azurite 的既有 test-channel Word 用例。它们没有计为通过；新增跨平台 provider seam 不调用真实 contained adapter，也未证明其 saved-prompt readback。

失败与修正单独保留：API reader 初轮遗留可 reclaim 的过期租约污染下一 fixture，恢复负例租约后 14/14 通过；Worker 首次统一轮为纯测试 42 pass / 15 fail / 2 skip、PG 31 pass / 0 fail / 4 skip，运行期测试源码有变，冻结不一致，因此不作为最终轮采用。9 项失败来自旧 fixture 缺完整 V1 lease，6 项来自 `BONDBUDDY_TEST_PYTHON` 未指向已验证运行时；只补测试夹具并补全三个 Python 环境变量后，完整 Worker 选集重跑通过。更早的 Worker 编译/夹具、Windows readonly、UTF-8 与 M4 实际长度问题记录在诊断 JSON；那些早期完整输出只留在工具会话，没有伪造为本地原始日志。

最终迁移文件 `0136_test_successor_word_delivery.sql` SHA-256：

`de66ed52a73121fb2f701504264af7f6d265b5600bcffdad1257830e206df3dd`

独立数据库 `bb_successor_word_final_20261027` 从 `template0` 创建，实际执行最终全套 135 个迁移文件，最新记录为 0136；0027 自身的原 seed 保留。没有依赖旧模板上的单函数补丁冒充最终整份迁移成功。

测试环境为本任务独立 PostgreSQL 16.14/15542、逐测试文件隔离 clone 及拥有的合成材料/Word/私有对象存储。Python 使用本机随应用提供的 3.12.14，`python-docx` 1.2.0、`lxml` 6.1.1；外部依赖运行时不在仓库源码冻结范围。

最终检查时仅剩两个已知模板与 PostgreSQL 系统数据库，没有测试 clone 或其他客户端。按最新核对的 postmaster PID 31792、完整命令、数据目录及 15542 监听归属，于 `2026-10-27T00:30:36Z` 优雅停止；`pg_ctl` exit 0，进程和端口监听均已消失。启动、迁移、最终数据库审计和停止记录分别封存。

证据以 gzip 保存，清单见 [manifest.json](manifest.json)。包含各轮完整日志/命令/摘要、源码冻结、选择与最终一致性脚本、135 迁移结果、独立审查、失败诊断、PostgreSQL 生命周期记录；清单记录原文件与压缩文件的长度及 SHA-256，归档逐份解压复核。旧 sealed archives 保持不变，不把本轮通过数加到旧 15/15 旅程、662 测试或整体 UX 覆盖率。

## 边界与剩余工作

用户已选择 B：“重做部分另行报价，确认追加金额后继续”，并于本轮明确先按 B1 执行：需要重做的每份文件按该文种现行整份价格追加，未受影响文件不收费。积分系统另行重设计。准确规则见[产品决定](../../../product-decisions/2026-10-27-supplement-rework-b1.md)；无需再问 B1/B2，但公开报价/金额确认及追加账务尚未实施，本轮没有新增收费。采用协议仍为内部测试 API，没有新增公共 HTTP 补料采用或报价确认入口。

本机可验证实际 stage、共享构建器、收集器、持久调用日志、Word 生成/登记及下载的合成 provider 路径；这与真实 Linux containment、真实外部模型、专业内容审阅和桌面完整用户旅程分别记录。缺少本机 Linux 隔离环境的项目不得计为通过。

G03 仍需要正式补料采用/追加报价确认流程、真实部署环境执行及完整桌面验收；整体 90%/主要 100% 尚未据本轮内部测试成立。未推送、创建 PR、合并或部署。
