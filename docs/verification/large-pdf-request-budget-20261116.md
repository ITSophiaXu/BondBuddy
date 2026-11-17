# 大 PDF 请求预算与恢复验证（2026-11-16，Refs #994 / #1324）

本 PR 整合按页读取/OCR 缓存、受控图片、实际 HTTP 请求预算及 #1302 的自动恢复核心。隔离 Qx 在 aee8962 准确镜像上复验到 a6，未出现 413，但 64k 下仍压缩并重复准备；a6 诊断停止后，root 已官方显式回退到 a5 正式 saved 快照，新镜像上的同 run a7 已于 05:07:09.999Z 开始。**operations 仍 2 项、没有真实双 Word，64k 单独未解决续跑循环，不能判业务 PASS 或关闭 #994。** 新续跑策略提交 5039d6ef 已推送，开发 overlay 与准确新镜像均独立通过 57/57，真实续跑效果待验证；尚未生产部署。

## 根因证据及边界

生产事件已确认模型调用收到 HTTP 413。历史请求 body 未保留，因此无法量化原事件中图片、文本和工具历史的占比，也不能把合成测量比例套到该事件。原始 PDF 的文件大小与发送给模型的单次 HTTP body 大小是不同指标；Codex 能在本地读取 PDF，并不保证其模型请求不受供应商或网关的 body 限制。

固定 CLI 的合成测试证明：本地看图结果会进入下一次模型请求，图片可显著放大请求；小图也会随历史累计。413 防护必须覆盖实际请求字节，不能只控制上传文件大小、单张图片或 token 数。供应商的实际 body 上限尚未由这些测试确定，默认 2 MiB 是本地保护策略。

## 本次实现范围

- 文件编制始终开启请求预算检查，默认 2 MiB，可用合法的显式预算覆盖。全局 `off`/`measure` 不关闭文件编制保护。首次本地超限或上游 413 后停止本次调用，避免同一超额 body 重发；本地未转发与上游拒绝分别记录。
- PDF 按需读取页内文字或执行本地 OCR，缓存绑定原件、页码及 OCR 引擎/训练数据身份。目录、读页和检索的 JSON 分片均不超过 6 KiB，保留明确续读游标，完整记录仍在缓存中。图片经受控工具生成 JPEG，单图不超过 128 KiB，每上下文累计 data URL 不超过 512 KiB；达到图片预算后由宿主识别独立轮换标记并停止当前上下文，核验快照后换新上下文，复用分段文字/OCR 缓存。正常图片轮换与真实 413 故障分别记录，不能把图片预算用尽冒充上游 413。缩放预览不能代替小字、财务数字与全部必要区域的核验。
- 复用 #1302 的完整工作区快照、捕获状态和自动恢复核心，没有引入其手动重试页面或重做接口。仅在退出证据、不可变观测、输入、归属、快照和现代捕获标记一致时，在原任务中以新上下文续跑。正常图片轮换每任务最多 32 次；真实 413、输出超限与超时共享每逻辑调用 2 次、每任务 6 次故障恢复额度。首次现代调用持久化该逻辑调用的绝对截止时间，后续自动恢复及人工重试不能删除或延长它；新上下文只使用剩余时长，默认仍为 5 小时，截止后不再调用模型。保留原预留及历史 unknown 用量，暂停、积分、钱包隔离和取消保护继续生效。轮换次数及时间限制不是总 token 或供应商费用限额。
- 快照上限统一为 4096 文件、单文件 100 MiB、总计 512 MiB。现代捕获标记存在但无效、失败、未完成或冲突时不自动重做；历史任务没有完整快照时也不会自动从原材料重新开始。

## 固定 CLI 的请求字节测量

环境为 Linux Node.js **v22.23.5**、Codex CLI **0.169.0**，provider 是本机 loopback 合成服务，没有真实模型调用或模型费用。测试图片是合成图片，不含客户材料。适配器、文件输出上限、指令、工作区恢复及 gateway/CLI 接线 5 组共 87/87 PASS，0 跳过；新增真实 CLI 分页传输项随后单独 1/1 PASS，0 跳过。

