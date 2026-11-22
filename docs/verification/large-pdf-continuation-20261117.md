# 大 PDF 续跑检查点与最终分页交接（2026-11-17）

Refs #994、#1324、#1339；Fix PR #1483。本文记录旧任务终态取证后补充的代码修复。自动化与合成结果不代表真实四材料已经交付双 Word。

## 原因与边界

旧隔离 run `1792b8a7-3c84-479a-a24f-f3b54c051998` 的五小时绝对窗口为北京时间 10:42:45.393–15:42:45.393。11 个原生进程 duration 合计 200.266 分钟，其余 99.734 分钟不在这些进程内，包含暂停诊断、构建、候选切换和启动/保存恢复；不能全算模型推理时间。

a7/a8 重复读取 input、知识和工作记录，已保存操作仍为 2。a9 使用 128k 候选时窗口只剩 126.638 分钟；a11 实际编制约 75.069 分钟，最终保留 2,111 项操作。a11 原始执行日志完整重读后，在 `item_633` 明确找到 `snapshot_current=true`、`operation_count=2111`、仅有 `WORD_PAGE_COUNT_UNAVAILABLE` 的 failed 预检，未带 `host_handoff`。随后 `item_638..653` 又读取工作记录 1–270 行，直至原 deadline 的 SIGTERM。旧文档中最后预检 `NOT_PARSED` 的描述已被这次完整重读取代；这仍不证明所有业务处理已完成。

原始 a11 日志 5,789,744 字节，SHA256 `cfb4d89e8dc7a0ba5960f8d818a3e3dbb290d9a961082dba0d083d39cc6af1da`。私有根因报告 SHA256 `06cca14de8dae5749741fa08b7f3c10e77da4b04d1270113171165f7be8ae858`。客户原件、原始日志和本地运行目录不进入仓库。

这是两个叠加问题：续跑入口依赖不断增长的自由文本工作记录；模型侧最终分页在 `/proc` 隔离下不可完成，却缺少明确的宿主交接。128k 自动压缩、延长 timeout 或已有文件均不能单独解决它们。原 run 已终态失败，不延长或重新打开。

## 有界续跑协议

新增 `bb_continuation.status/checkpoint` 固定 MCP，后端只调用随镜像发布的 Python 模块，无 shell 或模型提供的可执行代码。检查点保存在 `scratch/continuation.json`；提交不超过 4 KiB、状态不超过 6 KiB，绑定 `input.json` 实际 SHA、不可变 `input_hash` 和当前操作日志 SHA/操作数（直接生成则绑定两份 DOCX）。详细计算仍保留在工作记录，小检查点只保存阶段、具体下一步、待处理项和有界读取游标。

固定 CLI 0.169.0 的 `SessionStart` 在 startup、resume 和原生自动 compact 后，重新读取磁盘最新状态并通过 `hookSpecificOutput.additionalContext` 注入。原 Stop 完成控制继续独立配置和 hash 信任。旧 pinned prompt 的 runtime developer instructions 与 compact handoff 也指向这个小入口。缺少旧检查点仅提供工作记录尾部最多 2 KiB；状态不可用时继续有针对性地检查，不把整本工作记录当成必读启动步骤。

检查点写工具明确保持 `readOnlyHint=false`；仅这个固定工具采用无需交互审批的配置，避免后台 `approval_policy=never` 拒绝写入。不会因此开放任意 MCP、shell 或网络。字节超限、路径、输入冲突、来源变化等返回有界技术错误码，保留原检查点，不回显客户文本或原始异常。

材料按 `materials[].path`、知识按 `knowledge[].local_path` 对齐锁定 hash。路径必须为规范 POSIX 相对路径，拒绝 `./`、重复斜杠等别名。读取位置与完成声明始终为 `reported_unverified`；`current` 只表示绑定一致，不证明阅读覆盖、财务事实、编制或质量验收。

## PDF 页内游标

PDF `read` 的 offset 是单页分片 records 索引。检查点用 `page`、`unit=records`、实际响应 `mode=native/ocr` 和读取视图绑定记录，允许同一 PDF 多页以及 native/OCR 分别保存。仅传 mode 时只在固定缓存目录中选择唯一匹配缓存，并自动保存缓存路径、字节 hash 与引擎身份 hash；有歧义就报错，不猜测引擎。显式 view 可指定准确缓存，仍核对来源、页码、模式、数据 hash 和索引边界。

恢复只检查已保存的准确视图，缓存缺失、变化或引擎身份变化将状态标为 stale，不悄悄把旧 offset 绑定到新文字。分页未读完的 `next_offset` 继续保留；缓存存在不等于页面已读完，搜索没有命中不证明未 OCR 页不存在事实。

## 最终分页交接

沿用前次 #1339 选择性整合：固定预检重新核对当前输入、底稿和最终操作日志，且全部失败仅为 `WORD_PAGE_COUNT_UNAVAILABLE`，才给出绑定当前 operations SHA 的 `host_handoff`。预检仍 failed、退出 1。模型先完成剩余材料/事实/章节工作，再对最终日志预检、保存 `prepare_download` 检查点并正常结束；不等待沙箱内分页变成通过，也不通过杀进程伪造完成。

宿主等待正常模型结束并记录真实 usage，独立从锁定原稿重建双 Word、真实渲染并检查全部质量门禁及正文/页数 70% 下限。模型 handoff 或检查点不授权成功，不接受旧 hash 或混合错误。渲染故障继续既有基础设施重试，不调用模型反复改写正文。

## 验证和剩余验收

本轮验证结果以随后同一固定提交的准确镜像收据为准。真实 CLI 协议回归使用 loopback synthetic provider，验证 checkpoint 落盘 → 原生 129k 自动压缩 → 最新 SessionStart 状态/input+operations hash → status → 正常完成；不调用真实供应商。首次开发回归捕获了检查点审批配置错误，保留失败证据，修复后必须重新通过，不能跳过或削弱断言。

没有新增 SQL、公共枚举、业务计费规则或页面。2 MiB 请求保护、128k 文件窗口、恢复次数、原绝对 deadline、unknown 用量和宿主质量门禁保持。旧任务仍 `FAIL_NOT_DELIVERED`，财务成果 0/36、视觉 NOT_RUN；本轮不创建第三个业务 run，不改变线上 testlei 账务。Qx 不能替代 #1324 原 PPN、正式发布金样或 74 MB 全文任务的真实验收。PR、合入、部署和用户下载验收分别记录。
