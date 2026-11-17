# Copilot 文件编制认证与目录验证（2026-11-17，Refs #1508 / #1509 / #994 / #1324）

当前准确候选为 b9627e59：文件首次及恢复工作窗口改为128k，2 MiB请求、图片、工具输出及原任务截止时间保护保持。开发定向与准确官方镜像均57/57通过；这只证明工程机制。真实5039的a7/a8仍重复准备、无新增实质operations；a8已自然保存161文件并进入用户暂停，无强制模型终止或官方回退。当前尚无双Word，财务0/36、视觉NOT_RUN，不能判业务PASS或关闭#994；新128k同run a9已在途、真实效果待验证。下方保留各阶段历史证据，以本段及文末最新记录为准。

## 原始失败与直接根因（#1509）

失败使用候选 `b1930a5eb910bb65c610afc9c3bab2f275562fb6`、镜像 `sha256:8471162cf66a73145d1f40a36371f6018b80a9c5be0ccc32f80488a38530e006`、Codex CLI0.169.0及 `copilot_enterprise / gpt-6-sol / max`，位于私有本地隔离harness，没有部署生产。

Run `1792b8a7-3c84-479a-a24f-f3b54c051998` 的 attempt1 `call-55d98427-6638-4e16-ba73-773545b76d03` 记录1次HTTP400：**89,892B、4个input item、0张图片**，没有本地预算拒绝或HTTP413。错误为 `bad request: missing required Authorization header`；原exec证据2,884B，SHA256 `3ec40e28e51daa2a3948a7191784eba470d3c7bec486c9d40a52c428f5757e50`。

实际node UID1000对只读挂载helper的X_OK检查得到EACCES，credential的R_OK通过，检查没有读取credential内容。公开helper源文件为 **0664、root:root、569B**，Git模式100644；两次实际metadata检查一致，早期0644摘要不准确。helper字节SHA256为 `97b38fdfff3361a16a68d1f9b8be4f0526f7893b51caf200a1e6b87487d6d066`。

私有harness将无执行位的公开helper绑定到 `/usr/local/bin/bb-copilot-token`，覆盖镜像内helper。正式local-prelaunch也允许 `model.compose.yaml` 提供该bind，但此前未预检执行权限，来源哈希只覆盖字节。标准local-integration会在镜像内chmod0755，未观察到同样的覆盖路径故障。**helper无法执行、CLI未取得Authorization，是本次400的直接原因**；不是CLI0.169不支持auth.command，也不是413复现。原attempt1用量保持unknown，不能改成零用量或confirmed-not-sent。

## 固定CLI的断网因果验证

真实CLI0.169.0在Docker `network=none` 内访问loopback合成provider，使用synthetic token；没有真实OAuth挂载或供应商调用。只切换目录和fake helper执行权限：

| 诊断目录 | helper可执行 | helper调用次数 | Authorization | loopback HTTP | 请求字节 |
| --- | --- | ---: | --- | ---: | ---: |
| 不含gpt-6-sol | 是 | 1 | 正确synthetic token | 200 | 34,249 |
| 不含gpt-6-sol | 否 | 0 | 缺失 | 400 | 34,265 |
| 含gpt-6-sol | 是 | 1 | 正确synthetic token | 200 | 22,283 |
| 含gpt-6-sol | 否 | 0 | 缺失 | 400 | 22,299 |

不可执行的两组都记录Permission denied及相同缺头400，分类为MODEL_TURN_FAILED/unknown。因此目录不匹配不能被归为本次400的直接原因。匹配slug的早期诊断目录首轮tools为空，其200仅用于隔离鉴权原因，**不代表文件编制协议通过**。私有A/B收据SHA256 `82705ccd5f720d435c9bb9ed45a8e9119da19e452f7b795cae309e1b2b0865a6`；其中fallback布尔提取漏报，保留的diagnostic_lines与原exec warning才是对应证据。

## 独立目录问题与修复范围（#1508 / #1509）

原适配器对command credential的fileAuthoring选择了仅含deepseek-flash的目录，真实exec出现 `Model metadata for gpt-6-sol not found. Defaulting to fallback metadata`。修复新增Copilot文件编制专用目录，保持DeepSeek目录不变，并接入适配器、正式镜像、本地snapshot及验收指纹。专用目录使用文件任务指令、sandbox shell/file工具及受控图片能力，没有沿用“只转录图片、禁用工具”的提示；没有替代model_messages覆盖它。

正式local-prelaunch新增 `validateLocalAuthHelperBinds`：expanded Compose中Copilot服务的helper bind必须只读，源必须是存在的普通文件并通过真实R_OK/X_OK。它只拒绝错误配置，不改文件权限、不执行helper、不读取凭据。检查使用生命周期进程身份，不能单独替代实际容器UID1000的访问证明；本轮实际启动已另行完成该证明。

## 已构建候选与定向验证

