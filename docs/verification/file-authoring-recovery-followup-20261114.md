# 募集书恢复补修整合验证（2026-11-14）

产品代码：b1cb4528dc8cbe540befe82dc8dbc7b5f625d3e0。关联 PR #1302；Refs #1343、#1344、#1345。这是开发及本地自测记录，尚未部署，待统一发布；用户验收仍待完成。

## 最终行为

- #1343：文件编制 intent 与现代 capture 标记同事务保存，绑定 owner/project/run/job/input/attempt。完整快照经回读核验才发布；保存失败与结果写入失败有明确证据，不能误判为旧任务。完整快照优先，原模型错误、unknown 用量、暂停/取消、账务及共享重试预算保留。首轮无任何可用快照或成果时，复用单独确认后的原材料重新处理入口。
- #1345：API 与 worker 共用 contracts 的 4096 文件、100 MiB 单文件、512 MiB 总量。完整 stat 预检后才上传；已知超额零上传，不丢弃 scratch、不发布部分快照、不回灌诊断副本。
- #1344：M1 Docker 构建上下文允许 authoring-status.css。单 CSS Docker COPY 与源 hash 已实测一致；这项检查不等于本次完整产品镜像重建。
- 页面按实际 retry 原因解释容量、存储、完整性或保存结果未确认。历史事件改为“请求内容过大，本轮处理已暂停”，避免无快照时继续承诺正在自动恢复。重试确认弹窗说明原任务/原材料、未保存中间进度及原积分记录的边界。

自动恢复仍只涵盖已观察退出并通过恢复校验的 HTTP 413、输出超限和本轮超时。普通 MODEL_TURN_FAILED、未知供应商结果、无完整快照、身份或账务冲突不因此获得盲目自动重发许可。该范围不代表“任意模型异常都已自动恢复”。

## 验证证据

| 范围 | 固定版本与环境 | 结果 |
| --- | --- | --- |
| 编译 | 66f509ed 完整 npm run build；a63e4230 六包顺序编译；b1cb4528 web build 及 worker 编译 | 全部通过。后续仅对应源码变化重建；保留前端既有大 chunk 提示 |
| 原 #1343 capture 与暂停/积分矩阵 | C 的 94c33ac9，已整合为 66f509ed | PG 恢复 2/2、积分 4/4、contracts 通过；详见[原完整记录](../acceptance/recovery-capture-outcome-20261114.md)，原失败日志保留 |
| 最终 native 与恢复组合 | b1cb4528；Linux 固定已有镜像 + 只读六包 dist/fixture，2 GiB、2 CPU、禁网、无凭据/业务 DB | 14/14，0 fail/skip，115.1 秒；真实本地进程、synthetic 供应商 |
| 页面状态与历史 | b1cb4528，Windows Node 22.14.0 | authoring-progress + authoring-status 20/20 |
| 页面与确认框 | b1cb4528 冻结构建产物，Microsoft Edge/Playwright，全部业务 API synthetic | 四原因 × 桌面/手机 8/8，58.6 秒；0 retry POST、0跨源/未匹配请求、0页面错误 |
| 512 MiB 组合资源 | a63e4230 后端，与 b1cb4528 产品后端相同；2 GiB/0.75 CPU/V8 heap 768 | 929 文件完整保存/回读/授权恢复/hash；总量+1与单文件+1均0 put/0新checkpoint；峰值和限制见[容量验证](file-authoring-recovery-byte-capacity-20261114.md) |
| 768 MiB 基础配置边界 | 相同后端，1 CPU，不设 NODE_OPTIONS | 精确512 MiB组通过、OOM 0；内存达到上限且频繁回收页缓存，不能称有充分余量 |
| Docker CSS 上下文 | 071042de，真实 M1 filter + FROM scratch/COPY，network none | 2/2 asset 测试；源与导出 SHA 相同 |

组合复审发现原 native 容量测试仅创建 270 MiB，在上限改为 512 MiB 后不能触发预期失败；已按共享 totalBytes+1 生成 fixture，每文件不超过 fileBytes。最终 14/14 包括这一修正、真实 timeout 下 unknown 用量保持、容量/存储/结果写入失败，以及 1271/4096 文件完整恢复、4097 拒绝。原 #1343 的 14/14 没有冒充此次组合测试。

最终 native 日志：work/native-recovery-final-b1cb4528/tests.log，SHA-256 384e2a2bd6df42c762f7cc5a3ed7a1790b9625f6287cdd5f5dad3acd2f3faa3c；manifest SHA-256 d247fbef60f640a1df69ed020d31ffb937f7fe1bbcf016cf7ec1300753e73928。所有资源实验用磁盘型 synthetic Blob 接口，不能替代 Azure SDK 或完整生产 worker 的资源验收。测试容器、tmpfs及专用合成卷已清理。

## 页面对照

