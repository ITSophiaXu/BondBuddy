# M1 旧工作与补料续做请求准备：本地专项

本切片将真实暂停时捕获的完整 M1 文件结果、候选材料变化和固定要求交给当前生产编制 stage 共用的 prompt/workspace builder。**仅准备请求，没有采用补料、模型续做、V2、报价确认或补料后的新 Word；G03 / UX-A03 和完整 goal 仍 active。** 未推送、创建 PR 或部署。

## 行为与限制

- 内部 loader 按指定补料回执核对完整 source execution/input、请求 hash、准确暂停 checkpoint、同一 stage prompt 和唯一 captured result。HTTP 草稿响应与它复用同一冻结输入 reader、材料顺序和候选 compiler，不读取项目后来草稿，也不要求最新 receipt 替代明确选定的旧 receipt。
- 只接受同一完整且无 error 的 `codex-file-word-v1` 双稿结果。准确旧文件经现有私有读取器重新核来源、清理状态与字节，完整候选材料也核版本/hash/字节。选填 baseline 不成为必需项；拒绝的部分结果不冒充可恢复完整工作。
- 真实 M1 stage 和内部 preparer 共用 `buildFileAuthoringRequest()`。后者实际写 `previous_work/`、`continuation.json`、完整候选原材料、冻结知识及 `input.json`，不修改 V1 ctx/run/lease，不调用 model 或 collector。旧 clean 成为明确的本轮基线；旧 tracked/baseline 仅作回查，本轮新修订不冒充原始上传稿以来的完整历史。discard 分支保留候选自身基线。
- 固定要求复用现有准确 submission/version/hash 私有正文读取；后续消息排除，tombstone 后拒读，并保留既有 `bb_log_access_audit`。因此只能声明受测 run/job、回执、模型调用、账务和对象未因准备改变，不能声明数据库完全无写入。
- workspace I/O 前后重核边界、plan 和要求，实际输入副本全部列入原件 hash 校验。准备结果仍是数据，任何未来执行必须独立取得采用和执行授权；准备成功不能延长文件保留或越过删除权限。
- scratch 未保留，无法恢复任意中途章节。当前没有章节依赖图，请求如实要求结合完整候选材料保守复核全文；它不证明模型已进行增量处理。M3/M4 续做 workspace、追加报价/账务及完整桌面同任务续做旅程仍待完成。B 已选，B1/B2 公式未定。

## 验证与来源

采用轮次、命令、计数、失败及原始记录见 [summary.json](summary.json)、[verify.mjs](verify.mjs)、[raw-files.json](raw-files.json) 和 [manifest.json](manifest.json)。源码及实际 staged Git blob 的核对见 [sources.json](sources.json)。各组独立计数，不相加为用户旅程覆盖率。

| 最终采用集合 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| API 准备、候选输入、草稿及旧工作回归 | 161 | 0 | 0 |
| Worker 共享 writer 与真实请求准备 | 10 | 0 | 0 |
| Worker 原输入、暂停恢复与交付回归 | 20 | 0 | 0 |

contracts、API、Worker 构建和 web typecheck 通过。最终前后各 2,327 项源码、编译输出、Python 和配置冻结相等，snapshot SHA-256 均为 `405336f08ecffc3409d5af283bfa34b901265c2214b3120b25a749c09851fac7`。确切范围由 snapshot/verifier 明列，外部运行时和依赖包不在冻结范围；11 个变更源码/测试/package 文件另核对已测试原始字节与 Git 实际过滤后的 staged blob。

真实 PostgreSQL/HTTP fixture 经过 claim、准确模型结果登记、人工暂停和补料保存，再由实际内部 worker preparer 写工作区。旧稿是有效合成 OOXML，私有对象使用内存实现；未调用真实模型、Azure Blob、支付服务，也未处理客户文件。文件损坏/缺失、准确来源/候选 hash、暂停边界变化、调用方修改返回值、固定要求及后续编辑/清理均有针对性验证。普通 V1 stage 使用同一 writer，相关原输入暂停恢复与交付回归单独运行。

首轮 API 编译曾因测试 fixture 的 `Lease | null` 闭包类型失败；改为明确非空 lease。首轮新增 API/Worker PG 测试又因 fixture 的快照 redaction version 使用连字符而被既有格式校验拒绝；改成合法 `synthetic_v1` 后重跑。失败记录全部保留，未将这些轮次算成通过。

使用 `.local/report-postgres/data` 专用 PostgreSQL、loopback 15540、`bb_report_test` 和 `bb_execution_report_template_20261027`；准确 PID `18064` 的启动、身份、审计及停止记录在原始证据中。停止后确认无 PID 文件；数据库审计仅涵盖 verifier 明列的表，不推广到未列出的表。本专项没有浏览器、Word/WPS 视觉或专业内容验收，不增加既有用户旅程数。
