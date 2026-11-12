# #961 原任务恢复与新一轮准备

Refs #961。用户于 2026-11-12 要求直接实现 #961–#965，并各提独立 PR。本单只改变募集书更新的现有异常提示及操作组织；不合并、不部署，不改 API、计费政策、任务状态机或质量门禁。

- 开发基线：`8a7dc38a9546831346805d8cb36ce88aae456da3`。
- 实现、局部原型和截图：`74c73504ea2e79b0680c13df1e40a27ccb5459e8`。
- [恢复展示逻辑](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/src/execution-recovery.ts>)、[控制器接入](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/src/project-execution.ts>)、[局部原型](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/product-prototype/public/authoring-recovery.html>)。

## 实现范围

- 材料问题、人工暂停、系统核对中、失败及停止分别说明下一步；已知材料只按原任务输入中的准确编号/版本定位，不猜最近上传文件。
- 失败/取消后的“准备新一轮”与恢复同一任务分开。准备不执行；成功后的既有“继续修改”入口保留。
- “刷新原任务状态”仅 GET 原 run，核对任务编号及不可变输入，不切到最近任务、不重新提交。状态读取失败展示最近已知记录，不保证后台仍在执行；先核对再继续/准备。
- 支持摘要仅含安全任务编号、已知状态和记录时间；不含正文、项目名、文件名、原错误、URL、令牌或哈希。浏览器拒绝复制时提供只读手动选择，轮询保留焦点及选区。
- 自动篇幅修复预算已耗尽时保留支持路径，不展示不能推进的重复恢复。服务端预算、状态及恢复权限不变。

## 验证

环境：macOS arm64，Node 24，独立工作区 `npm ci --no-audit --no-fund`，真实 Chromium/Vite；所有项目、任务、HTTP 与文件数据均为 **synthetic**。未调用真实模型、生产 API、支付或客户材料。

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
npm run check:contracts
npm run build -w @bondbuddy/web
./node_modules/.bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/execution-recovery.test.js apps/web/dist-test/project-execution-poll.test.js
BB_E2E_BASE_URL=http://127.0.0.1:5961 npm test -w @bondbuddy/web -- project-execution.spec.ts --grep 'recovery UX|processor failure|exhausted size repairs|unknown processor reason|paginated recovery|trial pause|trial stage|operator denial' --output /tmp/bondbuddy-ux-961-acceptance-results --workers 1
```

- 依赖与 Web 构建：通过；仅保留已有大 bundle 警告。
- contracts：72 pass / 0 fail / 0 skip，另 195 个 synthetic examples。
- 定向单元及控制器轮询：8 pass / 0 fail / 0 skip。
- 定向 Chromium：20 pass / 0 fail / 0 skip，包含本单 6 项新用例及既有失败/暂停回归。

### 完整执行套件没有全绿：已核对基线差异

运行整个 [执行浏览器套件](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/tests/project-execution.spec.ts>)：**97 pass / 5 fail / 1 skip**。没有删除或跳过失败用例来声称全绿。

五项失败均在独立、未修改的上述基线（另一工作区及端口 5960）复现为相同断言失败：

| 用例 | 数量 | 两边一致的失败位置 |
| --- | ---: | --- |
| authoring materials stay read-only… | 1 | 上传 input 已 disabled，但旧用例期望其父 label hidden |
| deduplicated first draft… | 2 | 旧无原稿首稿准备路径未产生预期任务；未进入本单恢复控件 |
| lost upload acknowledgement… | 2 | 旧上传回执夹具停在保存，未出现“服务器已确认保存” |

基线比对命令（于未修改基线执行）：

```sh
BB_E2E_BASE_URL=http://127.0.0.1:5960 npm test -w @bondbuddy/web -- project-execution.spec.ts --grep 'authoring materials stay read-only|deduplicated first draft|lost upload acknowledgement' --output /tmp/bondbuddy-ux-961-baseline-results --workers 1
```

结果：0 pass / 5 fail / 0 skip。1 个完整套件 skip 是原有、依赖环境开关的旧计费截图用例；本单桌面/手机原型截图已实际执行。以上基线用例维护未混入 #961，不推定所有失败根因已经修复；发布仍需既有完整门禁和统一验收。

## 同视口局部对照

在真实产品页面中截取新增恢复提示区；原型同视口且使用相同内容宽度。未改变或掩盖实际页面状态。

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440 × 960 | [原型桌面](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/test-evidence/ux-961-recovery/prototype-1440.png>) | [实现桌面](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/test-evidence/ux-961-recovery/implementation-1440.png>) |
| 390 × 960 | [原型手机](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/test-evidence/ux-961-recovery/prototype-390.png>) | [实现手机](<https://github.com/ITSophiaXu/BondBuddy/blob/74c73504ea2e79b0680c13df1e40a27ccb5459e8/apps/web/test-evidence/ux-961-recovery/implementation-390.png>) |

已逐张查看：标题、原因、建议、两个操作及隐私说明顺序一致；实际页继承控件样式导致局部高度约 1–2px 差别。手机实际截图右侧可见既有助手浮标边缘，操作按钮未被遮挡；本单不修改 #623 的助手布局。页面没有横向溢出。局部方案方向按用户本次实现要求推进，**具体视觉仍待产品负责人确认，不能冒称用户已签认**。

最终统一验收待办：真实账号的异常任务与支持流程、实际收费政策下恢复、人工视觉确认、完整发布门禁及上述基线测试维护。未取得通过凭据，不部署。
