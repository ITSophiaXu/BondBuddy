# 普通关联文件检查逐份结算

2026-10-29。本地开发验收记录。全部项目、材料与模型建议为 synthetic；未调用真实模型供应商、支付渠道、生产账户或生产数据库。

## 行为与范围

在现有「文件一致性检查」页面，自动计费用户点击「开始逐份检查」即提交，页面不再要求确认金额。新批次最多 100 份普通关联文件，与已展示的标准范围一致。服务端固定募集书版本、选择修订号及各关联文件版本，按每份原报价求和，余额不足时整批不受理、不创建 child run、不冻结部分积分。

每份文件使用独立的 run 和 reservation，继续复用已有 worker、Word 交付及交付后结算。某份成功交付即结算该份，其他失败文件释放自己的预留。页面展示每份状态、已扣积分及原检查入口，允许仅重试明确失败、取消或未启动的文件；已成功文件不会再次调用模型、生成重复成果或扣费。底稿检查与既有文件生成／修订批次继续使用原链路。

旧 `/project-files/checks` 保留以恢复旧请求和读取旧任务，不重解释旧账。新批次的 `partial` 仅是批次聚合展示状态，没有向核心 run 增加 `partial` 状态。

## 价格、账务与恢复

- 迁移 `0152_project_file_check_batches.sql` 保存不可变 parent、逐项 manifest 与价格快照、每次 child attempt 及重试幂等请求。作用域 acceptance 允许原失败项在原 quote 关闭或过期后按已接受范围重试；范围／资产与已购覆盖仍须核实。
- 各项实际 `price_version` 分别返回，集合 `price_versions` 保留真实混合价版。parent `price_version` 只是恢复标签，取首个非零原报价版；全部零价时才取当前目录版。它不表示所有文件被重新按同一价版报价。
- 先锁项目与范围覆盖，再锁安全门与钱包。原批次双重试和同一用户另一个项目的新批次并发时保持一致锁顺序。
- 新 API 原生使用十进制 int64 字符串。POST 在 AJV 类型强制转换前检查 body，拒绝 JSON number、旧协议、重复项及超限范围，不经旧数字 wire 转换层。
- 浏览器按 owner＋project 使用 Web Locks；锁内重读持久化请求，超时或不明确回执只重放原 request_id。另一标签在读取原完成回执前不能覆盖未知请求。明确范围／价版冲突才清除未受理请求并重新报价。
- 积分不足保留原 body，用户可以前往订阅或充值，返回沿用原请求。浏览器无法可靠保存请求或不支持锁时不提交计费任务。
- 最近列表仅展示 30 批。持久化重试或完成回执若指向更早批次，通过独立 owned GET 读取原 batch_id；不会因为不在最近列表而丢失原失败项或创建替代请求。
- 迁移 `0155_file_check_batch_reuse.sql` 为零价重复检查保存 `reused_run_id`。仅复用归属、项目、完整 manifest 与 hash 全部匹配、未退款、Word 仍可交付的原成功结果；本批 `attempt=0`、`charged_points=0`，不创建新模型执行或积分预留。混合批次只执行新增付费文件。数据库同时禁止零价复用项插入 child attempt。缺乏可信原结果的零价范围明确拒绝受理，不能靠重复免费模型执行补出结果。

## 验证

1. PostgreSQL＋真实 HTTP＋Word：`apps/worker/src/ordinary-file-check-batches.pg.test.ts`，隔离克隆空库全量迁移至 0155 的 `bb_billing_complete_20261029_v3` 测试模板。最终 `completion/final-ordinary-file-worker-0155.log` 为 **8/8**（父测试 1＋子测试 7），0 失败、0 跳过。覆盖金额类型、101 份超限拒绝、余额不足不留行／预留、同键并发、单文件成功 Word 可下载及扣费、另一文件失败释放、原报价关闭后的失败项重试，以及两项目 create＋同键双 retry 并发。0155 新增的连续两次零价复用不创建模型执行／预留、已付＋新增混合批次仅执行新文件、原 Word 不再可用时拒绝免费执行均通过。
2. Edge：`apps/web/tests/ordinary-file-check-batches.spec.ts`，最终 `completion/task-refunds/browser-ordinary-file-check-batches.log` 为 **8/8**（18.0 秒），在最终 0155 构建后重启独立 Vite 执行。覆盖点击执行无确认弹窗、部分交付与仅失败项重试、双标签成功／未知回执均保持同一原请求、明确 409 重新报价、402 原请求补款、缺少 Web Locks 不提交、超出最近 30 批后的原重试恢复，以及原型操作／截图。
3. 父任务完成最终全 workspace 构建、空库至 0155 迁移，以及契约示例与 12 个计费契约测试。0155 与原结果复用逻辑经独立代理只读复审，无新增阻断项。其他全仓回归由父任务统一记录，避免共享 dist 并发覆盖。

早先 `final-ordinary-file-worker.log`、`final-ordinary-file-worker-correct-runtime.log` 是 Python 运行时误配期间的历史诊断，不能作为最终结果；本节仅以 `final-ordinary-file-worker-0155.log` 为最终 PG 验证。最终运行明确配置 `BONDBUDDY_WORD_PYTHON` 为本机已核实的 Python 可执行文件。

## 原型与视觉核对

沿用 `product-prototype/public/prospectus-panel.html?purpose=consistency&check-batches=partial`，增加同页面变体与本地模拟交互，没有新增业务导航。实现与原型均采用 1440×960、390×960 浏览器尺寸。以下截图均已目视核对：主要结构、每份结算文案与重试按钮一致，窄屏无横向溢出；成功受理后没有残留「正在提交」提示。

- `completion/task-refunds/ordinary-check-implementation-1440.png`
- `completion/task-refunds/ordinary-check-prototype-1440.png`
- `completion/task-refunds/ordinary-check-implementation-390.png`
- `completion/task-refunds/ordinary-check-prototype-390.png`

本记录证明合成数据条件下的工程行为，不代表真实专业成果质量、真实支付签约或已上线收费。最终统一验收待办由父任务发布记录管理。
