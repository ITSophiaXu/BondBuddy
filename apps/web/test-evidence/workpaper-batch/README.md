# 底稿批量生成界面对照

截图使用合成目录和募集书名称，不包含用户材料。视口 1440×960、390×960，均为全页截图。

|状态|实现|原型补充|
|---|---|---|
|准备/桌面|preparation-1440.png|prototype-preparation-1440.png|
|准备/手机|preparation-390.png|prototype-preparation-390.png|
|判断/桌面|assessment-1440.png|prototype-assessment-1440.png|
|判断/手机|assessment-390.png|prototype-assessment-390.png|
|提交/桌面|progress-1440.png|prototype-progress-1440.png|
|提交/手机|progress-390.png|prototype-progress-390.png|

原型：`product-prototype/public/workpaper-batch.html` 和 CSS，新增于本次 feature 提交；实现同一提交，原有页面 shell 基于 develop `a9c8c5dc`。复现测试：`apps/web/tests/workpaper-batch.spec.ts`。

2026-10-27 入口改版（产品提交 `9b5aaf87`）：用户反馈底稿入口不明显后，新增项目页直达按钮、文件生成首页的大卡片入口，底稿页首屏突出目录上传。两侧新增区域的顺序相同：三步流程 → 上传区 → 募集书依据 → 可展开的格式说明 → 已存目录 → 识别提示 → 查找与选择 → 清单 → 要求 → 判断范围 → 不生成项理由与依据 → 用户明确勾选确认及费用 → 开始生成 → 进度与操作。均在手机宽度把横向表格限制在内部滚动区，不产生页面水平溢出。

2026-10-27 组件审计修正（产品及原型提交 `ada9a4bf`）：截图已更新至此固定版本。同步统一顶部导航、来源文件条、目录下拉框及搜索操作栏；表单控件均44px，隔离全局 label 外边距。详细发现、实际尺寸及真实本地截图见 `test-evidence/workpaper-refine-20261027/README.md`。

差异：原型含导航示例、准备区与进度区，实际页面额外保留项目上下文、积分、辅助导航和 BondBuddy 浮层；本次审计的来源条、表单尺寸与工具栏布局已对齐。原型使用本地模拟按钮，实际页面接持久化 API（浏览器测试中用 mock）；原型演示运行状态，提交截图中的实现处于等待生成。截图已做视觉检查，不等于用户视觉验收。用户确认状态：待验收。

2026-10-27 本批编制要求、范围确认与生成进度改版（产品和原型 cdb1e495）：已更新全部截图。确认区按标题、数量、来源、单价/总额、操作和费用说明排布；判断前主按钮、判断后明确复核及确认生成按钮。进度以绿色进度条、独立状态及元数据呈现。8项底稿/原型回归通过，实际本地截图及99项整体相关回归见 test-evidence/file-rows-20261027/README.md。用户视觉验收仍待完成。
