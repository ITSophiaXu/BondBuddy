# DeepSeek 的 Codex 上下文配置

2026-11-05，用户要求将 BondBuddy 调用 DeepSeek 时的 Codex 上下文设为 1M。

适配器为当前 `model_provider=deepseek`、`model_id=deepseek-flash` 显式传入 `model_context_window=1000000` 和 `model_auto_compact_token_limit=900000`。普通调用、材料工具、图片输入、文件编制和续接会话使用同一配置入口。其他模型和 provider 保持自己的配置。

Codex 0.154.0 会将窗口参数限制到模型目录的 `max_context_window`，因此同时提供 DeepSeek 专用目录，将 `context_window` 和 `max_context_window` 均设为 1,000,000。保留该版本回退模型的其余能力、图片支持、95% 可用窗口比例（950,000 tokens）及默认指令；默认指令取自上游 `rust-v0.154.0/codex-rs/models-manager/prompt.md`，不改动任务编制规则。生产 worker 镜像和本地集成 worker 打包清单均包含此目录。

线上现用 Codex 0.154.0 对未登记模型使用 272,000-token 回退窗口；该版本默认自动压缩阈值为窗口的 90%。显式配置消除这一回退，保留 10% 的压缩余量。1M 按十进制 1,000,000 tokens 计。本次不调整模型 ID、推理强度、工具权限、任务账务或重试策略，也不将扩大窗口宣称为原暂停故障的已验证修复。

此变更须进入 worker 发布包后才对新启动的 Codex 进程生效；现有运行不动态更改。无数据库迁移和新增依赖。开发 chat 不执行生产部署、服务重启或原任务重试，交由统一发布流程集成和验收。

## 验证

- 7 个 workspace 的构建完成，包括 worker TypeScript 和 web TypeScript/Vite。Web 保留既有的大 chunk 提示。
- 适配器定向测试 3/3 通过，覆盖 DeepSeek 四种调用方式、模型目录上限、其他 provider 及原隔离参数。
- contracts 测试 72/72 通过；179 个合成示例、12 个内部资料库示例和 4 个生命周期示例校验通过。
- 原生 Codex 0.154.0 在 `network=none` 的隔离容器中使用本地合成 Responses 接口完成两次调用。持久化事件 `event_msg.token_count.info.model_context_window` 显示：仅传 1M 参数仍为 258,400；同时加载新目录后为 950,000。验证了旧上限确实被解除。没有访问真实供应商或使用生产凭证。
- 原有文件编制流程测试 4 项因当前本机为 Windows 而按既定规则跳过；未将跳过计为通过。

上游对应实现：[窗口覆盖与最大值限制](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/src/model_info.rs#L26)、[默认指令](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/prompt.md)。

状态：开发和自测完成，代码完成，尚未部署，待统一发布；不代表本地集成版或用户验收已完成。
