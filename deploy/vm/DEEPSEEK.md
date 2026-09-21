# Azure VM 的 DeepSeek 配置

VM 的项目任务和独立对话均使用 DeepSeek V4.1 Flash，API 模型名为 `deepseek-flash`。Compose 显式设置 `BOND_CODEX_PROVIDER=deepseek`、`BOND_CODEX_MODEL=deepseek-flash`、`BOND_CODEX_REASONING_EFFORT=max`，后端把它们传入同一个 `codex exec` 调用。这里只适用于 `deploy/vm/compose.yaml`；本机启动与 Container Apps 不会自动切换。

## 两个独立的配置目录

| 服务 | 命名卷 | 容器中的 Codex 目录 |
| --- | --- | --- |
| app | bonddraftai_codex | /data/codex |
| conversation-worker | bonddraftai_worker_codex | /data/worker-codex |

主机 `/home/azureuser/.codex/config.toml` 已保存可复用的 DeepSeek 凭据，`/home/azureuser/.codex/models-deepseek.json` 已保存官方模型目录。发布时仅提取所需凭据与模型目录，为每个容器生成下列配置；不要把主机整个 Codex 目录、MCP、Skills、历史记录或网页登录密码复制给 Worker。

```toml
cli_auth_credentials_store = "file"
model = "deepseek-flash"
model_provider = "deepseek"
model_reasoning_effort = "max"
forced_login_method = "api"
web_search = "disabled"
model_catalog_json = "/data/codex/models-deepseek.json"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
experimental_bearer_token = "<仅在服务器配置文件中写入已有的 DeepSeek 密钥>"
```

Worker 的 `model_catalog_json` 必须改成 `/data/worker-codex/models-deepseek.json`。两个文件均由容器用户 `10001:10001` 持有；含凭据的 `config.toml` 权限设为 `0600`。真实密钥不写入源码、发布包、命令参数或日志。本例中的占位文本不能作为实际密钥使用。

Worker 每次启动会重新生成配置，只保留模型、推理强度、模型目录、认证模式以及当前服务商的必要连接字段；显式设置 `web_search="disabled"`、`shell_tool=false`、`view_image=false`，移除其他工具、钩子及项目配置。也支持 `env_key="DEEPSEEK_API_KEY"`；采用这种方式时须另行向两个容器提供该环境变量，Worker 只把这一个服务商密钥加入子进程允许列表，不转发网页登录密码。

## 发布与验证

1. 核对 `/opt/bonddraftai` 的实际源码和运行中镜像版本。应用有未提交的本机改动，不能用整个本机工作目录覆盖生产。将本次针对模型配置的补丁合入与线上一致的发布源。
2. 保留旧镜像，并备份将修改的源码和两个卷内的 Codex 配置。构建新镜像；不要删除或重建五个持久化卷。
3. 在维护窗口确认项目任务及独立对话都没有 `queued`／`running` 任务，暂停接收新任务，再更新两个卷内的配置、模型目录并重建同名服务。保持只读沙箱、非 root 用户、默认 seccomp 及 `no-new-privileges`。
4. 检查 `/api/health`、`/cowork.html` 和 Worker `/health`。应用的 DeepSeek 就绪状态检查只验证本地配置及 CLI 可启动，不等同于 API 连接成功。
5. 使用虚构材料分别通过 `backend.runner.Runner` 项目任务和独立对话 Worker 执行真实调用，验证返回符合原 JSON schema、所选模型为 `deepseek-flash`，再确认 Word 导出。`codex login status` 的 ChatGPT 登录状态不能作为 DeepSeek 就绪依据。
6. 再重启 Worker，确认模型／凭据／模型目录仍被保留且独立对话可正常回复。验证失败时恢复备份配置和原镜像。

本地回归检查：

```bash
python -m unittest tests.test_deepseek tests.test_cli_environment tests.test_standalone_conversations tests.test_cowork -q
```

回归测试使用模拟凭据和测试子进程，不消耗真实 API，也不能代替生产环境的真实调用检查。

DeepSeek Responses 不提供 Codex 内置网页搜索，应用会同时禁用相关 CLI 参数和提示中的联网能力。来源材料上传与手动导入公开网址仍可使用。

参考：[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api)、[DeepSeek Codex 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)。
