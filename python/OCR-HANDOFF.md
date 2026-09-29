# #14 OCR 与用户校正交接

本切片提供真实 Tesseract OCR、私有原页/结果持久化和浏览器核对。它可以被材料预检 worker 调用；没有启用上传后自动 OCR 调度，也不改变现有生产 execute 的门槛。#14 保持开放，不能将这份工程交接等同于真实客户文档验收。

## v2 物理页批次与 checkpoint 契约（2026-09-26）

**状态：共享契约 + Python 算法/CLI + 独立 opt-in 内部持久运行时已实现；自动 parse/OCR hook 和用户核对 API 仍是 v1。** 本节在既有 v1 上增量定义，不更改下文 v1 的处理器、请求/响应、50 页全文限制、数据库快照和校正接口。后续 v1 OCR hook 的运行编排以 `docs/M1-TECH-ARCHITECTURE.md` 的 #17 章节为准；现有 hook 没有切换为 v2。真实 74/70 页材料目前仍不能通过 v1 自动预检路径接入全文 OCR。

2026-09-29 的内部运行切片以 `npm run ocr:v2 -- full_ocr OWNER PROJECT MATERIAL VERSION RUN_ID LEASE_TOKEN` 调用已存在的 running、已领取租约、输入锁定且包含该材料版本的 run；`source_preflight OWNER PROJECT MATERIAL VERSION` 只限已有持久 parse job 与前 3 页，跨请求累计最多 5 页尝试（失败或中断保守占满该批页预算）。不对浏览器增加执行入口、不给 v1 的最新核对快照冒充 v2 结果。Python `ocr-identity-probe-v2` 从已核对 SHA 的私有原件和当前 Tesseract/语言文件/PDFium/配置计算物理总页数及身份；后续逐批最多 50 页，缺页单独重试。默认要求目标环境 `chi_sim+eng`，调试可在受信调用方设 `language: eng`；不得将本机英文字库调试宣称中文部署验收。运行时只在独立 `0080_m1_ocr_v2_checkpoints.sql` 中记录批次、成功页引用及既有 `platform.processing_cost` outbox；租约冲突用数据库会话 advisory lock 序列化同一材料，单个 batch 的真实尝试量或中断后的 null 用量与 outbox 同一事务提交。读取缓存必须按 owner/project、原件精确版本/SHA、处理器/引擎/语言包/配置/渲染/物理页身份读回 checkpoint JSON 和 PNG 字节并调用共享 v2 语义校验；失败页不保存成功记录，任一页缺失只能 partial，不宣称 complete。删除材料的派生字节清理由现有 deletion lifecycle 处理，未入库的对象由存储 inventory 标记为候选而非自动删除。

本切片不将成功 v2 页变成 `bb_ocr_snapshots` 的 v1 原页或校正：v2 页面核对的公共 API、自动 source preflight→全文 run 串联、#15/#76 消费及 run 阶段/终态接线仍须单独做，不能用内部 CLI 的 aggregate=complete 判断成果已交付。原生解析优先、上传预检不触发全文 OCR、M1 平台承担的费用策略均保持不变。测试覆盖 PostgreSQL 16 上的 74 页 synthetic 分批、单页失败/重试、读回变更/跨账号拒绝、中断后 unknown 消费及累计预算；Python 探针在合成 PDF 上验证真实页数和原件 SHA，不能替代私有 Blob/Azurite 实机、目标镜像中文语言包、扫描历史募集书/财务金标准准确率和专业签认。

2026-09-27 的 Python 算法切片新增 `python/bondbuddy_ocr/v2.py` 和 CLI 的 `ocr-invocation-v2` 内部信封。信封包含契约原样的 `request`、受信调用方写入临时目录的 `material_path`，以及由调用方读回后提供的 `reuse_checkpoints`（每项 checkpoint + 原页 PNG Base64）。成功输出为 `ocr-invocation-response-v2`，其中 `response` 是契约 `OcrBatchResponseV2`，`checkpoints` 是新成功页的 `OcrPageCheckpointV2` + 原页 PNG Base64。它只产生内存/子进程结果，不证明 owner 授权、持久化、Blob 读回或缓存安全；服务端仍须用合同 validator 对持久读回的 checkpoint/image 做最终验证。新页最多50、单页 PNG 最大48 MiB、一次返回图像总量最多128 MiB；超限页会有明确失败，不会静默截断。CLI v1 输入/输出保持原状。

