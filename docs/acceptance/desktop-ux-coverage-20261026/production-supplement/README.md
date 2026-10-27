# B1 补料采用与同任务续做（0139，本地验收）

暂停任务后，用户可在原材料区保存补料、核对受影响文书与现行整份追加价格，再明确确认继续。采用在原 run/job 建立 V2，保留原输入、已完成调用、旧工作字节与原消费。M1、M3、M4 的真实本地桌面链均完成新版 Word 私有下载。G03 / UX-A03 的本地合成工程验收通过；未推送、PR、合并或部署。

B1 为[用户确认的暂行规则](../../../product-decisions/2026-10-27-supplement-rework-b1.md)：需重做的每份文书按当前整份价格追加，未受影响不收费，逐笔明确确认后继续；积分系统重设计另行跟踪。这里的 production 指代码的生产授权通道，不代表运行在生产服务。

## 最终采用结果

| 选集 | 最终证据 | 结果 |
| --- | --- | --- |
| 空 template0 全迁移 | [migrate02](raw/migrate02-result.json) | 138 份迁移至 0139；空 runs/quotes，源码稳定 |
| 完整构建 / 最后 API 测试编译 | [build](raw/build-20261027T021032131Z-39180/summary.json)、[API build](raw/build-20261027T021945359Z-8924/summary.json) | contracts/API/worker/web 类型与 Vite exit0；最后只改测试环境设置 |
| adoption / 当前费用快照 API | [API](raw/api-20261027T022142158Z-32828/summary.json) | 15 pass，0 fail/skip，2121 文件稳定 |
| 相关 API 回归 | [regression](raw/regression-20261027T021159870Z-25640/summary.json) | 88 pass，0 fail/skip，2121 文件稳定 |
| 生产实际 worker | [worker](raw/worker-20261027T023055916Z-39712/summary.json) | 5 pass，0 fail/skip，2153 文件稳定；含最终供应商 fixture 默认行为复验 |
| 内部 worker 回归 | [workerRegression](raw/workerRegression-20261027T021247073Z-40652/summary.json) | 8 pass / 3 需 Linux contained 环境的跳过，0 fail |
| 公共契约 / 全契约检查 | [contracts](raw/contracts-20261027T021252284Z-14584/summary.json)、[check](raw/contracts-check-20261027T0213-final/raw.log) | 4/4，完整契约检查 exit0 |
| 桌面交互 / 采用恢复 | [mock](raw/web-mock-round3/results.json) | 37 pass，0 fail/skip/retry/flaky；24 文件稳定 |
| 真实本地完整主页面链 | [real](raw/web-real-round6/results.json) | 3 pass，0 fail/skip/retry/flaky；27 文件稳定；最终 test-only noEmit exit0 |

各选集独立采用，重复轮不合计。历史 15/15 业务旅程（主要 11/11、辅助 4/4）、G01/G02 与 662 个历史浏览器 pass 沿原范围保留；旧 662 未整套重跑。共享源码变化及历史证据关系见[覆盖审计](raw/final-coverage-audit.md)，最终补证结论见[最终采用清单](raw/final-acceptance.json)。本次 G03 独立通过，不另造场景分母；已登记桌面工程范围达到整体至少 90%、主要场景和功能全部覆盖。

## 直接证据与账务含义

三个场景的 assertions.json、wallet-five-stages.json、network.json、owned-cleanup.json 和截图分别在 [M1](raw/web-real-round6/authoring/)、[M3](raw/web-real-round6/review/)、[M4](raw/web-real-round6/m4/) 中。五个必需采样点为暂停前、安全暂停后、补料保存后、明确采用前和成功后；另有采用后的辅助点。每点真实 credits/balance HTTP 读前/读后相等，中间以单独 REPEATABLE READ 保存账户、lot、allocation、reservation、ledger、meter 和 head；HTTP 与 SQL 是独立事务，稳定工作屏障下夹取，不伪称共用 MVCC 快照。