候选为 **`bcafcf8dab754a044c6bd540456cb2858831acad`**，tree `cd3d9e82d42bb0e8a234bdf80bf10a5dc36cfb55`；官方worker镜像为 **`sha256:dfd981987809c61d186dc24efd3adbf946c422c2ed339a9ae915f75dd599c8c3`**。构建收据SHA256 `2f2c3488a2c547b4c93ef3e35075d8ac124955607128c4c2ef0a683d92ce625c`。

| 验证对象 | 结果与边界 |
| --- | --- |
| 准确官方镜像：Copilot协议 | 3/3 PASS；CLI0.169、synthetic auth、真实同call_shell输出及exit0、真实JPEG input_image、无fallback/collaboration、400不重发且用量unknown、打包catalog与源码字节一致 |
| 同一准确镜像：adapter回归 | 53/53 PASS |
| 准确Git归档：helper及upgrade | 11/11 PASS；Linux真实0644/0444/0111拒绝、0555通过，root测试父进程下以UID/GID65534验证R/X；不执行helper |
| 同一归档：acceptance与catalog | acceptance22/22、split catalog定向1/1 PASS；是验证逻辑测试，不是当前真实成果验收 |

以上均0FAIL/0SKIP/0TODO。准确镜像验证使用node UID1000:1000、network none、只读rootfs、cap-drop ALL、no-new-privileges及既有seccomp，没有真实凭据、供应商调用、业务服务启动或**编译产物overlay**；WSL未启用AppArmor，不称为完整AppArmor验收。镜像测试收据SHA256 `8a818e0c621b0f09e12741b92600a311575d043b6a5572267552329f81aee8d3`。

归档检查使用WSL Node24.14.0与既有Python3.12.3；84个相关source/sample文件逐一匹配归档，只有5个公开helper源码文件临时导出供非特权测试，未导出客户样本或改私有父目录权限。收据SHA256 `c84c15d24dda0df60dab7e30900defb2d797c7015fbd552f2e1f7bbbee8fa9ef`。

旧 bcaf 准确归档的打包边界：其中 `deploy/m1/scripts/copilot-token.mjs` 有21处CRLF且shebang尾含CR，SHA256 `e2f39e2187df0977df7ced3d72b44ad5629fe6d92bcce52794fa35b81f77d16a`。协议测试使用synthetic helper，当前真实run使用上述LF公开helper的只读覆盖；这些结果不证明镜像内生产helper可直接执行或生产OAuth已验收。

后续已推送提交 eb85843003183d0b3b61c39edeac588d7f5fb2dd（tree 6642d5f8fc2cdbbcc3d4820fdf4eae237118c1fa），为公开 Copilot helper 固定 LF，并新增 Windows 风格 Git archive 回归。对该准确提交以 core.autocrlf=true 生成的限定路径归档验证：helper 为 1,162 B、shebang 无 CR，SHA256 427a68c9e7c0fba437d119e1d6ce07df98181effe131e3f06bca9a6c4bef9848，与 Git blob 完全一致；其他归档成员仅允许换行差异，不能称为全仓库逐字节一致。Windows 定向 1/1、隔离网络 Linux helper/upgrade 12/12 PASS，均无失败或跳过。收据 SHA256 e1162e4ccc48a2a1e8f9f18f9863e7742b9b04d6c0c2d87eafb08e4a377860e1。没有执行真实 helper、读取凭据或调用供应商。**这项归档检查本身不是镜像执行证据；历史 a2/a3 实际使用 bcaf 镜像和已验证的 LF 只读 helper 覆盖，新镜像的独立证据见后文。**

此前在b193镜像上只读挂载新编译产物/catalog的3项协议回归仍作为**旧overlay阶段证据**保留，日志SHA256 `c6b09a2586380d53ff6733002b0194a12747dec1e970713d60129f09f8dd7c8e`；它本身不证明新镜像或完整AppArmor通过，不能与随后准确镜像的56项结果混为一项收据。

两组新增测试已接入既有Linux CI及准确镜像断网步骤。bcaf本head的7项GitHub CI均经逐条annotation核对：账号付款失败或支出额度不足导致job未启动，steps为空。**远端CI未通过，也未执行到代码测试**；未修改账务、重跑、绕过检查或合并。脱敏汇总SHA256 `96b6de8f783b1e273ecf8f67632a168accea391b8056d0add517248a906699e9`。

2026-11-17T04:26:44.9210903Z 已逐项核对当时 head aee8962 的 8 项 CI（含新增 prospectus-quality-mechanical）：head 全部匹配，steps=[]，annotation 均为 GitHub account payment/spending limit 导致 job 未启动。**这些不是代码测试失败结果，也不是 CI 通过。** 私有汇总 SHA256 79746902f4011f74ba41c511eb8afe95d07b2d791fbf676ff3c9a95675034fa4；未修改账务或绕过检查。

## 真实运行历史（a1–a3；后续收尾见文末）

