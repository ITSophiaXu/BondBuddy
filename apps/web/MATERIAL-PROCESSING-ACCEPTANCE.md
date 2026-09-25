# #12 上传后的解析状态与历史稿信息：验收记录

日期：2026-09-25。初始基线：develop `39640c3`，包含 #149 持久化解析接口；之后同步 #151/#152 及 `294d614` 的 #153。#153 已提供持续 worker、OCR hook 和回填 CLI，本次相应更新运行中 OCR 状态及阻塞判断，保留双方架构记录。本次交付是 #12 的浏览器后续切片；不关闭 #12，也不宣布 M1 全流程上线。

## 行为与契约

- 完成字节传输后先等服务端确认保存，再独立展示解析任务。使用 `MaterialParseJobResponse` / `RecognitionResponse`，不从旧的 `MaterialResponse.state` 推断解析已经结束。不新增契约、枚举或数据库迁移。
- 项目事件恢复材料列表后，读取每个精确材料版本的任务。排队/执行中自动查询；已结束、暂停和读取失败不无限重试。无任务的旧材料明确显示暂无记录。手动按钮只重新读取状态，不重新排队、校正、执行全文更新或收费。
- 历史稿显示原发行市场、发行方式、年度/中期期间、合并/母公司/未知口径和最新报告截止日，以及原文、来源版本、待确认理由。源字段不会覆盖目标表单；不以发行日代替报告期，不补默认品种，不把用户说法升级为审计事实。
- #76 浏览器校正切片展示“历史稿来源”和“本次发行目标”两个独立区域；目标始终取当前项目表单。校正表单让用户显式选择修改的字段，可逐期添加、编辑、移除并提交完整期间列表，选填既有证据锚点并填写原因；最新截止日不由浏览器输入或从文件名推断，由 API 根据完整期间列表派生。请求使用 `RecognitionPatchRequest` 和十进制 `If-Match: profile_version`。保存后仍显示用户提供/待确认状态；409 刷新最新 profile 并提示核对，PATCH 路由不可用时保留只读展示。此浏览器没有难度估算查询或视图，尚不能验证校正后失效并重取难度结果。
- 识别结果显示前检查 project/material/version/hash 及逐字段 provenance。单个视图最多 3 个并发读取，单轮 15 秒超时，排队/运行轮询为 3/6/12/15 秒。离开项目/退出/切换账号撤销请求并丢弃旧结果；隐藏页面停止调度，返回先核对身份。个人数据不写 localStorage/sessionStorage。
- 真实联调发现并修复：恢复材料列表时重建文件选择控件，会丢失恰好随后到达的选文件事件。列表更新现在保留仍适用的原输入节点；状态刷新也不重建项目表单。

## 验证证据

所有材料均为代码生成的合成文件，没有客户数据或真实模型调用。环境为 Windows / Node 22.14.0 / PostgreSQL 16.14 / Azurite 3.35 / Playwright 1.63。使用独立数据库、对象存储端口和 Vite 端口，不复用其他人的服务。

| 检查 | 结果与范围 |
| --- | --- |
| 全部 M1 包构建 | 最终 `npm run build` 通过，包含 contracts/domain/API/worker/Web |
| 公共契约 | `npm run check:contracts`：最终 #153 基线上 78 个合成样例通过；本次契约未修改 |
| Web 单元测试 | 17/17 通过，其中新增 9 项覆盖绑定、未知/待确认、旧响应、并发、隐藏页、错误恢复等 |
| 浏览器套件 | 20 通过、9 跳过，包含本次新增的真实解析联调用例；既有账号/项目/OCR/项目事件/完整表单专项 live 开关未启用，不声称重验这些专项 |
| 合成浏览器接口用例 | 实际浏览器操作；模拟响应覆盖 saved → queued → running → succeeded、OCR 暂停、失败、无任务、读失败重试、DFI 标签、未知口径、原文转义、目标不被覆盖、重复版本合并读取、离开/换号后的迟到结果、控件保留 |
| 真实上传 → Python 解析 | `material-processing.integration.spec.ts` 不拦截 API、不模拟解析返回。浏览器登录/创建目标为交易商协会 MTN 的项目，上传具有两个独立章节证据的合成历史 DOCX；实际识别原市场上交所、普通私募公司债及 2022/2023/2024 年报告期，目标仍为 NAFMII/MTN |
| 真实恢复与去重 | 上传后关闭标签再打开仍看到排队；手动运行真实 worker drain 后展示结果；改名上传原文件，数据库仍只有 1 个解析 job、1 个历史画像，下一次 drain 为 idle，项目没有全文更新 run；退出重登继续恢复 |
| OCR 与账号隔离 | 实际 PNG 上传后由 worker 写入 paused/awaiting_ocr，页面准确提示；另一真实账号访问项目、parse-job、source-profile 均被拒绝，后两者为 404，无旧画像残留 |
| 视觉检查 | 检查 1440px 桌面与 390px 窄屏截图；原文按文本显示，窄屏无横向溢出。截图只保存在临时目录 |

