# 本轮资料整理的工程验证

日期：2026-09-26。验证范围为两包法规收件、原文定位、研究候选和原型检索；不是实际发行人的规则适用性批准或成果行业验收。

## 环境与复现

Windows，Node.js 24.19.0、捆绑Python运行时。M1目标Node.js 22未在本机复测；npm不可用，直接调用TypeScript和Node脚本。复用本地已安装依赖：与本分支lockfile比较，唯一差异为API新增内部workspace依赖，外部依赖锁定条目一致。所有`@bondbuddy/*`链接指向本工作区，contracts/domain在本工作区重新编译；未修改lockfile，未用旧分支编译结果冒充本次测试。

在仓库根目录执行：

```text
python scripts/build_exchange_knowledge.py
python scripts/check_exchange_archive_intake.py
python scripts/check_exchange_archive_intake.py --archive-dir <两个原始ZIP所在目录>
python scripts/test_sse_private_knowledge.py
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json
node --test packages/domain/dist/*.test.js
node packages/contracts/dist/check-examples.js
node packages/contracts/dist/check-data-lifecycle.js
node --test packages/contracts/dist/ocr-v2.test.js
```

原型测试在`product-prototype/`执行：

```text
node --test qa/exchange-knowledge.test.mjs qa/core.test.mjs qa/authoring.test.mjs qa/review-scope.test.mjs qa/reporting-periods.test.mjs
```

## 实际结果

- 两个ZIP及31个成员的SHA-256/字节数/路径映射通过；30份精确复用、1份新增，另取官方修订说明。公告原字节、可见施行/废止文字、原始附件链接及HTTPS下载附件hash均通过。
- 离线重建通过：36份来源目录原件、此前10份单独官方证据、38项共通候选、6套规则/章节/覆盖草稿和12份原型视图。
- contracts/domain编译通过；domain **154/154**；来源专项Python **2/2**；原型相关测试 **22/22**。
- contracts验证通过：122个合成示例、12个内部库示例、4个数据生命周期示例；OCR契约 **29/29**。
- 原型测试实际检查六种范围独立、大小公募隔离、EX039仅进入深交所、EX009/EX028退出当前检索、脚注可检索而批注不进入正文。规则包校验仍拒绝未经审核启用及不完整发布。
- 离线重建前后246份知识文件hash一致；与分支基线比较，44份既有记录中的13,940条正文/批注内容及锚点完全不变。新增注释关联单独校验。
- 本轮检查的1,273个有效本地链接/锚点通过，无新增失效链接；同时发现架构文档原有`acceptance/M1-01.md`指向缺失文件，已区分为本轮之前的问题，未虚构验收文件。

## 文档核读与未验证内容

读取DOCX原始OOXML、表格段落、脚注及对应正文；PDF按物理页定位。抽样渲染核读EX035第5页的普通投资者资格、EX027第15页的市政建设/地产审核重点、EX032第2页的专项目录，与文本定位相符。

尝试渲染新增DOCX时，捆绑运行环境缺少LibreOffice执行文件，未完成Word页面渲染。原件字节未改；不能据文本或PDF抽样宣称所有DOCX字体、分页、修订/批注或WPS兼容性通过。未运行目标环境、真实模型任务、生产规则发布或真实成果行业验收。

所有候选仍为`research_only`、`enabled=false`，`reviews=[]`、`release=null`。新增官方取证只证明对应公告/附件来源和版本文字；不代填专业审核人，不把本次收件视为#20–#25关闭证据。