本节保留截至 **2026-11-17T04:02Z** 的 a3 收尾历史；后续 a4/a5/a6 完整结果及 a7 在途状态见文末。本轮Qx是本地隔离真实任务。更早的run `2fdbae54-6682-48a2-af19-1713fc18d038` 因缺执行主机标识在provider前失败，没有模型attempt，原预留释放；该历史不能与上述HTTP400或后续attempt混合。

Root于03:25通过官方 `retry_unknown_usage` 操作恢复run `1792b8a7-3c84-479a-a24f-f3b54c051998`，reason为 `provider_auth_and_catalog_fixed`。before/after均通过；原provider/usage观察指纹、revision2完整input hash `03a36ec0c7779b57942caa39322cc7ce5dfac4f1992a6298608f5a78aae8afe7` 和原34,570预留保持，累计提交报价仍69,140，没有新业务run或报价。原attempt1仍为unknown；修复后的新增处理仍可能产生供应商费用。

03:29:27.732148378Z启动修正worker `7daba0ac3b1b362265a0886be1fe7074a81ff86894ebe331bebb5494f4a2b41f`，使用上述bcaf镜像及新的同字节0555公开helper只读bind。实际UID1000对helper R/X和credential R检查通过，没有读取credential内容。旧worker保留；v2启动收据SHA256 `6666f766c4b9899b6543b6414f87ec8877e4694321fe16473181caa71bc31769`。

Attempt2 `call-57b3059e-ed82-4aba-a204-6337e8fe24e8` 于03:38:20因图片上下文预算触发 `MODEL_CONTEXT_ROTATION_REQUIRED / image_context_budget`，保存现代完整工作区快照 **151文件、18,858,794B**。同一run自动接续到attempt3 `call-2d004a3d-1b7b-449e-a928-a2ad9ed30ea7`，其诊断收尾见下节；这是首次实际宿主上下文轮换，不是上游413，也没有重新提交。原绝对截止时间 **2026-11-17T07:42:45.393Z** 不变。

Attempt2收尾的完整gateway summary如下，适用范围仅为该attempt：

| 项目 | 完整summary |
| --- | --- |
| 请求及HTTP状态 | 88次请求，HTTP200=88；upstream_errors=0，gateway_rejected=0 |
| 网关流结束分类 | completed=30，client_closed=58；HTTP200不能写成88次completed，client_closed也不等于上游错误 |
| 请求字节 | 最大774,246B，总计22,937,995B；这是attempt2完整summary，不能外推后续attempt或全run峰值 |
| 图片 | 单请求最多2张，单请求最大image data URL合计309,810B |
| 网关观测用量 | 88个响应带usage；input3,934,160，cached input3,322,680，output35,079，reasoning13,614 tokens |

**Attempt2的durable usage仍为unknown**；上述gateway测量不能替换持久用量状态、原provider/usage证据或结算值，attempt1的unknown同样保留。live日志会省略部分成功请求，不能用其样本最大值/状态分布替代完整summary。轮换收据SHA256 `c9dd45963864c14ecb92084a46bfd1deb914ac7cbc479522de716352d3f1220a`；attempt3 完整 summary 已补录于下节；全 run 终态与最终费用仍待完成。

## Attempt3 恢复循环与已授权诊断停止（Refs #1324）

a3 开始时，a2 快照 151/151 文件及 54/54 PDF 缓存按 SHA-256 和大小恢复一致。03:45:19 尚无模型新增或修改；随后 03:59:03 终止前检查发现唯一变化是工作记录由 8,053 B 变为 8,716 B，已原字节私有保全，其他 150 文件匹配 a2，零新增，operations 仍 2 项。因此不能再写成 a3 全程零写入，也不能把该单文件备份称为 a3 完整快照。

用户明确授权“允许暂停并终止空转进程以诊断”后，root 的正常 UI 暂停请求获接受，并于 2026-11-17T03:59:26.497Z 经准确 PID/PGID、starttime、可执行文件及工作目录 guard 发送一次 SIGTERM。它是诊断中止，不是自然完成。实际分类为 MODEL_PROCESS_EXIT_NONZERO/unknown；run 为 paused/provider_reconcile、user_pause_requested=true。Codex 进程已退出；MCP 子进程自然退出为 zombie，无需 SIGKILL。原输入、预留、a2 快照与绝对 deadline 保持，a3 capture 仍为 prepared；这是 04:02 的收尾状态；随后官方回退及 a4 继续见下节。

完整未截断 raw exec 为 2,825,608 B，SHA256 0c5f6b2d1ee2df9447c8508b218d83cde1148c82998725d83055155403f29090，原始内容仅私有保全。a3 共 318 请求：317 HTTP200，最后 1 请求在 SIGTERM 时尚无 HTTP 状态；无上游错误、预算拒绝或 413，最大请求 326,382 B。281 普通请求带工具；37 请求无工具，其中 36 次成功后，下一请求历史均重置为 5 条 message，输入从约 31–38k 降回 17.05–17.48k tokens。295 条完成命令持续引用 input.json、工作记录和知识文件，业务操作仍为 2 项。

