# 最新报告期与补充说明 UX 修正

原型及实现源码 commit：57949a4（同一提交，基线 develop a647fdb）。依据为产品负责人 ITSophiaXu 在 2026-10-01 当前会话截图中的明确修正；对应 #361 / #370。本轮未代替用户做产品签认。

| 视口 | 同步原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型](prototype-create.png) | [实现](implementation-create-viewport.png) |
| 390×844 | [原型](prototype-create-mobile.png) | [实现](implementation-create-mobile-viewport.png) |

原型：product-prototype/public/project-workspace.js / project-conversation.js / app.js；实现：apps/web/src/update-form.ts / project-conversation.ts / main.ts。

已核对最新报告期在基本信息内，四个期末选择、报告期短摘要、右侧额外说明，无目标年度输入/date picker、上下文卡、快捷标签或创建后保存按钮；移动视口无水平溢出。补充说明在窄屏继续沿现有原型顺序置于表单后。创建时说明随项目保存，已有项目的创建说明和后续说明均可在右侧修改，保存不开始任务。

沿用已确认的产品差异：真实 M1 允许先保存未填全的草稿，因此仅项目名必填；未开放功能/平台试用状态如实标记。原型旧演示积分、用户信息和选填发行安排未改造成生产能力。本轮不新增功能或执行面板。报告期按通常窗口整理成 needs_confirmation 候选，不标专业审核，不覆盖原稿。

验证：Windows / Node 22.14 / Playwright Chromium。全仓 build、check:contracts 通过；Web unit 44/44；project-conversation 浏览器回归原10项全部通过，新增保存失败重试1项通过（合计11/11）。覆盖全部支持品种、四期末、切换年份/品种、年末不重复、旧目标/原稿保留、创建时说明保存/重开/编辑、失败保留与重试、后续消息版本/丢失响应幂等/账号隔离、无隐式execute。以上均为合成HTTP/材料；没有新增模型调用、真实Word或原项目功能验收。
