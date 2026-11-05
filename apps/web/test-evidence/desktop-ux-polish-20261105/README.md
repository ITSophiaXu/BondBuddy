# 桌面 UX 七项修复与对照（2026-11-05）

用户在本次审查清单后明确要求七项全部实施，限定桌面 Web 设计优化、不改业务逻辑。对应决定：[桌面工作区体验收敛](../../../../docs/product-decisions/2026-11-05-desktop-ux-polish.md)。关联 #361，不关闭该总单其他范围。

## 版本、环境与原型

- 原设计与检查基线：develop `3bb7baf12dba1c75465e9c5dd71ef7b073c176a9`。
- 实现与原型源码：`b5aec3ac8db7a8b7984844e362f24bd3dd914f61`。本证据提交只增加截图和记录。
- 原型：`product-prototype/public/desktop-workspace-polish.html?view=tasks|materials|results|files|qa`，与实现共用 `desktop-workspace-polish.css`。
- 实现：`apps/web/src/main.ts`、`project-qa-workspace.ts`、`review-workspace.ts`、`prospectus-panel.ts`。其余模块消费同一桌面样式。
- 本地 macOS / Node 24.14.0 / 仓库 Playwright Chromium。Browser 插件未提供，采用已有 Playwright。实现 `http://127.0.0.1:5174`；原型由仓库根目录只读 HTTP 服务提供。
- 主对照尺寸 1366×768；检查亦覆盖 1440×960、1920×1080，以及 1024/1366 下展开助手后的剩余空间。
- **全部数据、材料与 API 响应为 synthetic**。下载检查使用可核对的合成 DOCX 字节。没有真实模型、付费、生产存储或客户材料测试。

## 七项结果

| 项目 | 最终行为 / 证据 |
|---|---|
| 长标题 | 完整名称与右侧动作分开；删除按钮不收缩、不换行，完整标题保留 title；见 `materials-before/after.png`。 |
| 成果首屏 | 查看旧复核 V1 时下载仍为 V1 的字节；进行中第3轮另列入口。复核按钮约 y=900→566；问答约 y=852→470（保留历史依据警告）；见 `review-*`、`qa-*`。 |
| 列表密度 | 列表首行约 y=521→418，通常行高129.5→87.5px；保留搜索、筛选、同步状态、任务展开、归档和结果入口；见 `tasks-*`。 |
| 组件一致性 | 桌面28px页标题、13px控件、40px主控件；文件生成“更换”从28px宽恢复到64×40px；沿用绿色品牌和原SVG图标。 |
| 当前文件卡 | 只突出一个当前稿条目，已确认的重复名称转为辅助访问文本；上传、原文件下载、版本历史仍可用；未确认状态与警告不隐藏；见 `files-*`。 |
| 吸底操作 | 沿用原有 footer、按钮和 fieldset，保持禁用及执行条件；准备材料和阅读问题时动作保持可达，不复制执行入口；原生焦点和长页定位已复验。 |
| 历史/当前任务 | 结果页保留明确的V1引用和另一个进行中任务的入口，完整进度移至结果后；DOM阅读顺序同步调整。历史选择、刷新和下载不改变输入/版本。 |

## 同尺寸逐屏对照与偏离登记

每组有 `*-before.png`（原 develop）、`*-prototype.png`（设计原型）、`*-after.png`（真实页面），尺寸在 `manifest.json` 中登记；`before-after.png` 汇总列表和复核结果。

已逐屏使用图像查看核对以下六点：

1. **信息层级**：所选结果与下载优先，独立的进行中任务保持明确的入口和标识。
2. **文字与字段**：名称、版本、警告、价格说明和所有原动作保留；新增加的两条上下文说明只投影原返回字段，不增加判断或执行权限。
3. **字体与控件**：标题、按钮、行距、字号、内边距和单行标签与共享规则一致。
4. **布局与密度**：长标题/动作分离，列表压缩，文件信息减少重复，表格继续为表格。
5. **配色与图标**：保留既有品牌、白色内容面和SVG；没有引入图片、营销组件、新导航或渐变。
6. **操作与焦点**：原按钮吸底、焦点不被遮挡、选中历史文件下载准确，助手展开后无横向溢出。

