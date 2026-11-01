# 历史募集书拖拽上传，2026-11-01

用户要求历史／参考募集书支持拖拽，并与下方审计报告上传体验一致。基于 `a958d622`；原型 `product-prototype/public/prospectus-reference.html` 与实现 `apps/web/src/prospectus-panel.ts`、`prospectus-reference.css`、`prototype-adapter.css` 在本 PR 同一提交中更新。跨子元素拖拽保持高亮，离开或放下后恢复；审计报告共用样式并保持自己的上传角色。

截图来自本地真实前端与 ApiClient，API 回执和文件字节为 synthetic；不连接生产数据库或 Blob，不调用模型，不执行任务或扣费。这些截图不代表真实后端链路或用户验收完成。完整工作区截图中材料处理／补充说明的不可用提示来自未模拟的外围接口。

| 状态 | 实现 | 原型 |
| --- | --- | --- |
| 桌面空状态 | [1440px](implementation-empty-1440.png) | [1440px](prototype-empty-1440.png) |
| 手机空状态 | [390px](implementation-empty-390.png) | [390px](prototype-empty-390.png) |
| 窄屏空状态 | [320px](implementation-empty-320.png) | [320px](prototype-empty-320.png) |
| 桌面已保存 | [1440px](implementation-saved-1440.png) | [1440px](prototype-saved-1440.png) |
| 手机已保存 | [390px](implementation-saved-390.png) | [390px](prototype-saved-390.png) |
| 窄屏已保存 | [320px](implementation-saved-320.png) | [320px](prototype-saved-320.png) |

空状态三组原型／实现 PNG 字节完全一致。已保存状态的文件日期格式和服务端提示沿用实际组件，原型仅使用合成摘要；上传区一致。另见 [拖入高亮](implementation-dragging.png)、[完整桌面工作区](workspace-1440.png)、[手机工作区](workspace-390.png)、[320px 工作区](workspace-320.png)。所有宽度均检查无横向溢出，已保存和多文件条目保持可操作。

验证结果：

- `playwright test tests/prospectus-panel.spec.ts tests/upload.spec.ts`：44/44 通过，包含 4 项新增回归；覆盖实际组件与 API client 的拖拽、键盘选择、无效／空／多文件拦截、上传中重复操作、保存／采用、失败重试、会话恢复、文件角色隔离与样式一致。
- TypeScript 按仓库构建顺序编译 contracts、domain、rule-pack-registry、rule-applicability-context、api、worker；web `tsc --noEmit` 通过。首次单独编译 web 缺少工作区构建产物，补齐后通过。
- Vite 生产构建通过；已有大 bundle 提示仍在。
- contracts 检查：72 个测试、171 个公开样例、12 个内部样例、4 个数据生命周期样例全部通过。
- `git diff --check` 通过。

本机复现（工作目录 `apps/web`，已有依赖并完成工作区构建后）：

```powershell
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5193
# 另一终端：
$env:BB_E2E_BASE_URL='http://127.0.0.1:5193'
$env:BB_REFERENCE_DROP_EVIDENCE=Join-Path (Get-Location) 'test-evidence/reference-upload-drop-20261101'
$env:BB_REFERENCE_EVIDENCE=$env:BB_REFERENCE_DROP_EVIDENCE
node ../../node_modules/@playwright/test/cli.js test tests/prospectus-panel.spec.ts tests/upload.spec.ts
```

本次无 API、worker、数据库迁移、依赖或计费规则改动。上传成功自动采用沿用基线已有行为。开发和自测完成，代码尚未部署，待统一集成验收与发布。
