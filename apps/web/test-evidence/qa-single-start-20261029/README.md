# 项目问答：同页核对、一次开始

用户 2026-10-29 提供实际界面截图，要求合并识别与回答准备，去掉问答知识库和参考方式选择。本次用户要求为交互调整依据；基线 `5ec099a27d6e754cf9b7b8c75d0f3616746918a1`。

## 行为与交接

- 免费识别成功直接显示问题、材料、回答要求和费用；调整范围、移除问题及补充材料仍可用。点击一次「开始回答 · N 积分」连续保存和提交，去掉中间采用页及费用弹窗。
- 新一轮继续默认仅使用项目材料。移除知识库展示、浏览/录入/审核 UI 和参考方式选择，后台接口及权限保持原状。保留已有保存的开关与待恢复原请求；旧缓存中要求选择知识库的标志不再阻断可编辑准备。
- 页面载入、识别完成、刷新与查看历史均不会自动开始回答。另一份历史清单需明确采用，避免覆盖当前编辑。保留每题 60 积分、必需募集说明书、材料版本、CAS 与原请求幂等恢复；保存回执不确定时停止后续提交。
- 只涉及 web、原型与文档；无契约、数据库迁移、worker 或依赖变更。集成时从本 PR 固定提交构建 web。

状态：开发和自测完成；代码尚未部署，待统一集成与用户验收。未启动真实 API、worker 或模型；本地 Vite 仅用于合成接口浏览器测试，不作为可验收的完整集成环境。

## 同尺寸截图

两侧使用相同合成项目和材料。旧版截图通过基线源文件在同一壳内运行；新旧准备页均移除最后一题、输入相同回答要求并刷新。截图尺寸为 1440 × 960 或 390 × 960，整页截取高度随内容变化。320 px 额外检查窄屏。

| 状态 | 桌面 | 手机 |
|---|---|---|
| 修改前：问题识别确认 | [1440](before-recognition-1440.png) | [390](before-recognition-390.png) |
| 修改前：再次准备、选择参考方式 | [1440](before-preparation-1440.png) | [390](before-preparation-390.png) |
| 修改后：同页核对、一次开始 | [1440](single-start-1440.png) | [390](single-start-390.png) |

[320 px 窄屏](single-start-320.png)。已检查桌面及手机全页，无横向溢出，操作按钮均可见；保留原有字体和颜色。原型 `product-prototype/public/qa-materials.html` 同步更新。相对于旧界面的流程偏离均为本次用户明确要求，无新增业务功能。

## 验证

- TypeScript web 全量类型检查、Vite 生产构建通过。Vite 保留既有包体积提示，不影响构建。
- 56 项问答范围、缓存、独立恢复日志与上传恢复单元测试通过。
- 浏览器回归分批验证：合并页面（1440/390/320）、一次点击与重复点击、免费识别完成及刷新、零候选题手动合并、旧缓存兼容、历史清单保护、保存和回答回执丢失、跨标签页幂等、材料不可用和数量限制、上传恢复、历史任务跳转、费用拒绝以及 Word 下载定位。
- 旧测试中二次确认和知识库选择断言按新交互更新；已有材料测试补齐必需募集说明书 fixture，恢复区定位排除独立的活动任务区域。跨标签页核验等待明确回执导航，避免把中间渲染当作恢复完成。
- 使用真实页面代码、Edge 与公共 schema 合成 HTTP fixture。未验证本次真实模型效果、生产任务、账务结算或完整后端链路。

主要用例：`project-qa-single-start.spec.ts`、`project-qa-materials.spec.ts`、`project-qa-continuation.spec.ts`、`project-qa-recovery.spec.ts`、`qa-reference-materials.spec.ts`、`qa-result-next.spec.ts`、`project-qa-document-ux.spec.ts`、`project-qa-task-routing.spec.ts`、`contextual-errors.spec.ts`、`qa-upload-11th.spec.ts`。

截图复现使用 `BB_UX_EVIDENCE_DIR`，旧版对照另设置 `BB_QA_SINGLE_START_BASELINE=1` 并从上述固定基线临时导出 `apps/web/src/project-qa-workspace.ts/.css` 为 `qa-single-start-baseline.ts/.css`，运行 `qa-single-start-baseline.spec.ts`。导出文件不提交、不进入发布。浏览器测试可使用独立本地 Vite 地址设置 `BB_E2E_BASE_URL`；本次使用 Edge channel。
