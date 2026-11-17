# Copilot 文件编制认证与目录验证（2026-11-17，Refs #1508 / #1509 / #994）

本记录覆盖 PR #1483 本地隔离复测中发现的认证 helper 权限与 Copilot 文件编制模型目录问题。**本次真实尝试返回 HTTP 400，不是 413 复现；业务任务尚未完成，真实修订版、清洁版双 Word 尚未交付。** 以下离线结果不能替代供应商兼容性或大 PDF 全流程验收。大 PDF 的原有根因与保护证据见 [2026-11-16 验证记录](large-pdf-request-budget-20261116.md)。

## 实际失败及直接根因（#1509）

失败使用候选 `b1930a5eb910bb65c610afc9c3bab2f275562fb6`、worker 镜像 `sha256:8471162cf66a73145d1f40a36371f6018b80a9c5be0ccc32f80488a38530e006`、Codex CLI `0.169.0`，模型通道为 `copilot_enterprise / gpt-6-sol / max`。这是本机私有隔离 Qx harness，不是生产部署。

- Run：`1792b8a7-3c84-479a-a24f-f3b54c051998`；attempt：`call-55d98427-6638-4e16-ba73-773545b76d03`。
- gateway 记录 1 次 HTTP 400，实际请求 **89,892 B、4 个 input item、0 张图片**，没有本地预算拒绝或 HTTP 413。日志明确返回 `bad request: missing required Authorization header`。
- 实际容器使用 node UID 1000。只读检查得到 helper `X_OK=false / EACCES`，credential `R_OK=true`；没有执行 helper 或读取 credential 内容。
- helper 源文件为 **0664、root:root、569 B**，Git 文件模式为 `100644`；所有执行位均关闭。原文件保持不变。既有检查时间为 `2026-11-17T02:54:10.927686Z`，后续只读 stat 于 `03:04:31.379141Z` 再次确认 0664；早期摘要中的 0644 不准确。
- 公开 helper 的 SHA-256 为 `97b38fdfff3361a16a68d1f9b8be4f0526f7893b51caf200a1e6b87487d6d066`。原 exec 证据为 2,884 B，SHA-256 `3ec40e28e51daa2a3948a7191784eba470d3c7bec486c9d40a52c428f5757e50`；不提交原始执行日志、客户材料或凭据。

私有 harness 将 Git archive 中没有执行位的公开 helper 以只读 bind 覆盖到 `/usr/local/bin/bb-copilot-token`，覆盖了镜像内的 helper。正式 `local-prelaunch` 同样允许 `model.compose.yaml` 提供该 bind，但此前 `validateCompose` 未检查执行权限，`runtimeSourceHashes` 只记录字节哈希。标准 `local-integration` 将 helper 放入镜像并 `chmod 0755`，未观察到同样的覆盖路径故障。

因此，本次 400 的直接原因是 helper 无法执行，使 CLI 没有取得 Authorization。诊断不支持“CLI 0.169 不支持 auth.command”的推断。失败后的用量仍为 **unknown**，不能因缺少 Authorization 改记为零用量或 confirmed-not-sent；run 保持待核对语义，原始观察保留。

## 固定 CLI 的断网 A/B

诊断使用真实 Codex CLI **0.169.0**、Docker `network=none` 内的 loopback 合成 provider、synthetic token；**0 次供应商调用，没有挂载真实 OAuth**。只切换模型目录及公开 fake helper 的执行权限，结果如下：

| 诊断目录 | helper 可执行 | helper 调用次数 | Authorization | loopback HTTP | 请求字节 |
| --- | --- | ---: | --- | ---: | ---: |
| 不含 gpt-6-sol | 是 | 1 | 正确 synthetic token | 200 | 34,249 |
| 不含 gpt-6-sol | 否 | 0 | 缺失 | 400 | 34,265 |
| 含 gpt-6-sol | 是 | 1 | 正确 synthetic token | 200 | 22,283 |
| 含 gpt-6-sol | 否 | 0 | 缺失 | 400 | 22,299 |

不可执行的两组均记录 `Permission denied` 和 `missing required Authorization header`，分类为 `MODEL_TURN_FAILED / unknown`；两组目录都呈现相同鉴权差异。故目录不匹配不能被归为本次真实 400 的直接原因。

该矩阵仅用于隔离鉴权根因。含匹配 slug 的早期诊断目录在首轮输出空 tools，其 HTTP 200 **不代表文件编制工具协议通过**。私有原始收据保留在 `.local/http400-catalog-auth-20261117/receipt-v2.json`，SHA-256 `82705ccd5f720d435c9bb9ed45a8e9119da19e452f7b795cae309e1b2b0865a6`；收据中的 `metadata_fallback_warning` 布尔提取漏报，目录缺失 warning 以其中保留的 `diagnostic_lines` 及原 exec 诊断为准。

## 独立的模型目录问题（#1508）

`buildCodexArgs` 对 command credential 的 `fileAuthoring` 组合选择了 `codex-file-authoring-model-catalog.json`，实际镜像中该目录仅包含 `deepseek-flash`。真实 exec 明确记录 `Model metadata for gpt-6-sol not found. Defaulting to fallback metadata`。这使 Copilot 文件编制使用 CLI fallback 元数据，所需工具与 reasoning/wire 行为未由匹配目录明确控制；该缺陷独立于 helper 权限。