新处理器按 `pages` 指定的原件物理页号调用 PDFium/Tesseract，稀疏选择不重排页号；失败项保留 `attempted`/`retryable`，预引擎失败计 `false`，已启动引擎的失败计 `true`。如果 Python 子进程/worker 在没有响应时中断，运行时必须按既有计量契约把该页消费记为 unknown（`attempted=null`），不能把没有结果当成零消耗。单页重试须使用新 `request_id`；复用仅接受请求中精确引用、先前请求、匹配物理页身份/hash 和可校验 checkpoint/image。每条新 OCR record 继续带 `uncertainty` 并固定 `eligible_for_manuscript=false`。Python 与 TypeScript 使用同一规范 JSON 摘要算法，并由共享 synthetic checkpoint 固定向量交叉检查。

原算法 PR 只实现算法/协议；上述独立运行切片补齐内部调用的持久检查点和计量，但仍不接入 #17 常驻 run 阶段调度、公共核对 API、生产 Tesseract/语言包镜像或 #15/#76 消费接线。worker 的持久复用必须先做 owner/material/run 校验并从私有存储读回；哈希不构成签名或授权。真实页 OCR 仅作为本地 smoke 时也不是准确率/财务验收。

`packages/contracts/src/ocr.ts` 定义 TypeBox schema 和推导类型，`ocr-v2.ts` 定义导出的语义校验器与摘要函数；均从 `@bondbuddy/contracts` 导入。它们是内部传输契约，不进入公共 OpenAPI，也不新建 HTTP 路由。**JSON Schema 只能检查形状，必须同时调用相应 `validateOcr*V2` 校验器**，不能仅凭 `Value.Check` / AJV 接受完整覆盖或 checkpoint。

| 契约 | 字段与含义 |
| --- | --- |
| `OcrDocumentIdentityV2` | `owner_user_id`、`project_id`、既有 `material`（ID/version/MIME/SHA-256）、原件物理 `page_count`、`processor_version`、`engine`、`rendering` |
| `engine` | name/version/language、逐语言及方向模型 `language_data_sha256`、完整 OCR 配置的 `parameters_sha256`。每个指定语言必须有摘要，不得用名称代替真实语言数据版本 |
| `rendering` | renderer/renderer_version、dpi、max_page_pixels、完整渲染配置 `parameters_sha256`；单页仍不超过 2000 万像素 |
| `OcrPageIdentityV2` | `document` + 从 1 起的原件物理 `page`，不是批次内序号、印刷页码或拆卷后重排页号 |
| `ocr-request-v2` / `OcrBatchRequestV2` | request_id、document、context、严格递增且唯一的 `pages`、这些页中可复用的 `reuse` 引用；单批 1–50 页，可稀疏选择失败页 |
| `ocr-page-checkpoint-v2` / `OcrPageCheckpointV2` | identity、identity_sha256、source_request_id、result_sha256、result。result 保存既有页信息（去掉内嵌 image_base64）、原始 records、needs_confirmation 和 eligible_for_manuscript=false |
| `OcrCheckpointRefV2` | page、identity_sha256、result_sha256、source_request_id；引用不包含路径，不单独构成成功或授权证明 |
| `ocr-response-v2` / `OcrBatchResponseV2` | request_id/document/context 必须与请求相同；page_results 与请求页列表逐项一致。成功项带 checkpoint 引用和 reused；失败项带 attempted（true/false/null）、retryable、非空 error、warnings |
| `ocr-aggregate-v2` / `OcrAggregateV2` | document/context、严格递增的 successful_pages 引用和 coverage。只有逐页读回验证且精确覆盖物理 1..N 才是 complete；否则必须 partial 或 none |

`parameters_sha256` 必须由受信执行端对实际使用的不可变、版本化配置清单计算，不能由浏览器传入或使用占位值。OCR 清单包含全部识别模式/参数、表格恢复策略与阈值；渲染清单包含颜色/缩放/裁剪/EXIF/旋转及方向置信阈值、编码参数和所有影响像素的依赖版本。方向模型如 `osd` 的真实内容摘要也必须登记。处理器变化必须新版本，不能把现行 `bondbuddy-ocr-1.0.0` 冒充已实现 v2。配置清单的实际生成、锁定、保存和与运行参数一致性检查属于后续运行时接线；schema 不能证明调用端提供的配置摘要真实。

### 成功页验证与摘要

