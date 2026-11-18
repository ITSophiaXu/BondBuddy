# #963 复核 editor：预览、导出与当前稿反馈

## 范围与版本

- 基线：`8a7dc38a9546831346805d8cb36ce88aae456da3`，包含 #956 / PR #1025 的发现列表局部更新。
- 原型：[review-editor-feedback.html](../../../../product-prototype/public/review-editor-feedback.html)。实现：[review-editor.ts](../../src/review-editor.ts)、[反馈模型](../../src/review-editor-feedback.ts) 与 [局部样式](../../src/review-editor-feedback.css)。原型和实现的同一固定 source commit 在 PR 正文及 #361 登记。
- 仅增强已有 editor；不修改报告型结果页，不恢复 10-13 删除的“根据复核结果更新募集书”整块，不增加新任务类型。
- 现有导出/当前稿选择 API 和幂等请求不变，新增的当前稿读取是既有授权接口的只读调用。未改 contracts、run 状态、计费、后端或质量门禁。
- 用户确认建议方向及实施，**具体局部视觉仍待人工验收；未部署**。下述截图检查由 agent 完成，不是用户签认。

## 验收覆盖

| 关注点 | 证据 |
|---|---|
| 预览与已保存 Word 分开 | 未保存时就近显示成果 V1 和不包含的处理数量/事项；下载仍为固定 V1 字节 |
| 保存只导出、不重新复核 | 默认按钮明确“不重新复核”；原免费导出路径、完整请求恢复与新复核入口保留 |
| 未知回执/已受理不冒充新成果 | 断网后显示回执待确认；重载不自动发送，显式重试使用同一请求；已受理时旧下载仍明确标记 V1 |
| 新版与项目当前稿独立 | 新版 V3 读取后仍提示项目当前募集书 V42；只有显式设为当前稿成功后显示 V43，刷新仍一致 |
| 当前稿读取失败 | 显示暂不可核实，不阻断原成果下载；重试只读，不发任务或收费 |
| #956 阅读连续性 | 42 项列表中滚动到后段，选择/改决策/手动输入/异步刷新反馈均保留列表与按钮节点、列表 scrollTop 和输入光标 |
| 既有能力 | 旧 editor 下载、恢复、人工处理、下一轮补料、准确历史成果与报告型分支回归 |

## 同尺寸原型/实现对照

| 屏幕 | 原型 | 实现 |
|---|---|---|
| 桌面 1440×1000 | [prototype-desktop.png](prototype-desktop.png) | [implementation-desktop.png](implementation-desktop.png) |
| 手机首屏 390×844 | [prototype-mobile.png](prototype-mobile.png) | [implementation-mobile.png](implementation-mobile.png) |
| 手机操作区 390×844 | [prototype-mobile-actions.png](prototype-mobile-actions.png) | [implementation-mobile-actions.png](implementation-mobile-actions.png) |

对照范围：下载旁提示/未保存事项、项目当前稿提示、原保存操作带与预览状态。原型是独立的局部演示，复用既有 CSS，不读取 API。实现使用真实 ReviewEditor 与 ApiClient、schema 校验的 synthetic HTTP 和固定合成 Word 字节；不是生产/客户模型或真实文稿专业验收。

偏离说明（待视觉验收）：历史时间由实际浏览器本地化，原型使用固定示例时间；下方原问题列表/正文/批注在原型中为示意，实际组件保持既有数据、控件与处理能力，未为截图删减功能。就近状态和操作带的排列、层级、文案按局部原型一致；不把原型示意正文当真实成果。手机保存操作带在下载下方，以第二屏对照覆盖，不新设浮层遮挡文档。

## 复跑

独立 `npm ci --no-audit --no-fund`；@bondbuddy workspace links 均位于本工作区，不使用主仓 dist。

```bash
npm run build
npm run check:contracts
# managed 后台服务；完成后停止
npm run dev -w @bondbuddy/web -- --port 5963 --strictPort
npx tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/review-editor-feedback.test.js apps/web/dist-test/review-editor-cache.test.js
BB_E2E_BASE_URL=http://127.0.0.1:5963 \
BB_UX_963_EVIDENCE="$PWD/apps/web/test-evidence/ux-963-20261112" \
npx playwright test -c apps/web/playwright.config.ts \
  apps/web/tests/review-editor-feedback-963.spec.ts \
  apps/web/tests/review-editor.spec.ts \
  apps/web/tests/review-editor-recovery.spec.ts \
  apps/web/tests/review-flow-editor.spec.ts \
  apps/web/tests/review-followup.spec.ts \
  --output "$PWD/.local/final-test-results-963" --reporter=list
```

独立组件首次运行时没有主应用启动时的 date-time 格式注册，新增当前稿的严格 schema 核验因此显示未知；已在 editor 显式复用既有 schema-formats，未移除/放宽校验。旧 review-followup 末条仍操作已移除的财务材料折叠区和 financial 选择器，本次仅把测试改为当前可见统一 audit 上传入口及其角色断言，不改变材料页实现。父 agent 预审建议已采纳：顶部采用“本页处理 N 项正文修订”，不声称原文预览模式显示了修改。首次失败与最终 pass/fail/skip 计数写入 PR 正文。没有真实模型、支付、Word/WPS 专业内容或发布验收。
