# #1339 模型预检渲染失败交接至宿主验收

状态：代码和本分支自测完成；未合并、未部署，待与 #1302 统一集成及发布。本文不代表用户已验收。关联缺陷：[#1339](https://github.com/ITSophiaXu/BondBuddy/issues/1339)。

## 范围与保留边界

受控 DOCX 编制的预检若仅剩 `WORD_PAGE_COUNT_UNAVAILABLE`，模型可能反复修改正文或重试同一沙箱渲染。本改动在本次工具结果中提供 `host_handoff.action=defer_page_rendering_to_host`，仅将页数渲染延后至既有 worker 在模型沙箱外执行。`authoring_completion=not_verified` 明确该工具不判断业务编制是否完成。

- 只有 `snapshot_current=true`、预检和嵌套质量报告均为 `failed`、两份非空错误列表一致且全部为上述渲染错误，才返回交接提示。提示绑定本次 `operations_sha256`；输入、底稿和日志仍执行原有路径、字节及 hash 检查。日志变化后必须重新预检，旧报告不能授权新版本。
- 编制中途收到提示，不得跳过剩余材料阅读、章节与事实更新、来源回查或原任务其他待办。按既定缺项可出工作稿政策完成业务编制后，对最终操作日志重新预检，保存诚实的 `delivery.md` 再结束模型执行；该字段不新增人工确认、材料齐备或业务事实批准门槛。
- `status=failed`、退出码 1、原错误报告及未验收标记保持。内容、结构、格式、混合质量错误和快照失效均不得借此交接。worker 不把模型报告或 `host_handoff` 当作批准凭据。
- 宿主仍从锁定原稿和持久化操作日志独立重放，检查双稿一致性、结构、格式及整篇篇幅。正文 70% 下限保留；原稿至少 50 页、页数减少至少 20 页且实际渲染比例低于 70% 时仍拒绝。不得把缓存页数、模型声明或预检交接提示当作分页通过。
- `bb_file` 文件权限、`/proc` 拒绝、网络禁用、只读原件及仅 `scratch/output` 可写均保持；不改 renderer、放宽沙箱或重启现有任务。基础设施错误沿用宿主既有有界检查重试，不以额外模型改稿替代检查。
- 无数据库迁移、公共 run 状态、账务政策或新增运行依赖。真实募集书质量、真实模型效果、完整任务恢复及用户验收仍需分别验证。

## #1302 bootstrap 整合要求