相对旧原型的布局偏离为上表七项，确认人为本次用户。新原型使用独立合成示例，项目名、记录数量、内容长度及旧任务缺少依据的警告分支可能与实现夹具不同；这些内容差异明确保留，不声称全页面逐像素相同。实现中的完整复核正文、原费用说明、上传恢复及辅助文件仍按真实状态呈现，不以精简原型省略它们。

新增首屏文案为“项目另有进行中的任务…不影响查看此成果”和已知/未知的“本轮依据”说明，均属于本次第2/7项层级修复；未改变任务状态、业务结果或专业确认口径。

## 验证

- `npm run build`：通过；最终 CSS/文案完成后 `npm run build -w @bondbuddy/web` 再次通过。保留既有大 chunk 提示，没有为了此设计切片改打包或业务模块。
- `npm run check:contracts`：32 + 29 + 11 = **72项通过**；179个合成示例、12个内部示例、4个生命周期示例及恢复/用量不变量通过。
- 新增 `desktop-ux-polish.spec.ts`：**8项通过**，覆盖标题、吸底/原生禁用、准确历史下载、历史切换、上传和版本入口、助手下的布局。
- 相关最终浏览器回归：**187通过、1跳过**。该集合包含上述8项；不可相加冒充195项。可选的旧截图采集用例跳过，不计通过。
- 独立页面巡检：20项通过（53个状态/尺寸记录，无错误浮层/页面脚本异常/横向溢出），额外5页原型采集通过；冻结源码后的重点25个状态/尺寸再次采集通过。
- 检查没有改变契约、API、worker、数据库、价格、权限、输入选择、幂等与下载授权。现有相关回归涵盖了这些前端交互边界。

最终回归命令（先按仓库说明构建，再启动5174开发服务）：

```sh
BB_E2E_BASE_URL=http://127.0.0.1:5174 npm test -w @bondbuddy/web -- \
  tests/all-projects.spec.ts tests/project-entry-layout.spec.ts \
  tests/review-flow-reader.spec.ts tests/review-result-continuity.spec.ts \
  tests/project-qa-continuation.spec.ts tests/project-qa-materials.spec.ts \
  tests/project-qa-recovery.spec.ts tests/authoring-next-layout.spec.ts \
  tests/project-file-status.spec.ts tests/prospectus-panel.spec.ts \
  tests/project-assistant.spec.ts tests/file-generation-flow.spec.ts \
  tests/desktop-ux-polish.spec.ts \
  --grep-invert 'desktop, focus and narrow|folder, document type|prepared questions are previewed|a delayed active-run poll'
```

### 原 develop 已复现的四项失败

以下四项在未经修改的 `3bb7baf1` 上单独对照运行仍失败，最终定向集合显式排除；没有修改断言来获得绿色，也不将整个前端套件称为通过：

- `project-assistant.spec.ts:146`：窗口切换过程中可见性断言后的 boundingBox 为 null；本切片新增的1024/1366助手布局回归通过。
- `project-file-status.spec.ts:59`：旧断言寻找“免费检查全部当前关联文件”，当前界面没有该文案。
- `project-qa-materials.spec.ts:40`：旧断言寻找“尚未开始回答”，当前准备页为“尚未提交”等文案。
- `project-qa-recovery.spec.ts:204`：延迟轮询/补充上传用例的 DOM 标记未保留。该恢复行为不在本次只改设计的范围内。

首次扩大回归发现本次通用焦点留白影响复核/续轮定位，已将其限定到带吸底操作的页面并分别复验通过。组件独立动态 import 用例曾在热更新服务下失败；重启相同源码开发服务后并发删除恢复通过，最终固定服务回归也通过。此观察不作为生产缺陷或已证实的根因。

## 最终统一验收待办

客户桌面浏览器试用和主观体验确认、真实账号/后端/模型交付、线上部署与真实 Word/WPS 内容质量继续独立跟踪。本记录只证明此桌面展示切片及所列自动化范围；未发布到生产，不关闭 #361 的其他任务。
