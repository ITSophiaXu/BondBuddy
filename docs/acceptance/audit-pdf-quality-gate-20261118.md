# 审计 PDF 清晰度门禁验收（2026-11-18）

关联 #1603 / #1593。开发基线 develop `8cf0948a`，分支 `feat/audit-pdf-quality-gate`。

## 实现与范围

统一募集书更新曾跳过上传全文预解析，页面也不创建 MaterialProcessing，原提醒未覆盖此入口。本次在审计 PDF 完成上传、角色复制及跨项目复制后单独入队 `pdf-raster-quality-2` 轻量检查。仍按归属、版本、SHA-256 验证私有原件；只检查栅格像素及 PDF 实际放置尺寸，不做 OCR、全文解析、模型调用或计费。

低于 200 DPI 的图片联合覆盖页面至少 50% 才报告低清；小印章/Logo不会单独触发。0.0001 DPI 容差只覆盖 PDFium float32 矩阵精度。v1 回执可读但不能用于门禁放行。只适用于 update/audit/application-pdf，其他角色、非 PDF 和其他任务不改变规则。

待检查、低清、partial/unavailable均不能继续。低清提示 PDF 页码并要求移除后上传清晰电子版；未完成显示重试，不能称为低清。质量检查的 succeeded 只表示测量结束，结果保存测量回执，不伪造 parsed。显式重试新建尝试，保留终态作业不变；并发轮询/重试幂等。

输入锁定、报价和新任务提交检查当前所有审计 PDF 以及被选择的历史版本，省略坏附件不能绕过。旧版本不会阻塞未选择它的新版本。执行幂等重放提前返回，已有编制任务不改输入。

## 自动化证据

Windows Codex Node/Python，Linux Node 22 + PostgreSQL 16 + Azurite；全部专用本地测试环境，无生产数据库/账务/任务操作。数据库迁移使用与 Git 一致的 LF 副本，避免 Windows checkout CRLF 导致旧迁移的函数文本匹配失败；未修改迁移源码。

| 验证 | 结果 |
| --- | --- |
| `npm run build`，全部工作区 | 通过；Vite现有大包提示仍在 |
| `npm run check:contracts` | 72 tests通过，0失败/跳过；179公开+12内部+4生命周期合成样例通过 |
| `python -X utf8 -B -m unittest python/tests/test_pdf_quality.py -v` | 8通过，0失败 |
| `node --test apps/web/dist-test/material-processing.test.js` | 11通过，0失败/跳过；含已验证测量回执与后台终态中断的一致性 |
| Linux `node --test packages/contracts/dist/pdf-quality.test.js apps/api/dist/pdf-quality.test.js apps/api/dist/audit-pdf-quality.pg.test.js apps/api/dist/required-audit.pg.test.js apps/worker/dist/material-parser.test.js apps/worker/dist/material-parse-job.test.js` | 29通过，0失败，3旧可选全文解析集成测试跳过（仓库.venv/另行样本开关未配置）；本次实际PDFium、PG/Azurite门禁未跳过 |
| `playwright test tests/audit-pdf-quality-gate.spec.ts tests/required-audit.spec.ts tests/authoring-source-guide.spec.ts tests/pdf-quality-warning.spec.ts`（Edge） | 19通过，0失败/跳过 |

最终复验：新增门禁5项加上传恢复/重试4项共9项浏览器用例通过；最终API/worker门禁5通过、0失败/跳过。

追加兼容性：`authoring-continuation`、`first-draft-confirmation`、`authoring-onboarding`、`desktop-ux-polish`、`required-reference` 共58项浏览器用例通过。既有合成流程显式提供新检查端点的合格回执，真实检测由独立集成测试验证。

