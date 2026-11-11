# 诚信核查报价一致性修复与跨功能排查

日期：2026-11-11。Issue：[#985](https://github.com/ITSophiaXu/BondBuddy/issues/985)，关联原始需求 #720。开发基线：`c7b32f4547fe954f5c3802e5e4c38354b9349989`。

状态：开发与本地自测完成；尚未部署，待统一集成、用户验收及授权发布。本记录不代表完整本地集成版或真实官网验收。

## 问题与修复

API 已接受自动计价版本 `bb-task-price-170-20261029-v3` 的 22,738 积分报价，诚信核查 worker 的输入门禁却仍强制旧版 `integrity-round-5000-v1` / 5,000 积分，导致有效任务在 `input_lock` 返回 `INPUT_REVISION_CONFLICT`。已只读核对线上 worker 原门禁；当次任务尚未查询网站或交付成果，冻结已释放，实扣为 0。客户信息及原始生产诊断未纳入仓库。

`integrityPriceValid` 改为校验已接受的不可变报价：owner/project/run、输入哈希、积分和价格版本、实际绑定且仍为 held 的 on-delivery 冻结记录，以及报价对应的已发布范围、快照、行项目和自动/合同任务绑定。旧固定价格仍保持原校验。输入篡改、报价/冻结/范围不一致仍拒绝执行。

已接受任务继续使用原报价，不因排队、暂停续跑期间报价到期或新价发布而重新定价。同轮免费导出仍复用查询结果，不新增冻结或网站查询。未修改收费政策、公开 DTO、数据库结构或依赖。

## 排查范围

| 路径 | 校验与回归结果 |
| --- | --- |
| 诚信核查 | 修复旧常量拒绝新报价；6 类价格均通过真实 worker、Word 生成与钱包结算 |
| 项目问答 | 现有门禁已绑定不可变报价；旧固定价、审核价、自动价、合同价和失败重试通过 |
| 募集书编制、复核 | API/数据库绑定接受时的报价，worker 不另用旧固定价覆盖；报价竞争、失败重试、交付结算通过 |
| 普通文件、公司债底稿 | 自动/商业报价分支先于旧固定价；逐文件计费、余额不足原子性、异步续跑、部分交付、维护和隔离通过 |
| 文件检查与维护 | 锁定金额与已付覆盖绑定；新版本/退款后失效覆盖、无完整检查成果释放通过 |
| 助手付费回答与 M4 | 准备/不明确输入不能绕过付费；回答 SKU、固定/商业价格、旧报价拒绝通过 |
| 共享账务与价表 | bigint/字符串金额、幂等释放/结算、历史订阅保护、价格发布/回退及已接受旧报价保持通过 |

本次代码检查和回归覆盖内没有发现其他相同的新旧积分混用缺陷。此结论不涵盖所有外部供应商故障或真实模型内容质量。

## 环境与测试结果

Windows；Node 24.22.1；PostgreSQL 16.14；Python 3.12.14（python-docx 1.2.0）。使用专用本地 PostgreSQL 端口 15481，各套件克隆隔离数据库；不连接生产数据库。依赖锁文件与复用依赖来源一致，工作区包指向本修复 checkout。

| 证据日志 | 结果与说明 |
| --- | --- |
| `integrity-before-fix.log` | 原 worker 门禁运行新增自动报价用例，按预期失败 1 项，错误为 `INPUT_REVISION_CONFLICT`，证明回归捕捉原缺陷 |
| `integrity-final.log` | 8 passed / 0 failed / 0 skipped；6 种价格：旧固定 5,000、审核 5,321、自动 v3/v2 各 22,738、合成管理价 3,606、合同价 3,900 |
| `cross-feature-first.log` | 34 passed / 0 failed / 0 skipped；下列 10 个跨功能计费套件 |
| `worker-cross-feature.log` | 普通文件付费执行场景通过；底稿旧断言读取已移除的公开 `current.links` 字段而失败，保留失败记录 |
| `workpaper-paid-final.log` | 修正为公开 `links_count` 并额外查询归属正确的数据库版本完整 links；12 passed / 0 failed / 0 skipped（11 个目录用例与 1 个完整底稿执行场景） |
| `contracts.log` | 72 passed / 0 failed / 0 skipped；179 个公开、12 个内部及 4 个生命周期样例通过 |
| `web-build.log` | Vite 构建通过，571 模块；保留既有 chunk 体积提示 |

诚信核查初次测试还发现预期错误码写成内部 `INTEGRITY_SEARCH_UNAVAILABLE`，现行公开映射为 `DATA_UNAVAILABLE`；已修正测试预期，并核对持久结果全部为未完成查询。没有改动产品错误映射。

七个工作区按依赖顺序 TypeScript 构建通过，`git diff --check` 通过。GitHub CI 使用 Node 22/Linux，与此次本地环境不同；CI 的实际状态见 PR，不能用本地记录代替远端通过。

本地日志保留在共享工作区 `work/billing-input-consistency-20261111/`，不提交原始生产数据。新增诚信核查测试已加入 `m4-core-pr.yml` 及两个本地诚信核查测试入口。

## 复现命令

先安装锁定依赖、依次构建 contracts/domain/rule-pack-registry/rule-applicability-context/API/worker/web。准备已迁移的私有 PostgreSQL 模板库，设置 `BB_TEST_DATABASE_URL`、`BONDBUDDY_TEST_PYTHON` 和 `BONDBUDDY_WORD_PYTHON`；后两者指向具有业务依赖的 Python。命令中 `node` 指上述运行时；Windows 下可使用其绝对路径。

```sh
node --test --test-concurrency=1 apps/worker/dist/integrity-pricing.pg.test.js
node --test --test-concurrency=1 apps/api/dist/automatic-billing.pg.test.js apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/automatic-m4-boundaries.pg.test.js apps/api/dist/m4-fixed-billing.pg.test.js apps/api/dist/billing-int64.pg.test.js apps/api/dist/automatic-price-versions.pg.test.js apps/api/dist/billing-price-admin.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/worker/dist/project-qa-pricing.pg.test.js
node --test --test-concurrency=1 apps/worker/dist/ordinary-file-check-batches.pg.test.js apps/worker/dist/workpaper-paid-checks.pg.test.js
node --test packages/contracts/dist/outcome-pricing.test.js packages/contracts/dist/integrity-presentation.test.js packages/contracts/dist/workpapers.test.js packages/contracts/dist/workpaper-naming.test.js packages/contracts/dist/ocr-v2.test.js packages/contracts/dist/generation-issuer-binding.test.js
node packages/contracts/dist/check-examples.js
node packages/contracts/dist/check-data-lifecycle.js
```

测试通过 Fastify 注入执行真实 API 路由、真实 PostgreSQL/worker 门禁、Python Word 生成、成果读取和钱包结算。网站与模型响应使用合成数据，私有对象存储使用内存替身；未调用外部网站、模型或付款服务。新用例中的全部网站范围不代表真实官网可访问性已通过；未执行人工逐页版式验收。

## 发布交接

无新增迁移、依赖、配置项或价格变更。统一发布须包含更新后的 worker；只更新页面或 API 无法修复旧 worker 的门禁。已失败且冻结已释放的旧任务不能直接复用旧冻结继续执行，应在修复发布后走现有重新报价/创建任务流程；本开发任务未重跑客户任务、未改变生产账务。

最终统一验收待办：集成本修复版本并按范围实测、用户验收、获授权统一发布和线上核验。真实官网访问、验证码及搜索结果内容属于后续实际核查范围。
