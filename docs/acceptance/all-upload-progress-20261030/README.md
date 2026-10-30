# 全站文件上传进度统一

用户 2026-10-30 要求：所有文件上传入口统一展示进度条。开发基线 6819bb742bc650e4b5dd10d70ebe1571e1487f0e（develop）。本任务是开发交付，未执行生产部署。

## 覆盖范围

全量检索 apps/web/src 中的文件选择、上传恢复和二进制传输入口，覆盖 11 个页面模块、39 处文件 input 声明（包含不同视图及重新选择原文件）。

| 页面 | 已处理的入口 |
| --- | --- |
| 募集书更新 | 历史稿、参考稿、财务及其他材料、版本上传、恢复上传 |
| 募集书复核 | 原稿、补充材料、结果补证弹窗、恢复上传 |
| 文件生成首页 | 上传募集书、读取版本记录、保存后自动采用 |
| 文件生成准备 | 底稿目录、Word/ZIP/文件夹模板、其他文件模板、补充资料 |
| 原文件生成准备页 | 历史文件/模板、批量补充依据、原保存恢复 |
| 项目文件 | 募集书版本、关联文件及修改稿上传 |
| 底稿目录页 | Excel 目录及原目录恢复、后续目录识别 |
| 材料工作区 | 募集书、补充资料、私有模板、附件及恢复入口 |
| 项目问答 | 募集书、问题清单、补充资料及恢复入口 |
| BondBuddy 助手 | 普通附件、业务材料、私有模板、材料复用中的传输 |
| 诚信核查 | 历史补证草稿的原文件恢复（不恢复已移除的新补证入口） |

内部 business-handoff 的成果转存没有文件选择入口，继续沿用任务处理状态；未修改其业务逻辑。

## 展示与行为

- 统一使用绿色进度条。百分比仅来自浏览器观察到的实际传输字节，支持多文件逐份更新。
- 文件核对、服务器保存、模板解析、目录识别和版本读取显示活动进度条与具体状态，不虚构百分比。
- 传输 100% 与材料保存/采用完成分开；失败和待确认状态不持续动画，保留原重试和恢复入口。
- 截图中的募集书文件已保存但仍显示“正在上传”的标签已修正；成功后清除上传进度。
- 模板导入的二进制 POST 增加原生 XHR 字节进度，复用原 API 的 CSRF、身份刷新、错误处理及原请求编号。微小文件无 progress/load 事件时以收到响应确认传输结束。保存响应等待上限 120 秒，超时仍保留原导入编号供明确重试。
- 原有上传恢复记录、材料版本、草稿保存、计费与任务执行规则保持；无后端、数据库迁移或新增依赖。

## 原型与页面核对

本次用户要求为进度体验调整依据。实现与原型的共同提交为 `4f0fcba7eca8f11bc1e4fc8febbc5c414ca86fd4`；桌面与手机截图对应此实现。原型：product-prototype/public/upload-progress.html。原型和实现共用 product-prototype/public/upload-progress.css，实现由 apps/web/src/upload-progress.ts 渲染。

进度条样式、状态文案以本次用户要求为依据，原型与实现无已知组件差异；页面本身保留各自现有结构。本批尚未完成用户实际验收。

同尺寸原型和实际页面截图位于 apps/web/test-evidence/all-upload-progress/；包含 1440px 桌面及 390px 手机。核对绿色轨道、百分比、保存状态、长文件名换行、失败恢复和横向溢出。原型是组件状态展示，各业务页面继续保留已有结构和恢复规则。

## 验证

最终验证：137 项单元测试通过；web TypeScript 检查和生产构建通过（保留既有 >500 kB bundle 提示）。浏览器分组回归去重后 192 项通过、8 项可选截图测试按配置跳过；发现的失败已修正并定向复验，无未解决失败。

| 浏览器测试组 | 通过 | 跳过 |
| --- | ---: | ---: |
| all-upload-progress | 15 | 0 |
| assistant-template-fifteenth | 42 | 2 |
| assistant-upload-11th | 9 | 2 |
| file-template-preparation | 12 | 0 |
| m4-upload-thirteenth | 40 | 4 |
| prospectus-panel | 15 | 0 |
| qa-upload-11th | 9 | 0 |
| review-upload-progress-autosave | 4 | 0 |
| upload-entry-recovery | 11 | 0 |
| upload | 19 | 0 |
| workpaper-upload | 16 | 0 |

浏览器回归发现并修复了问答回调遗漏、采用成功后进度未收起、微小二进制导入缺少传输完成事件、忙碌时恢复按钮提前启用、错误提示重复及弹窗嵌套状态播报。旧问答助手测试按现行全局助手入口更新；跨页面记录断言等待存储同步，失败恢复测试等待真实失败再刷新，旧版补充依据测试先展开面板再选择文件。测试环境缺少 Chromium，使用本机 Edge；隔离工作区复用已有依赖，本批依赖清单及锁文件未变。

复现命令（工作区已具备依赖；Playwright 在 apps/web 执行，设置 BB_E2E_BASE_URL 指向本机 Vite、BB_E2E_BROWSER_CHANNEL=msedge）：

```text
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/upload-progress.test.js apps/web/dist-test/upload-recovery.test.js apps/web/dist-test/api.test.js
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
node node_modules/vite/bin/vite.js build apps/web
node ../../node_modules/@playwright/test/cli.js test tests/all-upload-progress.spec.ts tests/review-upload-progress-autosave.spec.ts tests/file-template-preparation.spec.ts tests/workpaper-upload.spec.ts tests/upload-entry-recovery.spec.ts tests/qa-upload-11th.spec.ts tests/m4-upload-thirteenth.spec.ts tests/assistant-upload-11th.spec.ts tests/assistant-template-fifteenth.spec.ts tests/upload.spec.ts tests/prospectus-panel.spec.ts
```

测试使用真实页面/controller、真实恢复代码及合成 HTTP/文件。二进制 POST 用真实浏览器 XHR 校验字节、CSRF 和认证重放。未调用真实模型、未连接生产数据库、未触发真实收费；本批不是用户已验收的统一本地集成版。

## 手工复验步骤

1. 在文件生成首页上传 DOCX/PDF 募集书，确认传输时显示百分比，保存/读取版本时显示活动进度，保存完成后收起上传提示。
2. 在文件生成准备上传 Excel 目录、Word/ZIP/文件夹模板和补充资料，确认多文件逐份显示当前文件名与进度。
3. 在项目文件上传关联文件及修改稿，在问答页上传问题清单及补充资料，在助手上传附件及私有模板，确认上传、保存和完成状态一致。
4. 在慢速网络下观察传输进度；断网或模拟失败后确认停止活动进度、错误只显示一次，重试仍沿用原文件和原任务。
5. 390px 手机宽度核对长文件名、百分比、错误与重试入口；刷新恢复后不得自动提交生成或收费任务。

## 集成交接

仅更新 web 静态资源。无需 API/worker 更新，无迁移。请将本 PR 纳入下一批固定集成版本，按项目规范提供统一本地入口验收后由统一发布 chat 上线。

开发测试临时地址为 http://127.0.0.1:5397 ，仅运行 Vite；没有独立登录后端，不作为可验收的完整测试版。测试结束后停止本任务启动的 Vite 进程。
