# 原稿选填与材料页末尾补充说明

原型及实现源码：`f83c4f840fb5dc29e276af3f6a84f79d487b4c2b`，基线 develop `964fedf`。依据：产品负责人 ITSophiaXu 2026-10-01 本会话明确要求原稿信息不得阻断编制，原稿报告期采用四期末，补充说明移至上传末尾并在运行中隐藏。对应 #361 / #35，本记录不冒充用户产品签认。

| 同尺寸页面 | 原型 | 实现 |
| --- | --- | --- |
| 创建，1440×960 | [原型](prototype-create.png) | [实现](implementation-create-viewport.png) |
| 创建，390×844 | [原型](prototype-create-mobile.png) | [实现](implementation-create-mobile-viewport.png) |
| 材料，1440×960 | [原型](prototype-materials.png) | [实现](implementation-materials-viewport.png) |
| 材料，390×844 | [原型](prototype-materials-mobile.png) | [实现](implementation-materials-mobile-viewport.png) |
| 上传末尾说明，1440×960 | [原型](prototype-supplement.png) | [实现](implementation-supplement.png) |
| 上传末尾说明，390×844 | [原型](prototype-supplement-mobile.png) | [实现](implementation-supplement-mobile.png) |

核对：单列，无常驻右侧栏或空白列；创建/信息页不显示补充说明，材料末尾选填说明、明确保存与开始操作。每份原稿下有独立的市场/品种/关系和年份＋四期末；无 date picker。桌面/手机无横向溢出。运行/暂停时编辑区隐藏，即使展开材料也不出现；结束后“继续修改”恢复。旧说明、版本、输入锁不丢失。

沿用的已确认差异：真实 M1 允许未填全草稿，保留上传重试/材料细分/数据政策入口，真实额度为单份100MB、每项目500MB；原型旧演示限额不进入生产。实现显示保存版本与必要失败/重读反馈，空说明不能点保存；原型演示按钮未接真实消息账本。本轮布局依据为用户直接决定，没有增加业务面板。

本地证据：Windows / Node22.14 / Playwright Chromium；全仓 build、contracts 通过，Web单元44/44、worker定向8/8、浏览器13/13。均为 synthetic 数据。运行恢复与真实部署、隔离 Word 集成结果另在 PR/issue 回填。截图不是客户材料；没有把合成模型或UI结果称为原项目 Word/专业验收。
