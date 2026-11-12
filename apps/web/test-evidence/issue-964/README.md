# #964 本批交付清单

Refs #964。代码完成，尚未合并、部署；Draft PR 等父 agent review。用户已要求实现方向，局部视觉仍待人工验收，不视为签认。

## 版本与范围

- 基线 origin/develop：`8a7dc38a`。
- 原型与实现、截图对应代码 commit：`72b70b5ee9dbf8370631932929fd9a3f83cba449`。
- 原型：[本批交付清单](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/product-prototype/public/file-delivery-checklist.html)。影响已迁移的“文件生成 → 生成记录”原步骤。
- 实现：[清单投影与渲染](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/src/file-delivery-checklist.ts)、[生成面板](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/src/file-generation-panel.ts)。无 API、公共契约、数据库、计费或 worker 修改。

母批只枚举它实际引用的子批；底稿采用本项 artifact pin，其他文件以原 run、文种、topic、执行项目及文件版本绑定。缺失、冲突、旧说明无可靠分类时明确待核对。资料不足/外部证据/不适用使用现有 decision，不从说明文字猜测。已有精确 pin 下载重新核验授权元数据和字节；原 ZIP/重试不重做，无新增补跑动作。

原母批不在最近列表时使用已有精确批次 GET，刷新不退到最新同类成果。其他文件的旧任务元数据若服务端未提供，只显示待核对和准确原任务链接，不声称已有完整交付信息。

## 验证

本 worktree 独立 `npm ci --no-audit --no-fund`，所有 @bondbuddy 依赖构建于此工作区。macOS arm64，Node 24，Playwright Chromium；预览端口 5964。

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
npx tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/file-delivery-checklist.test.js
npm run build -w @bondbuddy/web
npm run check:contracts
BB_E2E_BASE_URL=http://127.0.0.1:5964 BB_UX_964_EVIDENCE="$PWD/apps/web/test-evidence/issue-964" npm test -w @bondbuddy/web -- file-delivery-checklist.spec.ts --output="$PWD/.local/issue-964-test-results"
BB_E2E_BASE_URL=http://127.0.0.1:5964 npm test -w @bondbuddy/web -- file-generation-flow.spec.ts --grep 'upload adopts|switching a saved version|source conflict' --output="$PWD/.local/issue-964-source-regression"
```

最终结果：定向单元 **12 pass / 0 fail / 0 skip**；新 Playwright **5/0/0**，相邻来源选择回归 **4/0/0**；web/dependency build 成功（已有大 bundle 提示）；contracts **72/0/0**，另 **195** 合成 examples 验证通过。初轮自身 TS 可空性和故障夹具误阻断初始页面问题已修正，以上为修正后结果。

浏览器覆盖混合子批的分类计数、历史母批精确恢复、原任务链接、错误版本拒绝下载、成功原文件下载、元数据失败降为未知、刷新/重开，以及无生成写请求。测试中生成记录、HTTP 与文件字节均为 **synthetic**；真实页面/controller/API client 和 Chromium，不调用模型、生产存储或支付，不证明真实 Word 业务质量。

## 同尺寸视觉对照

| 视口 | 原型 | 实现 |
|---|---|---|
| 1440 × 1000 | [原型桌面](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/test-evidence/issue-964/prototype-1440.png) | [实现桌面](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/test-evidence/issue-964/implementation-1440.png) |
| 390 × 1000 | [原型手机](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/test-evidence/issue-964/prototype-390.png) | [实现手机](https://github.com/ITSophiaXu/BondBuddy/blob/72b70b5ee9dbf8370631932929fd9a3f83cba449/apps/web/test-evidence/issue-964/implementation-390.png) |

已逐张读取截图：桌面四列摘要、左右文件操作；手机两列摘要及单列文件卡，按钮完整、无横向溢出。原型只描述局部，实际保留原侧栏/顶栏/助手；既有全站字体、按钮居中和内边距使行高略不同。合成文件名、日期、版本示例不同。**以上是已列明的局部对照差异，确认人待产品负责人；不能据此宣称视觉签认，不在本 PR 合并或部署。**

最终统一验收待办：实际账号/真实已生成母批的历史文件可达性、受限账号隔离、真实交付与模型内容质量、产品人工视觉验收及统一发布。
