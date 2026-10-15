# 募集书更新：可选材料上传

用户于 2026-10-15 要求将有息债务明细表、担保明细、公司章程等具体材料列在上传页，允许选填并说明多种文件格式。基线 develop：`207d0b7`。本记录对应同目录截图及本 PR 的实现、原型版本。

## 实现与集成交接

- 将笼统的“其他项目材料”拆成“债务、授信与担保”“公司、经营与信用”“其他补充材料”，均标注选填。
- 默认展示有息债务明细表、银行授信情况表、担保明细 / 担保合同、抵质押资产资料、业务经营资料、公司章程 / 治理制度、营业执照 / 公司基本资料、评级报告和其他补充材料。每项附具体示例；原有其余细分类别仍可展开上传。
- 支持 DOCX、PDF、XLSX、CSV、TXT、PNG、JPG、JPEG，多文件选择和拖入沿用原上传队列。页面说明与既有 MIME 白名单一致；不增加 DOC、XLS 等未支持格式。
- 复用原有 material role、不可变材料版本、上传回执、去重、失败重试、删除和刷新恢复。已保存旧材料仍按原 role 展示。没有新增必填项、API / worker / 公共契约、迁移或依赖。
- 仅修改募集书更新的材料页。保持现有导航、历史募集书信息要求、财务材料、编制执行与全站助手行为。

状态：开发和自测完成；尚未纳入统一本地集成版，用户尚未验收；**代码完成，尚未部署，待统一发布**。

## 验证

- Edge 浏览器 **29/29 通过**：两种屏宽的材料默认展示、多格式多文件上传、正确 role / MIME、刷新恢复、重复文件、丢失回执、失败重试、取消、原生选择框保留、跨账号隔离和开始编制。未上传可选材料仍可开始；任务运行后继续锁定材料。
- API 原始文件接收校验 **1/1 通过**：既有全部 7 种 MIME 原字节保留，拒绝不支持类型及无效大小；这是实际接收校验函数测试，不等于真实数据库 / Blob / 浏览器全链路。
- contracts、domain、rule 包、API 编译及 web TypeScript、Vite 构建通过；171 个合成契约样例 + 12 个内部样例、4 个生命周期样例通过。Vite 保留现有超过 500 kB 的主包提示。
- 首次类型检查缺少尚未构建的 workspace 包产物，构建依赖后通过；首次新增浏览器断言误把整个材料页已有的 details 容器当作细分类别，改为检查 `.material-subtypes` 后通过。原型首轮截图受 main padding 影响，修正取证容器后以实际分区宽度重新截图。
- 浏览器 HTTP 和测试材料为合成数据；未连接生产、未运行模型、未发生任务计费。本次没有启动真实用户本地集成后端，未将自测端口作为验收入口。

依赖复用本机相同 package-lock 的已安装目录，workspace 包指向本次独立工作区；锁文件未修改。

可复现命令（仓库根，先构建依赖）：

```powershell
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
# 同样构建 domain、rule-pack-registry、rule-applicability-context、apps/api
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/vite/bin/vite.js build apps/web
# 在 apps/web 启动独立 Vite：node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_OPTIONAL_EVIDENCE=(Resolve-Path 'apps/web/test-evidence/optional-materials-20261015').Path
node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts tests/upload.spec.ts tests/project-execution.spec.ts --grep 'optional materials|upload|ready input saves|materials stay read-only'
node --test --test-name-pattern 'every supported project material' apps/api/dist/original-material-upload.test.js
node packages/contracts/dist/check-examples.js
node packages/contracts/dist/check-data-lifecycle.js
```

## 原型对照与验收步骤

增量原型：`product-prototype/public/optional-materials.html`，共用 `optional-materials.css`；对应已迁移页面 `apps/web/src/main.ts` 的材料上传分区，文案集中于 `optional-materials.ts`。原型仅演示选择文件，不上传或保存。原型与实现同一提交，用户本次请求为变更依据。

| 浏览器尺寸 | 债务分区原型 / 实现 | 公司分区原型 / 实现 |
| --- | --- | --- |
| 1440 × 960 | prototype-1440-0.png / implementation-1440-0.png | prototype-1440-1.png / implementation-1440-1.png |
| 390 × 960 | prototype-390-0.png / implementation-390-0.png | prototype-390-1.png / implementation-390-1.png |

截图以同尺寸浏览器、相同实际分区宽度裁切；桌面为双列、手机为单列。已逐图检查标题、示例、格式说明、上传操作和换行，无横向溢出。实现手机图含现有全站助手悬浮图标，原型不重建全站外壳；无本次业务布局偏离。

集成后：进入募集书更新的材料步骤 → 直接查看上述常用材料 → 分别上传债务 XLSX / CSV、担保 PDF / 图片、章程 DOCX / TXT → 刷新检查分类与文件恢复 → 在另一个准备完成但未上传这些可选材料的项目开始编制。实际后端存储和模型对新材料的使用效果留在统一集成验收验证。