该请求形态、历史重置与固定 CLI 的合成阈值对照，**强支持恢复分支的 32k 自动压缩导致重复准备**。网关未保留请求正文，不能声称读到了真实压缩提示或完成了真实模型因果对照；这些 36 次是压缩形态推断，不是显式 compact 事件计数。问题已关联既有 [#1324 的补充证据](https://github.com/ITSophiaXu/BondBuddy/issues/1324#issuecomment-6937902273)，该问题原 PPN 输入范围不由本轮普通私募 Qx 替代。

收尾收据 SHA256 fb9beb9b622b2f91f7e4adae0be770ececb2cc5100076b085fc7a6b6f05a9ab6；形态与用量收据 SHA256 22889e204893a30ba6b7d88aaa373c81e7cc99b6b50541414b515240a9a85eb9。详细统计及合成验证边界见大 PDF 记录。a3 durable usage 仍 unknown，网关统计不得替换持久用量或结算值。

恢复阈值修复已提交为 aee8962cc545de7b47a789d1a9779cb2da4b2556（tree 338ba66128458a8b2924955b5c801721a6868817）：文件编制恢复阈值统一到 64k，扩展固定 CLI0.169 协议回归，保留 2,048-token 工具输出、2 MiB wire 预算、图片预算、原输入及 deadline。

开发验证使用独立断网容器和编译产物 overlay，协议 3/3、adapter 53/53，共 56/56 PASS、零跳过；收据 SHA256 edfcf83cc3e5ff00951f4f01483eea6efb6b4f2047b6947f526f6177ef3cd319。旧 32k 的有效负例 protocol-old32k-negative-v2.tap 实际以 unexpected_recovery_compaction 断言失败，SHA256 8e0899487f5fca2b2059a2d7cb0db92a2e9545e5b4d6d63f1910230abebb5def；首轮提前 catalog 字节不匹配的失败另行保留，不能算作有效压缩负例。**这是开发 overlay 证据，不能替代下述准确新镜像验证或真实任务验收。**

准确候选 aee8962 的官方新镜像为 sha256:405dcadcf9805f236b8f963d9797dc222a15c80556d345ec5db4786623ba9255。它由全 LF Git archive 构建（归档 SHA256 cd4c8fbe91f7ad7608554d9b98197813a94a081e175863b6e60e671554079f95，构建收据 SHA256 343178df23e724203d2b4beec87771aaaf52ecef805950bf85a6ceb20c36b6a5）；核对的 15 个相关文件在 Git blob、原始归档和解包源码间字节一致，没有换行标准化后再比较。

2026-11-17T04:20:06.940008Z，准确新镜像单独完成协议 3/3、adapter 53/53，共 56/56 PASS，0 失败/跳过/TODO。验证为 network none、UID/GID1000:1000、只读 rootfs、cap-drop ALL、no-new-privileges 和既有 seccomp，无真实凭据、供应商调用、业务服务启动或编译产物 overlay；WSL AppArmor 不可用。收据 SHA256 b4d3a5fb9467014a376d8d1ae13b7a133c5c1c43dd1f5b6e72d62aae4711544e，与开发 overlay 及旧 bcaf 镜像收据分别保留。

eb858430 的 helper LF 修复已在本次源码/归档核验中确认；这组协议使用 synthetic helper，没有独立读取镜像内实际 helper 哈希或验证生产 OAuth，不能合并声称生产鉴权已验收。真实同 run 复验随后进入 a4/a5/a6，完整结果见文末；本次官方回退保留 a3 工作记录、真实错误和 unknown，没有伪造 a3 saved capture。

## 官方回退与 a4 启动历史（04:21–04:23）

准确新镜像离线验证后，root 于 04:21 停止空闲 bcaf worker，经 04:21:44 的 before guard 执行 a3 官方 retry_unknown_usage，reason 为 recovery_compaction_fixed_rollback_a2、idempotent=false，并完成 04:22:14 after guard。before/after 收据 SHA256 分别为 5253b175e0deb4ebc8853216436fc72a60f4437e874d17e1a27db711b9788a19 / fb8f02facaf66e998ef8d6fc5467ec3d125fd416045b4ed1e026497ce9007676；准备收据 SHA256 26df19a027dde53fa56b085d992dd31eaba59c4287ff2cdeb0ed697a2619f648。三次历史 unknown、实际错误、原输入及预留保留；a3 capture 未伪造为 saved，回退对象是已核验的 a2 快照，a3 工作记录另行私有保全。

新 worker 10e64d620911e435cf7df5121444bdfa1f4b6a20a9177e59560e041029c8bc9e 于 04:23:08 启动，config 为 qx-isolated-aee8962c-recovery64k-v3，使用上述准确 aee 镜像。启动后的暂停检查全 PASS，无漂移，也没有新 provider intent；随后 root 才通过正常 UI 继续。

a4 call-7c5bba99-8210-4315-9098-4636ee6faf07 创建于 2026-11-17T04:23:55.649Z，当时观察为 running/provider_call。前一暂停检查的“无新 intent”不适用于之后的 a4。仍是原 run、revision2/input、预留和 2026-11-17T07:42:45.393Z deadline，没有新业务 run 或报价。**这只是 a4 启动记录；后续 64k 仍重复准备的完整证据见下节。**

真实双Word尚未交付，财务36项成果对照与视觉/全文验收仍待完成；Qx不替代RQ正式发布验收，也不替代74MB中捷全文处理。最终仍须补录完整模型summary、终态/费用、同run的artifact与双Word下载哈希、机械/财务/全文/视觉结果。当前不能判业务PASS、生产生效或任意大PDF支持。

## 64k 真实复验、a6 诊断收尾及当前恢复边界

准确 aee8962 镜像上的 a4、a5、a6 均使用 64k 阈值，仍出现压缩形态及重复准备。**64k 单独没有解决续跑循环；operations 始终为 940 B / 2 项，没有真实 Word 或 artifact 交付。** a5 有实际提取进展，不能说三次 attempt 全程零进展。

| attempt | 请求 / HTTP200 | completed / client_closed | 最大请求 | 压缩形态及后续历史重置 | 实际文件进展 |
| --- | ---: | ---: | ---: | --- | --- |
| a4 | 43 / 43 | 10 / 33 | 672,572 B | 1 次；input 66,248 → 17,495，随后 5 messages | 仅工作记录 8,053 → 10,596 B；无新增文件 |
| a5 | 115 / 115 | 26 / 89 | 853,825 B | 4 次；input 65,967–67,203 → 17,025–17,235，随后各 5 messages | 新增 7 个财务/OCR/表格准备文件，工作记录 10,596 → 12,691 B；随后再次反复准备 |
| a6 | 217 / 216，最后 1 次无 HTTP 状态 | 62 / 155 | 557,343 B | 10 次；input 62,866–71,123 → 17,003–17,433，随后各 5 messages | 仅新增 3 个 inspect 文件及工作记录修改；出现 WORD_EDIT_NODE_NOT_FOUND |

三组完整 gateway 统计均未记录 413、upstream error 或预算拒绝。这里的压缩次数来自“无工具请求 + 下一请求 5 条 message 重置”的形态，**不是显式 CLI compact 事件计数**；请求正文未保留，不能声称已读到真实压缩提示或完成真实模型因果对照。HTTP200 不等于流 completed；网关 usage 测量不能替代 durable unknown、原始观察或最终账单。

a4 `call-7c5bba99-8210-4315-9098-4636ee6faf07` 的 runtime 于 04:26:55.079 记录正常图片预算轮换；已保存 151 文件 / 18,861,337 B。a5 `call-1e5ed87f-bb45-448c-b336-076536bd2166` 的 runtime 于 04:36:05.096 记录正常图片预算轮换；已保存 **158 文件 / 19,356,261 B**。这些是 runtime 记录时间，不是精确的进程停止或快照写完时间。a5 是最新正式 saved 恢复快照。两次轮换的实际分类仍为 MODEL_CONTEXT_ROTATION_REQUIRED / image_context_budget，历史 usage unknown 保留。

a6 `call-470a2636-a403-4516-952f-85b6be0b8874` 创建于 04:36:13.441，运行从 04:36:13.465 开始。Root 于 04:38 经正常 UI 请求暂停，并在已授权诊断范围内于 **2026-11-17T04:49:59.366356Z** 经准确进程身份 guard 发送一次 SIGTERM，没有 SIGKILL。实际 runtime 于 04:49:59.572 记录 **MODEL_PROCESS_EXIT_NONZERO / SIGTERM**，耗时 825,932 ms；不是自然完成或正常轮换。04:52:56 收尾观察为 paused/provider_reconcile、user_pause_requested=true、无 lease/holders，a6 capture 仍 prepared、usage unknown。Root 于 04:54 停止并保留已空闲的 corrected2 worker；四个旧业务 worker 均停止保留。

a6 诊断备份的 **17 items 不等于 17 个新增文件**，大部分是正式恢复快照未列出的原件或工具；该备份不是原子快照或正式 saved capture。相对 a5，实际仅新增 `scratch/inspect-attempt-table22.err`（38 B）、`scratch/inspect-attempt-table22.json`（0 B）、`scratch/inspect-confirm-2.json`（594 B），工作记录变为 16,540 B（SHA256 `f4d60ab8f3cd320fb388dbb177e84f04ddfda877a8a9a30398843fb7c094167d`）。`word_patch=0` 的命令字符串计数不能证明没有 helper 调用；应以实际 operations、文件、错误和交付状态为准。该 inspect 错误来自模型传入不存在的短 node ID，完整 ID 此前已被工具返回。后续成功 inspect 的是另一 cell，不能称 table22 已重试成功；这是独立的工具使用错误，暂无 helper 映射缺陷证据，也不能直接归因于 compact。

完整私有证据位于既有 ROOT；不公开原始日志或客户正文：

| 证据 | SHA256 |
| --- | --- |
| a4 analysis `corrected2-a4-log-analysis-20261117T043328116424Z.json` | `05650479c81781b50dba5905cc0e4790361e249e94f28c9a2d9ae7333c0b9e8e` |
| a5 analysis `corrected2-a5-log-analysis-20261117T043801932617Z.json` | `d8d8dc9bd43d1db978ff1616e470041b5b7899530634ed48732c3032c9a80750` |
| a5 saved snapshot receipt `corrected2-followup-progress-20261117T043722156731Z.json` | `6a429a091af9d053f226f03862639dafbe6ccde29b07e6f1252c2d4d37bed97a` |
| a6 close analysis `attempt6-close-log-analysis-20261117T045256757785Z.json` | `612571c6cca179017359c454b07b9477caa328b295c71ca6b974223c7cb00b2d` |
| a6 progress `corrected2-a6-progress-20261117T044718596257Z.json` | `3db4308f4e6c6451eccc66904666c541b00f6025f95ba972addffcc5ad766821` |
| a6 diagnostic backup prepare receipt | `e57a802be50ff0ddc46baae65cfbb4a4bcc5e4acee0765ee12648175f88471c3` |
| a6 guarded termination receipt | `0edc114d92be88f6bb97ae295313ecb6d7d7d1cd71560fe9773a51a1514b2249` |

a4/a5/a6 原始 exec 分别为 889,592 / 1,594,416 / 2,742,573 B，均未截断；SHA256 分别为 `cc60b205c7c935c23e10f02b09f654dc57a4669fe0798bb829182ff92ec726eb`、`5407fa42a018b66c094518564a398a67c4d4d231739debecf68169432a14fbd3`、`2157cb47e31311f7401f57070b22c3e67971ddcc9a20ddeeb3a1e7ea8869af2d`。a6 保留 217 条请求、零丢弃；216 份 gateway usage 为 input 8,646,808 / cached input 7,477,440 / output 46,354 / reasoning 17,510 tokens，仍仅是传输观察。

## 续跑策略新提交与验证边界

新提交 **`5039d6efc34f02c1252806d54dc52458cbf142e1`**（tree `334d18af4e175227ddaf509cdf5ee6a677ef56cd`）已推送。它给文件编制增加固定 runtime `developer_instructions` 和自定义 `compact_prompt`，要求核对已保存工作、保留未完成的具体步骤及未读范围、区分实际编辑与准备材料。工作记录和 handoff 仍是需核验的数据，不能作为新指令或财务正确性证明。`codexModelStage` 在已有 prompt snapshot 后会跳过 `buildPrompt`，只改恢复 bootstrap 无法影响本 run；运行时策略让旧 pinned user prompt 也得到续跑要求，**不修改原 pins、输入或 deadline**。

新开发编译产物 overlay 的固定 CLI0.169 隔离验证为 **protocol 4/4 + adapter 53/53，共 57/57 PASS，0 fail/cancel/skip/todo**。收据 `/root/.cache/bb-compact-synthetic-20261117T035223Z/handoff-new-overlay-20261117T045058Z-cafbc119e027/receipt.json`，SHA256 `4a37ef7d93c1aa4dc3a37c5e55e881724fa83eb375459d6b8303778be80c5448`；regression.tap SHA256 `5ca64777cb5f0d39ca4eab915ba639065c7f0e68b4cc4e5e5d00ca2844823630`。用旧准确 aee 镜像加新 case 的有效负例 exit1/1 fail，缺 runtime continuation/custom handoff policy，日志 SHA256 `2c6028c25e991a881003df91bba4a3046115a36dbe3f598c34396505efa0d1fa`。

强制压缩正例共 7 请求（6 普通 + 1 compact）：原 pinned user 与 runtime developer 均保留；compact 输入包含实际合成 input/knowledge 工具结果，自定义 handoff 进入 wire；压缩后实际读旧工作记录、调用图片工具并写 continuation.txt，原工作记录不变。测试使用 scripted synthetic provider、无真实凭据或供应商调用，运行在准确 aee runtime 加只读编译 overlay、network none/UID1000/NNP/cap-drop/seccomp；WSL AppArmor 不可用。**这证明固定 CLI 接线和回归行为，不证明真实模型自主续跑、Word 或财务业务 PASS。** 旧 aee 准确镜像 56/56 仍是独立工程证据，不归入新提交的准确镜像结果。

准确 5039 官方镜像 **`sha256:c202da09e677aea5c42917b4aeb87294ef82bdef10bfabb4f171d337f517d16f`** 已于 **2026-11-17T05:01:29.939434Z** 独立断网完成 protocol 4/4 + adapter 53/53，共 **57/57 PASS，0 fail/cancel/skip/todo**；image revision 与 5039 提交精确匹配，**没有编译产物 overlay**。收据 ROOT/`corrected3-worker-offline-lf-5039d6efc34f02c1252806d54dc52458cbf142e1-07226fda60ef/receipt.json`，SHA256 `71eab41ac07b8534c4293c72416c8ae1693a3c5d74b16e27b6b7e15e25e627ed`。全 LF archive SHA256 `6a00055339f0e6c3c6dc6a74402434c608c4b8f306cdce7af7cc05945194bd22`，build receipt SHA256 `35f23c2b01a8bf55a7b5967dab4cefc070b46d853606902b2e54324ba11ce1cc`；核对的 16 个相关文件在 Git blob、raw archive 与解包源码间字节一致，未做换行归一化。环境为 network none、UID/GID1000:1000、只读 rootfs、cap-drop ALL、NNP、既有 seccomp，无真实凭据、供应商调用或业务服务启动；WSL AppArmor 不可用。仍是 synthetic 工程证据，不证明生产 OAuth、真实模型续跑或 Word/财务验收成功。

Root 已逐项读当前 head 的 8 个 CI job/annotation，head 精确匹配、steps=[]，均因 GitHub 付款/支出限制未启动；不是代码测试 FAIL 或 CI PASS。汇总 `.local/qx-isolated-plan-20261117/ci-5039d6ef-summary.json`，SHA256 `cecd110e4904bcf859ce86be18e01999891962d65c862a6807bcdbadf3a0b684`。

## 官方回退 a5 与 a7 同 run 复验（截至 2026-11-17T05:07:18Z，在途）

准确 5039 镜像离线验证通过后，root 已执行 **一次** a6 官方 retry/resolve，`idempotent=false`，reason 为 `file_authoring_handoff_fix_rollback_a5`，显式回退到 **a5 saved 快照（158 文件 / 19,356,261 B）**。a6 的诊断文件、实际 MODEL_PROCESS_EXIT_NONZERO、prepared capture 与 unknown 原始证据均保留；这不是 a6 saved 或无损续跑，不得重复该已完成操作。

官方 after guard 于 05:05:15 PASS（ROOT/`attempt6-ops-retry-after.json`），收据 SHA256 `55c832f89e0e0d9397fe87c20b40127062c705205df2b2d1d84982467f052bcf`；05:05:30 暂停检查 PASS（ROOT/`corrected3-paused-recovery.json`），SHA256 `01ec3623f9f4b54b921a8959579257176e4beb6b0ba6cc24dee6ace5976159e9`。准确新 worker **`650d4d63cdd2d7edcf3f75d0f2190742b6f4aa44676b169650484dfce3a79cec`** 实际 StartedAt 为 **05:06:05.017745341Z**，config 为 `qx-isolated-5039d6ef-handoff-v4`；claim 后保持 user_paused、attempt 仍为 6，原输入、账务及历史证据哈希不变。启动收据 ROOT/`same-run-corrected3-worker-start-receipt.json`（05:06:09.515722），SHA256 `bd3adeb504e8e5eb39ca8599892352028c22b12534645ed0358a8a795f3b1d21`，postconditions 通过、旧 worker 保留。随后 root 才通过正常 UI 继续。

a7 **`call-f40e8b78-ed7b-4863-8640-3454a86869a3`** 创建于 **2026-11-17T05:07:09.999Z**，正在执行；首请求 **72,370 B、HTTP200、流分类 client_closed**，不是 completed。05:07:18 watch 收据 ROOT/`corrected3-watch-1792b8a7-3c84-479a-a24f-f3b54c051998-650d4d63cdd2-20261117T050718400638Z.json`，SHA256 `769257b62e5684abb7e189b009be2cd9e2a4a3ff7eea5ea7409168f0f7993c22`。该首请求观察不代表完整 attempt summary、压缩循环已消除或 Word 已生成，不能外推后续请求或最终用量。

仍为同一 run `1792b8a7-3c84-479a-a24f-f3b54c051998`、revision2/input、原预留 34,570 和绝对 deadline **2026-11-17T07:42:45.393Z**；业务 run/报价仅 2 次，累计 69,140。历史 unknown 不改写，gateway 测量不当最终账单。**真实双 Word 尚未交付，财务成果核对 0/36、视觉 NOT_RUN；全文、终态和最终费用仍待验证。** a7 在途不能判业务 PASS、关闭 #994/#1324 或声称生产生效。

## a7 实际运行时策略核验（2026-11-17T05:10:26Z）

既有只读收据 ROOT/`corrected3-a7-native-progress-20261117T051026224873Z.json`（SHA256 `f116565e52d13a80233024d1e3f9cb1e941635bb1b3d32b1440aac4b66f3ec6f`）确认 a7 实际 native PID67 与 holder 对应。实际 argv 的 auto-compact 为 64,000、工具输出为 2,048；runtime developer instructions 为 1,337 UTF-8 B、custom compact prompt 为 1,340 UTF-8 B，二者均逐字匹配 5039 镜像中的 compiled 常量。新策略已加载到真实运行进程，仍不证明续跑已正确完成。

运行中采样看到 a5 清单中的 158 个文件全在，其中 157 个仍匹配 a5 SHA；唯一变化是工作记录由 12,691 增至 15,666 B，另新增 `scratch/inspect-start-new2.json`（8,262 B）。operations 仍为 940 B / 原 2 项，SHA256 `18806fd546d6ea41febf5d9ba47f80732ccdfc28095b29f72023e3569a22c8c1` 不变，没有 Word 输出。**这是运行中的非原子观察，不是恢复瞬间 158/158 的原子完整核验、a7 saved 快照或终态证明；也未证明新增正文编辑、循环消除或业务交付。** 原输入、预留、deadline 及财务 0/36、视觉 NOT_RUN 边界保持。

## 128k候选与a8自然暂停（2026-11-17T05:32Z）

5039实际加载了新runtime策略，但a7/a8仍未新增实质编辑。a7完整88请求均HTTP200、最大532,949 B，4次压缩形态后历史重置；可核对续跑块反复从工作记录、input与哈希检查起步。不同日志流无精确join，不声称压缩后第一命令或真实模型因果A/B。a7 saved160文件/19,372,912 B，operations仍940 B/原2项；analysis v2 SHA256 `e300beeadae33aa2cdd03beaf8cd6b471d8b79e20bf16e4de95e2776d7512ad1`。

a8于05:26:47.923Z记录正常image_context_budget轮换，正式saved161文件/19,380,174 B；root此前通过正常页面请求暂停，后续已为paused/user_paused、无lease/holders。备用停止guard仅返回NO_SIGNAL，未向模型发信号，无官方resolve或回退；root05:29停止并保留空闲650d旧worker。a8完整raw2,151,276 B/未截断，SHA256 `d8bcf5649b5581e1ecb36ac02e563912ab656b8a20640c01cead89cd445450ad`；读取收据SHA256 `ecabcc878c015b33d298d04c939bd0b68569a212afc254c3b0e56ee6315c213f`。operations仍940 B/原2项；vs a7只见worklog增大和一个内容与旧inspect相同的新检查文件。有限检查活动不等于正文推进。

新提交 `b9627e595c4594cebdd91144c72bb8119980bc73` / tree `46e8e6999be80fd8544d76e3c7b6e29e323628af`仅改三文件：首次/恢复文件阈值128,000及对应测试，保留其余策略。固定CLI的scripted synthetic用量验证70k准备不压缩、129k触发custom handoff并继续真实读写；旧64k有效负例检出提前压缩。开发overlay57/57，receipt SHA256 `b2a787925e55967817323e44509273b7eb0347b4de9db85480fe0d294bb87149`；不是实际分词、供应商128k承诺或Word结果。

准确LF归档SHA256 `79ce9905a5998ced690eaa9f0aa3c4d508b5eab5bb547812adbe11b6742999a9`，官方image `sha256:9c3225d380909d1fd2c472a37aba314e443f735718d2a707702f65a049811ce7`，build receipt SHA256 `b32294ceeeb6a339e22ee610b8fbf99e45a661f1f36f0ec2eae73415a00ad2b1`。准确镜像于05:31:51.332240Z独立protocol4/adapter53，共57/57 PASS、0fail/cancel/skip/todo、无编译overlay；receipt SHA256 `6f25763f84e4bf17913623388c4500a09c1c492b995421685e8976531155d5e7`。network none/UID1000/只读/capdrop/NNP/seccomp，无真实凭据或供应商调用，WSL无AppArmor。

128k是受控缓解候选，真实效果尚待验证；现有实际接受的最大input约71k，不能由本地1M目录或字节外推推定供应商上限。仍只允许原run `1792b8a7-3c84-479a-a24f-f3b54c051998`、原input/34,570预留、累计报价69,140及绝对deadline `2026-11-17T07:42:45.393Z`。当前全部八次durable usage保持unknown；网关测量不替代账单。无新业务run/报价、余额修改、双Word交付、部署或发布凭据。

root已于05:34:23通过自然a8只读恢复guard（161份Blob逐一核验，receipt SHA256 `1bf6af5feb956c1368083eef996a67cbf5c52b9ca9be87b486eb8ddd59f72026`）。准确128k worker `578e82ac315776d75e56f3edc1e6160aab92e660455a5c2661bff608c2bcb0a0` 于05:35:27.552426232Z启动，config `qx-isolated-b9627e59-context128k-v5`；启动检查确认仍paused/user_paused、历史attempt8且无新intent，原输入/账务/历史hash保持。root随后正常UI继续，a9 `call-bc39cf4f-16ec-454a-8e78-d536c2bfd503` 于05:36:07.051Z创建；05:36:19为running/provider_call、无artifact。watch receipt SHA256 `e781c86de6b89bc9390548ec82d72eb34184190a1a37c777c8bf7036dc17e9e7`。目前只是同任务在途，不能推断128k真实效果、Word交付、财务或视觉通过。
