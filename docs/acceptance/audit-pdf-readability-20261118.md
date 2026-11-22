# #1623 审计 PDF 误拦修复验收

代码：`b6399efac134deef9758cb7b908aed59f0cd7c8b`，基于 develop `303ea69a`。后续提交仅补验收文档、同版本截图。状态：开发和自测完成；尚未部署；用户实际验收与最终统一验收待办。

## 根因及修复范围

旧 v3 把低于 200 DPI、面积覆盖至少 50% 的图片直接作为拒绝依据。获授权原件 A 的第 8 页实际由 150 DPI 背景和 300 DPI ImageMask 财务文字组成，背景 DPI 不能代表数字清晰度；普通可读 150 DPI 扫描同样会被旧规则误拦。

v4 将低 DPI 改为风险提示，候选页合成多个图层后检查有界局部细节，只有多个区域同时严重不足且高清局部复核未发现清晰边缘时拦截。清晰边缘区域直接跳过连通分量分析。所有来源共用同一算法，无客户、公司名、文件名、hash 白名单。原型/规则详见[产品决定](../product-decisions/2026-11-18-audit-pdf-readability.md)。

v2/v3 不再决定当前门禁，旧回执保留，新 v4 检查按 owner/project/material/version/hash 幂等创建；无需重传原件。旧轻量任务不会进入全文解析/OCR。异常/超时不能当通过，省略附件不能绕过，新任务的输入锁定、报价和执行一致判断。

## 自动化结果

| 检查 | 命令/范围 | 结果 |
| --- | --- | --- |
| Python | `PYTHONPATH=python python -m unittest discover -s python/tests -p test_pdf_quality.py -v` | 17 pass，0 fail/skip |
| 公共质量契约 | `node --test packages/contracts/dist/pdf-quality.test.js` | 5 pass，0 fail/skip |
| 仓库契约检查 | `npm run check:contracts` | 32+29+11 测试通过，182+12 examples、4 lifecycle examples 通过 |
| Worker/API 协议 | `node --test apps/worker/dist/pdf-quality.test.js apps/api/dist/pdf-quality.test.js`，设置真实 Python 路径 | 2 pass，0 fail/skip |
| 材料状态组件 | `tsc -p apps/web/tsconfig.test.json`、`node --test apps/web/dist-test/material-processing.test.js` | 13 pass，0 fail/skip |
| HTTP/存储/队列 | `node --test apps/api/dist/audit-pdf-quality.pg.test.js` | 6 pass（含5子项），0 fail/skip |
| Linux 暂存 | `node --test scripts/audit-pdf-staging.integration.mjs` | 4 pass（含3子项），0 fail/skip |
| 浏览器 | `playwright test apps/web/tests/audit-pdf-quality-gate.spec.ts --workers=1` | 9 pass，0 fail/skip；1440/390 px |
| 构建 | `npm run build`，rebase 后再次 `npm run build -w @bondbuddy/web` | 通过；保留既有大 bundle 提示 |

HTTP 测试是真实 Node API、PostgreSQL 16、Azurite、Python/PDFium 和队列；使用 synthetic 数字扫描/模糊图、独立测试账号、数据库、存储，不连接生产。覆盖上传、归属、重复轮询、严重低清不创建任务/扣费、更换/删除、不可通过省略附件绕过、报价/新执行拦截、旧执行幂等、哈希篡改、异常重试、v2/v3 原回执保留与 v4 放行。生成环节不调用真实模型，不据此宣称募集书生成质量通过。

Linux 环境使用本机临时容器及独立内部网络，测试结束清理。本机 Windows 换行转换曾导致空白测试库旧迁移的精确字符串匹配失败；使用 Git 原始 LF 迁移重建测试库后通过，未修改任何迁移。测试存储使用明确的 10000 端口。

## 授权原件只读复测

原件与页面图保留本机忽略目录，不提交 Git，不发送外部模型。

| 原件 | 页数/实际抽页 | v3 | 最终 v4 / Linux 独立进程耗时 |
| --- | --- | --- | --- |
| A | 75 / 5,8,12,1,19,38,57,75 | 第8页150 DPI即拒绝 | complete，风险页8/12/75，blocking为空；3019 ms |
| B | 83 / 5,8,12,1,21,42,63,83 | 第5页150 DPI即拒绝 | complete，8个风险页，blocking为空；2380 ms |

耗时包括 Python 启动，未包括上传、下载及队列等待；3秒检查本体预算和5秒子进程上限均未放宽。字形/边缘启发式不能证明 OCR 正确率；原件 A 第8页、前景/背景分层，B 第8页及 A 末页附件做了人工可视检查。合成回归另覆盖高清前景、透明高清覆盖物不能掩盖低清正文、空白/印章、旋转、非标准尺寸、200 DPI 浮点边界、真实严重模糊数字及预算/异常。

## 界面证据与剩余范围

新提示沿用材料行。原型和实现来自上述代码版本，新提示桌面/手机对照文字一致、无横向溢出，人工检查截图。文件在 `apps/web/test-evidence/audit-pdf-quality-gate/`：`advisory-prototype-*`、`advisory-implementation-*`、`full-page-advisory-*`。浏览器测试使用契约校验的模拟 API；真实上传/后端由上述独立集成测试覆盖。

这是位置抽样，不是财务报表语义定位；最多8页可能漏掉局部问题。普通低 DPI/边界材料（包括此前仅凭 DPI 被拒绝的材料）只提示。高标称 DPI 模糊、完全失去字形、未抽中页面等仍可能漏检，不保证生成成功。

最终统一验收待办：统一测试版用户实际操作、发布版本的真实模型金样/独立人工复核及生产发布核验。本次没有新发布授权，不沿用上一批已结束的限定例外。无需数据库迁移/新依赖，发布须协调 API/web/解析 worker，先更新或排空旧解析 worker 再启用 v4 producer。
