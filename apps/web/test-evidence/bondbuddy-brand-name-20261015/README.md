# BondBuddy 名称修正验证

用户 2026-10-15 确认产品称为 BondBuddy 或“券商助手”，取消“项目助手”名称。关联 #361；本次用户原话为文案确认依据。

原型与产品代码：`846fafa68c830d941c663422e1d207d9ec77d3f3`，基于 `develop 207d0b7`。当前原型 `product-prototype/public/project-assistant-refined.html`；实现为全站助手、材料及复核消息署名。其他可运行原型同步文字，保持原有布局。

## 同尺寸对照

| 窗口 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 展开 | [原型](prototype-open-desktop.png) | [实现](implementation-open-desktop.png) |
| 1440×960 收起 | [原型](prototype-collapsed-desktop.png) | [实现](implementation-collapsed-desktop.png) |
| 1024×768 展开 | [原型](prototype-open-small-desktop.png) | [实现](implementation-open-small-desktop.png) |
| 1024×768 收起 | [原型](prototype-collapsed-small-desktop.png) | [实现](implementation-collapsed-small-desktop.png) |
| 390×844 展开 | [原型](prototype-open-mobile.png) | [实现](implementation-open-mobile.png) |
| 390×844 收起 | [原型](prototype-collapsed-mobile.png) | [实现](implementation-collapsed-mobile.png) |

BondBuddy 主标题、券商助手副标题、菜单 BondBuddy 入口及可访问名称已同步。桌面与手机截图目视核对，命名和布局符合本次要求。原型使用简化背景；实现保留业务导航、工作台与原生滚动条。其余页面矩阵截图也保存在本目录。

## 验证结果

- Windows / Node 24.19.0 / Edge / Playwright；独立 Vite 端口 54415，测试后已停止。
- 按依赖顺序编译 contracts、domain、rule-pack-registry、rule-applicability-context、API、worker，web TypeScript 检查及 Vite 构建通过。
- 助手现有浏览器回归 **16 通过 / 1 跳过**。跳过的是旧可选取证用例；本次通过 `BB_RIGHT_PANEL_EVIDENCE_DIR` 实际生成以上对照。覆盖附件、确认卡、收费提示、发送、草稿恢复、收起/展开、焦点与页面宽度。
- `node --test --test-name-pattern='product help|M4 free task' apps/api/dist/m4-workspace.pg.test.js`：**2/2**。在空上下文和选中文件/引用/成果时，券商助手问候与产品帮助均免费，混合专业问题继续按原规则分类；兼容旧称。
- M3/M4 技能加载与固定哈希校验 **3/3**；同步助手身份正文、manifest 及加载器固定值。
- 契约示例 **171 + 12**、数据生命周期示例 **4** 通过；原型 JS/MJS 语法及 `git diff --check` 通过。
- 首次构建尾部 Vite 命令误在仓库根目录使用网页目录的相对路径而失败；改在 `apps/web` 执行后通过。身份文件哈希更新后重新编译 worker 并通过加载测试。构建保留已有大 chunk 提示。

浏览器接口与账号均为 synthetic；分类测试直接调用真实分类函数，未运行数据库集成、真实模型、真实任务或扣费。没有把这些结果当作后端全链路或用户验收。

无迁移、公共契约或新增依赖。新发布需携带 web/API/worker 对应代码及技能文件；旧会话名称、历史消息和已固定任务输入不改写。本地及仓库 AGENTS.md 已记录命名规则。

**开发和自测完成；尚未纳入统一本地集成版；用户未验收；代码完成，尚未部署，待统一发布。**
