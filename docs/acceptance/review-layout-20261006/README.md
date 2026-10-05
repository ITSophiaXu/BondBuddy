# 复核原型恢复与页面比例修复 · 2026-10-06

用户澄清：复核保留独立的 product-prototype 设计，仅材料分类、上传与末尾选填要求参考更新体验；切换入口整体比例保持一致。

## 设计基准与允许差异

基线 develop `67b76c264570d526019481f13064c240d22decfd`。复核结构依据 `product-prototype/public/review-v2.html` 的项目标题／状态／项目摘要、材料与要求／复核结果标签，以及三维结果层级。当前可交互原型是 `product-prototype/public/workspace-ux.html`，源码与实现随本 PR 一起提交；准确 commit 登记于 #361。

用户当前要求及此前已确认要求授权下列调整：全站共用侧栏、顶栏、主区和标题尺度；简洁复核表单不复制更新发行安排长表单／创建步骤条；分类直接上传；材料末尾选填要求；取消常驻助手；真实进度、全部项目导航来源、三维可读结果及报告后一键更新保留。旧项目已存资料不因简化表单丢失。未改变执行、收费、文件交付或公共契约。

## 同尺寸对照（全部为 synthetic）

| 页面 | 桌面实现 / 原型（1360×900） | 窄屏实现 / 原型（390×844） |
| --- | --- | --- |
| 创建 | [实现](implementation-create-1360.png) / [原型](prototype-create-1360.png) | [实现](implementation-create-390.png) / [原型](prototype-create-390.png) |
| 材料 | [实现](implementation-materials-1360.png) / [原型](prototype-materials-1360.png) | [实现](implementation-materials-390.png) / [原型](prototype-materials-390.png) |
| 结果 | [实现](implementation-results-1360.png) / [原型](prototype-results-1360.png) | [实现](implementation-results-390.png) / [原型](prototype-results-390.png) |
| 运行 | [实现](implementation-progress-1360.png) / [原型](prototype-progress-1360.png) | [实现](implementation-progress-390.png) / [原型](prototype-progress-390.png) |
| 结果更新 | [实现](implementation-updating-1360.png) / [原型](prototype-updating-1360.png) | [实现](implementation-updating-390.png) / [原型](prototype-updating-390.png) |

原型 scenes/CSS 是共享渲染镜像，截图相同只证明设计同步，不能作为独立实现正确性的证据。另以真实页面路由切换测量更新／复核两入口：

| 同一视口 | 更新入口 | 复核入口 | 计算样式和几何测量 |
| --- | --- | --- | --- |
| 1360×900 | [更新](update-entry-1360.png) | [复核](review-entry-1360.png) | [数据](scale-1360.json) |
| 820×900 | [更新](update-entry-820.png) | [复核](review-entry-820.png) | [数据](scale-820.json) |
| 390×844 | [更新](update-entry-390.png) | [复核](review-entry-390.png) | [数据](scale-390.json) |

外壳宽度、字体、边距与主标题字号相同，正文按各自任务设计排版。桌面侧栏236px、顶栏82px、标题31px；手机共用折叠菜单，标题25px，无横向溢出。人工查看窄屏截图发现报告期选项与年份重叠，已改成窄屏上下两行并重新截图核对。

## 验证与边界

- `tsc -p apps/api/tsconfig.json`、web TypeScript、`vite build` 通过；Vite 现有大于500kB分包提示保留。
- `playwright test review-workspace.spec.ts --grep-invert 'synthetic workspace design scenes|workspace prototype parity'`：27/27。覆盖分区上传与重试、保存、季度输入、旧隐藏字段保留、运行进度、三维报告、下载、结果更新和桌面／平板／手机导航。最初发现 edit 请求带多余 kind，已修正后完整27项通过；移动菜单测试定位歧义已定向修正。
- 最终手机样式修正后，设计场景／同尺寸原型对照／入口尺寸回归：3/3。
- 公共契约：166个合成示例＋12个内部库示例、4个数据生命周期示例，OCR／发行人绑定40/40通过。
- 浏览器HTTP夹具、合成材料、原型数据均为 synthetic；不代表真实模型、真实 Word 内容或用户业务验收。
- 本文不证明已部署。实际发布版本、原账号页面核对与回滚记录另记于 #361／#448。客户材料、报告正文和原账号截图不提交到 GitHub。
