# 底稿批量生成界面对照

截图使用合成目录和募集书名称，不包含用户材料。视口 1440×960、390×960，均为全页截图。

|状态|实现|原型补充|
|---|---|---|
|准备/桌面|preparation-1440.png|prototype-preparation-1440.png|
|准备/手机|preparation-390.png|prototype-preparation-390.png|
|提交/桌面|progress-1440.png|prototype-progress-1440.png|
|提交/手机|progress-390.png|prototype-progress-390.png|

原型：`product-prototype/public/workpaper-batch.html` 和 CSS，新增于本次 feature 提交；实现同一提交，原有页面 shell 基于 develop `1d8615c3`。复现测试：`apps/web/tests/workpaper-batch.spec.ts`。

两侧新增区域的顺序相同：说明与证据边界 → 上传/已存目录 → 识别提示 → 查找与选择 → 清单 → 要求 → 份数/费用/准确来源 → 明确开始 → 进度与操作。均在手机宽度把横向表格限制在内部滚动区，不产生页面水平溢出。

差异：原型只展示新增准备区与进度区，实际页面保留文件生成导航、项目条、积分、辅助导航和 BondBuddy 浮层；原型沿用公共样式，实际输入控件同时继承应用表单样式，行高和间距有差异。原型使用本地模拟按钮，实际页面接持久化 API（浏览器测试中用 mock）；原型演示运行状态，提交截图中的实现处于等待生成。截图已做视觉检查，不等于用户视觉验收。用户确认状态：待验收。
