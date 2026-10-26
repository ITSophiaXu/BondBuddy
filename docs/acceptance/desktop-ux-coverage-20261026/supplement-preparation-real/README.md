# 补料准备：真实主页面与后端联通验收

日期：2026-10-26；起点 `dd6be2d2`；分支 `codex/desktop-ux-coverage-20261026`。本次修复复核成果续改任务的原材料恢复回归，并将准备切片接入完整 main 页面、真实 HTTP/session/CSRF、隔离 PostgreSQL 与私有本地文件字节进行连续验证。**G03 / UX-A03 仍未完成，完整 UX goal 保持 active。**

## 产品修复

`POST /projects/{id}/review-updates` 创建的任务使用不可变 `authoring.review_result`，同时拥有 `bb_review_executions` 快照，没有 `manifest.review`。原补料接口把这种合法组合误判为损坏并返回 503；复核页面恢复任务前必须核对补料，因此即使用户从未采用补料，也无法按原材料继续。

现在明确识别该既有任务类型，核对 update/revision、现有公共输入和成果 pin schema、原成果任务、原稿 pin、完整材料和要求。普通复核仍按原 `manifest.review` 严格比对。没有取消固定输入校验，也没有新增公共协议、迁移、计费规则或执行版本。

新增后端回归从真实 review-draft、review-executions、队列 claim、合成报告登记及 finish，走到真实 review-updates、暂停、补料 GET/PUT 和原输入 resume；源报告与样本为 synthetic。旧代码已经复现首次补料 GET 返回 `503 DATA_UNAVAILABLE`，定向为 0 pass / 1 fail / 0 skip；那次输出只保存在工具记录，未事后制作原始日志。另验证普通复核缺少 review，以及成果续改的源任务、原稿、材料、要求或 operation 不一致仍返回 503。

## 采用结果

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| [后端专项](backend-final.log) | **44 pass / 0 fail / 0 skip**，16.324 秒，含父子测试 | 完整准备专项及本次合法成果续改、五种续改快照漂移、普通复核缺字段回归；真实隔离 PG 与 HTTP 中间件 |
| [完整主页面](browser-final.log) / [原始报告](browser-report.json) | **6/6**，34.9 秒 | M1、M3、单份 M4 和复核成果续改；实际上传、保存、刷新、明确排除补料并恢复同一原任务；保存响应丢失准确恢复与两个独立浏览器 context 的 CAS |
| [API build](api-build.log)、[web TypeScript](tsc.log) | 通过 | API 重新构建；web 包含新增 harness/spec 的类型检查。web 产品源码未改，使用前次构建的真实 main bundle |
| [源码一致性](source-check.json) | **1,031 文件前后相同** | API/web/contracts 的 source 与 dist，避免联通测试期间改变生产代码或构建；两份新浏览器测试另在 [sources.json](sources.json) 固定哈希 |
| [隔离库最终状态](database-final.json) | 模板 run/draft 均为 0、无残留克隆 | 模板仍迁移至 0118；每个浏览器 worker 关闭服务与连接后，显式清理仅属于自身的本地克隆；专用 [PostgreSQL 已停止](postgres-final.log) |

所有样本、会话和成果前置均为 synthetic。环境为 Windows、Node 24.22.1、PostgreSQL 16.14、Playwright/Edge；最终截图均为 1440×960。完整前端由实际 `dist/index.html` 和 assets 提供，同源 Fastify 只监听 `127.0.0.1:5198`。浏览器请求经过实际 API 客户端和 session/CSRF 中间件，没有 principal override、API response fixture 或合成页面外壳。请求外网会使测试失败。

M1/M3/M4 的普通旅程从明确标记的 queued 合成原任务起步，浏览器实际发出 pause，服务端持久化暂停。它证明排队边界暂停与准备，**没有运行模型后保存进度的暂停证据**。成果续改用例的目标任务由真实 review-updates API 创建；其前置成功报告通过合成 DOCX、真实私有字节登记和 finish 提供，不代表模型或最终 Word 验收。

浏览器实际选择文件，调用上传 session、PUT bytes、complete，再独立保存补料草稿。测试读取 PG 的 byte_size/hash，核对私有磁盘原字节和实际授权下载字节，并验证匿名下载为 401。保存前后比较全部原输入、原任务、业务快照和草稿、调用、非空 10,000 积分账户与流水、全部 owner jobs 和旧 outbox；只允许该目标 run/request/revision/base 的准确补料事件新增。显式 resume 继续原 job，job 身份集合不变，只允许原 job 的正常恢复状态变化。关键结果见 [assertions-summary.json](assertions-summary.json)；完整合成数据库快照只保留在 `.local/supplement-preparation-real/evidence/`，该摘要记录其哈希，没有提交私有字节或生成 Word。

