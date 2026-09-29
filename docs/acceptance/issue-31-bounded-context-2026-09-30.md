# #31 全文生成容量与恢复边界（2026-09-30）

## 触发与改动

[#31 实测回执](https://github.com/ITSophiaXu/BondBuddy/issues/31#issuecomment-5892414994) 的授权历史 DOCX 有 9,690 条记录。旧实现每块最多 80 条，至少 122 个顺序模型调用，每次重复传完整规则。两次真实调用累计 input 139,003 / output 25,173 tokens；第三次结果及用量未知，原 run 已取消，没有 Word。本变更不重放或抹掉那次未知调用。

新策略对原文四字段与规则 rules/sources/coverage.items 使用 `columns/rows` 无损编码，减少重复字段名。完整引用、原文定位、例外、来源状态和不确定性保留；事实/决策/证据审核仍全量进入 prompt，不进行按关键词筛选、摘要截断或默认 retain。模型仍须对每个 record_id 显式作出一次决定。最多 512 条/块，同时保留 24,000 原文字符与 240,000 UTF-8 prompt 字节上限；完整表格能装下时保持一块，超限表仍不能伪造完整新增列。

首次调用前计算全部分块和实际 prompt，最多 32 个逻辑调用；超限使用已有 capability_not_ready 暂停并保存内部计数，不先花费再发现尾部超限。整体清单固定准备哈希、模板/schema、每块顺序/记录 hash 和完整 prompt hash，任何后续块变化都在重放首块之前拒绝。旧 80 条策略的调用检查点不迁移到新策略；已经开始的旧 run 必须先由平台对账，另建获授权的新 run 验证本策略。

内部模板改为 `historical-sse-private-v4` / `historical-sse-private-test-v3`，模型响应 schema 为 `historical-generation-v2`；不改公开 DTO、枚举、数据库迁移或 UI 操作。提示资料仍是无权覆盖系统规则的不可信数据。Word 交付和来源/身份/授权门保持不变。

## 验证

- Windows、Node 22；完整 build 和 contracts 校验通过。历史模型阶段 **55/55**（启用原件只读解析，0 skip）：完整覆盖、遗漏/重复拒绝、未知事实拒绝、UTF-8 边界、撤权、精确恢复、后续块篡改、旧策略拒绝、容量超限零调用及 Word 待核说明传递。
- 同一授权源 SHA-256 `51f77e36dcdc8b565f9a7b58ebf87cb6be4839a3444b8602df833e3fd61ef678` 从原 DOCX 重新解析，校验原件前后 hash；parser `bondbuddy-document-parser-1.0.7`，**9,690/9,690** 记录按原顺序恰好一次分配为 **24 块**。规则上下文由 169,529 字节无损编码为 147,745 字节，另预留 20KB 给其余输入和 256 字节表头预算。这是容量检查，不是目标服务器实际冻结事实集的模型调用数；目标环境须读取实际 batch plan。
- JSON 输出 schema 标准化测试 **2/2**。尝试在 Windows 运行完整 adapter 套件时，既有 Linux 环境隔离与 SIGKILL 断言不适用，停止该运行；不声称完整 adapter/Linux 隔离通过，未修改这些断言。该 PR 未改 adapter 实现。
- 未调用付费模型，未生成真实 Word，未上传客户原文/解析文本/生成成果。合成模型恢复与 Word stage 测试不代替真实验收。

只读样本复现：设置 `BB_RUN_AUTHORIZED_SAMPLE_TESTS=1` 和 `BONDBUDDY_TEST_PYTHON` 后，构建 worker，执行 `node --test apps/worker/dist/historical-model-stage.test.js`。原件读取由仓库 `parse_authorized_sample.py` 做清单及 hash 校验，输出只留在子进程内存，不提交到 Git。

## 部署和最终验收依赖

@muhualing 在新版本部署后，先完成既有 unknown 调用对账；确认新 run 的 exact input/material/parser/profile/rule/authorization pin，查看 `historical_generation_batch_plan` 实际块数/总字节。超过容量时先处理上下文，不盲目提高上限或开始部分更新。由相同授权原件检验完整调用、真实 usage、全部记录处理、Word 交付检查及可下载，再回填 #31/#35/#448。成本/完成时间在此之前不承诺。

32 是逻辑调用上限；适配器现有最多 3 次 schema re-ask，因此在没有另行 operator_retry 决定时，自动尝试上界为 128 个有日志的 provider attempts，正常配置更少。平台人工对账后另批重试不包含在该自动上界内，须单独记录授权与用量。未知 attempt 仍必须对账，恢复不新增逻辑调用；byte 数不是 token 计费或美元估算。该策略降低重复输入但尚未证明真实输出长度、耗时、语义质量或专业通过。#31 和用户实测 B03 保持待验。
