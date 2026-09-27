# 上交所普通私募测试字典使用决定

记录时间：2026-09-27。记录人：Codex，按用户委托推进 #19/#20 内部测试；不是专家个人签名、具体项目事实审核或生产发布记录。GitHub 逐项答复见 [#19](https://github.com/ITSophiaXu/BondBuddy/issues/19#issuecomment-5856710917)。

## 固定范围

允许已授权上交所普通私募项目的非生产适用性审核使用 `bondbuddy-applicability-sse-private-v3`，对应 dictionary `sse-private-applicability-v3`，内容 SHA-256：`d3feccf27a5a4c833402cbc1dd08bb96edcc35cad2f0ed00626b986a663b1c95`。沿用既有 A01–A06 与 A03 九维映射，不改变任何值的语义。代码采用唯一公共字典，不能在业务文档另造枚举或仅凭客户端版本字符串批准。

采用独立 test-only taxonomy 门。生产 published taxonomy 白名单与生产 rule-pack registry 不因本决定改变。研究规则包保持 `2026.09.27-draft.6` / research_only；31 条业务采用决定不等于具体项目 overall approve。

## 审核与消费顺序

1. 锁定原始 input 和完整材料集合，产出证据 context，由实际获授权 reviewer 按原有机制审核。
2. 新 execution input 保存精确不可变的 context id/version/hash、source input revision/hash 及材料绑定；生产规则选择未成功也不能丢弃该引用。
3. 对最终 execution input 签发有期限 test grant；原始审核不依赖尚不存在的执行 grant，避免循环。
4. 测试 loader 消费时必须验证 preprod + enabled、有效 grant、owner/project/input、同一授权 case 的数据库 membership、taxonomy/rule-pack hash、实际审核和 issuer binding。领取、恢复、每一阶段及模型调用前重验。

证据审核继续区分工具、发行人、投资者、行业和九维特征；目标确认不替代这些事实。目标法规适用日不取财务截止日。撤销、材料替换及新的审核决定使旧批准按既有机制失效。共享校验可复用，生产调用不得默认接受测试分支。

## 实际账号与剩余交付

部署负责人通过已有 `rule-applicability-reviewer-grants` 运维入口签发精确 owner/project grant；使用真实账号、理由与 outbox，遵守既有授权人/审核人/项目 owner 隔离。不得预置假 reviewer、把本分析变成用户的系统签名或为此设置自审豁免。

#19 负责测试 taxonomy 与实际 runtime loader；#17/#35 负责独立 input ref/pin、运维授权和目标环境；#329 负责精确规则资产与模型消费者；#337 补覆盖缺口的公共结果契约。真实生成后的规则/章节验收归 #332，不回填成首轮生成的前置条件。
