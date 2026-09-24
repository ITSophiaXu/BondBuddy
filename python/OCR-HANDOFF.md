# #14 OCR 与用户校正交接

本切片提供真实 Tesseract OCR、私有原页/结果持久化和浏览器核对。它可以被材料预检 worker 调用；没有启用上传后自动 OCR 调度，也不改变现有生产 execute 的门槛。#14 保持开放，不能将这份工程交接等同于真实客户文档验收。

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
