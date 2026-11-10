# Bug 提报、修复关联与每日统计

从 2026-11-10 起统一采用本规范。仓库为私有仓库，开发者需有访问权限；标签维护需要相应的仓库权限。本文不改变既有开发、验收及统一发布授权。

## 入口

| 用途 | 链接 |
| --- | --- |
| 仓库 / 开发分支 | [ITSophiaXu/BondBuddy](https://github.com/ITSophiaXu/BondBuddy) · [develop](https://github.com/ITSophiaXu/BondBuddy/tree/develop) |
| 提交问题 | [选择 Issue 模板](https://github.com/ITSophiaXu/BondBuddy/issues/new/choose) |
| 功能故障 | [上传、下载、执行、权限、计费等](https://github.com/ITSophiaXu/BondBuddy/issues/new?template=01-functional-bug.yml) |
| 页面UX | [页面布局、交互、提示文案](https://github.com/ITSophiaXu/BondBuddy/issues/new?template=02-page-ux.yml) |
| 生成结果UX | [成果内容、批注定位、修订落地](https://github.com/ITSophiaXu/BondBuddy/issues/new?template=03-generated-output-ux.yml) |
| 修复 PR | [Pull requests](https://github.com/ITSophiaXu/BondBuddy/pulls) |

## 开发者怎样提交

1. 先搜索已存在的问题。同一个缺陷的补充证据写入原 Issue；已经修复后同一原因复发，重新打开原 Issue 并记录回归，不当作新发现重复统计。根因不同、可以独立修复的问题单独建单并关联旧单。
2. 选择上面的三类模板之一，标题为 `[分类][模块或成果] 触发条件与问题`。一项可独立修复的问题一条 Issue，避免把多个不相关 Bug 塞进一条 UX 汇总单。
3. 当天登记，并填写**首次发现日期（北京时间）**、环境与版本、复现步骤、实际/预期结果、证据及验收标准。晚登记保留真实发现日期；日期未知写“未知”。用户反馈、静态审查、模拟测试、真实复现分别说明，未复现不冒充已复现。
4. 模板自动添加 `bug`、一个 `type:*` 分类和 `fix:待排查`。认领人设置 Assignee，补充已有的 `area:*`、适用的 `priority:*`，维护修复跟踪。报告人不必先知道根因或修复方案，也不因缺这些信息推迟登记。
5. 不上传令牌、密钥或未经授权的客户原件；使用脱敏截图、版本与 run ID 定位。没有标签权限时先提交，再由认领人补齐，不伪造处理状态。

CLI 提交不会执行网页表单的必填校验；通过 `gh issue create` 创建时，同样按模板填写正文，并显式指定标签。例如先将完整正文写入 `bug.md`，再执行：

```sh
gh issue create --repo ITSophiaXu/BondBuddy --title "[生成结果UX][复核成果] 点击批注无法定位对应问题" --body-file bug.md --label bug --label "type:生成结果UX" --label "fix:待排查" --label "area:document"
```

此命令仅为格式示例；已有相同问题时更新原单。开发任务和新需求使用空白 Issue，按需加 `type:task` / `enhancement`，不要加 `bug`。汇总单使用 `type:milestone` 并关联独立 Bug，汇总单本身不计 Bug 数。

## 分类和修复状态

Bug 分类只选一个，`area:*` 可以有多个：

本仓库使用 labels 保存这些分类与状态；模板名称和 `type:*` 标签不表示已启用 GitHub 原生 Issue Type。

| 标签 | 含义 |
| --- | --- |
| `type:功能Bug` | 功能失败、错误执行、权限、数据、计费或性能问题 |
| `type:页面UX` | 既定页面的交互、布局、操作反馈或提示文案存在缺陷 |
| `type:生成结果UX` | 生成文件的批注、定位、修订、内容呈现和使用问题；单独统计，不并入页面UX |

有效 Bug 保留且仅保留一个 `fix:*` 标签。它记录**整个 Issue 范围**的代码状态：

| 标签 | 何时使用 | Issue 状态 |
| --- | --- | --- |
| `fix:待排查` | 已登记，尚未认领或尚待明确处理方案 | Open |
| `fix:修复中` | 已认领排查、开发或验证，或 PR 尚未合并 | Open |
| `fix:部分修复` | 只覆盖了部分验收项，仍有明确剩余工作 | Open |
| `fix:已合并` | 本 Issue 负责范围已修完，必要自动化测试与主链路验证通过，相关修复全部合入 develop | Closed，附验证证据与“最终统一验收待办” |

更新状态时移除旧 `fix:*`，不叠加。例如从待排查转修复中：

```sh
gh issue edit 123 --repo ITSophiaXu/BondBuddy --remove-label "fix:待排查" --add-label "fix:修复中"
```

完整修复后再维护发布标签：`release:待发布` 表示完整修复尚未部署；`release:已部署` 必须有完整修复所在的发布 commit、环境、时间及核验记录，两者互斥。部分修复的上线记录写在正文，不给整个 Issue 标记“已部署”。回滚了相关修复时，恢复 `release:待发布` 并记录原因；若代码本身仍有缺陷，重开 Issue、移除 `fix:已合并` 并设置实际修复状态。部署完成也不自动代表用户验收通过，用户验收另记时间、版本、操作者与结果。

历史单缺少标签或证据时在统计中列为“待核对”，不凭 Closed 推定已修复或已上线。确认重复后加 `duplicate`，写明原单编号并按 not planned 关闭；无效问题加 `invalid` 并说明理由。这两类从有效 Bug 统计排除。确认存在但决定不修的问题加 `wontfix`、移除 `fix:*` 与 `release:*`、说明原因并按 not planned 关闭，仍计入有效问题，不计入已修复；这是仅保留一个修复状态规则的例外。

## Fix PR 和关闭回执

1. 独立分支及工作区开发，PR 的 base 明确为 `develop`，按仓库要求验证并对齐最新 develop。
2. **部分修复**在 PR 正文用 `Refs #123`，在 Issue 中列出 Fix PR、已覆盖及剩余项，保持 Open。**完整修复**才用 `Fixes #123` / `Closes #123`；提交消息也不要对部分修复使用关闭关键词。
3. PR 合并后，负责人核对其实际合并状态，更新 Issue 的修复跟踪与标签。不能仅凭 PR 已创建、测试通过或某一阶段已合并关闭整个问题。
4. 完整解决时写明测试命令、pass/fail/skip 计数、环境、PR、合并 commit 和时间，以及“最终统一验收待办”。模型模拟、合成数据和真实链路分别说明。自动关闭后也要补齐这些记录；默认分支变化导致未自动关闭时，核实后手动关闭。
5. 开发完成记录“代码完成，尚未部署，待统一发布”。由已获授权的发布 chat 更新部署及验收记录，开发 chat 不因此自行部署。

可复制到 Issue 的完成回执：

```text
修复范围：完整 / 部分（列出剩余项）
Fix PR：#编号（填写实际 URL）
develop 合并：commit，YYYY-MM-DD HH:mm（北京时间）
验证：命令；pass/fail/skip；环境、版本；synthetic/真实链路边界
发布状态：代码完成，尚未部署，待统一发布 / 实际发布记录
最终统一验收待办：待验证项目；未完成的用户验收或真实样本检查
```

例：[生成结果UX #946](https://github.com/ITSophiaXu/BondBuddy/issues/946) 的 [PR #948](https://github.com/ITSophiaXu/BondBuddy/pull/948) 只取消未定位批注挂到文首的错误兜底。以 2026-11-10 第一阶段交付为例，重复段落消歧及表格定位仍未完成，因此是 `fix:部分修复`、Open，不能算作完整修复，也不能由合入 develop 推定已部署。最新进度以 Issue 为准。

## 每天怎样统计

统计对象为带 `bug`、排除 `duplicate` 和 `invalid` 的 **Issue**，不计 PR、需求、普通任务和汇总单。统一使用北京时间 `Asia/Shanghai`。

| 指标 | 统计口径 |
| --- | --- |
| 当日新增登记 | 按 GitHub `created_at` 落入当日北京时间的有效 Bug 单数；建议日常使用这个客观、可查询的指标 |
| 当日实际发现 | 按正文“首次发现日期”归集；补录归回原发现日，日期未知单独列出。不能用创建时间冒充发现时间 |
| 当日新增中已修复 | 同一批当日登记 Issue 中，目前带 `fix:已合并` 的数量 |
| 当日新增中未全部修复 | 同一批中无 `fix:已合并` 的数量，含部分修复、待核对及决定不修的问题；与上一行相加等于该批有效登记数 |
| 当前部分修复 | 有效 Bug 中带 `fix:部分修复` 的数量 |
| 当日完成修复登记 | `closed_at` 在当日且带 `fix:已合并` 的数量；这是关闭登记日，不是精确的 PR 合并日 |
| 已上线 / 待发布 | 在 `fix:已合并` 中按 `release:*` 分组；发布标签缺失单独列为待核对 |

下面链接可直接查看**当前状态**（GitHub 列表顶部有数量）：

- [全部有效 Bug](https://github.com/ITSophiaXu/BondBuddy/issues?q=is%3Aissue%20label%3Abug%20-label%3Aduplicate%20-label%3Ainvalid)
- [未全部修复](https://github.com/ITSophiaXu/BondBuddy/issues?q=is%3Aissue%20label%3Abug%20-label%3Aduplicate%20-label%3Ainvalid%20-label%3A%22fix%3A%E5%B7%B2%E5%90%88%E5%B9%B6%22)
- [已完整修复并合入 develop](https://github.com/ITSophiaXu/BondBuddy/issues?q=is%3Aissue%20label%3Abug%20-label%3Aduplicate%20-label%3Ainvalid%20label%3A%22fix%3A%E5%B7%B2%E5%90%88%E5%B9%B6%22)
- [生成结果UX](https://github.com/ITSophiaXu/BondBuddy/issues?q=is%3Aissue%20label%3Abug%20-label%3Aduplicate%20-label%3Ainvalid%20label%3A%22type%3A%E7%94%9F%E6%88%90%E7%BB%93%E6%9E%9CUX%22)

例如统计 **2026-11-10（北京时间）**，UTC 时间范围是 `2026-11-09T16:00:00Z..2026-11-10T15:59:59Z`；不要仅写 `created:2026-11-10` 后称其为北京时间结果。在 Issue 搜索栏使用：

```text
is:issue label:bug -label:duplicate -label:invalid created:2026-11-09T16:00:00Z..2026-11-10T15:59:59Z
```

- [11 月 10 日新增登记](https://github.com/ITSophiaXu/BondBuddy/issues?q=is%3Aissue%20label%3Abug%20-label%3Aduplicate%20-label%3Ainvalid%20created%3A2026-11-09T16%3A00%3A00Z..2026-11-10T15%3A59%3A59Z)
- 在上面的查询末尾添加 `label:"fix:已合并"` 查看该批已修复；添加 `-label:"fix:已合并"` 查看该批未全部修复。
- 查看某日完成修复登记，将 `created:` 改为 `closed:`，并加上 `is:closed label:"fix:已合并"`。
- 换日期时同时调整范围的前一天和当天；按实际发现日统计时需导出正文核对，不能用 `in:body 日期`，因为修复和发布时间也会包含日期。

建议日报格式：`日期｜新增登记｜实际发现（含补录/未知）｜本日登记中已修复/部分修复/其余｜当日完成修复登记｜待发布｜已部署｜待核对`，附对应 Issue 链接。统计结果注明截止时间。保存每日快照才能还原“当天结束时”的状态；实时筛选显示的是现在的标签，不能回推历史状态。

旧 Issue 存在漏标签和多个问题混记的情况，上线本规范不会自动修正历史统计。整理时逐条核对后补分类、修复证据与状态；不能根据标题或 Closed 批量认定修复。若拆分旧汇总单，父单去掉 `bug`、保留子单链接，注明拆分和原发现日期，不把迁移产生的新单数冒充当天新增发现。
