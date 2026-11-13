# 渐进底稿 API / 数据库自测

测试环境：本机独立 PostgreSQL 容器 `bb-progressive-20261113-pg`，迁移模板库 `bb_progressive_template_v2`；各测试文件从该库创建隔离数据库。未使用生产数据库、生产存储或真实模型。

## 第一阶段 API 回归

执行 `node --test apps/api/dist/workpaper-progressive.pg.test.js`，5 项通过、0 失败、0 跳过，总耗时 83,052.0578 ms。原始输出：`api-progressive-final.log`。

- 18 份真实 API 批次：固定章节顺序、前 8 章每章 1 份、并发上限 2；数据库拒绝第三份和无关业务并发；确认关卡、幂等重放、owner 隔离和失败重试。
- 停止后已接受任务仍可完成状态同步；重试只选择失败项，未启动文件保持未启动；旧 attempt 不能暂停新 retry；共享模型错误阻断后续调度。
- 试生成失败项重试后返回质量确认，不放行其余文件。
- 统一文件生成入口保留章节顺序、锁定报价和请求输入，旧报价不能用于另一顺序。
- 只有一份费用时可提交全量范围，逐份预留；余额不足暂停第二份；原批次补足并幂等恢复；不重复预留。

真实范围为网页 API、上传注册、目录导入、PostgreSQL 调度、数据库互斥、报价和账务预留。该测试通过受控终态注入验证失败处理，不将合成状态视作真实模型或 Word 生成证据；实际 Word 编制、逐份下载、说明退款和计划回放由 worker 集成测试单独覆盖。

## 既有账务兼容回归

执行 `node --test apps/api/dist/automatic-file-billing.pg.test.js`，10 项通过、0 失败、0 跳过，总耗时 41,301.7083 ms。此轮原始输出保留在工具执行记录，未另存日志文件。

覆盖原底稿余额不足、无副作用的 402、原批次恢复、重复支付返回不撤销人工暂停、历史单份检查和批量报价，以及固定报价跨价格版本发布的兼容性。

## 本次 API 变更文件

- `apps/api/src/workpapers.ts`
- `apps/api/src/file-generation.ts`
- `apps/api/src/workpaper-progressive.pg.test.ts`
- `db/migrations/0175_workpaper_progressive_batches.sql`

0175 已从空白数据库完整迁移验证；新增冻结的章节/试生成计划、独立运行阶段、确认回执、失败重试集合，以及仅限同一真实批次、不同文件且最多两份的数据库并发例外。

## 章节小组计划的 Python 验证

新增 `python/bondbuddy_workpaper_progressive.py` 和 `python/tests/test_workpaper_progressive.py`。执行 `python -B -m unittest discover -s python/tests -p test_workpaper_progressive.py -v`，11 项通过，1.361 秒。原始输出：`python-progressive.log`。

覆盖完整来源投影、表格/附注依赖、原始排除项不被改写、单项虚构数值和计算失败隔离、组级不完整时退回单项规划、源身份及图片安全阻断、PDF 页映射、跨项重复说明、未知事实，以及真实 CLI 输入输出。

随后执行 `python -B -m unittest discover -s python/tests -p 'test_workpaper_*.py' -v`，完整 4 个 workpaper Python 测试文件共 27 项通过，29.489 秒；原始输出：`python-workpaper-regression.log`。包括原共享编制、完整源提取与模板校验。

开发和自测完成不代表用户验收或已部署；本次未部署。

## 最终恢复路径补充

在完整迁移至 0177 的隔离模板库 v3 上，最终 8 项 API 测试均已验证通过。首轮 `api-progressive-recovery-final.log` 为 6 pass / 2 fail；新增两项成功态夹具缺少 Word 门禁记录。只修测试夹具为真实 claim、Word 编制校验/存储回读、artifact 登记、正常 finish 结算后，定向 `api-progressive-recovery-rerun.log` 为 2 pass / 0 fail / 0 skip，68,210.7275 ms。生产恢复逻辑未因测试失败改动，生产 Word 门禁未削弱。

新增覆盖 shared_blocked 显式重试、试生成补齐后仍等待确认、后续生成恢复、连续受阻保留未启动重试范围，以及 paused/awaiting_input 子任务和历史待对账的恢复保护。没有额外迁移或依赖。
