# 新旧计费规则：实际 worker 失败与尾款恢复

用户未提供具体线上失败任务，本轮主动构造同类兼容风险，不用于归因未知线上故障。承接已合并的 [#894](https://github.com/ITSophiaXu/BondBuddy/pull/894)，补齐原专项通过手动 checkpoint/finish 验证、尚未经过完整 worker 编排的分支。仅增加测试与证据，不修改产品、费率、契约或数据库迁移。

产品源码基线为 `1ef2092708aaadbb12f07a4e6ddf5a9e2dee322f`，不代表线上版本。隔离本地服务、PostgreSQL 和随机合成账号；Windows Node `v26.13.0`。两份脚本按顺序执行，所记录的十份脚本／编译产物及服务实例在执行前后保持一致，见 [provenance.json](provenance.json) 和主 agent 的 [独立核对](root-review.json)。旧报告保留，最终报告没有拼接不同轮次。

| 脚本 | 本次结果 | 新增覆盖 |
| --- | --- | --- |
| `node scripts/billing-functional/billing-policy-compatibility-verify.mjs` | [13 passed / 0 failed / 0 skipped，exit 0](review.json) | 旧复核 v2 任务在真实 pipeline 尾款不足暂停，HTTP 充值后恢复；原三份成果的 ID、版本和 hash 不变，合成模型输出仅构造一次。旧 v2 与 on_delivery 各发生一次 Word 阶段失败，分别退回已扣积分或释放原预留；重复终结返回 409 且账本不变。 |
| `node scripts/billing-functional/m4-billing-policy-compatibility-verify.mjs` | [13 passed / 0 failed / 0 skipped，exit 0](m4.json) | 相同分支覆盖旧 M4 文档任务；两份成果在尾款未结时不可下载，补款后原字节下载一致，未重新生成。 |

每项 13 个检查包含原来的 10 项及新增的 3 项，不与前轮重复累计。每份报告有四个真实 pipeline 场景：原有成功接管、尾款暂停与恢复、两种政策的失败。最终两个账号的账务审计均一致、活跃任务均为 0；真实商户与模型调用均为 0。

实际执行的是产品 HTTP、输入锁定／材料读取、`runPipelineOnce/defaultRunStages`、队列租约、成果登记和结算；模型与 Word 产出阶段为 synthetic。失败场景断言确实进入指定阶段一次，不以输入门禁提前失败代替退款测试。尾款场景核对持久成果与模型替身调用次数，不只比较最终余额。M4 历史 on_delivery 报价为明确追加的当前格式 fixture。

这证明当前二进制不同计费配置与已持久化 policy 的兼容，不是历史二进制/schema 迁移、未知供应商结果或实际用量对账，也不证明真实模型内容质量、商户收退款或线上部署。新专项首次完整执行即通过；随后加强阶段进入断言、报告审计字段并在最终源上完整重跑，原件均保留在忽略的本地目录。

独立只读复审及主 agent 检查了失败阶段进入、原 reservation/quote/policy、逐来源分配、终态重放与成果复用断言，未发现实质缺陷。证据无登录会话或凭证；运行与原件 SHA256 见 provenance。
