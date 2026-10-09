# #55 今日补充：原文批注版

原型 review-v2.html?delivery=files / review-v2.js / review-readable-preview.js/.css 与实现均为本 PR source commit。Windows / Node 22.14 / Python 3.14 / Edge；测试文档与页面数据均为 synthetic，不冒充客户材料、真实模型复核或 Word/WPS 验收。

- npm run build、npm run check:contracts：通过（rebase 前167个契约样例；合并账户流水后171个，合并前重验）。
- PYTHONPATH=python;python/tests python -m unittest -v test_review_file_annotations test_review_word：15/15。覆盖普通段落、表格、一项多处、同处多项、原有批注与修订、未匹配/重复引用、源文件hash、页眉/页脚等非变更包部件逐字节一致；PDF真实高亮坐标/内容、原注释和页面内容流保留、旋转和不可检索文字不乱贴。
- node --test apps/worker/dist/review-file-stage.test.js：本地3通过、1Linux软链接用例跳过；默认文件链路一次模型调用、共同问题编号、锁定源稿、原文批注存储与损坏阻断交付。
- apps/web：BB_E2E_BASE_URL=http://127.0.0.1:5640 BB_E2E_BROWSER_CHANNEL=msedge BB_ANNOTATION_EVIDENCE_DIR=test-evidence/source-annotations-20261009 npx playwright test tests/review-workspace.spec.ts --grep 'annotated source|readable report navigation|readable view failure|file-only'：8/8。DOCX/PDF下载名、报告读取失败仍可下载、刷新不重跑、定位限制明确可见。按钮顺序/窄屏原型调整后3/3再次通过。
- 扩展 review-file-delivery.pg.test.ts：真实PostgreSQL/Blob/contained CLI的DOCX和PDF原文批注、普通报告共同交付，崩溃重试仅调用一次、精准原生批注读回、原账号下载/跨账号拒绝、损坏拒绝及恢复。由PR Linux CI执行；本地Docker未运行，不能将跳过算通过。

截图 implementation/prototype × 1440×960、390×844，共4张。逐图查看：原文批注为首个主按钮，辅助报告和定位限制入口清晰，手机换行无横向溢出。复用已有阅读区和页面层级；两侧既有侧栏宽度/顶部导航、钱包、助手及示例项目内容不同，原型较早且自带完成横幅，所以同尺寸截屏的纵向起点不同，本次未回退已批准页壳。新增按钮顺序与移动纵向布局已同步原型；未改版其余页面。

本次无需公共API schema或数据库迁移。报告MD/Word/批注文本共源；源文件不变。只对当前新文件复核任务生成批注，不覆盖历史已保存成果。当前支持精确唯一引用；扫描PDF、旋转/裁剪、重复文字、复杂修订范围等定位限制如实列出；加密PDF不伪造批注成果。

最终统一验收待办：真实长募集书/不同版本定位，实际 Word/WPS 与 PDF 客户端打开、保存重开及跨客户端往返、真实模型专业结论（#56/#146）；本PR只完成#55今天补充的工程范围，不关闭整个父issue。部署状态另记。

Rebase 到5a69ff12（#630合并）后，Python15/15再次通过；最终 build/contracts、worker单测及5项浏览器复验在PR合并前完成并记录。

首轮Linux CI：3组通过；cli-review中DOCX链路通过，PDF测试夹具直接写stdout触发pypdf Illegal seek（9/10）。夹具改用BytesIO后已本地子进程实测成功，重新跑CI；这不是生产writer路径（生产写普通文件）。最终rebase后的build/contracts171样例、worker3通过/1跳过、浏览器5/5已通过。
