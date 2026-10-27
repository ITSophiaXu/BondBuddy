# 准确执行交付记录（2026-10-27）

起点 `b893ea9c`，分支 `codex/desktop-ux-coverage-20261026`。本增量为 G03 / UX-A03 建立准确实际交付边界。**完整 goal 仍 active，G03 未完成。** 用户已选择 B“必要重做另行报价并确认”，具体计价基准尚未决定；本轮没有采用新材料、后继执行或追加收费。

## 改动及证明范围

- `0126_run_execution_deliveries.sql` 冻结完整执行/输入身份、准确主文件与成员版本/hash、名称依据、配对和交付时间。候选可用不表示已交付。真实终态在既有结算守卫后捕获，event/outbox/业务登记失败使整笔事务回滚；暂停、动态余额不足和待结算不冒充 final。
- 单独的 `m4_durable` 保留旧非动态 M4 已登记文档/说明与 QA 文本的读取权限；终态及终态事件均为 NULL，不宣称成功或新增收费。完整 final 优先，损坏 final 只能回退独立有效 durable。无法准确回填的历史保存结构化 gap，不能用旧 run 成功兜底授权。
- 通用公开读取使用严格交付 view；命名和配对使用冻结 details。历史在完整 final phase 证明后读取准确成员，按交付时间/run/execution 稳定分页；助手成果选择、最新成果和 Worker previous_output 不再被当前 job 配对、run 主文件/状态或时间替换。实时归属、质量/撤销、test grant 精确输入及撤销/过期检查保留。
- 13 个新 PG 测试使用真实 promoter、finish、lease 和事务，覆盖候选隔离、暂停/余额、回滚、不可变记录、成员/底层来源损坏、两阶段、跨时区、并发重放、历史缺口及真实迁移锁竞争。HTTP 和 Worker 读取核对准确字节、旧 grant 无法绕过缺失来源，并保留原任务、历史和积分。

## 采用结果

每项都是独立调用，有重叠，**不相加为总通过数或 UX 覆盖率**。准确命令、环境、时间、退出码及跳过标题见 [summary.json](summary.json) 与 records 原文。

| 集合 | pass | fail | skip | 采用调用 |
| --- | ---: | ---: | ---: | --- |
| API 交付记录/执行来源/身份 | 41 | 0 | 0 | api-focused-1 |
| API 实际消费者最终复验 | 92 | 0 | 1 | api-consumers-2 |
| API 交付与既有计费 | 13 | 0 | 1 | api-delivery-1 |
| Worker 定向单元 | 62 | 0 | 2 | worker-unit-1 |
| Worker PG / 登记 / 恢复 | 38 | 0 | 4 | worker-pg-1 |

API/Worker 构建与契约检查通过；契约校验为 186 个合成样例和 12 个内部样例。空库实际回放 0001..0126，最终使用独立模板 `...20261027d`。Windows、Node 24.22.1、PostgreSQL 16.14；清除继承 BB/provider/Azure/DB/PGOPTIONS 配置，最终运行未全局开启 runtime，也没有 JIT 覆盖。跳过项逐条保留，未计通过。无本轮浏览器、真实模型、Azure、支付或 Word/WPS 排版验收；材料与私有字节均为 synthetic。

## 失败和修正

首次迁移在 0126 的 PLpgSQL CASE 比较处报语法错；修正后发现 provenance view 复合行不能直接传入 base-table 参数，改为真实 artifact 行并保留准确 provenance join。相关首次日志及 probe 留存。规范化 UTC 成员 JSON 防止跨时区误拒；任一成员底层来源损坏时，完整对应 phase 拒读。

首轮各组原文保留：API focused 为 38 pass/2 fail，消费者 82 pass/10 fail/1 skip，交付 12 pass/1 fail/1 skip；Worker 两组通过并分别有 2/4 skip。旧迁移测试需要完整拆除私有 clone 中的后继 scaffold；旧人工交付 fixture 的 job/run 顺序、时间和事件游标不一致，已忠实修复，没有放松生产守卫。第二轮消费者为 88 pass/4 fail/1 skip：新增列表 phase 校验的 `completed` 名称被同名统计整数列遮蔽，明确改名后全组复验通过；SQL probe 记录真实 42883。

历史重复展开来源/交付 view 导致明显耗时。非内联、调用方权限的 per-phase predicate 保留完整证明，再将历史改为读取该证明下的准确成员。该同一历史测试在本轮先后为约 129.6 秒、87.2 秒，最终约 4.3 秒；独立 JIT-off 诊断为约 107.3 秒，只用于诊断，未采用为最终通过或通用性能承诺。

三次验证前后各 1,674 个源码/编译/契约/迁移文件哈希一致。第二轮至最终只改变 history、对应集成测试和项目列表别名的六项 src/js；随后重建 API 并完整复跑消费者集合，没有声称再次重跑其他已通过组。准确差异见 summary 的 source_freezes。

专用 PG 端口 15528、启动记录 PID 38116。最终模板的 run/execution/业务快照/artifact/binding/delivery/member 均为 0；前三个诊断模板也核对为空，没有测试 clone 或其他连接。停止后 pg_ctl 返回已停且无 postmaster.pid，见本轮 pg-stop 原文。initdb elevated 完成状态引用工具转录，未伪造一份未捕获的原始 stdout。

原始 JSON/log 按字节归档，目录属性禁用换行转换；manifest 为除自身外的文件记录长度和 SHA-256。复现脚本位于 [reproduce/verify.mjs](reproduce/verify.mjs)，归档校验/收集脚本为 [reproduce/collect.mjs](reproduce/collect.mjs)。没有复制 PostgreSQL 数据目录、凭证、客户原件或生成的业务 Word。

## 剩余边界

仍只执行 V1。按 run 唯一的复核报告/editor、M4 成果登记、输出 ID、版本检查点和真实增量处理尚待推进；后继采用、B 追加价格/确认/账务、材料生命周期闭合及同任务新版 Word 全旅程尚未完成。独立有效 durable 不能证明一个损坏 final 的成功状态或时间；view 本身也不是全部下载授权。

另已确认旧 history DTO 要求任何配对必须有 baseline，因此合法两成员首稿虽然有准确 receipt、下载及助手选择，仍会在该历史列表漏列。该独立待修边界保留，不据本增量宣称历史功能全覆盖。G03 和完整 goal 均不关闭；本轮仅本地提交，没有 push、PR 或部署。
