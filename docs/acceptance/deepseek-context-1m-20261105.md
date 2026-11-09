> 2026-11-09 合并说明：以下为原 PR #891 的历史验证。当前 develop 已通过 #892 采用显式静态模型目录，并升级至 Codex 0.167.0；本次整合保留现有适配器、目录及两类认证的 1M/900k 设置，本地构建脚本同步当前版本。下文 0.166.0 与每任务缓存记录不代表最终集成实现或当前版本测试结果。

# DeepSeek Flash 4.1 的 1M 上下文与 Codex CLI 升级

2026-11-05，用户明确要求修改 BondBuddy 服务器任务使用的 Codex，使用 DeepSeek Flash 4.1、确保模型配置文件中的上下文为 1M，并升级 CLI。此变更不修改本机 Codex 桌面应用。

## 配置与打包

DeepSeek 官方 API 模型名是 `deepseek-flash`，查询当日对应版本 `DeepSeek-V4.1-Flash-1017`，支持 1M 上下文和 Responses API。保留这个有效 API ID；供应商版本由该别名路由，不能将展示名称 `DeepSeek Flash 4.1` 当作另一个 API ID。

worker 每个进程使用隔离的 `CODEX_HOME`。启动前将随应用打包的 `deploy/m1/codex-deepseek-model-catalog.json` 原子写入该目录的 `models_cache.json`（文件权限 0600），通过 `-c model_catalog_json="<CODEX_HOME>/models_cache.json"` 显式读取。新建任务和续接会话均写入固定目录；不依赖普通远程缓存的 300 秒有效期、客户端版本或供应商身份匹配。保留 `--ignore-user-config`，避免用户全局配置改变任务隔离规则。这里的文件作为本地模型目录使用，不是伪造自动远程缓存的有效期。

适配器仅对 `model_provider=deepseek`、`model_id=deepseek-flash` 设置：

| 字段 | 值 |
| --- | ---: |
| `model_context_window` | 1,000,000 |
| 目录 `context_window` / `max_context_window` | 1,000,000 |
| `model_auto_compact_token_limit` / 目录 `auto_compact_token_limit` | 900,000 |
| `effective_context_window_percent` | 95 |
| CLI 实际可用上下文 | 950,000 |

1M 按十进制 1,000,000 tokens 计。普通调用、材料工具、图片、文件编制及续接会话共用此入口。Codex 仍会把窗口覆盖值限制到目录的 `max_context_window`；因此不能只传窗口参数。其余模型能力、图片支持和默认指令保留原 0.154.0 回退模型配置，默认指令来源为上游 `rust-v0.154.0/codex-rs/models-manager/prompt.md`，不额外更改任务编制规则。默认审计配置版本更新为 `codex-deepseek-v4.1-flash-1m-20261105`；显式环境配置版本仍优先。

生产 worker Dockerfile 及本地集成 worker 构建统一固定官方稳定版 **Codex CLI 0.166.0**，同时更新 x64/arm64 npm SHA512。x64 官方归档已下载，SHA256 与 GitHub Release 资产摘要相符，SHA512 与 npm 元数据相符，实际二进制输出 `codex-cli 0.166.0`。arm64 仅校验官方元数据，未在 ARM 主机运行。应用模型目录被打包到 `/app/deploy/m1/codex-deepseek-model-catalog.json`。

## 验证

- 先前同一 PR 的 7 个 workspace 构建通过，包括 web TypeScript/Vite；contracts 测试 72/72、179 个合成示例、12 个内部资料库示例、4 个生命周期示例通过。Web 只有既有大 chunk 提示。
- 本次 worker TypeScript 构建及 5 项定向适配器测试通过，覆盖四种 DeepSeek 调用方式、实际缓存文件、其他 provider、隔离参数和成功结果持久化。
- 原生 Codex 0.166.0 使用更新后的 `runCodexProcess` 和本地合成 Responses 接口：新建与续接均成功；故意清空续接前的模型目录后会重新写入固定配置；持久事件 `event_msg.token_count.info.model_context_window` 两次均为 **950,000**；请求模型均为 `deepseek-flash`。
- 原生文件权限预检通过；CLI 执行一次真实 `exec_command`，将合成文本写入允许的 output 目录；Stop hook 在必需文件缺失时确实触发一次补正，第二次请求包含完成检查反馈。共 6 次本地模拟请求，未调用真实供应商。
- Linux 文件编制测试 4/4、完成钩子测试 3/3 通过，无跳过。覆盖文件采集、取消后进程组终止、不重复发送、无最终文字时采集文件、已知无效结果与存储错误的区分、完成钩子及防伪造文件规则。
- 隔离容器使用非 root、只读根目录、`cap-drop ALL`、`no-new-privileges`、`network=none` 和资源限额；无生产凭证、数据库或材料。Docker Desktop 无 AppArmor，直接使用生产 seccomp 的首次文件权限预检拒绝；改用项目已有的本地 no-proc 收紧规则后通过。生产 seccomp/AppArmor 配置未修改，未以取消沙箱获取通过。生产 AppArmor 组合仍须由统一发布流程验证。
- 历史对照：0.154.0 仅传 1M 参数时实际窗口为 258,400；加载同一 1M 模型目录后为 950,000，证明目录上限是必要配置。

GitHub Actions 自动检查未启动：检查注释提示账户最近付款失败或消费额度不足（`The job was not started because recent account payments have failed or your spending limit needs to be increased`）。这不是已运行测试的断言失败；云端 CI 未通过，需恢复 Actions 额度后重新执行。

本地私有诊断目录保存原生验证脚本、版本/完整性回执、模拟事件及结果；不将真实任务材料或凭证放入 PR。

## 集成与发布边界

必须构建新 worker 镜像并按统一发布流程集成、验收、发布，才会对新启动的服务器 Codex 进程生效；现有运行不动态更新。无数据库迁移和新增应用依赖。回滚使用发布前固定 worker 镜像，不能只撤掉模型目录而保留指向它的配置。

此变更没有重跑原沧州交投任务。原暂停故障未复现，不能将扩大窗口或升级 CLI 宣称为已经验证的故障修复。

**状态：开发和自测完成；代码完成，尚未部署，待统一发布。未完成完整本地集成版验收或用户验收，生产配置、CLI、服务和任务均未修改。**

## 来源

- [DeepSeek 官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing)：API ID、Flash 4.1 版本、1M 上下文。
- [OpenAI Docs 配置参考](https://developers.openai.com/codex/config-reference/)：模型目录、窗口和压缩配置。
- [OpenAI Docs CLI 更新记录](https://developers.openai.com/codex/changelog/)；[官方 0.166.0 Release](https://github.com/openai/codex/releases/tag/rust-v0.166.0)。
- 上游 0.166.0 实现：[普通缓存校验](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/models-manager/src/cache.rs)、[模型目录加载](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/models-manager/src/manager.rs)、[窗口最大值限制](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/models-manager/src/model_info.rs)。
