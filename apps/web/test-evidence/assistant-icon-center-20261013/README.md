# 右下角助手图标居中

2026-10-13 用户截图指出圆形助手按钮内的图标偏上，要求居中。源码及原型修复 commit `295ddfdd9285178e65aaef95da0a0f0811e17767`，基于 develop `6cd5d2cb`。实现 `apps/web/src/project-assistant.css`，原型 `product-prototype/public/project-assistant-refined.html`；受影响的是所有已登录页面的右下角助手入口。交互调整依据和确认人是本次用户请求。

未启用的活动状态点 `<i>` 没有隐藏，作为 grid 的第二个项目形成空行，将 SVG 向上推。现在仅在未启用时 `display:none`，启用后沿用原来的绝对定位。圆形按钮和图标尺寸、SVG 路径、颜色、点击面积和活动点外观不变。原型与实现同步修改，无新增偏离。

## 验证

- 开发与集成工作区 web TypeScript 检查、Vite 构建通过；既有大包提示保留。
- 现有 `project-assistant.spec.ts` 的 `assistant closes to the bottom-right launcher` 5 项全部通过（1440、1024、390、320、720 宽度），覆盖展开/收起、草稿恢复、刷新、页面空间和焦点。
- 原 localhost:5178 真实账号页面刷新复验：桌面 SVG 中心从向上偏 5.75px 改为 0，手机从 4.75px 改为 0；水平偏移始终为 0。展开再收起后仍居中。
- 活动点的检查通过 DOM 添加 `.is-active` 模拟装饰状态，没有启动真实任务；两个尺寸中心偏差均为 0。原型两种尺寸亦为 0。完整坐标见 [before.json](before.json) / [after.json](after.json)。
- 实际页面登录与助手展开/收起使用真实本地 API；5 项开发回归使用 synthetic HTTP 夹具。未发送助手消息或调用模型。截图脚本首轮在登录请求完成前刷新导致取不到按钮，等待登录完成后通过；未修改产品登录逻辑。

截图以 1440×960 / 390×844 视口、2 倍设备像素比裁出相同按钮区域，便于观察图标中心。

| 视口 | 修改前 | 修改后 | 原型 | 模拟活动点 |
|---|---|---|---|---|
| 桌面 | [前](before-1440.png) | [后](after-1440.png) | [原型](prototype-1440.png) | [活动](active-decoration-1440.png) |
| 手机 | [前](before-390.png) | [后](after-390.png) | [原型](prototype-390.png) | [活动](active-decoration-390.png) |

本次已纳入现有本地集成版：来源 `295ddfdd` cherry-pick 为 `db94230`，与之前 PR #694 操作栏修复同时生效。未重启服务，无 API/worker/迁移/依赖变化。开发和自测完成，本地版可验收，用户尚未验收，尚未部署。
