# 专业文档工作台：实现与视觉核对

用户查看本次对话中的交互预览后明确要求按该风格实施。设计决定见 [专业文档工作台](../../../../docs/product-decisions/2026-11-05-professional-document-workspace.md)，关联 #361。

## 版本与环境

- 基线：develop `a8936895`（包含桌面 UX PR #882）。
- 实现、共享样式及运行原型：`1f572963eea9f3b61dd3f198582af5b3255b60e5`。后续提交增加本目录与 Docker 资源清单修复，不改变已验证的 UI 源码。
- 已确认原始预览：`bondbuddy-document-workspace.html`，SHA-256 `37e197b00e46ecf12bbdba4ab2f56dae0cfadc35ad3206e900886466f8ef57a8`；本目录保留 `approved-tasks-1024.png` 和 `approved-review-1024.png`。
- 运行原型：`product-prototype/public/document-workspace.html?view=tasks|results|materials|files|qa`，与真实前端同用 `document-workspace.css`；`index.html` 同步加载。
- macOS / Node 24.14.0 / 仓库 Playwright Chromium；实际前端 `http://127.0.0.1:5182`，原基线 `http://127.0.0.1:5183`；原型使用本机 4333 只读服务器。
- 未提供独立 Browser skill；真实页面复用仓库已有 Playwright 合成 API 夹具。另用 Codex 内置浏览器打开运行原型，核对页面身份、导航、筛选、截图及控制台，无相关脚本错误。
- **全部材料、项目、响应和下载字节均为 synthetic**。没有真实支付、模型调用、生产写入或客户材料测试。

## 实现范围与对照

共享视觉覆盖任务、编制材料、复核、项目文件、生成、问答、账号的工作台外壳及助手；复核普通报告和修订编辑器均按真实文件元数据呈现文档行。下载、历史选择、未保存处理恢复、费用、队列和权限仍使用原代码路径。

| 检查点 | 已确认方向与实际结果 | 生产保留项 / 差异 |
|---|---|---|
| 底色和语义色 | 白工作区、中性浅灰侧栏、深灰正文、深绿主操作；无新增渐变 | 错误、待补材料、原失败证据沿原语义色及文字显示 |
| 导航和控件 | 184px 桌面侧栏、56px 页眉、浅绿选中加左侧标记、细边控件 | 沿用真实 logo、SVG 图标、52px 助手入口和原账号名称；预览的示意图标未替换品牌资产 |
| 排版和密度 | 30px 通常内容留白、约84px通常项目行、减少英文装饰眉题和外层卡片 | 采用刚完成 UX 统一的28/18/14px层级；预览27px标题按现有28px体系落地。完整长名称及操作换行可增加行高 |
| 项目表 | 搜索、归档和刷新同一工具栏；状态筛选下划线；同步回执保留在表后 | 保留原来“查看任务/进度、查看结果、更多”等全部操作和真实任务计数。没有照搬预览的单操作和独立草稿筛选 |
| 文档交付 | 文件名、保存版本、下载按钮成行；普通报告提示待人工审阅；所选旧版下载仍精确对应旧版字节 | 文件名直接读取 API；未从当前项目材料推断历史依据。正文读取失败、异常报告说明和历史/当前任务关系仍显示 |
| 复核内容 | 中性内容面、较轻的三维度入口和可展开的依据内容 | 保留真实维度状态、条目数、说明、全文搜索和处理入口；没有用预览的固定示例问题替换真实报告 |
| 响应式和助手 | 1366×768、1024×900、390×768截图；1024/1366助手开合相关回归通过 | 1024保持表格，剩余工作区小于600px时逐行重排。移动菜单和全屏助手沿原960px边界，不引入示例横向手机导航 |
| 文案对照 | 去掉装饰英文、收敛重复项目标题；新增“待人工审阅”与文件行保存版本说明 | 保留真实业务说明、费用、恢复/失败信息和所有原操作文案。表格内容量与示例不同，不声称全页逐像素相同 |

已使用图像查看工具在同一轮对照已确认预览和最新真实截图，重点检查配色、导航、字号、间距、容器、文件行、操作及小窗口。修正了1024过早堆叠、文档下载过早换行和文件生成残留英文眉题。上表差异是按“应用风格、保留真实业务”的范围适配，确认依据为用户本次要求及既有产品约定。

