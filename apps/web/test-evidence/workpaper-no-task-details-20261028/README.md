# 底稿进度清单移除“任务详情”

用户在 2026-10-28 截图指出，逐份底稿右侧的“任务详情”没有额外有用信息，要求取消。实现只删除该链接；文件名称、状态、错误提示、底稿和不适用说明下载、ZIP 以及批次操作沿用原实现。

- 实现 commit：`54f8ba710b62f30a8a65ae6fc2d0c76b885316e9`，文件 `apps/web/src/workpaper-panel.ts`。
- 原型基线：`6725d8f7` 的 `product-prototype/public/workpaper-batch.html`、`workpaper-batch.css`。原型本来就没有该链接，本次未修改原型。
- 对应已迁移页面：文件生成 → 批量生成底稿 → 底稿生成进度（#361）。本次交互调整由用户截图要求确认。
- 无 API、worker、契约、迁移或依赖变更。

## 验证

Windows、Node 24.22.1、Edge；在独立工作区启动 Vite，浏览器 API 使用现有合成 fixture。没有连接生产、提交真实生成任务、调用模型或变更积分。

- contracts、domain、rule-pack-registry、rule-applicability-context、API 的 TypeScript 构建通过，用于准备 web 类型检查依赖。
- web `tsc --noEmit -p apps/web/tsconfig.json` 通过。第一次检查时缺少本工作区 API 编译产物；补齐依赖后通过。
- web Vite production build 通过，保留已有的大 bundle 提示。
- 现有 `workpaper-progress-routing.spec.ts` 和 `workpaper-batch.spec.ts`：20 passed，0 skipped。覆盖已完成／处理中／排队中清单、项目入口、刷新和轮询、历史批次、不可访问批次、直接提交、请求恢复、暂停／继续和说明下载入口。
- `git diff --check` 通过。未新增测试；本次使用已有回归和截图检查。

## 同尺寸原型对照

截图均为合成数据，已逐张检查。桌面 1440 × 960，手机 390 × 960。

| 尺寸 | 原型 | 实现 |
| --- | --- | --- |
| 桌面 | [prototype-1440.png](prototype-1440.png) | [implementation-1440.png](implementation-1440.png) |
| 手机 | [prototype-390.png](prototype-390.png) | [implementation-390.png](implementation-390.png) |

实现中已完成、处理中和排队中的文件均不再显示“任务详情”；已完成项的“下载底稿”和批次 ZIP 仍显示，暂停及结束排队按钮保留。两种宽度无横向溢出。

原型使用单批次占位段落，实现使用真实页面组件及合成的两个批次、逐份清单和下载按钮。这些原有差异延续此前进度路由验收，本次只删除清单里的“任务详情”，没有新页面或替代入口。

开发和自测完成；代码完成，尚未部署，待统一发布。本次截图与浏览器回归不代表用户已验收本地集成版，未重新验证真实下载字节或后端生成链路。临时开发服务已停止。
