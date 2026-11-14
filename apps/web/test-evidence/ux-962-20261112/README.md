# #962 助手项目上下文交接 · 合成验收

## 范围与版本

- 开发基线：`8a7dc38a9546831346805d8cb36ce88aae456da3`。
- 原型：[assistant-project-handoff.html](../../../../product-prototype/public/assistant-project-handoff.html)。实现：[project-assistant.ts](../../src/project-assistant.ts)、独立的 [解析模块](../../src/assistant-page-context.ts)、[展示模块](../../src/assistant-page-context-view.ts) 和 [局部样式](../../src/assistant-page-context.css)。原型与实现的固定 source commit 在本 PR 正文及 #361 登记，两个截图来源相同。
- 用户确认的是 #962 建议方向及实施，不是局部视觉签认。**尚待人工视觉验收；未部署。**
- 真实 Chromium + 实际 ProjectAssistant/ApiClient + 合成 HTTP 数据；专属 Vite `http://127.0.0.1:5962`。左侧是合成页面壳，用来隔离右侧助手的局部对照，不是生产项目页截图。
- 不调用客户模型、支付或生产 API。测试里的发送只调用合成响应，不能作为真实供应商/账务验收。

## 验收矩阵

| 内容 | 证据 |
|---|---|
| A 会话不随 B 材料/问答/文件生成/诚信页面切换 | 新 suite 桌面/手机路径，未点击交接时 0 创建；原稿、附件与成果 pin 不变 |
| 有名字的交接、旧对话完整恢复 | 交接 source B 与私有 scope 区分；历史回看及重载恢复 A 草稿、附件、V3 清洁稿 |
| 不能由导航提示授予归属 | project/source_project_id 授权读取；return_project 不参与身份决定；topic 先于 project 提示 |
| 读取失败/迟到与保存失败 | 原对话可继续使用；失败无交接按钮，重试只读；旧页面迟到响应不覆盖新页面；草稿保存失败不创建 B |
| 长名称与小屏 | 320×740 的长名称无横向溢出，编辑区保持在视口内 |
| 旧能力 | 原助手上传/卡片/收费边界及准确成果交接回归；未改变后端或计费逻辑 |

## 同尺寸截图对照

| 尺寸 | 实现 | 原型 |
|---|---|---|
| 桌面 1440×960 | [implementation-desktop.png](implementation-desktop.png) | [prototype-desktop.png](prototype-desktop.png) |
| 手机 390×844 | [implementation-mobile.png](implementation-mobile.png) | [prototype-mobile.png](prototype-mobile.png) |

局部原型与实现均把交接放在现有关联项目/成果区，发送对象和成果版本放在输入框上方。只对作用范围内样式做对照；主导航、业务页面不重设计。原型附件为禁用的演示控件、仅本地演示交接，实际组件保留原上传、草稿和任务能力。手机中部内容沿用原滚动区域，不因新增信息遮住输入框。原型未新增网络或收费行为。

## 可复跑命令

工作区先独立 `npm ci --no-audit --no-fund`，npm workspaces 的 @bondbuddy 链接指向本工作区内的 packages/apps，不指向主仓 dist。

```bash
npm run build
npm run check:contracts
# 以 managed job 启动，完成后必须停止
npm run dev -w @bondbuddy/web -- --port 5962 --strictPort
npx tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/assistant-page-context.test.js apps/web/dist-test/assistant-view-cache.test.js apps/web/dist-test/project-navigation.test.js
BB_E2E_BASE_URL=http://127.0.0.1:5962 \
BB_UX_962_EVIDENCE="$PWD/apps/web/test-evidence/ux-962-20261112" \
npx playwright test -c apps/web/playwright.config.ts \
  apps/web/tests/assistant-page-context-962.spec.ts \
  apps/web/tests/project-assistant.spec.ts \
  apps/web/tests/result-handoff-assistant.spec.ts \
  --grep-invert 'approved prototype comparison capture' \
  --output "$PWD/.local/final-test-results-962" --reporter=list
```

排除的仅是旧助手原型的 opt-in 截图用例；本单桌面/手机原型对照在新 suite 中实际执行，不以 skip 替代。

既有 result-handoff fixture 原来直接传数值余额，不符合当前 billing wire（字符串金额），已用现有 fixtureJson/serveDisabledBillingCatalog 修正；未放宽任何产品断言。旧布局测试改为等待助手初始化完成再读取 boundingBox，避免在初始化 DOM 替换间读取空节点。首次失败与最终回归结果分别在 PR 正文记录。
