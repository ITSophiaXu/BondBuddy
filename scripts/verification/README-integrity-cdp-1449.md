# #1449 CDP 异步异常与诚信核查复验（2026-11-16）

结论：#1449 对特定 Playwright/CDP 异步断言的进程隔离有效，但不能据此认定诚信核查已恢复。真实官网采集仍失败，已保存的失败缓存也不会因 worker 恢复而自动变成有效查询。

## 固定版本与环境

- 原始修复：develop `372d2ec529b1d36eb43735a7b1b0c9e5dcd2bb54`（包含 #1451 的 CDP 修复及 #1456 的依赖挂载修复）。
- 后续版本：develop `8209b347d765589fb97c19c990c63718d67ad227`，含异常阶段和安全诊断增强。
- 两版本均完成下列三种业务故障场景。Linux Node 22.23.2、Playwright 1.63.0、Chromium 153.0.8010.12、PostgreSQL 16；数据库和 Azurite 均为本任务新建的隔离容器。schema 分别为 188/189。
- 真实 Fastify API 路由、worker pipeline、PostgreSQL、Blob、原生桌面浏览器、截图和 Python Word 生成；API 通过 inject 调用，没有测试网页前端。
- 故障测试的网站响应为明确标注的 synthetic fixture；无外网。模型调用为 0，无支付调用，未读取或修改生产任务、数据库、账务或服务。

## 真实依赖故障测试

脚本：`integrity-cdp-1449.mjs`。通过 Playwright 1.63.0 的实际 transport 注入没有对应 callback 的 CDP 回复，执行依赖自己的 `assert → _CRSession._onMessage → CRConnection._onMessage`，没有伪造 Error.stack。

负对照不安装隔离边界，真实断言导致子进程 ExitCode 1；修复后的生产 collector 共启动 9 次原生浏览器，注入 4 次真实断言，3 个任务在同一进程顺序执行：

| 场景 | 结果 | 成果 | 报价 / 实扣积分 |
| --- | --- | --- | --- |
| 首个网站 CDP 失败，后两个网站正常 | 首项 query_failed、无查询/截图；后两项完成，任务成功 | 1 份 Word、2 张截图 | 2255 / 2170 |
| 同一 worker 进程的下一轮，无注入 | 3 项完成，任务成功 | 1 份 Word、3 张截图 | 2255 / 2255 |
| 3 个网站均注入 CDP 失败 | 3 项均 query_failed，任务失败 | 无成果、无截图 | 2255 / 0 |

下载字节与元数据 SHA-256 一致，另一账号下载被拒绝。每轮后浏览器已关闭、采集临时目录已删除、unhandledRejection 监听器数恢复；最终冻结积分为 0。原始版本两份 Word 的 ZIP CRC 正常，正文分别明确“2项搜索无返回结果；1项查询未完成”和“3项搜索无返回结果”，失败项未冒充无记录。

后续版本异常边界/诊断回归 **5/5 PASS**，包括并发采集一起结束、无关异常仍退出、安全诊断不泄露原始信息。

## 真实官网采集：仍未通过

脚本：`integrity-cdp-1449-live.mjs`。2026-11-16 北京时间约 21:05—21:09，使用原始修复固定版本实际查询“东营市城市建设发展集团有限公司”。使用本机 Docker 的公网出口，**不是生产北京出口**；没有调用模型。结果不能推定所有官网或所有生产节点表现相同。

| 官网 | 实际结果 |
| --- | --- |
| 国家税务总局 | 已提交查询；两次尝试，每次等待 90 秒，仍返回 result_unverified。保留了真实截图，页面可见主体名称和“相关结果0个”；当前程序未确认此次查询，不能将这次测试记为查询成功或认定企业无失信。 |
| 信用中国 | 入口 HTTP 400，search_performed=false，无有效截图；未完成核查。 |

两项均正常返回诊断，进程没有退出。这证明网站查询成功与进程存活是两个不同的验收条件。

## 原任务和既有回归的边界

- [#1477](https://github.com/ITSophiaXu/BondBuddy/issues/1477) 的生产记录显示：原任务 e35c8ed5 的 21 条打开失败缓存均为 query_failed / search_performed=false，0 截图；恢复执行复用缓存后仍为 INTEGRITY_SEARCH_UNAVAILABLE，0 扣费。此处引用该问题已登记的生产证据，本次没有重新查询生产数据库，也没有重跑原任务。该问题仍 OPEN，根因尚待细分。
- [#819](https://github.com/ITSophiaXu/BondBuddy/issues/819) 继续跟踪历史多官网访问、结果确认及截图问题。不能仅凭相似错误认定同根因。
- 原始固定版本浏览器/采集/边界相关用例 **32 PASS**；另跑业务套件 **10 PASS / 3 FAIL / 0 SKIP**，未宣称全绿：旧 integrity-e2e 仍假定新任务固定 5000 积分（实际初始报价为 0、需获取范围报价）；automatic-v2 / automatic-v3 两个暂停恢复用例得到 idle 而非 succeeded，尚未定位。本次新增故障测试使用当前 quote 接口，上表业务链路不依赖这些旧断言。
- 原始版本 worker/API 在补齐跨包声明后严格检查通过。后续快照定向运行通过，但全包构建仍遇到跨包 dist 声明输入/输出重叠 TS5055；不计为完整构建成功。
- 测试准备中曾遇到 Windows CRLF 导致 SQL 文本替换迁移失败、Azurite 对新版 SDK API 版本拒绝、缺少 pngjs 测试依赖以及挂载读取导致负对照加载超时。隔离库重建为 LF 迁移；Azurite 使用 skipApiVersionCheck；补齐测试依赖；改用本地镜像和最小负对照。最终故障测试保留完整重跑证据，这些准备失败未计为产品通过。

## 重跑

在固定、已编译的 Linux checkout 中准备独立迁移数据库、Azurite、Playwright 1.63.0 Chromium、原生 Xvfb/Openbox/XFCE/scrot 及 Python 文档依赖，使用项目的浏览器 seccomp 配置。不得使用生产数据库。

设置 `BB_TEST_DATABASE_URL`（仅作克隆模板）、`BB_TEST_AZURITE_CONNECTION_STRING`、`BONDBUDDY_TEST_PYTHON`、`BB_INTEGRITY_TEST_OUTPUT_DIRECTORY` 和准确的 `BB_VERIFICATION_SOURCE`（40 位 Git SHA），运行：

```sh
node scripts/verification/integrity-cdp-1449.mjs
node --test apps/worker/dist/integrity-browser-boundary.test.js apps/worker/dist/integrity-collection.test.js
```

真实官网脚本单独执行，只读访问公开网站，默认结果保存到 `/out/live/`；不要把它的失败改为通过来满足断言。测试依赖与截图/Word/日志仅保存在本地证据目录，不提交到 Git。

本次仅补充验证脚本和报告，没有修改产品逻辑，没有部署或重启生产服务。诚信核查整体验收仍未通过。