| 路径 | 首次请求 | 看图后请求 | 实际 wire 图片 |
| --- | ---: | ---: | --- |
| 原生 `view_image` | 24,036 B | 2,582,671 B | PNG，1,918,722 B；data URL 2,558,318 B；1333 × 1888 |
| 实际 `bb_images` → 同一 CLI | 30,414 B | 198,889 B | JPEG，125,515 B；data URL 167,379 B；578 × 819，未转回 PNG |

原生看图场景中，上游返回 413 时拒绝 body 只发送一次，provider 共收到 2 个请求；配置本地 1 MiB `enforce` 时，第二个请求被本地拦截，provider 共收到 1 个请求。1 MiB 是该边界测试的配置，不是产品默认或供应商限额。

恢复模式的真实 shell 工具设置为 2048 token，实际执行 `pdf_pages.py` 返回 3 个中文/英文密集页分片：5,604 / 5,604 / 5,607 B。随后的 HTTP 请求逐字包含完整 JSON 和 `next_offset`，没有截断。测试将相同固定 CLI、bundled bwrap 及 Python helper 字节放入任务允许目录，未扩大生产权限边界。

## 真实大 PDF 的本地页读取与缓存

受控私有扫描 PDF 为 **74,336,855 B、83 页**。本次只验证第 1 页，未声称读完 83 页，也未据此核验财务明细或生成业务 Word。

| 项目 | 实测结果 |
| --- | --- |
| 页目录返回 | 3,058 B |
| 第 1 页原生文字 | 0 条记录 |
| 本地 `chi_sim+eng` OCR | 8 条记录、8 个片段 |
| 分段返回 | 3,829 B，`next_offset=null`，仅说明该页本次结果已返回完 |
| JSON 缓存 | 合计 4,199 B，无 PNG 缓存、无 `image_base64` |
| 迁移到新的 attempt 工作目录后重读 | 返回对象完全一致；首次 OCR 提取 1 次，迁移后提取 0 次；仍核验引擎和训练数据身份 |

验证通过 `PdfPages.outline`、`read(1, ocr='force')`、计数 OCR 提取及复制缓存完成。临时原件副本和缓存已清理；本记录不包含客户正文、源文件绝对路径或凭据。该证据说明按页 OCR 与缓存复用可行，不证明整份扫描件的识别质量或最终交付。

## 此前实现阶段的定向检查

| 检查 | 结果与实际覆盖 |
| --- | --- |
| PDF 页工具 Python 单元测试 | 23/23 PASS，0 跳过；含真实 Tesseract 识别合成数字、原件/引擎变更使缓存失效、按字节有界的中英文密集页分页完整、扫描检索不隐式 OCR、缓存迁移和无图片字节返回；新增部分文字层且无图片对象页面的强制 OCR 缓存复用/搜索及损坏 JSON／非法 UTF-8 缓存显式拒绝 |
| 既有 Word 质量、格式、交付和修复回归 | 46/46 PASS，0 跳过；Linux Node 22 + 实际 Python 检查，涵盖双 Word 一致性、过度缩稿拒绝、受控编辑、诊断和恢复交付；使用合成文档，不是实际财务内容验收 |
| 网关及受控图片 Node 检查 | 26 项通过；覆盖实际/解码字节、压缩、锁存、流式超限、并发与 HTTPS CONNECT 代理（代理项使用可用 OpenSSL 补跑通过）；受控图片最新 5/5 PASS |
| 受控图片 Python 检查 | 5/5 PASS，含单图大小、尺寸、裁剪及原图不变 |
| API 快照元数据 | 2/2 PASS；输入/归属/attempt 绑定、路径与哈希、完整快照、文件数及字节边界 |
| 自动恢复 PostgreSQL | 2/2 PASS，0 跳过；真实 SQL 中 413 → 待核对 → 有限恢复 → 原 job/run 重新领取 → 新 attempt 的持久成功结果；历史 unknown 用量不改写，原输入及账务保留；并发恢复、预算、无完整快照、捕获冲突、独立暂停及钱包/取消保护均覆盖 |
| 八路原生进程 API 回归 | 1/1 PASS，0 跳过；冻结的 250 文件合成批次，8 个真实子进程重叠 572.7 ms，均正常退出；16 份合成 Word、零上游调用、排空成功、剩余容量占用为 0 |
| acceptance/gate 单元测试 | 53/53 PASS；在 WSL 使用正确 Python 环境。这是验收逻辑的单元验证，不是客户任务业务验收 |
| contracts 示例及检查 | 全部 PASS |
| 正常完整构建 | `npm run build` PASS，包含全部 7 个 workspace，无临时 API 测试排除；构建在 Windows Node v26.13.0 执行，worker/CLI 定向运行测试使用上述 Linux Node 22 |

