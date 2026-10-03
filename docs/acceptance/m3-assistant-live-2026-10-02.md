# M3 项目助手：实际 Copilot 五场景探测

2026-10-02T12:34:20Z–12:38:00Z，Codex CLI 0.159.2，通过当前 `copilot-enterprise` 配置运行；保留既有账号、自动审批和只读沙盒，工具关闭。提示词与输出 schema 取自当前 `review-assistant.ts`，供应商 schema 经实际 `normalizeCodexOutputSchema` 转换，回复经 `validReviewAssistantReply` 校验。

业务上下文为 **synthetic**：项目 P1、报告 R1/V1、问题 F001/F002/F005、募集书及更名证明均为合成值。回复和用量来自实际供应商。该探测未使用真实客户材料，也没有经过部署后的 API、持久化队列和浏览器；它验证提示词、供应商兼容性及回复行为，不代表完整联合验收或专业成果签认。

| 场景 | 实际回复观察 | input | output |
| --- | --- | ---: | ---: |
| 业务口径 | 区分母公司与合并口径，要求原文、日期及差异依据，不默认全稿统一 | 10,758 | 1,308 |
| 结论异议 | 保留原 F002，整理历史名称异议；缺证据不直接判通过 | 10,777 | 1,270 |
| 材料解释 | 引用 synthetic-change-certificate V2/certificate-p1 及2025-08-01生效日期，未覆盖当前报告 | 11,026 | 1,019 |
| 跨问题计划 | 提议纳入F001/F002、排除F005；保留标题样式及原报告；采纳和执行分开 | 10,789 | 1,669 |
| 运行中补充 | 保留RUN1/V1；新附注用于下一轮；明确完整复核无需采纳修订计划 | 10,785 | 1,213 |
| 合计 | 五次均exit0、schema有效、无工具事件 | 54,135 | 6,479 |

总用量60,614 tokens。cached input46,660已包含在input中，不再次相加。前两次 schema 被拒绝的诊断调用未返回用量，保持unknown，不计成零。完整五场景输出和prompt hash保存在同目录的[合成场景真实回复证据](m3-assistant-live-evidence.json)中。

实际探测暴露并修复两项问题：

1. Copilot的结构化输出不接受`uniqueItems`，返回`invalid_request_body`。适配器只转换发给供应商的schema副本；原始本地schema继续检查唯一性。已加入重复ID被拒绝的回归；明确schema/请求拒绝归类为`MODEL_PROVIDER_REQUEST_REJECTED`，不盲目重试。
2. 运行中补充场景曾把修订计划采纳误作为完整复核前置。助手指令现明确两条路径，修正后重跑全部五场景；上表仅引用修正后的最终结果。

公开 web search 仍未取得真实工具事件，单独见[集成记录](m3-implementation-2026-10-02.md#实际公开搜索能力探测)。这五个无工具助手场景不补齐搜索、授权真实材料联合运行、Word/WPS专业成果或生产发布验收。