### #76 源信息校正浏览器切片（2026-09-25）

当前分支补充了源/目标分区、逐字段证据锚点/不确定性、市场/发行方式/报告期校正表单，以及对 `RecognitionPatchRequest` 的 PATCH。期间列表支持添加/删除和整表替换；截止日交给 API 从新列表派生，浏览器不推断。浏览器发送十进制 `If-Match`，校正原因必填；PATCH 成功后重新读取源画像并继续显示 `user_asserted`/待确认状态。版本或证据冲突（409）触发读取最新画像并要求用户重新核对；不可用接口保持只读。不修改共享 schema 或 API。

验证：从新依赖安装后全 workspace `npm run build` 通过；Web 单元测试 28/28 通过，包括源/目标隔离、只读降级、十进制 `If-Match`、缺漏期间添加、多余期间移除、整表替换、pending 状态和 409 刷新。全部为合成数据；未运行部署 API 联调、真实 OCR或真人专业验收。Web 尚无难度估算 API/视图，因此校正后的难度缓存失效和重取仍未验证。

### 测试环境限制

本机缺少 Playwright 默认要求的 Chromium revision 1243，使用临时配置指定已安装的 Chromium headless revision 1223；未修改仓库的默认浏览器配置。首次缺二进制的启动失败不计作功能测试通过。

生产 parser bridge 面向 Linux，只接受 POSIX 暂存路径。本机 Windows 联调通过测试注入点直接运行同一真实 Python 模块，再使用原 `validateDocumentParseResponse` 校验返回，并明确设置 UTF-8；未模拟文书内容或识别响应。这证明本地组件串联，不证明 Linux 部署或 Windows worker 已通过验收。初次只有 Title 样式的合成封面被保守识别为证据不足；最终样本提供两个明确 Heading 章节，未放宽业务识别阈值。

浏览器使用 localhost 的真实 Cookie 会话及真实 API；没有以本地 HTTP 结果冒充生产 HTTPS 验收。worker 由测试显式调用 `runMaterialParseOnce`，没有部署持续调度器。没有验证真实 OCR 内容、授权客户文书、全市场识别准确率、难度计价或 Word 交付。

## 复现

先构建依赖，准备专用 PostgreSQL 16/Azurite/API，运行当前 develop 的所有迁移，并让 Vite 代理该 API。API `BB_ALLOWED_ORIGIN`、测试 `BB_E2E_BASE_URL`、协议版本须一致。专用数据库不得有其他测试正在争抢全局解析队列。

```sh
npm ci
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
npx playwright install chromium
BB_E2E_PARSE=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 \
  BB_TEST_DATABASE_URL=postgresql://... \
  BB_TEST_AZURITE_CONNECTION_STRING='UseDevelopmentStorage=true' \
  BB_PYTHON=python3 npm run test:web
```

测试会创建随机账号、项目和合成材料，保留数据库/Blob 证据；结束时只取消本测试仍未结束的解析 job，避免后续 drain 误领，并移除本次临时生成的本地 DOCX。其余持久化数据由专用测试环境生命周期处理。

## 阻塞 callout 与责任

| 依赖与当前负责人 | 尚缺交付 | 阻塞的验收 |
| --- | --- | --- |
| #17 / #35：muhualing | #153 的运行进程/回填 CLI 已就绪，仍需 Compose 部署、实际回填及重启验证 | 部署后上传能自动开始、早期材料也能取得真实任务；本次手动 drain 不能替代 |
| #14：ChrisLiu95；#17：muhualing；#76 消费方：loooo139 | #153 OCR hook 已合入，仍需 Tesseract/配置和真实 OCR/存疑数字验收 | 扫描/混合 PDF 和图片完成识别；未启用 OCR 时仍停在 awaiting_ocr |
| #76：loooo139；浏览器：ChrisLiu95 | #187 API 与本 PR 的 source/target 展示和源信息校正控件；仍需部署联调。Web 当前无难度估算视图/API，需由消费难度估算的切片提供失效和重取入口 | 在线校正保持 user_asserted/needs_confirmation；不能据本 PR 宣称难度已重算、事实已核验或 #76 验收完成 |
| #76 / #13：loooo139；#8 / #35：muhualing | 授权真实材料准确性、缺页/附注/期间完整性、生产 Blob/TLS、备份与实际大文件压测 | #12 整体验收及 M1 发布；本次合成原生 DOCX 通过不能代替 |

上述责任按 2026-09-25 GitHub assignee 核对。#13 已关闭并不意味着 OCR、所有材料完整性或 M1 联调均已完成；本次未重开它，也没有更改他人的 Issue 状态。