失落回执用例让真实 PUT 完成、提交 PG 并返回 200 后才丢弃网络响应；页面按原 request_id 发起真实 GET，只有一条保存 revision、一次 PUT。CAS 用例在两个隔离 localStorage 的真实浏览器 context 中保持各自选择，一次 PUT 成功、另一次真实 409；用户明确保留本页后才以新 revision 保存，刷新保持准确内容。旧 outbox 逐行不变，新增事件逐项核对，不把所有补料事件排除后再声称完整比较。

## 画面

| 主页面 | 视口 | 全页 |
| --- | --- | --- |
| M1 编制/更新 | [viewport](m1-saved-viewport.png) | [full](m1-saved-full.png) |
| M3 复核 | [viewport](m3-saved-viewport.png) | [full](m3-saved-full.png) |
| 单份 M4 文书 | [viewport](m4-saved-viewport.png) | [full](m4-saved-full.png) |
| 复核成果续改 | [viewport](m3-review-update-saved-viewport.png) | [full](m3-review-update-saved-full.png) |
| 准确回执恢复 | [viewport](m3-receipt-recovered-viewport.png) | [full](m3-receipt-recovered-full.png) |
| 明确解决 CAS | [viewport](m4-cas-resolved-viewport.png) | [full](m4-cas-resolved-full.png) |

已实际查看主页面截图：原生导航和项目工作区完整，材料来源、保存事实与“尚未采用”可读，上传、保存、原材料继续可达，无水平溢出，采用按钮仍禁用。页面结构和准备能力沿前次切片；本次没有修改 UI。原 [HTML 提案](../../../ux/prototypes/pause-supplement-resume.html)及其与生产组件的差异仍按[前次对照](../supplement-preparation/README.md)保留，不将本轮真实页面截图冒充产品负责人签认或完整新输入续做的对照验收。

## 复验与过程

先在本任务专用本机 PG 上提供迁移至 0118 的空模板，构建 API 和 web。仓库根目录运行：

```powershell
node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/verify.mjs tsc
node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/verify.mjs source-before
node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/verify.mjs test
node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/verify.mjs source-after
node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation-real/verify.mjs snapshot
```

脚本清除继承的 BB_/DATABASE/AZURE/OPENAI/DEEPSEEK 设置，再仅配置本机专用模板、5198 和已安装 Edge。后端专项复用 [前次隔离脚本](../supplement-preparation/verify.mjs)的 `test` 模式。本次没有重新迁移、访问生产或供应商。

文本证据副本只统一 CRLF/LF、去除行末空白及末尾空行，原输出保留在本机 `.local/supplement-preparation-real/`；本目录按固定 LF 保存，截图字节不变。源码哈希记录本次 Windows 工作区实际运行的文件，不把源码行末转换当作不同产品版本。

首次主页面轮为 [2 pass / 1 fail / 2 未运行](browser-first.log)，42.3 秒：M4 合成前置使用空 knowledge 数组，不符合真实 manifest schema，尚未进入其页面。修正为既有真实知识 loader、公共文种计费映射及实际 input gate，保留 schema 断言，并加入真实成果续改回归后，[中间轮 6/6](browser-intermediate.log)，38.0 秒。

中间轮完成后，[数据库检查](database-before-cleanup.json)发现 Playwright worker 不执行 node:test 使用的 beforeExit 清理，留下两份本轮测试克隆。确认它们均无会话后仅清理这两个准确名称；harness 改为显式关闭并清理经本地端口、模板前缀、当前 PID 和随机尾码核对的自身克隆，绝不操作模板。随后补强准确 outbox 和 resume job 身份断言、统一回执截图尺寸，最终整套再次通过且克隆为零。未用中间通过覆盖这些问题，也没有削弱生产规则。

## 仍未完成

本次验证的是准备保存与明确的**原材料恢复**。没有新输入采用、活动执行版本、补料模型处理、追加报价/扣费、支付、Azure Blob 服务或最终新 Word 连续验收；未重复历史 15/15、662 项、其他组件或原任务回归，也不累加其通过数。

完整范围只读复审在已检查的最新产品决定及对应入口中，没有确认 G03 之外新的主要功能缺口；该结论不等于主要功能全部完成。用户已选择 B“必要重做另行报价并确认”，B1/B2 具体计价基准仍未选择。后续仍需完整版本化采用与三类执行器、旧工作复用、准确成果/材料生命周期/授权、追加账务和同任务全旅程。G03 继续保持 functional_gap / design_gap，新输入续做测试仍为 not_run。本轮仅本地提交，未推送、创建 PR 或部署。
