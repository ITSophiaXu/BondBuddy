# 诚信核查清单移除 5 项：本地验证

本目录为本地合成验证，不是生产核查。未访问核查官网、调用生产 API 或发生计费。

- `before.png`：`develop c7d0c42a58c467c999f9c565a7355aaef37079bf` 的共享清单及选择组件，54 项。
- `after.png`：本提交的共享清单及选择组件，49 项。基础征信保留破产重整、国家税务总局、重大税收违法失信查询 3 项，其他分类不变。
- 两张截图均为同一浏览器的 1265 × 720 视口，使用相同样式、相同合成验证容器。只比较真实选择组件，不把该容器当作正式页面原型。新增/移除范围由本次用户指令确认，布局和控件未调整。

## 验证结果

Windows / Node 22.14.0，独立工作区，锁文件依赖。全量 TypeScript 构建及 web Vite build 通过；Vite 仍提示既有大包体积。

- API 范围校验：`node --test apps/api/dist/integrity.test.js`，3/3 通过。
- Worker：`integrity-evidence.test.js`、`integrity-readiness.test.js`，8 通过、2 个可选浏览器探测按原条件跳过；未运行官网探测。
- Web 单元：`integrity-recovery.test.js`、`integrity-continuation.test.js`，53/53 通过，覆盖历史对象、原始范围及未确认请求恢复。
- Contracts：49 个测试、171 个公开合成样例、12 个内部 library 样例和 4 个 data-lifecycle 样例全部通过。
- 最终浏览器范围回归：18/18 通过，包括本机/服务器旧名单、49 项全选、历史采用、仅停用项的空范围、人员适用性提示、保存/收费确认、原请求幂等重试、拒绝后恢复及历史免费导出。命令如下（`BB_E2E_BASE_URL=http://127.0.0.1:5186`，从 `apps/web` 运行）：

```text
node ../../node_modules/@playwright/test/cli.js test tests/integrity-retired-sites.spec.ts tests/integrity-continuation.spec.ts --grep "saved selections|current all|historical selection|retired-only|adoption|adopted|cancelling the paid|a paid new|unknown draft GET|unknown paid check|definitive|free export requires" --max-failures=3 --reporter=line
```

扩展浏览器检查 `integrity-browser.spec.ts`、`integrity-delivery.spec.ts` 及当时的 4 个新用例共 22 项：20 通过，2 个旧 delivery 用例失败。失败均发生在查找 `#integrity-evidence-form`：这两个用例仍要求从历史记录新建人工补证，基线 `c7d0c42a` 的 `evidenceModal` 已不渲染该表单，只允许恢复既存旧表单；本改动未修改该方法。不能将此扩展套件称为全绿。另一次临时基线模块回放未成功加载页面，不计作通过证据。

既有截图查看、原图 hash 校验、历史导出记录及下载元数据检查均在通过的扩展用例中。原始查询记录与计费规则不变；#819 其余问题继续保留。无迁移，未部署；后续统一发布需要同时更新 web/API。
