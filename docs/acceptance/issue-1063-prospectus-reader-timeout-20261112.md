# 财务验收回归执行预算与重复读取修复（#1063）

本次修复开发测试门禁的超时，不据此判断线上模型生成或专业财务验收已通过。代码完成后仍由主任务汇总集成、固定版本并执行完整 gate；没有合并、部署或用户验收。

## 原失败与测量边界

- 原 #1013 gate：commit `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2`，run `1794418350450-38278111`，`verify-prospectus-acceptance.test.mjs` 在 300,072 ms 超时，仅输出 TAP 头。
- 原 **749 文件 = 580 passed + 127 failed + 42 skipped 阻断** 的 failed 回执保持原样；没有改 exclusions。
- 测量基线：`8a7dc38a9546831346805d8cb36ce88aae456da3`，tree `f4ca4e5d7ab2bc4665b296c31473f111a4f5db0d`。12 个直接相关源码 blob 与原失败版本一致；不据此声称整个仓库树一致。
- 原字节归档 122 文件，SHA-256 `3a0207fcf5694e6f6753f0996d807de25d184855db93c26a5fcaddfc21139a8b`，逐 blob 校验且授权样本不改写。
- Linux 缓存镜像 ID `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`，Python 3.11.11，lxml 6.1.3、openpyxl 3.1.5、python-docx 1.2.0、pypdf 6.21.4。
- 独立 1 CPU / 3 GiB 容器，断网、无模型凭据/主机目录挂载/端口/数据库/UI。每项外部执行仍限 300 秒，超时回收整组进程。

## 根因和有界拆分

#1013 的 `scripts/pr-gate/run.mjs:347` 将 `--file-timeout-minutes` 默认设为 5；第 263 行对每个 `.test.mjs` 文件分别应用。它是通用测试文件预算，不能等同于单份财务检查的产品性能断言。生产 `inspectAcceptanceArtifacts` 的单次独立检查仍有原来的 `timeout:300000`，本次未改动。

原 JS 文件把 14 个直接测试和六个 Python 类串行包在一个文件内，`spawnSync` 缓冲 Python 输出，因而超时日志只剩 TAP 头。实测原六类：

| 类 | 原方法数 | 原字节 wall 时间 | 结果 |
| --- | ---: | ---: | --- |
| FinancialGeometry | 4 | 3.494 s | pass |
| FinancialLabels | 2 | 1.177 s | pass |
| NarrativeLists | 5 | 3.203 s | pass |
| AuthorizedTemplateLayout | 1 | 114.786 s | pass |
| FinancialSourceBindings | 11 | 4.436 s | pass |
| ExpandedAmountRegression | 12 | 300.561 s | timeout；第四方法未完成 |

外部 20 ms 栈采样定位到同一快照反复解析 XML、解析修订和样式、扫描可见文本。修复让 Reader 复用已通过全部 ZIP/XML 验证的树，并在本 Reader、本文件不可变快照内复用文本、标题和固定角色目标；外部可变编辑节点不进入缓存。每次 coverage 仍重新验证传入的已核对位置，不能用缓存掩盖漏项/重复。revision、TOC 和可见文本改为按目标标签迭代，保留原顺序和筛选规则。

性能优化后，单个 43 角色正例由 15.880 s 降至 9.857 s；完整 Expanded 类保留 12 个方法及全部变体，单独测量 268.950 s、0 fail/skip。但是第一次仍将六类捆在原文件的尝试继续在 300 秒超时，失败证据保留，不能记为原文件通过。

因此只把完整 Expanded 类的 Node 包装移动到 `verify-prospectus-expanded-amounts.test.mjs`，其余五类和 14 个直接测试留在原文件。两个入口分别受同样 300 秒通用预算约束；既不增加预算，也不减少覆盖。质量 gate 的显式列表与 `pipelineFingerprint()` 同步包含新入口，质量回归命令串行执行以避免两类在 1 CPU 下争用资源。自动发现的测试文件数因此增加 **1**，不能回写旧 749 文件回执。

## 覆盖一致性

见同目录 `issue-1063-coverage.json`。基线和修复版对比确认：

- 原 35 个 Python `test_` 方法的 AST 哈希逐个相同，扩展变体夹具文件和财务 policy 内容不变。
- 原 14 个直接 JS 测试前缀字节相同；两个入口的类调用/断言包装除类名单外相同。
- 两入口名单互斥且完整覆盖原六类，无遗漏或重复。
- 新增两个 FinancialGeometry 测试：Reader/文件快照隔离与外部编辑节点实时读取；未引用恶意 XML 拒绝及部分验证树不得泄露。总 Python 方法为 **37**。
- 固定 **43 个角色、21 个财务源键**及其金额、单位、期间、主体、历史值、重复/遗漏、不受支持叙述的全部正反断言不变。

## 最终定向验证

| 命令/范围 | 环境 | 结果 | wall 时间 |
| --- | --- | --- | ---: |
| `node --test --test-reporter=tap scripts/verify-prospectus-acceptance.test.mjs` | 上述 Linux 限额容器 | 19 pass，0 fail/cancelled/skip/todo；含其余五类共 25 个 Python 方法 | 57.069 s |
| `node --test --test-reporter=tap scripts/verify-prospectus-expanded-amounts.test.mjs` | 同容器串行 | 1 pass，0 fail/cancelled/skip/todo；完整 12 个 Python 方法及全部变体 | 211.315 s |
| `python -B -m unittest -v test_file_authoring test_fixed_edit test_source_outline test_format_plan test_word_delivery test_document_quality` | 同容器串行，`PYTHONPATH=/patched/python:/patched/python/tests` | 137 pass，0 fail/error/skip | 192.416 s |
| `node --test scripts/prospectus-quality-gate.test.mjs` | Windows，Node 24.22.1 | 31 pass，0 fail/cancelled/skip/todo | 0.391 s（Node 报告） |
| 拆分覆盖证据、`git diff --check`、改动 JS 语法检查 | 本地 | pass | — |

两个财务入口各自仍由 300 秒外部截止约束。不同轮次的耗时有波动，以上是最终运行的实际值，不保证其他负载或硬件下的固定耗时。最终运行前后原 `/candidate` 122 文件逐 blob 匹配，授权样本哈希不变。只读复核未发现缓存隔离、ZIP/XML 校验、revision/TOC 行为或入口遗漏的阻断项。

本地完整证据目录为 `work/prospectus-reader-measurement-20261112`：原字节 manifest、六类原始耗时与逐行记录、原采样/优化后采样、第一次整文件超时、修复后逐类测量、最终三个定向运行的完整 stdout/stderr 和覆盖核对脚本。客户原件和这些大日志未加入 PR。

定向回归只证明合成校验器与文档 helper 行为，不是完整 #1013 gate、真实模型调用、专业签认或用户验收。最终统一验收仍需在整合后的固定版本执行完整 gate，并按原任务范围完成后续业务验证。
