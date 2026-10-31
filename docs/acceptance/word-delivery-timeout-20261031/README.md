# Word 交付超时与错误提示修复

状态：开发和自测完成；尚未部署，待本地集成验收与统一发布。无数据库迁移、依赖或公共契约变化。

## 事故证据与确认边界

用户报告的任务在模型生成完成后，连续三次进入 `word_delivery`，分别约 307.137、306.978、307.011 秒后退出，最终为 `processor_failed / DATA_UNAVAILABLE`。四份输入材料均为 `persisted` 且 `error=null`，没有材料缺项错误；账务最终释放预留，净扣费为 0。`persisted` 不表示独立解析流程全部完成。

前端未处理 `processor_failed`，回退为“仍有待处理条件，请查看材料信息或联系支持”，导致用户找不到对应待处理项。这一提示错误已确认。

Word 重放中，`Editor.replace_paragraph` 每次构造非修订 `Patcher`，构造函数的绝对 XPath `//@w:id` 却扫描整个文档。该过程不生成修订编号，扫描结果从未使用。大型原稿和大量修改使工作量随“文档大小 × 修改次数”增长，并可超过 worker 的 300 秒子进程时限。这一性能缺陷已通过剖析复现。

未取得该生产任务原始操作日志和异常栈，因此不能声称已重放其准确修改，也不能排除其他交付故障。已核实的线上时间模式与复现缺陷高度吻合。本次没有修改生产材料、账务或任务，没有重新调用模型、恢复失败任务或部署。

## 修复

- 非修订重放跳过全文修订编号查询；真正生成修订时继续使用原有编号分配，避免与旧修订冲突。
- 每个文档部件仅计算一次待修改节点集合，避免逐节点重复构建集合。
- `processor_failed` 显示后台处理失败；最后已观察到的进度为 Word 交付时，明确显示 Word 生成或保存失败，并保留“保存文档”步骤。未知阶段、缺少历史或未知失败原因不会被解释为材料缺失。
- 原有 300 秒时限、输入校验、修订/清洁版生成、检查点与收费规则保持不变。

## 性能与格式验证

同一 Windows 机器、同一原稿、同一组 **3,000 处合成追加修改**，不调用模型。原稿约 29 万 XML 元素、10,127 段。原稿与用户失败任务参考稿的 SHA-256 匹配；文件和合成成果未提交仓库。

| cProfile 区间 | 修复前 | 修复后 |
|---|---:|---:|
| 重放 3,000 处修改 | 357.472 秒 | 6.873 秒 |
| 生成修订部件 | 11.981 秒 | 8.488 秒 |
| 两阶段合计 | 369.453 秒 | 15.361 秒 |

修复前 `Patcher.__init__` 累计约 350.384 秒。对修复后代码另行运行实际 `finalize(..., skip_report=True)`，完整生成双 Word 用时 **21.132 秒**：42 个未改动包部件逐字节一致；接受修订等于清洁版，拒绝修订恢复基线（双方按相同规则处理原有修订）。此时间不与上表剖析区间混作同一指标，也不是生产环境耗时承诺。

仓库回归测试使用纯合成的 8,000 段 × 10 个格式化 run 的 DOCX，对 600 段进行修改，通过真实 finalizer 子进程的 30 秒期限，并检查修订数量、清洁版、可撤回性和未修改部件。

## 验证结果

环境：Windows，项目固定锁文件；Node 与 Python 使用 Codex 本地运行时，浏览器为 headless Edge。所有工作区包指向本修复工作区构建，未使用旧工作区的应用产物。

- TypeScript：contracts、domain、rule-pack-registry、rule-applicability-context、API、worker、web 全部通过；Vite 构建通过，仅有既有的大 bundle 提示。
- Python：`test_fixed_edit*.py` 18 项通过（包含 4 份已授权原稿的格式回归）；file-authoring / word-delivery / unified-word / revision-cli 25 项通过；project-files / review-corrections 18 项通过。总计 **61 项**。
- Worker：file-authoring-format / file-authoring-delivery **9 项通过，0 跳过**。包括真实 Python finalizer、原稿绑定、存储失败后复用结果且模型仅调用一次。
- Contracts：**72 项测试通过**，171 个合成示例、12 个内部库示例、4 个生命周期示例及恢复/冲突/用量不变量验证通过。
- Browser：**7 项通过**。Word 失败、其他阶段、未来未知阶段、无事件历史、未知原因、供应商超时和恢复；刷新不重发任务，输入 hash 不变，不自动调用恢复操作。首次冷启动曾在 Vite 依赖预构建时导航超时，预构建完成后复验和最终完整定向运行均通过。

可复用的主要命令（运行时路径按环境配置）：

```text
PYTHONPATH=python PYTHONIOENCODING=utf-8 BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1 python -m unittest discover -s python/tests -p 'test_fixed_edit*.py' -v
PYTHONPATH=python PYTHONIOENCODING=utf-8 python -m unittest python.tests.test_file_authoring python.tests.test_word_delivery python.tests.test_unified_word python.tests.test_revision_cli python.tests.test_project_files python.tests.test_review_corrections -v
BONDBUDDY_TEST_PYTHON=<python> node --test apps/worker/dist/file-authoring-format.test.js apps/worker/dist/file-authoring-delivery.test.js
BB_E2E_BASE_URL=<local-vite> BB_E2E_BROWSER_CHANNEL=msedge playwright test tests/project-execution.spec.ts --grep 'processor failure|unknown processor reason|provider timeout|resumed source-input'
```

## 原型与实现对照

原型：`product-prototype/public/authoring-live-progress.html?state=word_failed`。
已迁移页面：`apps/web/src/project-execution.ts` 的募集书更新任务面板（关联 #361；业务 #31）。原型和实现为同一修复版本；确切源码 commit 记录于 PR。

| 视口 | 原型 | 实现 |
|---|---|---|
| 1440 × 960 | [prototype-desktop.png](prototype-desktop.png) | [implementation-desktop.png](implementation-desktop.png) |
| 390 × 844 | [prototype-mobile.png](prototype-mobile.png) | [implementation-mobile.png](implementation-mobile.png) |

已检查四张截图：失败文案一致，保存文档步骤一致，保留继续修改/查看材料，不提供失败任务的暂停/继续按钮，移动端无横向溢出。实现沿用现有应用外框、事件列表、提示边框与材料锁定说明；原型是已有独立进度面板，附合成状态切换按钮。此次没有重排生产页面或新增导航。对照由本开发任务完成，用户尚未进行本地集成验收。

## 发布及恢复交接

需要统一发布 worker 的 Python 代码与 web。发布前在固定本地集成版本中验收。该生产任务仍为失败状态；发布 chat 应在获得本批发布及恢复授权后，先读取真实操作日志与保存结果，再确定是否可以仅从 Word 交付检查点恢复，不能默认让用户重新上传或重新调用模型。当前证据不等于任务已恢复或成果已可下载。