PostgreSQL 使用独立容器和空模板，全部 192 条迁移以 Linux 的 LF SQL 文本执行成功；测试没有读写现有应用数据库。自动恢复验证耗时约 82.8 秒。八路测试使用 Linux Node 22，测试体约 44.2 秒，总计约 119 秒（含挂载盘模块加载）。测试容器、数据库卷及保持会话均已清理，原有服务保持运行。

自动恢复后的新工作仍可按既有活动计费规则累计费用；“保留账务”表示沿用原预留、金额和计费策略，不表示新增处理免费。历史调用的 unknown token 用量保持 unknown。

以上保留此前实现阶段的定向检查，不是bcaf的全量门禁复跑或发布收据。上述测试未连接真实模型供应商；合成成功结果及合成Word不能替代真实大PDF到双Word交付。bcaf新增验证及实际运行见下节。

## 真实运行历史（a1–a3；后续收尾见文末）

本节保留截至 **2026-11-17T04:02Z** 的 a3 收尾历史；后续 a4/a5/a6 完整结果及 a7 在途状态见文末。本地隔离Qx使用1份DOCX和3份PDF；PDF合计14,535,596B、154页，最大单份7,227,129B。这不是前述74,336,855B中捷PDF的全文任务，也不替代RQ正式发布金样或历史testlei线上验收计划。

已推送候选 `bcafcf8dab754a044c6bd540456cb2858831acad`，tree `cd3d9e82d42bb0e8a234bdf80bf10a5dc36cfb55`；官方worker镜像 `sha256:dfd981987809c61d186dc24efd3adbf946c422c2ed339a9ae915f75dd599c8c3`。准确镜像断网protocol **3/3**、adapter **53/53**通过，未挂载新编译产物overlay；准确Git归档helper/upgrade **11/11**、acceptance **22/22**、catalog定向 **1/1**通过，均0FAIL/0SKIP。此前b193镜像加编译产物overlay的协议测试只保留为旧阶段证据，不能替代准确镜像验证；WSL结果也不代表完整AppArmor通过。完整根因、环境与收据见 [Copilot文件编制验证](copilot-file-authoring-20261117.md)。

bcaf本head七项GitHub CI均因账号付款或支出额度问题在job启动前失败，steps为空；远端CI没有通过，也没有执行到代码测试。未修改账务、绕过检查或合并。

2026-11-17T04:26:44.9210903Z 已逐项核对当时 head aee8962 的 8 项 CI（含新增 prospectus-quality-mechanical）：head 全部匹配，steps=[]，annotation 均为 GitHub account payment/spending limit 导致 job 未启动。**这些不是代码测试失败结果，也不是 CI 通过。** 私有汇总 SHA256 79746902f4011f74ba41c511eb8afe95d07b2d791fbf676ff3c9a95675034fa4；未修改账务或绕过检查。

后续 helper LF 提交 eb85843003183d0b3b61c39edeac588d7f5fb2dd 已推送，准确提交的限定归档通过 Windows 定向 1/1、隔离网络 Linux helper/upgrade 12/12；该源码/归档检查与下述新镜像验证分别记录；历史 a2/a3 实际使用 bcaf 镜像。详情见 Copilot 验证记录。

真实历史与当前状态分开保留：

