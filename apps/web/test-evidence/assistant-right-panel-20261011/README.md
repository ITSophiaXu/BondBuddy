# BondBuddy 右下角入口与右侧栏

用户于 2026-10-11 提供 Review 按钮/右侧栏截图，明确要求点击入口展开、点击 × 收起并恢复入口。本次用户为变更确认人；取代旧顶部入口及浮窗位置要求。

原型与实现源码 commit：`805e8479`，基于 `develop db067ed8`。原型为 `product-prototype/public/project-assistant-refined.html`；实现为 `apps/web/src/project-assistant.ts` / `.css`。影响所有登录页面上的全站助手，不改变业务执行入口、公共契约、数据库、价格和后台 worker。

## 同尺寸对照

| 尺寸及状态 | 原型 | 实现 |
| --- | --- | --- |
| 桌面 1440×960 展开 | [原型](prototype-open-desktop.png) | [实现](implementation-open-desktop.png) |
| 桌面 1440×960 收起 | [原型](prototype-collapsed-desktop.png) | [实现](implementation-collapsed-desktop.png) |
| 手机 390×844 展开 | [原型](prototype-open-mobile.png) | [实现](implementation-open-mobile.png) |
| 手机 390×844 收起 | [原型](prototype-collapsed-mobile.png) | [实现](implementation-collapsed-mobile.png) |

另有 1280×960 的 [更新页](implementation-update-1280.png) 和 [复核页](implementation-review-1280.png)，用于检查正文和侧栏并排。

逐屏核对：右下角仅显示一个 BondBuddy 按钮；展开时入口隐藏，侧栏贴右侧并占满高度；× 和 Escape 恢复入口及页面空间。桌面正文真实缩窄，窄屏全屏显示，输入和关闭按钮均在视口内。原型保留简化的业务背景，实现保留真实导航及页面内容；桌面实现沿用网页的原生滚动条槽。除这些既有背景/浏览器差异外，无额外交互偏离。

## 验证

- Windows / Node 22.14.0 / Edge / Playwright，本地 Vite 独立端口 54321。
- `npm run build`：全仓构建通过。
- `npm run check:contracts`：通过，11/11 契约示例检查。
- `npm test -w @bondbuddy/web -- project-assistant.spec.ts`：14 通过，1 跳过（旧原型截图的单独可选采集；本次四组对照实际执行并已保存）。
- 单独布局复测：5/5 通过。覆盖 1440、1280、1120px 的工作台、全部项目、更新、复核、材料生成页面，普通/加宽侧栏；390、320、720px 的开关、滚动、键盘焦点及恢复。
- 覆盖未发送文字在立即收起、导航、刷新、历史对话中保留；上传队列/附件、确认卡、已执行任务和结果下载保持；不会因为开关而新增执行；窄屏背景不可误点，关闭后可导航和退出。
- 初次定位断言忽略桌面 15px 原生滚动条槽，修正断言；窄屏展开时同时移除槽位并锁定根滚动。最终全部相关行为通过。没有将初次失败记为通过。
- 原型单独运行并检查输入状态：无浏览器脚本错误，输入文字后发送按钮可用。

全部数据和材料均为 synthetic，API 由测试拦截，无真实生成、复核、模型或扣费。GitHub hosted checks 如受账户付款/额度限制，不能替代为“CI 通过”。上线状态独立记录，不以本证据或 PR 合并表示发布完成。