- `ocrPageIdentitySha256V2(identity)`：SHA-256 的输入为 `{schema_version:"ocr-page-identity-v2",identity}` 的规范 JSON。
- `ocrPageResultSha256V2({identity_sha256,source_request_id,result})`：输入再加 `schema_version:"ocr-page-result-v2"`。因此结果摘要绑定页身份、来源请求、图像摘要、全部文字/框/表格/存疑信息，不能拼接另一个账号、版本或请求的结果摘要。
- 规范 JSON 使用 ECMAScript `JSON.stringify` 的标量表示、对象键递归按 JS 字符串顺序排序、数组原顺序、无额外空白、UTF-8。不得排序记录/页数组、归一化原文或省略 null。其他语言实现需对照合成摘要向量，不能直接假设默认 `json.dumps` 与此兼容。
- `validateOcrPageCheckpointV2(value, expectedIdentity, imageBytes)` 比对受信 expectedIdentity、重新计算两种摘要、验证图像 SHA-256/PNG 头/宽高/像素上限、记录对应物理页、记录 ID 唯一、框在原页内、表格跨度合法和每条 uncertainty 非空。数值沿用 number/blank/dash/unparsed，非 number 的 decimal 必须 null。
- `record_id` 和 `table_id` 保留在各自页 checkpoint 的作用域；引用需同时携带 checkpoint/物理页身份，不能仅按一个表 ID 合并不同页的表格，也不能声称已完成跨页表格语义还原。
- 这里与 v1 一样检查 PNG 头和摘要，不代替安全图像解码、源文件真实性、OCR 质量或存储持久性证明。下游不能以 `status=succeeded` 的批次项认定事实已核验：它只表示识别页成功生成。checkpoint 的内容状态始终 needs_confirmation。
- `validateOcrBatchResponseV2(response, request, reader)` 与 `validateOcrAggregateV2(aggregate, {document,context}, reader)` 按页顺序调用 `OcrCheckpointReaderV2` 读回 `{checkpoint,image}`，逐页验证；不必把整份 PDF 的图像内嵌在响应或同时载入内存。存储读取失败、hash 不符或任何身份不匹配均明确抛错，不静默丢页。
- reader **必须**由后续服务端按受信 owner/project/material/version 校验数据库归属和删除状态、读取私有不可变对象后提供。expected identity/context 也必须由服务端锁定输入推导，不能复制待校验 payload。摘要不是签名、授权凭证或成功持久化回执；仅有 DTO 或调用者自称成功，不得命中生产缓存。

### 覆盖、失败与计量边界

单个 batch 永远只有 `coverage=partial/none`，即使本批碰巧覆盖全部页，也由 aggregate 单独声明完整覆盖。原件 page_count 最多 1500，不能用批次长度改写总页数。aggregate 拒绝缺页冒充 complete、重复页、越界页、无序页、外来身份、错误摘要及读取失败；完整覆盖仍不是专业验收或 run 成功。

失败页没有成功 checkpoint，保留失败原因和原始消费记录，以新 request_id 单独重试该物理页。成功页 `reuse` 引用须来自其他 request_id 并匹配请求中的完整引用；不可仅根据 attempted_pages 或一个成功布尔值复用。相同 request_id 重投属于后续幂等响应重放，不是一次新批次或复用自己。

`attempted_pages` 是**当前批次**实际进入 OCR 的不同物理页数：新成功页计 1，复用页计 0，失败按 attempted=true/false 计 1/0；任何 attempted=null 则总量必须 null。单批每页最多一次尝试，页内表格/方向识别的多个引擎子调用不重复算物理页；重试另起批次并保留前次消耗。崩溃后无法核对是否进入引擎时保持 unknown，不能记 0。aggregate 故意没有此字段，不能用最终成功页数替代所有尝试的消费历史；#79 接线需沿用现有 `platform.processing_cost` 幂等域与日志，不另造账务。

`context` 固定保留业务边界：source_preflight 的 run=null，单次及允许物理页集合都不超过前五页（默认调度前三页）；full_ocr 必须有 run_id/execution_request_id/input_revision/input_hash。二者在 M1 都为 billable=false、cost_payer=platform。run 引用不是授权，后续仍需验证当前 active run、明确执行和不可变输入包含本材料，不能凭布尔值或伪造引用启动全文；未来 M2 付费须单独评审计费契约。预检重复请求的累计尝试预算也需运行时限制，不能轮换请求绕过。