- 首个隔离run `2fdbae54-6682-48a2-af19-1713fc18d038` 因缺执行主机标识在provider前失败，尚无模型attempt；不是413。
- 当前run `1792b8a7-3c84-479a-a24f-f3b54c051998` 的attempt1仅发出89,892B、0图片请求，返回缺Authorization的HTTP400。直接原因是helper源0664无执行位，独立目录缺gpt-6-sol warning不是该400根因；原用量仍unknown。
- root于03:25完成官方同run `retry_unknown_usage / provider_auth_and_catalog_fixed` 恢复，before/after通过，原观察指纹、revision2完整输入和原34,570预留不变，累计提交报价仍69,140，没有新业务run或报价。
- 03:29启动准确bcaf worker `7daba0ac3b1b362265a0886be1fe7074a81ff86894ebe331bebb5494f4a2b41f`；实际UID1000 helper R/X与credential R预检通过，未读取credential内容。attempt2 `call-57b3059e-ed82-4aba-a204-6337e8fe24e8` 于03:38:20因图片预算触发MODEL_CONTEXT_ROTATION_REQUIRED，保存现代完整快照151文件/18,858,794B，自动接续attempt3 `call-2d004a3d-1b7b-449e-a928-a2ad9ed30ea7`，其诊断收尾见下节。这是首次实际上下文轮换，不是上游413。原绝对deadline **2026-11-17T07:42:45.393Z** 保持不变。

Attempt2完整gateway summary现已保存：88请求、HTTP200=88、upstream_errors/gateway_rejected均0；最大请求774,246B、总请求22,937,995B，最多2张图片，单请求最大image data URL合计309,810B。流结束分类为completed30/client_closed58，不能把HTTP200写成88次completed或把client_closed当上游错误。这是attempt2的完整统计，不能外推attempt3或全run峰值。

Gateway在88个响应观测到input3,934,160/cached input3,322,680/output35,079/reasoning13,614 tokens；**attempt2 durable usage仍unknown**，不能用网关测量替换持久证据或结算状态，attempt1的unknown也保留。live日志省略部分成功请求，样本统计不能代替完整summary；attempt3 完整 summary 已补录于下节；全 run 终态仍待完成。该次轮换收据SHA256 `c9dd45963864c14ecb92084a46bfd1deb914ac7cbc479522de716352d3f1220a`。

当前尚无已交付的真实修订版、清洁版双Word，财务36项成果对照及视觉/全文检查未完成，不能给Qx业务PASS。终态须补齐实际artifact/run/输入绑定、双Word下载及哈希、费用和请求完整summary、机械/财务/全文/缺口/视觉结果；Qx通过也不能替代RQ或74MB原件的相应验收。

## Attempt3 压缩循环与诊断收尾（2026-11-17，Refs #1324）

恢复开始时 151/151 快照文件和 54/54 PDF 缓存按 SHA-256、大小一致。03:45:19 的检查尚未发现模型写入；03:59:03 终止前检查则确认唯一工作记录由 8,053 B 变为 8,716 B，已原字节私有保全，其他 150 文件匹配 a2、零新增、operations 仍为 2 项。工作记录 SHA256 8e7b79876ae1b92d59637aecd54fe2be17915fcbc8bbd24944381f6078caf6d5。不能声称 a3 全程零写入或已捕获 a3 完整工作区。

用户明确授权暂停及终止空转以诊断后，root 先用正常 UI 请求暂停，再于 2026-11-17T03:59:26.497Z 通过目标身份 guard 向当前 Codex 发送一次 SIGTERM。实际 a3 分类为 MODEL_PROCESS_EXIT_NONZERO/unknown，run 为 paused/provider_reconcile、user_pause_requested=true；不是自然完成或正常上下文轮换。Codex 已退出，MCP 子进程自然退出为 zombie，无需 SIGKILL。原 a2 saved 快照和绝对 deadline 保留，a3 capture 仍 prepared；这是 04:02 的收尾状态；随后官方回退及 a4 继续见下节。

a3 完整未截断 raw exec 为 2,825,608 B，SHA256 0c5f6b2d1ee2df9447c8508b218d83cde1148c82998725d83055155403f29090。原始客户内容及日志不公开。完整 gateway 摘要如下：

| 项目 | a3 完整观测 |
| --- | --- |
| 请求与 HTTP | 318 请求；317 HTTP200，最后 1 请求在 SIGTERM 时尚无状态及 usage；upstream_errors=0、gateway_rejected=0，无 413 |
| 流结束分类 | completed=115、client_closed=203；不能把 HTTP200 数当作 completed 数 |
| 字节与图片 | 最大请求 326,382 B，总请求 40,561,585 B；最多 1 图，最大单请求 image data URL 157,535 B；318 条均保留、零丢弃 |
| 普通请求形态 | 281 请求均有 8 个工具、全部 HTTP200、均带 usage |
| 无工具请求形态 | 37 请求；36 次 HTTP200 且带 usage，最后 1 次在 SIGTERM 时中断 |
| 成功无工具请求之后 | 36/36 的下一请求均重置为 5 条 message（2 developer、3 user，无 function/reasoning 历史）；input usage 回到 17,050–17,477 |
| 无工具请求输入 | 已测 input usage 为 31,089–37,792 tokens |
| 命令与成果 | 295 条完成 command_execution，270 种命令 SHA；目标字符串引用计数为 input.json 150、工作记录 120、knowledge/k0 97、operations 46，计数可重叠，工作记录引用含唯一写入，不能当作独立成功读取次数；业务操作仍 2 项 |