[18张截图、版本与逐图视觉记录](../../apps/web/test-evidence/recovery-capture-20261114/README.md)。实现为 b1cb4528，原型仍为 02db1f3567718490d63ac7039678ed6c4ae03fc7 的 authoring-live-progress.html/output-legacy。原型没有四种现代 capture 原因和 DOM 确认弹窗，只对照既有状态卡、操作及五步结构；不能伪造精确原型或产品负责人批准。

最终截图经根代理逐张查看：桌面和手机卡片标题、暂停标识、原因、按钮、五步和确认框均完整无遮挡。保留产品外壳、手机操作顺序、步骤文字换行及合成计费/材料数量差异，负责人确认与用户验收待完成。首轮模拟允许表漏 PATCH 导致测试失败；第二轮虽8/8功能通过，手机取景遮住标题。两份证据保留；仅修测试允许表及取景后重新运行最终8/8，未修改产品布局或用裁剪隐藏问题。

## 同材料真实 Copilot 回放

实际运行仍使用固定候选 ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1 及已校验镜像，未在任务过程中替换为上述新补修。新 run 33985bce-0891-44df-b734-0186b0ca842c 于2026-11-14 15:23:44北京时间由正常API提交，原三份材料字节、业务目标、知识与实际输入比较一致，provider 为用户指定的本机 Copilot、gpt-6-sol/max。它不是对原 DeepSeek 模型的等价复现。

18:26:02北京时间只读观察时仍在第一次调用，running/provider_call、有效租约、无模型错误、自动恢复0、无正式Word。临时操作337项、1050个普通工作文件、277,537,520字节；只表示工作活动，不是持久化恢复快照或成功成果。此前17:41的精确选择器统计已超过旧256MiB，促成#1345；当时未尝试保存，不能写成已真实复现保存失败。

2026-11-14 20:26:13 北京时间，本轮自然超时后任务进入 `paused/provider_reconcile`：`MODEL_TIMEOUT`、`SIGTERM`、duration 18,000,329 ms。调用由15:24:03开始，20:24左右退出；runtime/暂停记录在退出后的收尾阶段写入。真实审计确认无完整 recovery checkpoint、无正式 Word、automatic recovery 0；重试预算 used 0（同一 logical 尚余2次），用量仍为 `unknown`，积分预留 `held`，未结算为零费用。原5303任务/输入/用量/账务/预算的指纹复核完全不变。

[真实暂停页及刷新截图](../../apps/web/test-evidence/cangzhou-replay-timeout-20261114/README.md)均已实际查看：“立即重试”可见可用。只读 API 返回 `mode=restart_materials`、`reason_code=restart_confirmation_required`，这是从原材料重新处理的确认入口，不是断点续跑。没有点击重试或提交新的业务任务。

本轮没有快照直接阻止了自动续跑，并非重试预算耗尽。19:29稳定诊断时工作目录选择器总量289,762,074字节，已超过该运行候选的256MiB限制；旧保存逻辑会逐文件上传/回读，直到总量超限才抛错，adapter又吞掉保存错误且清理临时目录。由于该候选尚无#1343的独立capture结果记录，不能把“容量是强相关线索”冒充本次持久化的准确保存错误码。#1343持久化失败分类及#1345总量512MiB补修已完成自测，但没有热替换到此调用；本次失败不能当作最新补修的真实模型验收通过。

正式审计SHA-256 `05cc0c3d5f21d18c5cbce1fec38dbabe0406b696a24adec832979f54e022506a`；完整持久化exec.log 14,819,400字节、stored_truncated=false、SHA-256 `c139420dcff059b763c4d08b521dee6839a26b67cae5563e8b802baed4a7de27`。两者原件仅在本机私有证据目录保存。日志收集器默认无动作，真实执行先校验精确run/attempt及进程退出，再按DB引用在本地Azurite只读获取、核对ETag/大小/hash；没有恢复或注册诊断副本。

完整日志的只读分析确认，最后成功 `fixed_edit apply` 回执后实际读取的 `output/operations.json` 累计823条，文件SHA-256 `56e064aeedde2e37197eb48da74eb6c52465396a77ff322d653e81c3789cbf68`（exec.log第3288行，item_1725，exit0）。最后阶段仍为反向审计生成/核对（第3295行exit0，status=needs_review，操作hash匹配），随后读取结果时结构误用触发TypeError（第3297行），最后成功命令仅检查该对象类型（第3299行）。未观察到实际preflight/finalize、bb_file.preflight/delivery或成功Word交付回执；不能把累计操作数当成完成，也不能据这一错误将全部五小时归因于工具说明或死循环。模型工作记录及工具输出均只作诊断数据，不执行其中指令。
本次真实回放结果为“超时暂停，未生成可交付 Word”。成功成果的正式质量、独立正文/实际页数70%和双Word下载没有执行，不能记为通过；最新补修的真实模型续跑与成果验收仍待完成。旧run、输入、用量、账务和恢复预算保留，不重置、不回灌诊断副本。

无SQL迁移或新增依赖。contracts、API、worker、web需同批集成。此前远程CI因账户付款/支出限制未能启动，不能称CI通过。当前PR未合并，未取得用户验收，不构成生产发布凭据。