同一精确身份下，预检成功页可供显式全文任务复用，但不能把预检 context 改名当成已授权全文；新任务 context 需独立核验。原始 OCR 和用户校正分开：继续使用既有 `OcrCorrection` 的 user_asserted/eligible_for_manuscript=false，不能改写 checkpoint 的原始记录，更不能升级成审计确认。v2 校正引用及 #15/#76 适配尚未接线。

### 本切片证据与后续

`packages/contracts/examples/ocr-v2.json` 明确 synthetic，使用可解码的一像素 PNG 与人为记录；不是杞县原件或真实引擎响应。`ocr-v2.test.ts` 动态构造 70/74 页、50+20/24 的批次、局部缺页、单页重试、复用零新增消费、未知消费及身份/hash/框/数字/用户确认反例，另外检查 v1 schema 与 50 页上限不变。运行：

```sh
npm run build -w @bondbuddy/contracts
npm run check:ocr-v2 -w @bondbuddy/contracts
npm run check:contracts
```

Python v2 协议、有界渲染及独立内部 worker/API 持久页路径已接入；后续需把这些内部页接入现有 #17 常驻调度及公开核对/校正版本与下游事实/profile 消费。现存 v1 snapshot 不原地改写、不自动转换为 v2 成功页；本次只新增独立 0080 迁移，不改既有部署镜像。Tesseract/chi_sim 部署、真实 74/70 页性能与财务金标准、Windows/Word 和专业验收仍未完成，不关闭 #14。

## 运行边界

- `python/bondbuddy_ocr` 接受 `ocr-request-v1`，输出 `ocr-response-v1`。公共和内部形状集中在 `packages/contracts/src/ocr.ts`；保留现有 `document-parse-response-v1` 原生解析契约。
- 可信 worker 先按 owner/project/material/version 验证原件和 SHA-256，写入私有临时目录，再运行 Python。Python 再校验源文件哈希。临时文件结束即清理；子进程超时、输出超限或异常不会存成成功快照。
- `source_preflight` 默认最多前三页，硬上限五页，费用归平台，`billable=false`。部分覆盖明确返回 `coverage=partial`，不能代表全文。原生文本可用时应先消费 #13；源信息缺口需要 OCR 时由预检编排调用本接口。
- `full_ocr` 需要传入真实、当前账号项目的 active run，该 run 的不可变输入必须包含本材料版本；仅一个布尔值不能绕过 worker 的数据库核验。最多 50 页，超过预算整次失败，不静默截断。M1 全部仍由平台承担成本，未来计费需经独立契约变更。
- 公共 HTTP 只读已生成结果、读取校验过的原页和保存校正，不运行 OCR/模型。运维单次命令只能发起有界预检，不提供执行全文的公开后门。

## 结果与下游消费

- PNG/JPEG 和扫描/混合 PDF 使用同一接口。PDF 逐页按 250 DPI 渲染；每页最大 2000 万像素。原件不改动，派生 PNG 含完整页面，框坐标以 `rendered_pixels_top_left` 表示。
- OSD 仅在方向置信度达到阈值时旋转，并记录顺时针角度；不能可靠判定时保留方向并标 `orientation_unverified`。图片 EXIF 方向在派生图中应用，不改原件；这些坐标不能直接当作未旋转原件的坐标。
- 保存处理器版本、真实 Tesseract 版本、语言包/方向模型 SHA-256、材料版本、原件 hash、每页图像 hash。结果和图片都存私有 Blob，写入后回读核验；数据库只存结果引用和版本关联。
- 表格处理识别长横/竖线和交点，从封闭网格恢复矩形候选单元格、行列和 row/column span，逐格识别短表头/数字。原图保留边线，识别裁剪只去单元格边框。无完整网格、非矩形合并、跨页表头匹配和复杂结构不宣称已还原；整份结果仍需核对。
- `numeric.kind` 区分 number、blank、dash 和 unparsed。数值用十进制字符串；显式括号负数、千分位、小数和元/万元/亿元/% 单位保留，不从列头猜单位，不交换年序。未识别出的有墨迹单元格为 unparsed；短横线的形状辅助识别单独标记 `dash_shape_inferred`。
- 所有 OCR 记录都含 uncertainty 且 `eligible_for_manuscript=false`，即使置信度高也不是核验事实。表格行列、期间、单位、主体口径必须继续经过 #15 的独立事实/来源核对。下游不得将这些记录包装成 native_text 或静默去掉门槛。
- 用户校正追加 revision、原值、新值、说明、期间/单位/口径、服务端 actor 和时间；`status=user_asserted`，仍 `eligible_for_manuscript=false`。旧识别与旧校正不覆盖；新旧版本冲突返回 409，相同 request_id/payload 重放不重复写事件。
- `bb_ocr_snapshots` 和 `bb_ocr_corrections` 在追加迁移 `0017_m1_ocr_review.sql` 中；各自 append-only。结果/校正与状态型 outbox 同事务，outbox 不写识别文字或校正明文。账号注销、材料删除、跨账号访问均不能通过这些读取接口绕过权限。

