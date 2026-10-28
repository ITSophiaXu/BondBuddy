# 项目列表进入本批底稿进度

用户反馈：项目列表的“查看进度”进入单份底稿任务，无法直接查看所属批次的完成情况和文件清单。本次按用户要求修复入口，复用现有批量底稿页面。

## 版本与范围

- 实现及测试代码：`8a7bedbbff1ca547912c0c19b365a436dc0f265b`。
- 原型基线：`859e7adac43b1e44fe2543e4ed18b24d0097dfed` 的 `product-prototype/public/workpaper-batch.html`、`workpaper-batch.css`。
- 实现：`apps/web/src/project-collection-model.ts`、`workpaper-panel.ts`、`workpaper-panel.css`。
- 公共契约增加可选 `ProjectTask.workpaper_batch = {batch_id, project_id}`；项目列表摘要和项目任务列表使用同一 SQL 投影。`project_id` 是批次所属项目，任务原有的执行项目和 run 身份保留。
- 使用不可变的 `bb_workpaper_attempts` 关联批次，重试后的旧任务仍可打开原批次；关联同时限制账号、主题、执行项目和源项目范围。
- 链接进入 `#generate?from=projects&project=…&step=workpapers&view=results&batch=…`，定位并展开对应批次。超出最近 10 批的记录通过已有的精确批次接口读取，轮询时继续保留；指定批次不可访问时显示读取失败。
- 原有 `workpaper_batch` 参数仍仅用于重新编制受影响文件。普通单文件任务及检查任务保持原路由。
- 无新增依赖、数据库迁移或 worker 行为变化。后续集成发布需要包含 contracts、API 和 web。

## 验证

环境：Windows、Node 24.22.1、Edge、独立 PostgreSQL 16 容器。本地数据库和浏览器数据均为 synthetic，不包含生产账号、客户资料或真实生成成果。

| 检查 | 结果 |
| --- | --- |
| 七个 workspace 的 TypeScript 构建；web 的 Vite build | 通过；保留现有的大 bundle 提示 |
| contracts 检查脚本对应的 4 个测试文件 | 49 通过，0 跳过 |
| contracts examples / data lifecycle 检查 | 171 个合成示例、12 个内部示例及 4 个 lifecycle 示例通过 |
| `node --test apps/api/dist/workpaper-task-routing.pg.test.js` | 2 通过，0 跳过；使用实际 SQL 和隔离数据库 |
| `node --test apps/web/dist-test/project-collection-model.test.js` | 11 通过 |
| Playwright：`workpaper-progress-routing.spec.ts`、`workpaper-task-routing.spec.ts`、`workpaper-batch.spec.ts` | 28 通过 |
| 最后补充手机端滚动留白后的 `workpaper-progress-routing.spec.ts` 和 Vite build | 7 通过，构建通过 |

本机没有 npm 命令，构建和 contracts 校验使用 Node 直接执行各 package script 对应的 tsc、Vite 和检查脚本。浏览器测试设置 `BB_E2E_BROWSER_CHANNEL=msedge`，`BB_E2E_BASE_URL` 指向本工作区独立 Vite 服务。第一轮碰到其他开发任务占用端口，已停止且不计入通过结果；正式结果来自系统分配的独立端口。

浏览器回归验证项目列表、项目文件最近任务、刷新、旧批次额外读取和轮询、手动收起状态、不可访问批次报错及无额外写请求。数据库验证旧 attempt 与当前 retry 的关联、摘要序列化、无重复任务和项目/账号隔离。页面下载按钮复用已有实现；本次未执行真实模型生成、生产下载或积分结算。

## 同尺寸截图与原型对照

截图都是合成数据，尺寸分别为 1440 × 960 和 390 × 960。原型只有单批次占位内容；实现展示两个批次，并定位用户点击的批次，内含已完成、处理中和排队中的文件。

| 尺寸 | 原型 | 实现 |
| --- | --- | --- |
| 桌面 | [prototype-1440.png](prototype-1440.png) | [implementation-1440.png](implementation-1440.png) |
| 手机 | [prototype-390.png](prototype-390.png) | [implementation-390.png](implementation-390.png) |

- 保留现有批次卡片、完成数量、依据、积分、操作区和逐份状态清单，没有增加页面或导航层级。
- 本次交互变化是项目列表直接定位所属批次、自动展开清单；来源为用户本次修复要求。手动收起后不因轮询再次展开。
- 手机端为固定顶部栏预留滚动距离，批次标题与状态不被遮挡。两种尺寸均无横向溢出，已逐张查看截图。
- 原型的占位提示与实现的逐份下载、ZIP 按钮差异来自原有功能及合成数据；本次没有新增下载、暂停或计费规则。

## 交付状态

开发和自测完成，代码完成，尚未部署，待统一发布。专用集成测试版尚未由集成 chat 汇总，本批尚未经过用户实际验收。此次本地合成测试不能代替生产核验。