## 验证结果

| 项目 | 结果 |
|---|---|
| 页面身份、非空内容、框架错误层 | 6个真实页面和5个运行原型检查通过 |
| 页面脚本错误、水平溢出 | 6页 × 1366/1024/390尺寸检查通过；无 pageerror 和水平溢出 |
| 同尺寸对照 | 18张实际页面、10张运行原型、2张已确认预览，共30张；清单见 `capture-manifest.json` |
| 构建 | `npm run build`通过；最终源码的 `npm run build -w @bondbuddy/web`再次通过；保留既有大chunk提示 |
| 公共契约 | `npm run check:contracts`通过：32+29+11=72项，179个合成示例、12个内部示例和4个生命周期示例 |
| 前端完整单元回归 | `npm run test:unit -w @bondbuddy/web`：**971通过**，含构建资源清单检查 |
| 最终相关浏览器回归 | **209通过、1跳过**。下方命令一次完整运行；跳过的是旧可选原型截图用例 |
| 专项截图/布局巡检 | 7项通过，覆盖18个实际页面尺寸、10个原型尺寸及已确认预览。截图采集脚本为本次临时工具，已移除 |

主要交互覆盖：项目搜索/状态筛选/刷新及重载、任务展开和归档菜单；查看历史V1→下载并逐字节核对V1→切换成果；异常/丢失成果不能借用另一版本；修订处理保存和回执恢复；材料保存与原生禁用/吸底开始按钮；问答历史及固定依据；助手开合、附件、确认卡；生成选稿与更换；账号导航和当前诚信核查范围选择。

```sh
BB_E2E_BASE_URL=http://127.0.0.1:5182 npm test -w @bondbuddy/web -- \
  tests/all-projects.spec.ts tests/project-entry-layout.spec.ts \
  tests/review-flow-reader.spec.ts tests/review-result-continuity.spec.ts \
  tests/review-editor.spec.ts tests/review-editor-recovery.spec.ts \
  tests/project-qa-continuation.spec.ts tests/project-qa-materials.spec.ts \
  tests/project-qa-recovery.spec.ts tests/authoring-next-layout.spec.ts \
  tests/project-file-status.spec.ts tests/prospectus-panel.spec.ts \
  tests/project-assistant.spec.ts tests/file-generation-flow.spec.ts \
  tests/desktop-ux-polish.spec.ts tests/billing-navigation.spec.ts \
  tests/integrity-retired-sites.spec.ts \
  --grep-invert 'desktop, focus and narrow|folder, document type|prepared questions are previewed|a delayed active-run poll'
```

## 既有失败与边界

- GitHub 首轮 desktop-ux 的前端单元检查为970通过、1失败：M1 Docker构建白名单遗漏此前的 `desktop-workspace-polish.css`，本次 `document-workspace.css` 也需纳入。现已同时补齐 `deploy/m1/Dockerfile` 的 COPY 和专用 dockerignore；原构建资源检查2/2、完整前端单元971/971通过。UI源码和截图不因此改变；GitHub最终执行结果以PR检查记录为准。

- 本次扩大检查发现 `integrity-browser.spec.ts` 的11项旧结果/准备流程用例失败；对未修改的 `a8936895` 前端（5183）完整重跑同一文件，11项全部复现。场景未进入断言预期的准备或结果状态；本次未据此修改业务代码或旧断言，也不将它们算作通过。
- 最终命令沿用 #882 已登记的4项排除：助手窗口切换的瞬时 boundingBox、旧文件检查文案、旧问答准备文案、延迟轮询/上传 DOM 标记。这4项本轮未重新基线复测，仍按既有记录单列。
- 初轮本次引入的编辑器问题是文件行重复显示页面处理摘要。已改为只引用所选保存版本，原断言不变；最终完整回归通过。
- 不宣称全仓库前端套件全绿；上述旧失败与最终通过集合分别记录。

## 最终统一验收待办

线上部署、真实账号/后端/模型交付、真实 Word/WPS内容与专业验收继续独立跟踪。本次只完成前端风格实现和上述合成验证，不关闭 #361 的其他范围；商用官网、登录流程和独立管理后台未重设计。合入 develop 不等于生产已发布。