| gateway 观测用量分组 | input | cached input | output | reasoning |
| --- | ---: | ---: | ---: | ---: |
| 281 个普通请求 | 6,928,324 | 6,367,699 | 34,670 | 13,136 |
| 36 个成功无工具请求 | 1,164,609 | 0 | 39,873 | 19,029 |
| 317 份 usage 合计 | 8,092,933 | 6,367,699 | 74,543 | 32,165 |

**a3 durable usage 仍为 unknown。** 上表是 gateway 测量，不是最终结算或持久用量替代；最后一请求也不得补成零用量。无工具形态加随后历史重置与固定 CLI 压缩机制高度吻合，但 gateway 不含请求正文，不能直接确认真实压缩提示或称为 36 个显式 compact 事件。stdout/stderr 没有显式 compact 标记也不能否认这一结构证据。

a3 所用 bcaf 版本的静态配置在恢复时把 auto-compaction 从普通文件编制的 64k 降为 32k，并将工具输出设为 2,048 tokens。准确归档的恢复提示为 55,667 UTF-8 B；input.json 8,718 B、知识文件合计 54,511 B 在磁盘上按要求读取。这些是字节，不是 token 数；不能仅靠字节宣称超过 token 限额。

固定 CLI0.169.0 的独立断网 loopback 对照使用上述大小的合成 bootstrap/input/knowledge，每轮由假 provider 注入 input_tokens=33,000：32k 阈值下 4 个普通请求间出现 3 次实际 compact，64k/128k 阈值均为 0 次，shell 均 exit0。它验证真实 CLI 的阈值机制；注入用量不是真实分词，知识输出受 2,048-token 限制，脚本模型仍然前进，不能称为复现了真实模型的重复阅读循环。该测试未使用客户文本、真实凭据或供应商调用。合成收据 SHA256 1226acf661f95109ae4f75576cc92244f95412fbfb4f8b15bca604f1dcda2d60。