reserved 对应公开 frozen；consumed 为本合成场景 settle 流水之和。暂停前尚未结算的合法 active_ms 可在暂停请求时结清，增量单独保存；安全暂停后保存/核价/刷新不改变钱包和流水。动态 B1 采用只新增独立 4500 上限，不冻结或预扣 4500；成功时新段实际累计扣 4500，旧段已扣不变，余额/lot/allocation/流水守恒。API 另外覆盖 carry/unbilled、原 policy 退休、新段失败独立退款、资金/现价/有效期、权限、并发与精确幂等。

上传的唯一 SYNTHETIC_…_ADOPTED 标记由合成供应商从真实材料文件字节读取，记录其 material/path/sha256；V2 实际浏览器下载 Word 的正文包含该标记，旧私有 Word 字节及 SHA 保持且不含标记。暂停中的旧 Word 尚未完整交付，因此其公开 descriptor 的 404 是正确保护；旧字节检查走准确私有测试读取，没有放宽公开授权。实际 provider、journal、prompt、请求准备、Word stages、交付与私有下载使用真实代码；供应商输出为明确的 synthetic 替身。

清空两个本机 journal 后刷新，从服务端 current 采用回执恢复，普通继续没有新增 quote、consent、adoption、fee 或第三次模型调用。旧 run/job 与初始 input/pointer 保留，当前 head 为 2；旧调用/成果登记/字节保持，新 Word 对应准确 V2。401/外账号 404、失落回执、跨页冲突等分支由浏览器/API 分别验证。

## 版本与失败保留

基准为本地 db7ffc95，变更与测试源码由本提交固定。0139 SQL SHA-256 为 98e64cd61beefddd9bd7888e4589c31ba05c19c999c30d36dabfbec351c4376b。[最后 API 构建差异](raw/final-api-build-delta.json)只含内部测试 TS/JS；[补证后差异](raw/post-fixture-production-delta.json)显示产品字节不变。Web 的 source-before/after（含 dist/assets）分别按 24/27 份校验。原 0137/0138 封存目录未修改。

初次迁移的语法失败、86/88 回归、worker 测试 sentinel 拼写错误、内部测试通道漏设、浏览器面板等待/中文编码设置均保留原轮。旧 real round1/2、mock round2 的失败由明确 test-only 修正后完整重跑替代。round3 的 37+3 通过仍缺五点钱包和材料内容传播，未直接拿来关闭完整卡。round4 的暂停旧稿公开 404 是测试读取前提错误；round5 复核业务与补证完成但清理 timeout，不计整条通过。最终轮保留 240 秒整体预算和全部业务断言，消费 HTTP 响应体、关闭已离开业务页的浏览器 context，并记录每个 app/fixture/owned DB 清理阶段；只有无在途业务请求或查询时才允许关闭自有闲置连接。各轮结果与清理诊断均在 raw 中，未抹去失败。

## 清理、封存和边界

[最终库审计](raw/final-db/database-audit.json)与[停止记录](raw/final-db/summary.json)核对专用 PG 的 PID17984、启动时间、可执行文件、data_directory 与 15542 端口；确认无自有测试 clone/其他客户端后正常停止。全部模板数据保留，包括成功至 0139 的空模板和初次迁移未完成模板。最终浏览器审计确认自有 5187/5199 服务关闭，不触碰其他集群。

raw 为逐字节副本，.gitattributes -text 防止换行转换；[manifest](manifest.json)记录本目录除自身外每份文件的字节数和 SHA-256，暂存后用 Git blob 再核对。运行脚本、原始日志、失败报告、源码清单、网络、钱包、清理和截图保留。[选择清单](archive-selection.json)列出排除的生成 Word、私有对象字节、worker 工作区、运行时 Python 及 trace；这些留在本机 .local，不进入仓库。

当前只支持 V1→V2 的一次补料采用，V3/再次补料未实现；原 UX-A03 未要求多次采用。起始生产 run/合成原稿/积分 lot 由测试夹具建立，本次桌面链从运行中暂停开始；没有声称重跑所有创建任务旅程。真实供应商/支付/Azure、Linux containment、Word/WPS 真客户端、专业正确性与目标用户理解、学习成本及留存效果仍属最终统一验收待办。
