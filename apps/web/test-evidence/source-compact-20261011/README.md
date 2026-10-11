# 历史／参考募集书原稿信息：紧凑布局

关联 #361。用户于 2026-10-11 以材料页截图要求缩小选择框间距；本次用户为布局调整确认人。基线：`c70b91e9`；新原型与实现随本目录所在提交登记。

原型：`product-prototype/public/project-workspace.js`，原稿上传后信息区。实现：`apps/web/src/source-prospectus.ts`；共用 `product-prototype/public/source-prospectus.css`。受影响的已迁移页面为编制材料页及助手中的历史／参考原稿表单。

- 取消全局 label 上下外边距及通用 update-grid 对该组件的影响，字段间距为 12px、标签与控件为 6px。
- 宽容器中关系、市场、品种并排；中等容器为两列，品种占整行；窄容器为单列。依据容器实际宽度响应，适配右侧助手和手机。
- 年份与四个季度在宽容器内同行，统一 40px 控件高度；窄容器中季度换到下一行，仍保持四个选项并排。
- 说明和完成／缺项反馈收在底部，保留期间摘要、旧实际期间提醒、键盘焦点与单选语义。
- API、公共契约、必填校验、保存、报价和执行逻辑均未修改。

## 同尺寸对照

`before/` 和 `after/` 为现有 `uploaded source without an issuer name can start and preserves target identity` 浏览器用例的完整页面截图（1440×960、390×844），均使用同一 synthetic API 场景。桌面表单高度由约 590px 减少至约 280px。

`prototype-*.png` / `implementation-*.png` 为同尺寸组件对照，覆盖 1440、1024、768、390、320px 视口（容器 1004、620、450、294、250px）。`implementation-assistant.png` 为 360px 助手表单中的组件。测量见 `metrics.json`，全部无横向溢出。原型延续“2023年1—6月”简写，实现保留精确日期摘要，因此个别窄屏多换一行；该业务文案原有差异未改变，布局无未确认偏离。

复现组件截图：在当前工作区启动 Vite 后执行 `node apps/web/test-evidence/source-compact-20261011/capture.mjs`；默认 `http://127.0.0.1:5188`，可用 `BB_E2E_BASE_URL` 指定。脚本使用 Edge 和 synthetic 数据，未调用真实任务或扣费。

## 验证

- 全仓 build：7 个 workspace 的既有 TypeScript 构建及 Vite 生产构建通过。由于本机无 npm 命令，使用 Node 直接调用同一 tsc / vite CLI；仅有既存大 chunk 提示。
- check:contracts 对应全部检查通过：171 公共样例、12 内部库样例、4 数据生命周期样例及 40 项 OCR / 发行人绑定检查。
- 现有 Edge 浏览器测试 7/7 通过：缺项阻断、运行后只读、误传替换（当前会话／刷新）、源稿无发行人名称仍可保存并开始、助手任务卡与窄屏适配。
- `node --check product-prototype/public/project-workspace.js`、`git diff --check` 通过。

浏览器复现：设置 `BB_E2E_BASE_URL=http://127.0.0.1:5188`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts tests/project-execution.spec.ts tests/project-assistant.spec.ts -g "missing uploaded source|uploaded source without|replace mistaken historical|authoring materials stay read-only|editable task card|desktop, focus and narrow assistant"`。

以上证明前端布局和 synthetic 交互；上线状态独立记录，不以截图、构建或 PR 合并表示已经部署。