完整现场形态、反复引用及合成阈值证据**强支持 32k 恢复预算使上下文反复压缩、重读准备而缺少业务进展**。关联既有 [#1324 补充记录](https://github.com/ITSophiaXu/BondBuddy/issues/1324#issuecomment-6937902273)，不将本轮 Qx 视为原 PPN 样本验收。收尾收据 SHA256 fb9beb9b622b2f91f7e4adae0be770ececb2cc5100076b085fc7a6b6f05a9ab6；形态与用量收据 SHA256 22889e204893a30ba6b7d88aaa373c81e7cc99b6b50541414b515240a9a85eb9。

恢复阈值统一到 64k 的最小修复已提交为 aee8962cc545de7b47a789d1a9779cb2da4b2556，tree 338ba66128458a8b2924955b5c801721a6868817，并扩展固定 CLI0.169 协议回归。现有 2,048-token 工具输出、2 MiB 强制 wire 预算、图片预算、原输入及绝对 deadline 保持。

独立断网容器的开发编译产物 overlay 验证为协议 3/3、adapter 53/53，共 56/56 PASS、零跳过，收据 SHA256 edfcf83cc3e5ff00951f4f01483eea6efb6b4f2047b6947f526f6177ef3cd319。旧 32k 的有效 v2 负例实际触发 unexpected_recovery_compaction 断言失败，日志 SHA256 8e0899487f5fca2b2059a2d7cb0db92a2e9545e5b4d6d63f1910230abebb5def。此前首轮负例因 catalog 字节不匹配而提前失败，不能计为压缩机制负例。

准确 aee8962 官方镜像 sha256:405dcadcf9805f236b8f963d9797dc222a15c80556d345ec5db4786623ba9255 已完成独立断网验证：协议 3/3、adapter 53/53，共 56/56 PASS，零失败/跳过/TODO，收据 SHA256 b4d3a5fb9467014a376d8d1ae13b7a133c5c1c43dd1f5b6e72d62aae4711544e。实际 image revision 匹配提交；全 LF archive 构建、核对的相关源码字节一致，未挂载编译产物 overlay。环境为 network none、UID1000、只读 rootfs、cap-drop/NNP/seccomp，无真实凭据或供应商调用；WSL AppArmor 不可用。完整构建/归档和 helper 鉴权边界见 Copilot 记录。

**准确 aee 镜像的合成验证通过，但随后真实 a4/a5/a6 证明 64k 单独没有消除重复准备，见下节。** 官方操作已显式回退到 a2，a3 工作记录另行保全，prepared capture、真实错误和 unknown 保留。真实双 Word、财务36项、全文与视觉验收仍未完成。

## a4 同 run 启动历史（04:21–04:23）

root 已于 04:21:44–04:22:14 完成带 before/after guard 的 a3 官方 retry_unknown_usage，reason 为 recovery_compaction_fixed_rollback_a2，明确回退到 a2 已核快照，保留 a3 工作记录、prepared capture、真实错误及三次历史 unknown。使用准确 aee 镜像的新 worker 10e64d620911e435cf7df5121444bdfa1f4b6a20a9177e59560e041029c8bc9e 于 04:23:08 启动，config 为 qx-isolated-aee8962c-recovery64k-v3；启动后暂停检查全 PASS，无漂移、无新 provider intent。

之后 root 用正常 UI 继续，a4 call-7c5bba99-8210-4315-9098-4636ee6faf07 于 2026-11-17T04:23:55.649Z 创建，当时观察为 running/provider_call。原 run、input、预留及绝对 deadline 不变。官方恢复与收据详情见 Copilot 记录；此前“无新 intent”仅属于 UI 继续之前的暂停检查。该段仅保留启动历史；a4/a5/a6 的完整结果及后续诊断状态如下，仍无真实 Word 或业务验收通过。

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

## 发布与未完成验收

API、contracts 和 worker 的错误分类、捕获标记、快照协议及队列恢复相互依赖，升级时须协调版本，核对实际执行节点与未来节点模板，不能只发布网站或单独替换 worker。历史无快照任务不自动重新开始。图片预算、正常轮换次数、故障恢复次数及执行时间仍有上限：超出上限的材料仍可能无法完成；完整快照超过容量或保存失败也会暂停，不能声称任意 PDF 都能完成。

本轮已提交并运行的本地Qx与生产发布分别验收；历史testlei线上计划不得冒充本轮执行。必要页面和财务明细、真实双Word交付及费用/终态仍须按上述固定输入完成验证。预算拦截、恢复成功、PR合入或镜像存在均不能单独代表业务验收或生产生效。

## a7 实际运行时策略核验（2026-11-17T05:10:26Z）

既有只读收据 ROOT/`corrected3-a7-native-progress-20261117T051026224873Z.json`（SHA256 `f116565e52d13a80233024d1e3f9cb1e941635bb1b3d32b1440aac4b66f3ec6f`）确认 a7 实际 native PID67 与 holder 对应。实际 argv 的 auto-compact 为 64,000、工具输出为 2,048；runtime developer instructions 为 1,337 UTF-8 B、custom compact prompt 为 1,340 UTF-8 B，二者均逐字匹配 5039 镜像中的 compiled 常量。新策略已加载到真实运行进程，仍不证明续跑已正确完成。

运行中采样看到 a5 清单中的 158 个文件全在，其中 157 个仍匹配 a5 SHA；唯一变化是工作记录由 12,691 增至 15,666 B，另新增 `scratch/inspect-start-new2.json`（8,262 B）。operations 仍为 940 B / 原 2 项，SHA256 `18806fd546d6ea41febf5d9ba47f80732ccdfc28095b29f72023e3569a22c8c1` 不变，没有 Word 输出。**这是运行中的非原子观察，不是恢复瞬间 158/158 的原子完整核验、a7 saved 快照或终态证明；也未证明新增正文编辑、循环消除或业务交付。** 原输入、预留、deadline 及财务 0/36、视觉 NOT_RUN 边界保持。
