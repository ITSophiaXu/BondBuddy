# 助手隐藏与恢复（#623）

用户反馈悬浮入口遮挡业务按钮且无法隐藏。入口旁与展开面板顶部新增“隐藏项目助手”，隐藏整个悬浮层；正常侧栏/手机菜单中的“BondBuddy 助手”可恢复。当前账号在该浏览器会话内保留隐藏选择，刷新及页面切换不重新弹出。隐藏只改变显示，不清除未发文字、会话/材料，不取消任务。

原型 product-prototype/public/project-assistant-refined.html 与实现同步；用户当日需求确认隐藏/恢复行为。原型恢复按钮在普通页面导航示意区，实现放在既有侧栏账号区，手机沿用菜单。未增加悬浮恢复入口。320px 下压缩标识，为顶部隐藏键留出空间。

## 验证
Windows / Node 22.14 / Edge，Vite 5637，全部 API、账号、材料、任务均为 synthetic。
- 全仓库 build、最终 web build、check:contracts 通过（167 公共样例、12 内部样例、4 生命周期、29 OCR、11 发行人绑定）。
- project-assistant.spec.ts 10 个功能场景全部获得通过：首组 9 通过、1 测试断言取错首个旧确认卡而失败；改为当前卡后该场景独立复验 1/1 通过。另 1 个旧截图专用场景因未设置 ASSISTANT_EVIDENCE 跳过；本次新截图另用 BB_HIDE_ASSISTANT_EVIDENCE_DIR。
- 新增 1440×960、390×844、320×740、720×480 四种视口；隐藏后点击原悬浮位置的合成底层“保存项目”按钮，刷新/滚动/菜单恢复后未发文字仍在，未创建额外任务。
- 720×480 代表常见桌面 200% 放大后的等效 CSS 视口，不冒充实际浏览器缩放快捷键测试。实际浏览器缩放进入最终统一验收。
- 既有材料上传→确认卡→运行流程增加隐藏/恢复：任务仍 queued，只有一次执行，后续成果可恢复下载。

## 原型与实现截图
起点 develop 3aef9c48；最终原型/实现 commit 见 PR。同尺寸截图已目视核对，隐藏键可见、恢复后文本保留、侧栏恢复按钮不覆盖业务页面。原型使用原 HTML setContent（合成演示，无后端），实现使用正常页面与合成 API。

| 状态 | 原型 | 实现 |
| --- | --- | --- |
| 展开 1440×960 | [原型](prototype-open-desktop.png) | [实现](implementation-open-desktop.png) |
| 隐藏 1440×960 | [原型](prototype-hidden-desktop.png) | [实现](implementation-hidden-desktop.png) |
| 展开 390×844 | [原型](prototype-open-mobile.png) | [实现](implementation-open-mobile.png) |
| 隐藏 390×844 | [原型](prototype-hidden-mobile.png) | [实现手机菜单](implementation-hidden-mobile.png) |

最终统一验收待办：真实账号已有对话/运行任务、实际浏览器缩放、生产各业务页面的交互验收。本次不执行真实扣费任务；生产发布另行记录。
