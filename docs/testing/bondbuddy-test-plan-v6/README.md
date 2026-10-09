# BondBuddy v6 测试执行入口

本轮目标是尽快达到 **U：受控邀请用户测试准入**。准备齐全后按1–2个工作日规划；全部适用U子例和Human预检通过才可开始邀请。完整79组是覆盖池，完整E/R验收、全历史回归对账与用户测试并行推进。

发布于2026-10-09。源码参考为 master `a6fa7eb030f7f9bc4c803176b2aacf38d35642b6`，develop `ebae7f6b50aaacff34cab717a5bde5892fe239b6`，10月9日重新核对时未变化。**线上观察仅来自10月8日；执行前重新冻结实际运行版本、功能与配置。所有产品结果初始为 `not_run`，U未批准。**

## 文件与用途

| 文件 | 怎么用 |
|---|---|
| [test-plan.md](test-plan.md) | 五项业务goal、79组case与pass criteria；第3章分工、第5章daily bug bash、第6.0节U必跑子例 |
| [regression-registry.json](regression-registry.json) | 39条已知永久回归起始登记；按本轮范围/diff选高风险断言，完整历史inventory尚未完成 |
| [release-baseline-template.json](release-baseline-template.json) | 完整版本/配置/计费/资料/回归/批准manifest模板；U、E、R分别登记 |
| [execution-report-template.json](execution-report-template.json) | 本轮执行副本：逐包、逐子例、Human预检、缺陷及决策；不要直接覆盖模板 |
| [validate.mjs](validate.mjs) | 检查本包ID、分工、映射、初始状态和文件引用；仅用Node标准库 |

## 启动本轮测试

1. 拉取包含本目录的分支，在仓库根目录用Node 22+运行：

   ```bash
   node docs/testing/bondbuddy-test-plan-v6/validate.mjs
   ```

   无需安装依赖。绿色结果只说明文档metadata一致，不表示产品测试通过或U ready。

2. QA负责人复制两个结果模板到团队受控证据目录，分配Agent执行人、业务用户、内容审核人及Word/WPS客户端审核人。记录实际日期、owner与反馈入口。凭证、客户原件、生成稿、完整日志保留在受控位置；仓库/Issue仅保存脱敏摘要、hash及授权访问的证据链接。

3. 冻结实际试用URL、Web/API/worker SHA或image digest与可核对回执、相关迁移、flags、实际价格/开关、开放模块及市场、授权fixture/hash、余额和真实调用预算。将执行报告 `selection.frozen` 与所选子例范围填全。模板候选SHA是设计依据，实际运行不同版本时需登记该版本源码与diff；不能用最新源码测试替代旧运行版证据。

4. Agent先启动各开放模块真实旅程，同时跑下面七包的必要子例。对每个子例明确是否 `required`，范围外记 `N/A` 并填理由；将同一次run/文件/账务复用于不同断言，分别登记结果。未覆盖分支保留 `not_run`，缺环境记 `blocked`，不能把整组case标为pass。

5. 真实成果可用后，Human做三项短预检，目标为30–60分钟有效操作；生成等待另算，发现阻碍修复后复验。QA负责人核对版本及全部适用必跑证据后填写U决策。已知共享P0或试用核心P1阻断准入；U通过即可开始限定小批用户测试。

6. 按[计划第5章](test-plan.md#5-daily-bug-bash-schedule--tasks)的09:30–17:20节奏执行triage、修复、定向复验和G1–G5日报。D1–D5从实际启动日顺延；用户测试无需等五日轮转完成。全历史fix对账、CI补齐、完整8组合及双客户端/专业验收继续按E/R推进。

## Agent自己测试哪些

| U包 | Agent负责的结果 |
|---|---|
| U-A 版本/入口 | 实际版本、相关迁移/flags/价格、health/ready/worker、入口与禁用提示可核对 |
| U-B 真实业务闭环 | 每个开放模块真实输入到下载；M1双Word、M3报告，开放四文种时各一个授权市场，共4组合；可见免费帮助 |
| U-C 权限/输入 | 两个隔离账号越权拒绝、退出/过期清理、准确源version/hash、M1材料锁及worker隔离 |
| U-D 明确执行/幂等 | M1报价确认、材料表单一点击、double click/丢响应沿同key只有一个run/hold；助手纳入范围才补卡确认与隔离 |
| U-E 积分 | 当前价格/启用模式、余额临界和竞争、交付后一次扣费、失败/取消释放、主余额与ledger一致 |
| U-F 恢复 | 上传complete丢响应、reload/重登、checkpoint、取消成功竞争、paused/resume；不重call或重复结算 |
| U-G 受影响fix | 试用范围和diff涉及的已知权限/资金/误执行/底稿/恢复P0/P1永久断言全部通过 |

具体ID、操作和oracle以[第6.0节](test-plan.md#60-u门受控邀请用户测试的最小准入)及baseline的 `user_testing_admission.packages.required_subcases` 为准。U池38个ID只要求选定必要子例。完整分工为65组Agent独立、3组Human最终验收、11组Agent预检后Human验收；这是责任分配，尚未全部实现自动化。

故障注入、并发、跨账号负例与破坏性分支在隔离环境执行。真实闭环使用授权资料与既定预算；生产日常smoke只读。现有测试命令见[第6.5节](test-plan.md#65-可复用命令本轮未执行)及固定SHA的CI workflow；PG/Azurite/Linux/browser环境须按对应workflow准备，不能依赖skip获得通过。

## Human必须测试哪些

| U预检 | Human负责的判断 | Agent交接 |
|---|---|---|
| U-H-flow / BB-051-U | 业务用户能理解准备、费用/确认、进度、下载/回看，代表旅程无死路或持续辅导依赖 | 提供测试任务及可用环境，观察并记录阻碍 |
| U-H-content / BB-013/016/036/037-U | 开放模块代表输出的发行人/市场/期间、关键数字/条款和明显虚构程序事实无核心错误 | 提供准确源位置、run和artifact hash |
| U-H-client / BB-039-U | 在用户主要使用的一个真实Word或WPS打开代表M1双稿/M3报告/M4成果，可读可编辑、无修复警告或空白成果 | 提供受控下载链接和hash，不用XML检查冒充客户端操作 |

这些是U预检，不能据此把完整专业/Word-WPS验收case标为pass。全专业审阅与另一客户端完整矩阵留R；用户测试启动后Human真实任务和反馈成为重点，Agent负责观察、账务复算、复现与回归。

## 结果与证据

每条结果保留：gate/package/case/subcase、owner、selection理由、expected/actual、运行版源码/配置、fixture/run/input/request/artifact/ledger、受控证据和缺陷。使用 `pass/fail/blocked/not_run/skipped/N/A`；N/A须明确范围理由及适用的禁用负例。必跑子例不能带fail/blocked/not_run/skipped进入U，多个断言共用run不代表自动全部通过。

JSON的 `suite_candidates` 是 **固定 `source_reference_sha` 的仓库根相对路径**，可能包含源代码/历史材料，并非每条断言已有自动化。包内artifact链接相对本目录，源码Markdown链接固定GitHub SHA。历史PR/Issue回执可读，原本地调查记录未提交；本轮须留可复核的新证据。

完整release baseline仍要求全历史fix对账、unmapped=0和全部适用永久回归；目前 `inventory_complete=false`。U ready只批准记录范围内的受邀试用，不代表正式发布或已部署新功能。
