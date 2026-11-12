# 底稿浏览器用例迁移记录

## 原失败证据

原 full gate 为 `1794418350450-38278111`，commit `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2`，tree `21417a07201cb9526317bf6f993b0c524f29dc64`，develop 基线 `8a7dc38a9546831346805d8cb36ce88aae456da3`。

`browser-2-case-inventory.json` 中本文件有下列 17 个 `unexpected`。原结果保留，不将迁移后的新结果回填为原 gate 通过，也不将 17 个测试失败计作 17 个已确认产品缺陷。

| 原用例 | 数量 | 原首个失败点 | 当前契约与保留的业务检查 |
| --- | ---: | --- | --- |
| saved directory stays compact... 1440/390/320 | 3 | `.wp-directory-current` 不存在 | 普通旧入口转统一准备；2/3 精确选择，目录更换入口、返回/刷新保留、只提交一次、无横向溢出 |
| first visit with no catalogue... | 1 | “添加底稿目录”标题不存在 | 无内置目录可用时上传入口仍可用，刷新保留，空范围不能报价/提交；其他统一准备用例覆盖默认光大目录加载 |
| automatic workpaper... 1440/390 | 2 | `#wp-start` 不存在 | 350 份服务端费率、单击、无金额确认、交付扣费说明、精确范围和进度 |
| confirmation submits selected 349 files... 1440/390 | 2 | `[data-wp-item]` 数量 0 | 20 行分页及搜索排除第350项；精确349 IDs、编制要求、源版本及revision、报价、说明免费、无旧assessment、结果刷新不重提 |
| uncertain direct submit survives reload... | 1 | 等待 `#wp-start` 超时 | 首次导航前存在真实历史 direct pending；原请求重放、丢响应后换源/刷新不改请求，不重复建批次 |
| legacy paused/running/succeeded preflight... | 3 | 等待 `#wp-requirements` 超时 | 首次导航前种入历史 assessing，普通入口迁往统一页；无新assessment/resume，保留精确范围。历史assessment不代表活动任务锁 |
| a previously confirmed legacy request... | 1 | 等待 `#wp-requirements` 超时 | 首次导航前存在真实历史 assessed pending；旧价、assessment/hash、request_id、目录、要求、源版本完全保持，不自动重提 |
| delivered explanations are visible... | 1 | 等待 `#wp-start` 超时 | 直接进入既有批次结果；暂停/续跑不建新批次，3份说明、0积分 |
| empty selection explains why submit... | 1 | 等待 `#wp-none` 超时 | 统一准备空选时禁用、解释原因、零quote/submit |
| result action failures remain visible... | 1 | 等待 `#wp-start` 超时 | 直接进入既有批次结果；操作失败仍显示错误，零新建批次 |
| automatic workpaper tariff starts... | 1 | `.wp-fee-summary` 不存在 | 统一准备服务端单价3458×3=10374；单击且只提交一次 |

## 迁移依据与范围

- `docs/acceptance/2026-10-30-workpaper-template-selection.md` 第9、12、14行：默认光大模板，20行分页，普通旧准备入口迁往统一页；历史pending、成果、受影响底稿重编保留。
- 同文档第27–30行对应 PR #850 与 `product-prototype/public/file-templates-v2.html`；`docs/FILE-TEMPLATE-IMPLEMENTATION.md` 指定相同原型。设计文档的“待评审”状态不作为额外用户验收证明。
- 13项使用当前 `/file-generation` preparation/quote/batches 契约；2项使用真实历史pending；2项直接使用已存在批次。未添加 blanket `legacy=1`、skip 或删除业务验收条件。
- 新的窄用途fixture固定已保存准备版本及报价快照，真实前端发送的计费wire仍由 `fixtureRequest` / `fixtureBody` 校验。范围与要求在准备快照中检查；不把旧 `WorkpaperStart.item_ids` 硬套到新父批次请求。
- 额外覆盖统一底稿提交丢响应后换源/刷新恢复，确保当前入口也保留原请求；已有历史恢复测试不替代当前入口的恢复检查。
- 旧 standalone `workpaper-batch.html` 原型用例保留其历史范围，不用它定义当前默认准备入口。受影响历史底稿重编和异步补款用例保留。

## 尚待验证的产品差异

静态核对发现统一准备页自动费率路径缺少原用例要求的逐份费率及“成功交付后扣费”说明；空选只有“本批0份”及禁用按钮，缺少可操作原因提示。迁移保留相应断言，使用软断言让其后的提交和幂等检查仍能执行；失败仍使测试不通过，不是expected failure或skip。

此变更只调整测试fixture及当前控件定位，不修改产品、价格、业务接口、模型、数据库或正在运行的候选版本。浏览器未复验前不得称为通过。合成HTTP不证明真实模型生成、扣费结算或最终用户验收。

## 首轮固定版本复验

- Commit `c6886df905c3360bbb0a477f3e7035a75f657d8b`，tree `c997569454b96ba365c243fdd5e46f4737c1cb26`，基于 `origin/develop` 的 `8a7dc38a`；该基线尚不含并行修复分支新增的7个结果恢复用例，集成时须保留两边。
- `playwright test tests/workpaper-batch.spec.ts --workers=1 --retries=0 --reporter=list,json`：22例，18通过、4失败、0跳过，用时5.8分钟。新增统一底稿换源/丢响应恢复通过。
- 3个失败为已实际到达的产品提示断言：自动费率1440/390缺少逐份费率和成功交付后扣费说明；空选缺少原因提示。软断言之后的精确350项、报价、单次提交、进度及空选零请求检查均已执行，没有其他失败。
- 另1项说明下载仍使用旧5.1秒假时钟；当前 `TaskPoller` 默认10秒，尚未到刷新时点。后续只将此fixture推进到完整轮询周期，保留3说明、0积分、零新批次断言；空选提示断言收窄至操作页脚，避免无关文字假阳性。
- 镜像 `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`，`--network none --cpus=1 --memory=3g`。contracts来自本候选源码定向编译；依赖缓存的lock内容按JSON语义相等。没有模型、数据库、宿主挂载或宿主端口。
- 原始 Git archive 按3423个Git blob逐一核对，运行前后均零差异；默认截图已进入Playwright输出目录。证据保存在本机 `BondDraftAI/work/workpaper-fixture-retest-20261112/results/`，包括浏览器JSON、日志、错误上下文及前后源码核验。容器已删除。
