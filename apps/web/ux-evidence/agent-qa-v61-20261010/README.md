# v6.1 Agent 修复：合成界面证据

2026-10-10，Chromium/WSL。全部截图使用合成账号、材料和拦截 API；不包含生产账号、授权客户原稿、模型生成内容或实际账务。

原型基线：develop `98a5f25a65df9371c1effd8c0b6cee300f5801cf` 的 `product-prototype/public/material-studio.js`、`project-assistant-refined.html`；实现为该基线加本轮 Agent 修复。M4 截图回执 `web-browser-integrated`；助手截图回执 `web-browser-integrated-assistant-visual`，14/14 pass。

| 场景 / 尺寸 | 原型 | 实现 |
| --- | --- | --- |
| M4 页脚，1440×960 | [原型](prototype-footer-desktop.png) | [实现](implementation-footer-desktop.png) |
| M4 页脚，390×844 | [原型](prototype-footer-mobile.png) | [实现](implementation-footer-mobile.png) |
| 助手收起，1440×960 | [原型](prototype-collapsed-desktop.png) | [实现](implementation-collapsed-desktop.png) |
| 助手收起，390×844 | [原型](prototype-collapsed-mobile.png) | [实现](implementation-collapsed-mobile.png) |
| M4 提交拒绝，1440×844 | 原型已有按钮旁反馈位置；不伪造演示失败 | [实际错误在视口内](implementation-error-desktop.png) |
| M4 提交拒绝，390×844 | 同上 | [实际错误在视口内](implementation-error-mobile.png) |
| 助手展开与移动菜单，390×844 | 沿用原侧栏菜单，无新布局 | [菜单退出未被助手挡住](assistant-mobile-menu-open.png) |

AQ-04 仅在明确提交失败、返回输入页后把错误提示滚入视口，不修改原型结构，不在后台 poll 强制滚动。AQ-05 仅提高已打开菜单层级，不新增菜单入口。

助手原型只展示工作台骨架，实际页面展示真实 API 能力对应的区域；对照检验顶部入口与收起行为，不以示例卡片数量作为相同布局要求。M4 原型仍有独立问答/充值导航与示例输入，当前实现按已确认产品决定使用全站助手、真实账户入口和服务端材料状态。这些既有差异不由本轮重新设计，产品标准采用最新 #642/#643/#646；Human 签认尚未执行。

手机菜单测试用键盘 Enter 打开已被展开助手覆盖的菜单按钮，再非 force 点击退出并验证一次 logout、登录页与助手状态清除。截图只证明打开后菜单可操作，实际触摸入口与可发现性仍需 Human 检查。
