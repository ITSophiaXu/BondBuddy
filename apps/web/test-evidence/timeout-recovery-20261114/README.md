# 募集书超时恢复状态对照

全部为synthetic HTTP fixture＋真实Microsoft Edge/Playwright，不连接真实API、数据库、模型或Word任务。

- 实现：`ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1`。
- 原型：`02db1f3567718490d63ac7039678ed6c4ae03fc7`，`product-prototype/public/authoring-live-progress.html`。
- 页面：`apps/web/src/project-execution.ts`、`authoring-status.ts`、`authoring-progress.ts`。
- 原型HTML/CSS哈希见两个comparison manifest。Vite从该工作区启动；两提交间产品源码及原型无变化，仅截图取景测试变化，HTTP入口已实测200。

| 状态 | 桌面实现/原型（1440×1000） | 手机实现/原型（390×844） |
| --- | --- | --- |
| 正在核对恢复条件 | [实现](implementation-timeout-pending-1440.png) / [原型](prototype-timeout-pending-1440.png) | [实现](implementation-timeout-pending-390.png) / [原型](prototype-timeout-pending-390.png) |
| 已安排自动续跑 | [实现](implementation-timeout-queued-1440.png) / [原型](prototype-timeout-queued-1440.png) | [实现](implementation-timeout-queued-390.png) / [原型](prototype-timeout-queued-390.png) |
| 恢复不可用 | [实现](implementation-timeout-unavailable-1440.png) / [原型](prototype-timeout-unavailable-1440.png) | [实现](implementation-timeout-unavailable-390.png) / [原型](prototype-timeout-unavailable-390.png) |
| 次数耗尽 | [实现](implementation-timeout-exhausted-1440.png) / [原型](prototype-timeout-exhausted-1440.png) | [实现](implementation-timeout-exhausted-390.png) / [原型](prototype-timeout-exhausted-390.png) |

15项相关浏览器测试全部通过。Codex逐对查看16张图片：状态文案、按钮、颜色、五步流程与当前编制步骤正确，完整状态卡无遮挡且没有横向溢出。首轮手机截图靠近底部，被既有悬浮助手遮住步骤；仅修正取景测试并重拍，本目录全部为重拍后的结果。

[1440 manifest](timeout-comparison-1440.json) / [390 manifest](timeout-comparison-390.json) / [独立视觉复核记录](visual-review.json)。自动生成manifest的visual_review字段保持原始pending；后续实际视觉检查写在独立visual-review.json，不改写原始捕获记录。两侧卡片真实坐标及宽高不同，不宣称像素对齐。

既有差异与确认状态：

1. 实现保留产品导航和项目外壳，原型是含状态选择按钮的独立演示页。
2. 手机实现将操作放在说明之后，原型放在说明之前；是既有响应式DOM差异，本次timeout原因未改变该布局。
3. 既有产品字形图标与原型SVG不同；实现有2份合成材料、原型为3份，均不是本次真实回放材料计数。

上述差异未记录产品负责人确认，视觉自查不能代表用户验收或合并许可。原型版本已登记到[#361](https://github.com/ITSophiaXu/BondBuddy/issues/361#issuecomment-6873285002)。开发自测、真实任务、用户验收和生产部署分别处理。尚未部署，待统一发布。
