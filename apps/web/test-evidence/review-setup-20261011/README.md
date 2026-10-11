# 复核创建页与范围说明验收

源码及设计快照 commit：`91361603`。初始基线：`e2cba46b`；提交前集成最新 `develop ad29bd53`，保留 #663 材料页简化和右对齐按钮布局。用户 2026-10-11 的截图反馈为本次交互修改依据，详见 `docs/product-decisions/2026-10-11-review-setup-scope.md`。所有数据、接口响应及发行人均为 synthetic，没有进行真实工商查询、模型调用、扣费或生产提交。

## 同尺寸设计对照

原型为本次实现生成的可交互设计快照 `product-prototype/public/review-setup.html`，不是旧版界面，也不代表独立业务引擎。对照使用 Edge，桌面 1440×1040、手机 390×844，fullPage 截图。

| 状态 | 实现 | 设计快照 |
|---|---|---|
| 桌面默认收起 | [实现](implementation-collapsed-1440.png) | [预览](prototype-collapsed-1440.png) |
| 桌面展开合规、公开信息 | [实现](implementation-expanded-1440.png) | [预览](prototype-expanded-1440.png) |
| 手机默认收起 | [实现](implementation-collapsed-390.png) | [预览](prototype-collapsed-390.png) |
| 手机展开详情 | [实现](implementation-expanded-390.png) | [预览](prototype-expanded-390.png) |

核对：必填说明位置、自动名称、市场/品种、三条范围摘要、公开核验限制、详情双栏/手机单栏、提交按钮均一致，无横向溢出或内容遮挡。预览的提交按钮仅说明下一步，不创建业务项目；外围导航仅作布局展示。当前页面内容及布局无未确认的设计偏离。

## 检查结果

- TypeScript：contracts、domain、rule-pack-registry、rule-applicability-context、api、worker、web 构建通过；Vite 生产构建通过。保留现有较大 bundle 提示。
- 契约：171 个公开合成样例、12 个内部库样例及生命周期 4 个样例通过；OCR/发行人绑定 40 个测试通过。
- `form-model.test.js`：6/6，包含复核后缀、空白名称、有效品种、Unicode 截断、原更新命名兼容。
- 最终定向浏览器：8/8。覆盖更新及复核自动命名、创建保存与恢复、空白发行人校验、市场切换、PPN/DFI/交易所规范、原生键盘展开、未联网说明、报告期及既有项目字段保留、桌面/手机布局。
- `review-setup-prototype.spec.ts`：1/1，覆盖两种尺寸及两种展开状态，名称与规则交互、无真实提交、无页面脚本错误。

广泛回归 `review-workspace.spec.ts` + `prototype-workflow.spec.ts` 共 66 项：59 通过、4 个既有手动截图用例跳过、3 失败。随后在独立、未修改的 `e2cba46b` 工作区复验：材料生成入口的旧“尚未开放”断言和工作台 `.review-project-card` 旧选择器同样失败，属于原有用例落后于当前界面，本次未改写它们。第三项更新创建加载用例在全量运行中因宽泛的 status 选择器与自动命名 output 产生短暂多匹配；基线及最终定向重跑均通过。本次不声称全量回归已全绿。

执行方式：本机使用 `node node_modules/typescript/bin/tsc`、`node node_modules/vite/bin/vite.js build apps/web`；浏览器在 apps/web 运行 `node ../../node_modules/@playwright/test/cli.js test`，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5198`、`BB_E2E_BROWSER_CHANNEL=msedge`。复核截图生成额外设置 `BB_REVIEW_SETUP_EVIDENCE=test-evidence/review-setup-20261011`。

公开在线核验仍未接入默认文件复核：这一点由执行路径核查得出，界面已明示。本次验收不包含外部工商/信用供应商联调或真实项目专业结论。

提交前集成复验：在 develop ad29bd53 上解决材料页布局冲突，仅保留创建页与完整复核提议的范围详情；contracts/API/web 类型构建及 Vite 通过，相关创建、材料上传、讨论草稿与收费明确执行浏览器测试 18/18 通过。
