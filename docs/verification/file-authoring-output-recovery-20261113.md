# 文件编制输出超限与旧任务恢复补修

2026-11-13，Refs #1323、#1324；PR #1302。开发与自测完成，尚未部署；真实 Copilot 重跑待核验。真实结果单独记录，不以合成测试代替。

## 已复现原因

此前真实回放在 3 小时 15 分钟、2989 次工具调用后触发 `MODEL_OUTPUT_TOO_LARGE`，进程 SIGKILL，任务停在 `provider_reconcile`。文件编制仍按整场 stdout 累计 32 MiB 终止；之前恢复分支只处理 HTTP 413，没有保存该次工作快照，立即重试返回 blocked。详见[原回放证据](local-copilot-replay-20261113.md)。

保留的日志前缀至少包含 1039 次显式读取 task.md 的命令，且多个框架索引内容相同，证明存在重复准备工作。未取得直接上下文压缩或 Stop hook 触发证据，不能把它们写成已确认根因。

## 改动

- 文件模式按单个 JSONL 事件 4 MiB、最后回复 1 MiB 控制实时内存；累计小事件允许超过原 32 MiB。日志仍截断在 20 MiB，非文件模式的累计限制保持原语义。
- 真实超限在已退出且租约有效时先保存 input/scratch/output，校验后发布检查点，再清理工作目录。未知用量和原 observation 保留。
- 自动扫描与用户重试共用严格恢复条件及预算。有效快照可继续同一 run；无效快照或次数耗尽明确失败；旧无快照任务保持暂停并提供需确认的原材料重新处理。
- 旧任务重新处理创建独立指令快照，保留旧 snapshot 和 logical call。完成结果的纯重放允许后续篇幅修复阶段，任何无关调用不得借旧确认获得发送权限。
- 完整可信说明注入首次提示；保留同字节文件副本，项目数据不混入可信说明区。工作记录必须写实际进展、具体下一步和已保存文件；复用已核对缓存，不重复探测不可用命令。
- 页面区分待核对、已排队续跑、失败与旧任务重新处理，通用调用待核对文案不再声称进程一定未退出。重复点击/回执丢失沿用同一请求 ID。

## 自动化验证

全部为合成输入或合成供应商响应，未在以下测试中调用真实模型。

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| contracts/domain/registries/API/worker 编译 | 通过 | 当前工作区依赖链接指向自身编译产物 |
| 契约示例 | 179 + 12 内部示例、4 数据生命周期示例通过 | 兼容性与恢复/用量不变量 |
| 契约测试 | 72 pass / 0 fail / 0 skip | 公共 DTO 回归 |
| Windows 适配器/指令/恢复 | 75 pass / 0 fail / 0 skip | Node 22.14.0，真实合成子进程 |
| Linux 适配器/沙箱/恢复/格式 | 97 pass / 0 fail / 0 skip | 独立离线容器，真实 CLI sandbox preflight、Python、>32 MiB流与边界测试 |
| API 供应商事件 | 6 pass / 0 fail / 0 skip | 输出超限保留 pending_reconcile 原始观察 |
| 旧任务指令快照重放 | 6 pass / 0 fail / 0 skip | 包含手动→自动→完成→篇幅修复、owner restore 两种确认值、临时数据库错误传播 |
| 原 timeout PostgreSQL 回归 | 1 pass / 0 fail / 0 skip | 独立 PostgreSQL 16，旧恢复行为保持 |
| 输出/HTTP 413 恢复 PostgreSQL 回归 | 1 pass / 0 fail / 0 skip | 最终恢复链版本 202.834 秒；并发、用量、预留、旧任务确认、人工暂停与预算 |
| 网页状态 | 18 pass / 0 fail / 0 skip | 精确的 failed/paused 终态、无重复保留提示 |
| Playwright | 11 pass / 0 fail / 0 skip；修正终态和暂停撤销入口后相关 5 项再次通过 | 真实页面 + 合成 HTTP fixture，6 状态×桌面/移动与重试幂等 |
| 前端类型检查 | 通过 | 包含浏览器测试类型 |

首次组合测试的新用量断言比较了包含可变 attempt status 的视图，改为核对用量字段及不可变 usage/provider observations 后，完整恢复套件重跑通过；原日志保留，不把失败改写为通过。最终审查发现的 manual→auto→完成→repair 组合重放补修后，恢复 PG 与 helper 共 7/7 通过、0 fail/skip（214.468 秒）。旧 output 的用户暂停撤销入口已验证：重复点击只发一次 resume，撤销后仍保持系统暂停；再次点击并明确确认才发出 restart。此前 GitHub CI 因账户账单/支出限制未启动，不能称为通过。

UI 同尺寸合成截图、实现/原型差异、复现命令见 [界面对照](../../apps/web/test-evidence/output-limit-recovery-20261113/README.md)。保留既有布局，不把自动化通过当成产品负责人已确认或用户已验收。

## 集成边界

无数据库迁移、无新增 npm/pip 依赖。API、worker、web 需协调更新；真实重跑仅操作已隔离的本地测试环境，沿用用户授权的 Copilot，不连接或修改生产任务。第一次失败的 attempt、原始 observation 和终态证据保留，不从诊断备份伪造恢复检查点。质量门禁及全文/格式要求不放宽。
