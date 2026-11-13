# 非文件生成主选择区：UX 审查与验证

日期：2026-11-13（北京时间）。基线：develop `92bbba8f`。本次工作区 `BondBuddy-file-generation-ux-audit-20261113`，最终提交由主代理固定。

环境：Windows / Microsoft Edge / Vite `http://127.0.0.1:5296`。使用真实前端代码、DOM、CSS和既有合成HTTP数据。没有生产数据库、模型调用、真实支付或积分消耗。开发和自测完成，尚未部署，待统一发布；不代表用户验收。

## 已修问题与证据

| 问题 | 修前 | 修后 | 证据 |
| --- | --- | --- | --- |
| 手机导航开关触控面积低于10/31导航规范 | 打开/关闭菜单36×36px | 均44×44px，品牌右侧内距同步让出关闭按钮 | before/authoring-390.json及PNG，after/mobile-controls-*.json、navigation-*.png |
| 助手手机工具栏与发送目标过小、紧邻 | 320px时3项分别x219/248/277、29×30px、gap0；390px32×32px、gap0；发送32×32px | 仅手机44×44px、gap4；附件44px高；桌面32×32px保持 | before/assistant-320.json及PNG，after/mobile-controls-320.json、assistant-controls-320.png |
| 已知#1075诚信流程条溢出 | 320px时scrollWidth337，第三步x234、宽103 | scrollWidth305，原顺序/当前步骤保留并自然换行 | before/integrity-320.json/PNG，after/integrity-320.json/PNG；原样复用#1076的8行补丁 |
| 已知#623助手启动器遮挡手机文件生成主操作 | launcher固定right/bottom16，fg-footer吸底且按钮全宽，启动器盖住按钮右端 | 只有可见操作栏与默认启动器位置实际相交时，启动器移到栏上方12px；离开该栏复位；桌面原右边距保持 | file-choice-final的修前390图；dock-final的390/320实际截图及稳定复跑 |

#1076来源已通过GitHub正文和diff核对：HEAD `56cd4498afc0004130286a01691574c2c4718da2`。不重复建单；本批明确复用该精确补丁。

## 审查范围

- 28个页面/尺寸场景：更新募集书下一轮准备、复核历史成果、项目文件完整目录、诚信历史成果、问答准备、问答成果、助手打开，各1440/1024/390/320。修后均无整页横向溢出。复核中可访问但视觉裁切的上下文子元素会在扫描JSON的overflow清单出现；父元素已正确裁切，未误报成页面溢出。
- 手机菜单/助手：960/760/390/320目标面积、相邻间距、菜单开关、历史返回、关闭重开保留草稿；桌面32px目标保持。
- 原有助手焦点陷阱、退出、跨导航/刷新保留未发送文字、桌面标准与加宽侧栏、390/320/720×480关闭恢复。
- 诚信工具栏1366/1093/390同高对齐保持。
- 账号订阅不可支付/刷新及支付宝待付→已付，1440/390截图已查看，未发现新增间距/对齐问题。本轮不替代支付既有Issue的完整验收。
- 390/320助手和导航原型同尺寸图已生成、控制尺寸及开关交互通过；助手内联原型同步修改，导航共用样式。
- 独立查看文件选择1440/390图：分组名称和数量、桌面两列/手机单列、文字对齐、支持区输入内边距、上传/保存等高和间距符合本次要求。首次查看发现launcher遮挡并已修复。全页截图中的吸底栏显示在当前视口位置；实际滚动与点击检查以dock-final视口证据为准。

## 执行命令与结果