修复范围为新增 Copilot 文件编制专用目录，并同步适配器选择、镜像 COPY、本地 worker snapshot 与验收指纹；保留 DeepSeek 原目录。固定 CLI 的正式回归必须验证实际鉴权、工具 schema、shell 结果进入后续请求以及受控图片回传，不能仅断言 JSON 字段或首轮 200。正式 catalog/protocol 回归收据由主验收记录随后补充；本记录不以私有探索性工具往返结果代替正式新增测试。

## helper 启动前检查及正式测试

`scripts/local-prelaunch/runtime.mjs` 新增 `validateLocalAuthHelperBinds`，在解析 expanded Compose 后、启动容器前检查 `copilot_enterprise` 服务绑定到 `/usr/local/bin/bb-copilot-token` 的源：必须为只读 bind、存在的普通文件，并通过真实 `fs.accessSync(R_OK | X_OK)`。检查失败只给出服务与修复提示，不输出源文件路径或凭据内容，不 chmod 源文件、不执行 helper、不调用网络。不覆盖 helper 的镜像路径及非 Copilot 服务不受影响。

该最小检查验证生命周期进程身份下的文件访问；**不能单独替代实际容器 node UID 1000 的挂载访问证明**。修正私有 worker 的启动流程另行要求 node UID 对实际 helper 做 R_OK/X_OK、对 credential 做 R_OK 检查，并保持只读挂载；该步骤不得读取 credential 内容。

在 WSL Linux、Node **v24.14.0** 执行以下正式检查：

```sh
node --check scripts/local-prelaunch/runtime.mjs
node --check scripts/local-prelaunch/auth-helper.test.mjs
node --test scripts/local-prelaunch/auth-helper.test.mjs scripts/local-prelaunch/upgrade.test.mjs
```

结果：**11 PASS / 0 FAIL / 0 SKIP**，包括新增 3 项 helper 测试和既有 8 项 local-prelaunch 升级/生命周期回归；语法检查与 `git diff --check` 通过。Linux 权限测试创建专属临时文件；父进程为 root 时使用 UID/GID 65534 的 Node 子进程执行真实访问检查，避免 root 绕过读权限位造成假通过。0644、0444、0111 拒绝，0555 通过；缺失、目录、可写 bind 拒绝；镜像 helper、其他挂载及非 Copilot 场景不误拒绝。测试不执行 helper、不运行 Docker，仅清理自己创建的精确临时路径。

两份 local-prelaunch 测试已加入 `.github/workflows/m3-linux-pr.yml` 现有 Linux targeted integration 的显式文件列表，复用该步骤的非零测试数和零 skip/TODO 检查，没有新增 CI job。此前 npm 脚本和 workflow 不会自动发现这些脚本目录测试。此处记录接线完成，不声明远端 CI 已运行通过。

## 候选与业务验收状态

截至本记录新增时，这些后续修改尚未形成新的已构建候选镜像，未部署生产；正式 catalog/protocol 测试结果待补。原真实 attempt 的 unknown 用量和原观察保持，不能将离线测试标记为业务 PASS。恢复必须使用原 run、原不可变输入与原预留，并保留原绝对截止时间 `2026-11-17T07:42:45.393Z`，不能借修配置新建报价或延长截止时间。

尚需固定修正后的源码/镜像，核验实际 node UID 的 helper 权限，通过官方 ops 恢复既有任务，并完成真实大 PDF 输入到修订版、清洁版双 Word 的交付与质量检查。本记录不声明该恢复、生产生效或业务交付已完成。

## 补充：本轮源码的固定 CLI 协议回归

新增 `codex-copilot-file-protocol.test.ts` 最后一次运行 **3/3 PASS、0 FAIL、0 SKIP、0 TODO**，exit 0。使用官方 b193 worker 镜像、只读挂载本轮编译产物和专用目录，保持 network none、cap-drop ALL、no-new-privileges 与原 seccomp；WSL 未启用 AppArmor，不能将此结果称为完整 AppArmor 验收或新准确镜像通过。测试核对镜像目录位置的 catalog 与源码字节一致、实际 CLI0.169、synthetic auth、同 call_shell 的真实 function_call_output 和 command_execution exit0、真实 JPEG input_image、无 fallback/collaboration、400 不重发及 unknown 用量。专用目录保留文件任务指令，未继承图片转录的“禁用工具”提示。

目录 SHA-256 `0f62ff64106b21d6d064d6f266eb170ea1a7ce3aff339b8c4a6fbf0b7119b4d8`；本地脱敏测试日志 SHA-256 `c6b09a2586380d53ff6733002b0194a12747dec1e970713d60129f09f8dd7c8e`。worker TypeScript build、acceptance 22/22、split catalog 定向 1/1 通过。两条新增回归分别接入既有 Linux targeted 列表及同官方镜像的断网专用步骤；远端 CI 尚未证实通过。下一步为固定提交的新官方 worker 镜像构建与原业务 run 恢复。