PR [#1605](https://github.com/ITSophiaXu/BondBuddy/pull/1605) 的6项GitHub Actions在启动前失败；已逐项读取原始annotation，均为账号付款失败或spending limit不足。云端CI没有执行，不能计为通过；未修改额度或绕过保护。本地构建与测试结果如上。原型commit与截图已登记[前端#361](https://github.com/ITSophiaXu/BondBuddy/issues/361#issuecomment-6970486657)。

集成覆盖：真实HTTP上传与Azurite原件读取（合成PDF）、自动单检查入队、实际PDFium测量、待检查/低清拦截、外人404、并发幂等、坏附件省略、删除/200 DPI替换恢复、锁定/报价/提交、旧run重放、不新增run/报价/积分预留、partial重试、原件篡改与恢复、旧终态不改写、其他角色/任务不受影响、复制审计材料重新入队。测试中的编制队列为 synthetic；不验证模型生成质量。

## 页面与原型

用户本轮明确要求的行为由 `product-prototype/public/audit-pdf-quality-gate.html` 表达，只改现有文件处理状态和底部操作禁用，不新增页面/导航。材料行对照使用实际 MaterialProcessing 模块和合成 DTO；完整页面测试使用合成 API。真实后端链路另由上表集成测试覆盖，不能把截图当作实际模型验收。

截图在 `apps/web/test-evidence/audit-pdf-quality-gate/`：1440×900、390×900同尺寸组件原型/实现 PNG；两组图像字节一致。另有两种宽度完整材料页面截图；已视觉检查无裁切、溢出或重叠。原型确认依据为用户2026-11-18本轮请求；暂无额外布局偏离。测试通过不代表用户已实际验收。

## 沧州本地原件复验

10份去重PDF、903页均检查complete。只本机读取，未将原件/图片送模型、外部服务或提交至仓库。原件SHA-256与逐页本地回执保留在ignored work/cangzhou-v2-results.json。复测确认6份低清年审仍提示；名义200 DPI的一季报、半年报及募集书盖章页不再误报。

| 材料 | 总页数 | 低清页数 | v2结果 |
| --- | ---: | ---: | --- |
| Y-4-1沧州港务集团有限公司2023年度经审计的合并及母公司财务报告.pdf | 114 | 114 | 低清 |
| Y-4-2沧州港务集团有限公司2022年度经审计的合并及母公司财务报告.pdf | 112 | 112 | 低清 |
| Y-4-3沧州港务集团有限公司2021年度经审计的合并及母公司财务报告.pdf | 126 | 126 | 低清 |
| Y-4-4沧州港务集团有限公司2024年度一季度财务报表.pdf | 8 | 0 | 无低分辨率提示 |
| 沧州港务集团有限公司2021年度第一期中期票据募集说明书.pdf | 182 | 0 | 无低分辨率提示 |
| DY-4-1沧州交通发展（集团）有限责任公司2022年度经审计的合并及母公司财务报告(1).pdf | 109 | 109 | 低清 |
| DY-4-2沧州交通发展（集团）有限责任公司2021年度经审计的合并及母公司财务报告.pdf | 84 | 84 | 低清 |
| DY-4-2沧州交通发展（集团）有限责任公司2023年度经审计的合并及母公司财务报告.pdf | 156 | 156 | 低清 |
| DY-4-3沧州交通发展（集团）有限责任公司2023年半年度合并及母公司财务报表.pdf | 4 | 0 | 无低分辨率提示 |
| DY-4-3沧州交通发展（集团）有限责任公司2024年半年度合并及母公司财务报表.pdf | 8 | 0 | 无低分辨率提示 |

这里只验证像素/放置尺寸规则。不存在自动财务报表语义定位，也未判断文字模糊、压缩、放大插值等所有可读性问题；低分辨率不等于必然解析失败，检查通过不等于模型生成一定成功。

## 交付与统一发布

无需数据库迁移，无新增依赖。API、web和解析worker需作为兼容的一组交付，先更新解析worker再启用API/web门禁，或由发布chat协调同步更新；已有材料打开时会补建v2检查。没有签发生产质量发布凭据。

代码自测完成；尚未部署，待统一发布。最终统一验收待办：由集成/发布chat在统一测试版验证实际上传与后台检查服务可用，用户实际操作验收；按本批发布授权及现行质量门禁统一上线。本chat不执行生产变更。
