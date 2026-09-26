# #11 更新项目表单收尾验收

日期：2026-09-26。基线：develop `e9b8d40`。前置 #8 已关闭。本记录汇总 #11 的四项验收及本轮 DFI 原稿分类修复，不把表单验收扩大为募集书生成或专业规则验收。

## 验收映射

| #11 验收项 | 结果与可复现证据 |
| --- | --- |
| 沪深仅显示普通私募、小公募、大公募；DFI 仅在交易商协会发行方式中 | 已通过。`form-model.test.ts` 覆盖合法组合及错误组合；[预发真实浏览器记录](issue-11-12-preprod-2026-09-26.md)验证三个市场下的选项。没有 DFI 独立入口或注册模式问卷。 |
| 切市场清除不适用方式、保留可复用信息；DFI 保存恢复 | 已通过。`update-form.integration.spec.ts` 在真实 HTTPS/API/PostgreSQL/Azurite 下保存 DFI、关闭整个浏览器上下文、重登恢复；切换市场及两页 409 后保留/明确放弃本页输入均通过。 |
| 单承销商无需联席、多品种不预建两档、无重组/投资者保护开关 | 已通过。沿用展开表单和自由机构/债券安排；[表单验收](../../apps/web/FORM-ACCEPTANCE.md)与本轮浏览器用例验证单主承销商、自由债券文本、多项资金用途及补充信息保存恢复。 |
| 未定额度/本期条款可空；后台区分 DFI 注册安排与具体工具 | 已通过。真实 API 保存并恢复 null 额度；新增统一的原生/OCR 分类器：统一注册稿列出覆盖的 MTN/CP/SCP 仍归 DFI，明确本期工具时归该工具；引用、否定、未定或矛盾证据仍待确认。 |

以上满足 #11 自身验收，合并后可关闭。历史稿完整识别、OCR 质量、多轮对话、规则适用、全文生成和 Word/WPS 验收由各自 issue 继续跟踪，不由这张表代替。

## 本轮改动与兼容性

- `nafmii-offering-evidence.ts` 为原生和 OCR 原稿识别提供共享判别，避免 DFI 覆盖清单被误当作本期发行工具。仍要求独立锚点佐证；OCR 候选不自动变成已确认事实。
- 原生识别版本升至 `historical-native-recognition-v3`，读取兼容 v1/v2；OCR 升至 v2，API/worker 兼容 v1。旧快照不重写，公共市场/方式枚举、HTTP DTO、数据库迁移均不变。
- Windows 本机样本联调发现两个问题：Node 路径检查误拒绝带盘符的绝对路径；Python 管道继承非 UTF-8 系统编码，中文路径被误读。改用主机路径判断，并在普通/流式子进程固定 UTF-8。相对路径仍在启动 Python 前拒绝；文件授权、hash、符号链接与证据校验保持。
- Windows 的三项暂存测试使用既有默认临时目录；Linux 继续使用带锁的指定暂存目录，不关闭生产锁或修改暂存策略。

## 实际执行结果

环境：Windows、Node.js 22.14.0、PostgreSQL 16.14、Azurite；专用隔离数据库，迁移至 0044。本机 HTTPS 使用临时自签证书，无模拟登录身份。没有真实模型调用、积分消耗或生成成果。

| 检查 | 结果与边界 |
| --- | --- |
| M1 全包 build、公共契约样例、Web 单元测试 | 构建通过；契约 29/29、Web 单元 34/34，均无跳过。 |
| 解析器响应与路径边界 | 7/7，无跳过；版本/字节绑定、错误响应、页/段/单元格定位及相对路径拒绝。定向运行，不包含 Linux shell 专用用例。 |
| 表单 API、源信息校正、历史稿预检/仓储 | 25/25，无跳过；真实 PostgreSQL/Azurite，内容为明确合成 fixture。 |
| 原生/OCR/DFI/UTF-8 回归 | 34/34，无跳过。含四份授权历史 DOCX 经真实 Python 解析桥验证市场、方式、期间及不确定性传播；含普通 JSON 与流式管道中文路径/内容回归。 |
| HTTPS 真实浏览器 | 2/2，无跳过，13.8 秒；DFI 表单、PDF 保存、关闭/重登恢复及冲突处理。合成项目与 PDF，真实 API/数据库/Blob。 |
| 预发环境 | 沿用同日 #261 的真实注册/表单/授权任丘九月 DOCX 上传及源候选展示记录；本轮修复尚未部署，不把旧部署计为新版分类器上线。 |

四份原稿来自 `tests/samples/2026-09-25/manifest.json`，使用前核对 SHA-256。它们都是上交所普通私募测试材料；DFI 反例为明确合成材料，不能据此声称真实 DFI 文书专业验收。图片/页眉页脚等不完整解析仍返回 `needs_confirmation`；原稿信息来自原文，未从用户目标期间回填。

## 复现

按 `apps/web/README.md`、`apps/api/README.md` 配置专用 PostgreSQL 16/Azurite 与 HTTPS 开发环境，执行：

```sh
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
node --test apps/api/dist/update-project.test.js apps/api/dist/source-profile-correction.test.js apps/worker/dist/historical-material-precheck.test.js apps/worker/dist/historical-profile-repository.test.js
```

设置 `BB_RUN_AUTHORIZED_SAMPLE_TESTS=1` 与 `BB_PYTHON` 为已装 `python/requirements.txt` 依赖的解释器，再执行：

```sh
node --test apps/worker/dist/historical-native-recognition.test.js apps/worker/dist/historical-ocr-recognition.test.js apps/worker/dist/nafmii-offering-evidence.test.js apps/worker/dist/document-parser-utf8.test.js
```

浏览器按 README 设置 `BB_E2E_LIVE=1`、`BB_E2E_REAL_API=1`、HTTPS 地址和实际测试协议版本，运行 `update-form.integration.spec.ts` 与 `project-events.integration.spec.ts`。日志、临时证书、数据库、客户正文与浏览器凭证均不入库。