[#1302](https://github.com/ITSophiaXu/BondBuddy/issues/1302) 的 v4 bootstrap 要求在首轮模型输入中提供完整 `task.md` 与受控编辑所需的完整 `fixed-edit.md`，不能只依赖模型自行打开文件或被工具输出截断的片段。

后续集成 #1302 时必须保留首轮全文注入及 64 KiB 上限校验，同时纳入 #1339 的交接指引与新版本标识；不得以短提示覆盖全文 bootstrap。本独立分支基于 develop，未包含冻结候选的 #1302 改动。受控首轮版本为 `single-cli-authoring-format-host-handoff-v5`，非受控首轮为 `single-cli-authoring-host-handoff-v5`；篇幅修复版本为 `single-cli-authoring-size-repair-host-handoff-v2`。非受控任务不得误获得受控操作日志交接指引。

整合状态待补：记录实际合入的 #1302 commit、完整指令内容/hash 与未截断断言、新版本 prompt/templateVersion 测试结果。本文初稿只登记整合要求，不把尚未核验的集成写成完成。

## 已有证据与待补项

| 验证 | 当前结果 | 证明范围 |
| --- | --- | --- |
| `python -B -m unittest test_fixed_edit.WordQualityPreflightTests -v` | **28/28 通过，0 失败，230.261 秒**；Windows，Python 3.12.14。已包含最终 `defer_page_rendering_to_host` 与 `authoring_completion=not_verified` 断言 | synthetic DOCX、真实预检/质量代码；仅 mock renderer/查找。覆盖五类渲染错误、混合错误、快照变更、旧报告覆写、成功撤销交接及真实 CLI 子进程退出码/摘要隐私 |
| `git diff --check` | 通过（本次测试文件变更） | 补丁空白检查 |
| 全仓 `npm run build`；`npm run check:contracts` | **通过**；契约 72/72，179 个公开样例＋12 个内部库样例＋4 个生命周期样例通过 | 当前源码类型检查与既有公共契约 |
| `python -B -m unittest test_document_size -v` | **10/10 通过** | 70%篇幅及渲染失败保持拒绝 |
| worker 格式、quality、repair 三套定向测试 | Windows：29 通过、1 超时取消（原有复杂重放用例60秒上限）；Linux固定worker环境：**30/30通过，0失败、0跳过，301.823秒**；同一复杂用例15.656秒通过 | 不放宽测试超时；renderer outage 用例确认新增模型调用为0 |
| #1302 首轮全文 bootstrap 整合 | **待主任务集成；不在本独立 PR 中混入另一候选改动** | 整合后验证全文内容、64 KiB 限制与新版本 |
| 独立 Docker：真实 `bb_file` 预检 → 宿主重放/渲染 | **通过**；最终修正版含中途30→最终60条操作 | 真实沙箱与LibreOffice；全部材料synthetic，0 provider/0真实任务操作 |
| 用户实际验收、部署及线上核验 | **未完成** | 交统一发布流程 |

本机 Python 路径：`C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1112-737-0_26.1112.737.0_x64__3k8sg7r9htsxt/dependencies/python/python.exe`。运行上述单测时将 `PYTHONPATH` 设为本工作区的 `python` 与 `python/tests`，并设置 `PYTHONDONTWRITEBYTECODE=1`、`PYTHONUTF8=1`。

## 零 provider 合成容器验证

入口为 `scripts/preflight-host-render/verify.mjs`，材料由同目录 `fixtures.py` 生成，全部为 synthetic。脚本调用 `codex sandbox`，不调用 `codex exec` 或模型；不启动 worker runtime，不连接 API、数据库或现有任务卷。

2026-11-14 最终修正版全部断言通过：

1. 先运行现有 `verifyFilePermissions`，再在原 `bb_file` 沙箱中调用真实预检。正常内容案例须保留纯渲染失败、退出码 1 和 hash 绑定，同时返回仅延后页数渲染的短提示及 `authoring_completion=not_verified`。补测中途操作版本继续完成剩余业务修改，再对最终日志的新 hash 预检和验收，旧提示不能代替最终版本检查。
2. 混合失败及正文缩减案例不返回交接提示；CLI 摘要不含长正文或嵌套诊断。
3. 将同一锁定输入、底稿和操作日志直接交给现有 `finalizeFormat`/`verifyWordQuality`，不传入预检报告或交接字段。正常案例应在宿主环境渲染为 60/60 页，双稿 hash 对应，正文及页数比例均为 1；混合及正文缩减仍失败。
4. 另用正文相同、分页由 60 页压缩为 20 页的反例，确认实际页数门禁仍拒绝。

若特定环境不再复现沙箱 `render_output_invalid`，脚本对该失败路径的断言会失败；应记录实际结果，不能人为制造失败或放宽运行任务权限来取得通过。

以下 PowerShell 命令从本工作区根目录运行。操作者须先将 `BB_TEST_WORKER_IMAGE` 设为已核验的完整 `sha256:…` 镜像 ID，将 `BB_TEST_SECCOMP` 设为已核验的本地 seccomp JSON 路径。本次固定镜像为 `sha256:2a1bbe5398f0c204cfedbf43789be0b04ba6093be67240d27e86c2a708a66741`；源码分支基于 `e0ea46f5ec0b85034401e32e0dd66dbd4dee337e`，实际提交见关联 PR。

```powershell
$taskRoot = (Resolve-Path .).Path
$taskImage = $env:BB_TEST_WORKER_IMAGE
if ($taskImage -notmatch '^sha256:[a-f0-9]{64}$') { throw '先设置已核验的固定 worker 镜像 ID' }
if (-not $env:BB_TEST_SECCOMP) { throw '先设置已核验的 seccomp 文件路径' }
$taskSeccomp = (Resolve-Path -LiteralPath $env:BB_TEST_SECCOMP).Path
$taskPython = Join-Path $taskRoot 'python'
$taskProbe = Join-Path $taskRoot 'scripts/preflight-host-render'
$taskEvidence = Join-Path $taskRoot ('work/preflight-host-render-' + [guid]::NewGuid().ToString('N'))
$taskContainer = 'bb-preflight-host-render-' + [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
$taskArgs = @('--context', 'desktop-linux', 'run', '--rm', '--pull=never', '--name', $taskContainer,
  '--label', "bondbuddy.synthetic.probe=$taskContainer", '--network', 'none', '--read-only',
  '--user', 'node', '--workdir', '/app', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--security-opt', "seccomp=$taskSeccomp",
  '--memory', '6442450944', '--memory-swap', '12884901888', '--cpus', '4', '--shm-size', '67108864',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=4g,mode=1777',
  '--mount', "type=bind,source=$taskPython,target=/app/python,readonly",
  '--mount', "type=bind,source=$taskProbe,target=/probe,readonly",
  '--env', 'PYTHONPATH=/app/python', '--env', 'PYTHONDONTWRITEBYTECODE=1',
  '--env', 'BONDBUDDY_WORD_PYTHON=/opt/venv/bin/python',
  '--entrypoint', 'node', $taskImage, '/probe/verify.mjs')
& docker @taskArgs 1> (Join-Path $taskEvidence 'result.json') 2> (Join-Path $taskEvidence 'progress.log')
if ($LASTEXITCODE -ne 0) { throw "合成验证失败；保留证据：$taskEvidence" }
Get-Content -Raw -LiteralPath (Join-Path $taskEvidence 'result.json') | ConvertFrom-Json |
  Select-Object status, model_calls, task_operations
```

这是本分支 Python 只读挂载与固定镜像既有 worker helper 的组合验证，不能代替本分支完整镜像构建、首轮模型 prompt 实测或 API/队列端到端测试。容器不挂载凭据或客户资料；正常退出自动删除。若运行被中断，只能核对上述 UUID 名称、同值 label 及镜像后清理自有测试容器，不操作正在运行的本地任务栈。

本次证据保存在 ignored `work/issue-1339/2026-11-14T04-43-34-272Z/`（`environment.json`、`source.diff`、`result.json`）。seccomp SHA-256：`4dfedd73001fa832651c82adc9e8a4184b762979348ce7919ce3c8cd9738f504`。现有 `verifyFilePermissions` 通过，原 `/proc` 拒绝未变。

| 最终修正版实测项 | 结果 |
| --- | --- |
| 中途30条操作预检 | failed/exit1，提示仅延后页面渲染，`authoring_completion=not_verified` |
| 继续完成60条操作并新预检 | failed/exit1；旧hash不再匹配，新hash用于host重放 |
| 正常内容host验收 | passed，正文43,311→43,311字符、实际60→60页，两项比例1.0 |
| 混合事实缺失 | 无交接提示；host仍failed |
| 正文缩减 | 无交接提示；host仍failed |
| 相同正文60→20页 | 实际渲染比例0.333333，`WORD_DOCUMENT_SIZE_REDUCED`拒绝 |
| 正常预检短stdout | 1,078字节；保留失败与身份摘要，无长正文/嵌套诊断 |

最终日志 hash（预检、host重放输入及重放输出三者一致）：`248ee2731dd75583d7efe0dbc3d59c10847ca50d98a289c536efa8970dde75e8`；中途日志 hash：`fc90b5a0eacfd4b371540e9c86c5a28661205e6045c860bbb39147ab91182bca`。

正常修订版 SHA-256：`9dbd2fa1d0506ff642bb6cc60f276b0848b28be9c31ed477a2289186cc9af6a2`；清洁版：`a544c9a9c1f2574a6caf84d9cec7997238ee00426be220667e2c81246d33fe10`。这仅证明合成操作重放与质量机械检查，不是专业内容、视觉或真实模型验收。

运行时记录的 `preflight.py` SHA-256 为 `81f6bcd088f677964086fabcbe389de59224860a2bd250935d8cdda1a3e8e34d`。同次记录的 `quality.py`、`document_size.py` 及三个实际 worker helper（format/quality/permissions）均与本分支代码或编译产物 hash 相等；helper源码和package-lock与固定镜像候选无差异。没有把旧checker的通过当作新checker证据。

Linux定向套件使用本分支编译的 worker、API及公共库（只读挂载各 `dist`）和当前Python源码，命令为 `node --test --test-concurrency=1 apps/worker/dist/file-authoring-format.test.js apps/worker/dist/file-authoring-repair.test.js apps/worker/dist/file-authoring-quality.test.js`；完整输出在 ignored `work/issue-1339/node-tests-2026-11-14T04-52-06-924Z/stdout.log`。其中 `renderer outages retry checking without any model repair` 验证模型调用计数为0。Windows原有用例的60秒超时保留，未改超时阈值；本分支运行环境以Linuxworker结果为准。

代码完成，尚未部署，待统一发布。当前未合并；#1302整合、当前真实募集书模型任务的完成及用户实际验收均不能由这些合成测试代替。
