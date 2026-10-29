# 项目问答事实答复与表格验证

状态：开发和自测完成，代码完成，尚未部署，待统一发布。用户尚未验收；未调用真实模型，以下数据与模型输出样例均为 synthetic。

基线：develop `c4e98f51`。关联功能 #722，界面原型跟踪 #361。分支 `fix/qa-prospectus-first-20261029`。

## 改动与验证范围

- 提示词优先形成募集说明书事实答复，仅对本题未解决部分列补充项；默认清空额外答复思路，不把一般复核提醒、公开案例要求、无关提取警告当作材料缺口。
- 选文移除 400 段上限，保留完整表格与附近说明，跨章节检索，优先保留采用的募集书。过大表格采用完整行和表头，并标记部分选入；未选入不解释为未披露。表格空白单元格仍保留。
- Word 募集书提取脚注、尾注等完整内容；图片/不可读部分仍如实保留警告，不声称完成 OCR。唯一逐字引文可以在同一文件内修复错写的段落号。
- 网页复用现有转义 Markdown 展示，Word 原生表格可编辑，表头重复且无固定行高；保留原问题清单及页脚。无契约、迁移、依赖、收费变化。

## 证据

- TypeScript：contracts、domain、rule-pack-registry、rule-applicability-context、API、worker 编译；web 类型与 Vite 生产构建通过。
- worker `project-qa-materials.test`：9 项，包括 650 单元格全文、长文完整表格/单位/附注/跨章节原因、募集书优先、过大表格遗漏标记、空白/零/横线、完整及局部缺项答复、引用定位纠错和拒绝虚构。
- Python `test_project_qa.py`：7 通过、1 跳过。DOC 转换依赖 LibreOffice，本机未安装该运行依赖，保留跳过；DOCX/PDF/XLSX、脚注/440 单元格、嵌套表格、空白/零/横线和原件保留通过。
- Playwright Edge：`project-qa-answer-tables.spec.ts` 3 项 + `project-qa-materials.spec.ts` 9 项通过。含 1440/390 表格、320 材料页、局部缺项与 HTML 转义，未执行付费 API。
- contracts：50 项定向契约测试，171 个公共样例、12 个内部资料库样例、4 个生命周期样例通过。
- 合成 Word 经实际 Microsoft Word 后台只读打开、导出 PDF 和 Poppler 渲染，1 页目视确认表头、单位、数据、附注和局部标记完整。打包的 `render_docx.py` 缺 LibreOffice，改用 Word 导出，未使用其他 LibreOffice。只关闭本次新建 Word 实例。

界面截图位于 `apps/web/test-evidence/qa-prospectus-first/`，1440/390 同尺寸回答组件与原型对照。新增表格样例依据本次用户要求；沿用原有页面、导航、费用和待补清单，展示截图为合成 HTTP 夹具，不能证明真实模型回答质量。

## 统一集成待办

1. 集成 worker/Python 与 web；无需迁移或新增依赖。提示模板版本为 `project-qa-prospectus-first-v2`，已有任务按现有固定提示/回答检查点恢复。
2. 在独立测试环境用实际募集说明书和问题清单生成一轮答复，验证跨章节事实充分性、表格内容与局部补充项。未做真实模型或完整数据库/Blob/队列 E2E；不将合成测试视为专业内容验收。
3. 用户验收后由指定发布 chat 统一上线。本次不覆盖既有结果，不自动重跑、扣费或触碰生产。
