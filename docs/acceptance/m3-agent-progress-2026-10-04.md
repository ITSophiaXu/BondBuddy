# M3 当前动作与助手进展验收（#547）

本次依据 [2026-10-04 产品决定](../product-decisions/2026-10-04-review-agent-progress.md)及 [Issue #547](https://github.com/ITSophiaXu/BondBuddy/issues/547)。界面在左侧两个标签上方持续显示紧凑当前动作；项目助手回复区域维护同一任务记录，已完成动作默认折叠。取消、失败、等待补充及结果入口沿用原任务。界面不展示心跳、时间、预计完成时间或百分比。

## 执行边界

`packages/contracts/src/review-action.ts` 唯一定义 `review-action-v1`。公开动作仅含宿主生成的不透明身份、固定类别与开始/完成/失败状态，不含模型推理、prompt、CLI 参数/结果或内部路径。新增 `onActivity` 在既有工具隔离检查之后调用；原 `onEvent` 的诊断与取消语义保留。只有既有 M3 复核、公开检索/对照及修订路径接入动作投影。

worker 使用有界串行队列记录实际活动，结束前 drain。API 校验归属、有效租约和非终态，在同一事务写 run event/outbox，只增加事件游标；任务阶段、检查点、输入、用量和计费均保持原有含义。报告整理来自实际 Python 渲染及报告登记，不由模型自述或 shell 完成判定交付成功。无需数据库迁移或额外模型调用。

助手采用原地 DOM 更新，保留任务身份、展开记录、焦点、文字选择和回看位置。终态和停止请求优先于工具活动，同一动作不能从完成/失败回退到开始。旧任务没有细分事件时只展示真实粗阶段，不补造动作历史。

## 验证证据

所有任务、工具事件及浏览器项目均为 **synthetic**。Linux 使用独立 PostgreSQL/Azurite 和非 root `bbm3` 用户；真实执行数据库事务、CLI fixture 进程及 Python 文档渲染，未发起供应商模型调用，未使用生产账号、项目、材料或账务数据。

最终代码、原型及截图 commit：`b2bc94dcf2b3c5a7f659749b45558a05ce72a770`。合并基准 develop：`b38b9ec9bab3544ed7cb75748dbc219e41e74d27`，含 #548 的租约、异步验证与取消修复；冲突解决保留两份 CI 中双方的测试清单。该基准已随 #549 合入 master，两项 Linux CI 成功。

### Linux 后端与共享契约

环境为 WSL `BondBuddyM3` 的原生 Linux 文件系统，非 root 用户 `bbm3`，Node 24.14.0 / npm 11.9.0 / Python 3.12.3。最终同步快照源码 digest：`7011415801278540fa2564950914894f69a9f03c52f8f238edb8497a959f10c1`。以下命令从本次独立测试 runner 调用；`required` 展开两份 M3 工作流的 host 测试清单并去重，采用 `node --test --test-concurrency=1 --test-reporter=tap`，不是挑选部分通过项。

```powershell
./diagnostics/m3-agent-progress-implementation/run-linux-tests.ps1 -Action sync
./diagnostics/m3-agent-progress-implementation/run-linux-tests.ps1 -Action build
./diagnostics/m3-agent-progress-implementation/run-linux-tests.ps1 -Action required
./diagnostics/m3-agent-progress-implementation/run-linux-tests.ps1 -Action targeted
./diagnostics/m3-agent-progress-implementation/run-linux-tests.ps1 -Action contracts
```

| 验证 | 最终结果 |
| --- | --- |
| `npm run build` 全 workspace | 通过 |
| 两份 CI host 清单并集 | 413/413；失败、取消、跳过、TODO 均为 0 |
| 动作投影、严格 DTO、归属/租约 PG 事务、长事件历史及完整 M3 PG pipeline 等定向验证 | 60/60；失败、取消、跳过、TODO 均为 0 |
| 公共契约 | 166 个 synthetic 示例、12 个资料库示例、4 个生命周期检查通过 |
| OCR / 发行人回归 | 29/29、11/11；零跳过 |
| 六模块 Python parser / Word / revision | 71/71；零失败、跳过；源码等价复用见下文 |

Python 命令为 `python -m unittest -v test_document_parser test_review_word test_unified_word test_word_delivery test_file_authoring test_revision_cli`。最终源码的 39 个 Python 文件逐一 SHA-256 与已通过的 71 项测试完全一致，单独 receipt `linux-python-reused-after-rebase.json` 关联最终快照；没有声称 rebase 后又运行一次 Python。CI 固定的 `reportlab==4.4.9` 仅安装到本次独立 fixture 依赖目录。

本机内核的 AppArmor 未启用，不能复现工作流的 hardened Docker native 阶段。一次 raw WSL 尝试的四项 native 用例在已有 `/proc/1/environ` 访问拒绝探针处失败，其余 282 项通过；探针未读取环境内容、未调用供应商，产品沙箱要求未降低。两份 GitHub 工作流保留完整原生沙箱验证，PR 必须以它们成功为准。以上 413 host 结果不包含、也不替代该阶段。

### 浏览器与原型

Windows / 本机 Edge / owner-aware synthetic HTTP fixture。环境变量为 `BB_E2E_BROWSER_CHANNEL=msedge`、`BB_E2E_BASE_URL=http://127.0.0.1:5473`、`BB_E2E_PROTOTYPE_URL=http://127.0.0.1:5474`。

```text
npm run test:unit -w @bondbuddy/web
npm test -w @bondbuddy/web -- tests/review-workspace.spec.ts tests/review-agent-progress-prototype.spec.ts
npm test -w @bondbuddy/web -- tests/review-agent-progress-prototype.spec.ts
npm test -w @bondbuddy/web -- tests/review-workspace.spec.ts tests/review-agent-progress-prototype.spec.ts --grep "agent actions stay visible|narrow progress opens|approved prototype"
npm run build -w @bondbuddy/web
node --check product-prototype/public/review-v2.js
git diff --check -- apps/web product-prototype/public
```

单元 67/67；完整 runtime 32/32。最初 prototype 用例受已打开抽屉的测试前置状态影响，修正测试后 prototype 1/1。最后局部 focus/抽屉交互调整后，对应 3 项定向验收、最终 web build、语法及 diff 检查通过，验证源码与 `b2bc94d` 相同。完整 32 项 runtime 回归在该局部调整之前完成，没有冒称最终 SHA 上又完整重跑。定向验收覆盖跨 tab 同一任务、保留卡片身份和展开历史、文字选择/焦点/滚动、无时间、准确结果入口以及窄屏查看进展/停止中/取消。

六张截图均提交在 `apps/web/test-evidence/m3-agent-progress/`，原型与实现来自上述同一 commit，已逐张检查：

| 同尺寸 | 原型 | 实现 |
| --- | --- | --- |
| 1360×900 | [prototype-desktop-1360x900.png](../../apps/web/test-evidence/m3-agent-progress/prototype-desktop-1360x900.png) | [runtime-desktop-1360x900.png](../../apps/web/test-evidence/m3-agent-progress/runtime-desktop-1360x900.png) |
| 1280×720 | [prototype-desktop-1280x720.png](../../apps/web/test-evidence/m3-agent-progress/prototype-desktop-1280x720.png) | [runtime-desktop-1280x720.png](../../apps/web/test-evidence/m3-agent-progress/runtime-desktop-1280x720.png) |
| 581×753 | [prototype-narrow-581x753.png](../../apps/web/test-evidence/m3-agent-progress/prototype-narrow-581x753.png) | [runtime-narrow-581x753.png](../../apps/web/test-evidence/m3-agent-progress/runtime-narrow-581x753.png) |

三种尺寸都满足标签上方当前动作、助手当前动作与折叠历史、无时间/百分比、无横向溢出；桌面 composer 可用，窄屏当前动作和停止可达。与原型的差异为 synthetic 项目/材料/发现/完成动作数量，以及既有外壳/header/composer 文案；实现运行中保留已登记的上一份报告，原型初始显示演示运行提示及已有报告入口。进展条、任务记录、当前动作、折叠历史、停止及无时间行为一致。设计确认人为本次产品负责人，无新增交互偏离。显式“查看进展”仅滚动助手聊天到当前摘要，任务标题可能处于聊天裁切上方，工作区整体不滚动。

## 发布与最终统一验收

发版由 develop 合入 master 后使用准确 master commit。需先检查生产有效作业、助手租约、模型执行及未核实调用回执，避免切换中断业务；保留既有回滚脚本和部署前的实际服务版本，不能用数据库旧快照覆盖后续用户数据。

截至本次代码验收登记，尚未执行生产发布。本机 SSH 在认证前被断开，现有 Azure 会话没有目标订阅；已向用户请求现有 master 连接信息，并继续完成 PR 与发版准备。GitHub CI、develop/master 合并及实际部署版本另在 #547 留存结果，不以该文档或设计示意代表已上线。

真实模型三维复核、专业结论和 Word/WPS 为最终统一验收待办；自动化合成链路不能冒充这些验收。
