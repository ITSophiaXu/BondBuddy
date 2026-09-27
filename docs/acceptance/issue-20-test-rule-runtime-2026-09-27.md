# #20 / #31 内部测试规则部署与模型消费者

本切片衔接 #325 候选资产和 #326 非生产测试通道。目标是解除“input_lock 已准许测试、模型阶段仍只读取 production pin”的第二处接线缺口；不把 draft.6 发布为生产规则，不关闭 #20。

## 已实现

- 三份候选 JSON 逐路径固定 LF；Docker build/node-runtime 仅复制该三文件，构建时校验原始字节、schema、范围与字典 hash。无样本原件/来源附件入镜像。探针 `node apps/worker/dist/verify-sse-private-candidate-assets.js` 使用编译模块位置查找根目录，可在任意工作目录运行。
- `loadSsePrivateCandidateAssets(root)` 返回同一批已核缓冲区解析出的内容，原有 descriptor loader 保持兼容。没有校验后重新读取文件的时间窗口。
- `loadAuthorizedHistoricalTestRuleGuidance(ctx, input)` 复用 #17 身份/授权门与 #19 `testRuleCapabilityLoader`，再次检查输入 hash、有效 grant、sample/taxonomy/rule hash，再读取三份精确候选资产。只有 `non_production_test` 的 update run 可进入；生产分支继续精确复核 production release。
- 目标市场、发行方式、文书阶段和法规日取已确认且锁定的 `target_confirmation`。财务截止日不代替法规日；当前研究快照不冒充 2025 年历史法规包。
- 模型参考保留 31 条 research_only 规则、179 处原文/定位、16 组完整来源信息和 32 条 coverage（31 uncovered、1 not_applicable）及四项 blockers。无规则映射的 item 保留空 ruleIds。去重来源元数据后完整参考约 169,529 字节，不裁引文或例外。
- 测试 prompt 模板为 `historical-sse-private-test-v1`，参考和授权信息参与 prompt/checkpoint hash；生产 v3 不改。规则/来源均待核，不声称合规通过。原文分段在完整规则/事实之后按剩余 UTF-8 字节预算执行；单块仍超限则明确暂停，不截断。

## 验证边界

组件测试包括准确资产加载、独立运行目录、缺失/篡改拒绝、来源完整读回、生产隔离、grant 归属/过期/撤销、输入变更、未确认目标拒绝、无 production pin 的历史稿规划、恢复前重新校验，以及中文长文档的字节预算。

本地验证：组合构建通过；相关 worker 测试 85/85 通过、无跳过（包含实际 Python 的合成 DOCX 读写）；任丘九月授权原件只读解析得到 9,690 个原文块，在完整 169,529 字节规则参考及额外预留 20KB 下分成 132 段，无遗漏/重复；此预留测试不代表实际模型 prompt 的最终财务上下文规模。运行资产探针通过。规格重建 19 模块、204 链接、133 表格、4 JSON、190 验收标识，零错误。后续新增用例计数以 PR 最新记录为准。

数据库/身份/候选选择与模型使用合成组件替身；不代表真实 #19 selector、PostgreSQL/Azurite、供应商或目标机部署通过。真实样本只读分段验证也不等于财务数据可用性或出稿验收。本机 Docker daemon 未运行，未把镜像级测试记为通过；目标机镜像探针/run 证据待 #35 回填。

## 部署与验收交接

1. 合入 #326 的修订版公共覆盖项契约/0056，及 #19 的授权样本 membership + candidate selector + runtime 注入。不能用空 uncoveredItems、任意 manifest SHA 或假生产 release 代替。
2. 预发按准确合并 SHA 构建镜像；执行资产探针，应用新增迁移，核对健康检查、备份和回滚点。未取得目标机证据前不得称已部署。
3. 仅在预发开启既有测试通道。运维给指定测试账号/项目/不可变输入创建有期限 grant；原版年度/当期材料依 #19 最小清单逐份校验。
4. 跑真实历史稿任务，保留阶段、输入/规则/模板 pin、prompt、真实模型用量、失败原因和 Word hash。每个模型意图和恢复继续验证身份/授权。检查 `test_completed`、`test_only`、不结算及 Word 首页/页眉/待核清单。
5. 从真实浏览器覆盖上传后保存材料版本、目标确认、提交、同页进度、关闭重开和下载。#18 页面与 #76 校正版本单独验收。

本切片不解除存疑财务候选/历史稿结构支持的真实限制；局部缺口继续标待人工确认。有历史稿不等待 #77；Word/WPS 兼容性不阻断 #20，按 #146 跟进。