## 接口和页面

- `GET /api/v1/projects/{project_id}/materials/{material_id}/ocr`：最新当前材料版本的核对结果和历史校正。
- `GET .../ocr/pages/{snapshot_id}/{page}`：owner 校验后返回 hash 已核对的 PNG，private/no-store。
- `POST .../ocr/corrections`：必须带 snapshot_id、result_sha256、record_id、expected_revision、request_id、corrected_text、reason、period/scope/unit（未知时 null）。
- 项目材料行的“核对识别内容”打开 `#/projects/{project_id}/materials/{material_id}/ocr`。选择记录显示原页小范围片段和框线；图片未读到之前不能提交。未保存输入离开会提示，保存期间避免切换或覆盖新输入。没有结果时明确显示尚无可查看结果。

## 安装与复现

需要 Python 3.11+、Tesseract CLI、`eng`、`chi_sim` 和可选方向模型 `osd`。Python 依赖见 requirements-dev.txt；Pillow、NumPy 和 PDFium 用于图像/表格几何与渲染，没有新增模型供应商。

```sh
python3 -m venv .venv
.venv/bin/pip install -r python/requirements-dev.txt
npm ci
npm run build
npm run migrate:api
```

语言包使用 Tesseract 官方 [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)，存放在部署环境并用 `TESSDATA_PREFIX` 指定目录；不要把模型或客户材料提交到仓库。CLI 参数和 TSV 定义见 [Tesseract 命令行文档](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)。发布环境需要自行确认版本/资源上限。

已有真实 owner/project/material/version 后，在仓库根目录由受信运维/worker 运行：

```sh
BB_PYTHON="$PWD/.venv/bin/python" npm run ocr:preflight -- OWNER PROJECT MATERIAL VERSION REQUEST_ID
```

数据库和私有存储配置沿用 API 的 DATABASE_URL 与 AZURE_STORAGE_CONNECTION_STRING。此命令没有替用户创建 run，也不会启用模型任务。

测试：

```sh
PYTHONPATH=python BB_OCR_CHINESE_TEST=1 .venv/bin/python -m unittest discover -s python/tests -v
BB_TEST_DATABASE_URL=... BB_TEST_AZURITE_CONNECTION_STRING=... npm run test:api
BB_E2E_BASE_URL=https://127.0.0.1:5175 BB_E2E_LIVE=1 BB_E2E_REAL_API=1 BB_E2E_OCR=1 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 BB_TEST_DATABASE_URL=... \
  BB_TEST_AZURITE_CONNECTION_STRING=... BB_PYTHON="$PWD/.venv/bin/python" npm run test:web
```

测试动态生成合成中文表格和混合 PDF；不依赖客户材料。可用 `BB_OCR_TEST_FONT` 指定支持中文的本地字体。浏览器测试实际调用 Tesseract worker、PostgreSQL、Azurite 和真实 API，不用模拟 OCR 替代识别。测试在本地接受自签名 HTTPS；不代表生产 TLS。

## 仍需继续的验收

1. #8/#17 的自动预检编排、检查点恢复和统一 job 错误时间线尚需接入；本切片交付可调用 worker 和页面，不启用新的自动执行入口。
2. #15/#76 消费 OCR 结果、校正与上下文的适配，以及授权真实材料的财务表格/跨页准确率和行业验收。
3. 大于 50 页全文需按不可变页面清单设计分批调度；不能通过提高前端传参绕过当前限制。
4. 无线框、破损表格、方向不明、复杂合并/跨页内容的高可靠还原；当前保持候选和待确认，不按空白或零值交付结论。
5. OCR 派生 Blob/校正明文的生产保存期限、删除/备份清理策略与 #8/#9 生命周期统一。当前删除后立即停止访问，但不宣称字节已物理清除。