命令cwd均为工作区 `apps/web`，先设置：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5296'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
```

| 验证 | 实际命令（省略上述环境） | 结果 |
| --- | --- | --- |
| 全站矩阵与首批触控 | `node ../../node_modules/@playwright/test/cli.js test ux-audit-scan.spec.ts mobile-action-targets.spec.ts --output=test-results-ux-audit --reporter=line` | 当时28矩阵+5产品触控，共33通过/0失败/0跳过；其后增加4原型例另跑 |
| 现有交互/账号/诚信 | `node ../../node_modules/@playwright/test/cli.js test project-assistant.spec.ts subscription-account.spec.ts ux-review-fixes.spec.ts --grep='mobile assistant keeps\|global launcher preserves\|desktop, focus\|assistant closes to\|desktop pages reflow\|account shows point rights\|account refresh keeps\|Alipay return ignores\|integrity result toolbar' --output=test-results-ux-related --reporter=line` | 15通过/0失败/0跳过 |
| 新原型对照 | `node ../../node_modules/@playwright/test/cli.js test mobile-action-targets.spec.ts --grep='design reference' --output=test-results-ux-reference --reporter=line` | 4通过/0失败/0跳过 |
| dock实际文件生成 | `node ../../node_modules/@playwright/test/cli.js test assistant-dock-layout.spec.ts --output=.../work/ux-audit-20261113/dock-final --reporter=line` | 3通过/0失败/0跳过，1440/390/320空选和已选，各4滚动位置，按钮中心/右侧hit-test与trial-click，不提交生成 |
| dock后的关联回归 | `node ../../node_modules/@playwright/test/cli.js test project-assistant.spec.ts mobile-action-targets.spec.ts --grep='mobile assistant keeps\|global launcher preserves\|desktop, focus\|assistant closes to\|desktop pages reflow\|mobile navigation\|desktop assistant' --output=test-results-ux-dock-related --reporter=line` | 12通过/2失败；执行期间project-assistant.ts生命周期修改触发Vite全页重载，2旧布局例读取到已关闭/替换的panel。错误证据保留，未降低断言 |
| 固定源码复跑 | `node ../../node_modules/@playwright/test/cli.js test assistant-dock-layout.spec.ts project-assistant.spec.ts --grep='launcher avoids\|desktop, focus\|desktop pages reflow' --output=test-results-ux-dock-stable --reporter=line` | 5通过/0失败/0跳过；含新dock3及上述失败2 |
| TypeScript | `node ../../node_modules/typescript/bin/tsc --noEmit` | exit0；在dock主改动后执行。随后只增加suspend/dispose可选cleanup和mount幂等初始化 |

本模块最终覆盖55个唯一用例均取得通过结果（28矩阵+5产品触控+4原型+15既有回归+3dock）；重复回归不重复计数。首轮before28只是测量，不算最终验收通过。最新源码继续由主代理统一构建。

独立helper审查与harness：`dock-helper-review.md`（由prototype代理保存）。390×900，100px底栏offset96；24帧无额外style写入；移除底栏归0，重新插入恢复；dispose清理offset、Mutation/ResizeObserver和3个窗口监听，随后DOM/scroll/resize无再写入。代码还在suspend时清理、mount幂等重建，避免独立admin页留下全局观察器。

## 应保留的文件

产品源码：

- apps/web/src/assistant-dock-position.ts（新增）
- apps/web/src/project-assistant.ts
- apps/web/src/project-assistant.css
- apps/web/src/integrity-workspace.css
- product-prototype/public/navigation-responsive.css
- product-prototype/public/project-assistant-refined.html

回归测试：

- apps/web/tests/ux-audit-scan.spec.ts（新增；证据环境未设置时只断言布局，不落截图）
- apps/web/tests/mobile-action-targets.spec.ts（新增；9例，包括5产品+4原型）
- apps/web/tests/assistant-dock-layout.spec.ts（新增；3例）

交付文档可选取before/after中导航、助手、诚信320的成对图、after中390/320原型对照、mobile-controls JSON、matrix-summary.json及dock-final视口图，避免把所有临时浏览器目录放入PR。test-results-ux-*均为临时执行输出（失败证据留work引用即可）；本代理没有覆盖仓库旧test-evidence图片。audit-notes.md是前一版摘要，以本文为准。

## 边界

未机械把所有文本链接放大为44px；11/05桌面标准允许主控件40–44、次级列表36。已有未合并支付/文件筛选问题沿原Issue跟踪，不以本轮矩阵替代原问题完整验收。未测试所有异常数据、所有管理员功能、所有历史任务、浏览器缩放和每种移动设备；这是列明状态的布局与交互审查，不声称穷尽全部UX。
