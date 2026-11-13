# 界面参考与自测截图

`reference-*.png` 是用户于 2026-11-13 在本任务提供的五张 UX 截图；本批交互依据为这些截图，没有对应的仓库原型 commit。它们的示例 248 份/9 章不是固定产品数据。

实现截图为真实前端、合成 API 和材料状态，固定桌面宽 1440px、手机宽 390px，全部在同一开发工作区生成。当前合成目录有 20 份/10 章，用于证明动态数量与试生成最多八章；不表示真实项目已生成。保留现有产品导航和视觉样式，补充逐份查看、下载和分类结果。

| 阶段 | 用户参考 | 桌面实现 | 手机实现 |
| --- | --- | --- | --- |
| 选择与待开始 | [参考](reference-prepare.png) | [1440](prepare-1440.png) | [390](prepare-390.png) |
| 试生成 | [参考](reference-trial.png) | [1440](trial-1440.png) | [390](trial-390.png) |
| 确认质量 | [参考](reference-confirmation.png) | [1440](confirmation-1440.png) | [390](confirmation-390.png) |
| 自动续跑 | [参考](reference-remaining.png) | [1440](remaining-1440.png) | [390](remaining-390.png) |
| 部分失败与重试 | [参考](reference-partial.png) | [1440](partial-1440.png) | [390](partial-390.png) |

手机提交栏另保留实际视口截图：[顶部](prepare-390-viewport-top.png)、[滚到提交按钮](prepare-390-viewport-submit.png)。回归覆盖按钮不被助手遮挡并实际点击成功。全页截图不能单独代替此检查。

本批的章节文件全部常显。其他文种选择、全站间距与对齐修复位于前一批 PR #1301，集成时保留两个 PR 的改动。
