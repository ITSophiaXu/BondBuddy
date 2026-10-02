# M3 #47 复核工作区：浏览器验收记录

2026-10-02。实现位于本提交的 `apps/web/src/review-*`，接入共享 M3 API；未引用演示数据、未修改用户原型或其浏览器存储。

## 对照版本

- 实现分支 `codex/m3-47-workspace`，基线 `744791a07bc53d7d899c33f79f8a46d2100a8e7a`（已合并 M3 需求）；实现版本为包含本记录的 PR head。
- 交互依据：用户确认的 `prototype-preview/product-prototype/public/review-v2.html/.css/.js` 及 `dashboard-v2.*` 本地补充。该原型工作区 HEAD 为 `19918c66500d5078781b553613d237da6b3e708c`；补充文件尚未进入该 HEAD，以如下 SHA-256 精确标识，不能把 HEAD 当成已含补充的提交。
- `review-v2.html`：`1a503afc1c8746e711318d081de19adc0fb31df5cc9ed12a6ac0e66f04c1cd7d`
- `review-v2.js`：`973ae71d51a35e437400b4891a8a8b60bb043662e8684ee176f427570f5d08c6`
- `review-v2.css`：`1bbdaf4d29224fdc0e5c4a661848d0d2ba8ae235d53c1980b8cbf52e30dd2bac`

## 逐屏核对

| 页面 / 行为 | 实现与对照 | 生产数据适配 |
| --- | --- | --- |
| 复核结果、项目助手展开 | [原型桌面](prototype-desktop.png) / [实现桌面](desktop.png)，均为 1440 × 1000 viewport、整页截图 | 保留现有 M1 公共导航宽度；复核路由隐藏收费占位。结果条数、证据、任务状态、消息均来自 API，本测试使用明确标记的 synthetic HTTP 数据。 |
| 窄屏助手抽屉 | [原型窄屏](prototype-narrow.png) / [实现窄屏](narrow.png)，均为 390 × 844 viewport | 抽屉、遮罩、关闭与键盘焦点保留；草稿由服务器和账号/项目分区的浏览器恢复缓存共同保存。 |
| 版本记录 | [实现工作台版本记录](history-desktop.png) | 工作台复核项目卡片与全部项目列表可打开相同记录；复核页只有材料与要求、复核结果两个 tab。停止/失败记录有独立执行版本、输入快照和范围。 |

原型与实现均使用隔离的测试浏览器上下文截图，没有读取、清空或写入用户正在体验的浏览器存储。截图文字/条数差别来自测试材料与实际 API 状态；不预填原型的助手回复、不把未执行的检查显示为通过。

## 已验证行为

- 不经过聊天即可查看解释/证据、加入修订、核对范围、明确执行、下载带哈希校验的成果；解释窗口不生成聊天记录。
- 助手默认收起。每个项目、报告、问题、材料版本保留精确引用；多个未发送草稿可切换并在刷新后恢复。云端保存失败时保留本地草稿；另一个账号不能显示这些草稿。
- 发送说明只保存消息/等待真实回复；查看提议不改计划，明确采纳只改计划，执行需单独确认。发送中继续输入的内容不被清空。
- 问题展开状态、正在编辑的内容和光标在轮询时保留。差异报告明确标记本轮核验与沿用先前结果。
- 补证锁定原报告/问题。上传完成响应丢失后重用原上传会话，不重复上传字节；保存补证不启动任务，差异复核仍需明确确认。
- 同一项目活跃任务、空修订被阻止；网络响应丢失时保留同一执行请求。停止后的新一轮产生新请求，不复用已停止版本。
- 输入冲突同时展示服务器与本地草稿，明确选择后才保存，不自动覆盖。
- 复核成果与修订成果按 `artifact_run` 标明执行版本/来源报告；生成修订版、清洁版不改变原复核发现，也不表示复核通过。历史链接精确带 `report_id`。
- M3 不调用报价、积分、支付、充值、预占或结算接口。现有 M1 用户说明组件未改为多轮助手。

## 验证命令与结果

环境：Windows、Node 24.14.0、npm 11.9.0、Playwright + 已安装 Microsoft Edge（Chromium），Vite 本地服务。

```powershell
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/web
npm run test:unit -w @bondbuddy/web
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npm test -w @bondbuddy/web -- review-workspace.spec.ts prototype-workflow.spec.ts project-conversation.spec.ts
```

结果：contracts / web build 通过；web 单元测试 48/48；浏览器 23/23（M3 8、M1 项目说明 13、原型工作流程 2）。`git diff --check` 通过。更新了旧原型回归脚本中已被 M1 产品决定取消的“有无历史稿”选择及创建页补充说明断言，未改变 M1 实现。

首次运行缺少 Playwright 默认 Chromium，改用本机 Edge 后执行成功；`BB_E2E_BROWSER_CHANNEL` 为可选环境参数，CI 默认行为保持不变。

## 验收边界

本记录是**真实浏览器 + synthetic API**验证。测试中的助手回复、Word 下载字节和材料均为 synthetic，不证明真实供应商调用、Word 业务质量、专业签认或部署环境通过。最终统一验收仍需合并公共契约/API/worker 后，以授权材料执行真实三维复核、差异复核、修订及实际文件下载。公共 M3 DTO 和后端实现由协调分支提交，不包含在这个 Web 提交中。
