# #965 诚信核查的阅读优先级

Refs #965。本轮用户已要求实现方向；局部视觉待人工确认。Draft PR 不合并、不关闭 Issue、不部署，不请求 Felix review。

## 版本与实现

- 基线 origin/develop `8a7dc38a`；与 #964 分支独立。
- 实现/原型及截图代码 commit：`a435d85fa23cf2241bab2b6ce3e841ad03081dfb`。
- 局部原型：[诚信核查阅读优先级](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/product-prototype/public/integrity-reading-priority.html)。补充原结果步骤，无新页面/导航。
- 实现：[只读分组](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/src/integrity-reading.ts)、[结果页面接入](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/src/integrity-workspace.ts)。没有 API、worker、公共契约、数据库或价格修改。

按主体 × 网站计数；使用现有 `integrityRecordPresentation.group` 区分已发现、查询受限/未完成、无返回结果、不适用，缺原记录单列。一般信息、其他主体命中不改为风险结论。原来的 pending 过滤保留兼容；筛选展开对应主体，“下一条已发现记录”直接打开原证据详情。

同一准确核查轮的阅读筛选/主体/网站写在 URL 的纯 UI 参数；不写查询或处理结论，不作为授权。关闭详情恢复原控件焦点和滚动；重开能辨认先前阅读对象。原始记录与免费导出快照保持独立，不借后来核查结果填旧版。不会恢复已取消的新建人工补证入口。

## 验证命令与计数

工作区独立 `npm ci --no-audit --no-fund`；macOS arm64 / Node 24 / Playwright Chromium；独立预览端口 5965，输出目录仅本 worktree。

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
npx tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/integrity-reading.test.js
npm run build -w @bondbuddy/web
BB_E2E_BASE_URL=http://127.0.0.1:5965 BB_UX_965_EVIDENCE="$PWD/apps/web/test-evidence/issue-965" npm test -w @bondbuddy/web -- integrity-reading.spec.ts --output="$PWD/.local/issue-965-test-results"
BB_E2E_BASE_URL=http://127.0.0.1:5965 npm test -w @bondbuddy/web -- integrity-continuation.spec.ts --grep 'pending/all filters|terminal missing record|requested missing historical run' --output="$PWD/.local/issue-965-regression"
npm run check:contracts
```

最终：定向单元 **9 pass / 0 fail / 0 skip**；新 Playwright **6/0/0**；旧筛选/缺轮回归 **3/0/0**；web/依赖 build 成功（已有大 bundle 提示）；contracts **72/0/0** 与 **195 合成 examples** 验证通过。

浏览器验证覆盖五类互斥计数、多主体事项与来源原文/匹配提示、详情关闭焦点和滚动、重开阅读对象、错误 UI 参数、旧导出不借新记录、无效记录不标为零项，以及过滤/阅读全程 **0 写请求**。原正常页面/控制器/API client/Chromium，HTTP 与记录均 **synthetic**；不访问真实官网、不执行模型/收费、不证明真实截图真实性或 Word 内容质量。已有取消人工补证及原导出业务保持，不新增处理状态机。

## 同尺寸对照与差异

| 视口 | 原型 | 实现 |
|---|---|---|
| 1440 × 1000 | [桌面原型](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/test-evidence/issue-965/prototype-1440.png) | [桌面实现](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/test-evidence/issue-965/implementation-1440.png) |
| 390 × 1000 | [手机原型](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/test-evidence/issue-965/prototype-390.png) | [手机实现](https://github.com/ITSophiaXu/BondBuddy/blob/a435d85fa23cf2241bab2b6ce3e841ad03081dfb/apps/web/test-evidence/issue-965/implementation-390.png) |

已读取四张截图：桌面五列、手机两列摘要，文字和按钮可读、无横向溢出，主体表保持原结构。局部原型未复刻完整导航与历史元数据；实际页面保留全站壳、原记录表、真实既有控件风格。原型与 fixture 的受限/无结果数量各相差一项，都是合成示例，不是状态转换；两边各计满 12 对。**上述差异待产品负责人视觉验收，未冒充人工确认。**

最终统一验收待办：真实账号、真实多主体/多网站记录与证据截图的业务审阅、原底稿及导出回归、人工视觉确认、统一发布。开发通过不等于上线验收。
