# 合并前检查（PR gate）

所有开发者和 agent 在合并前使用同一条本地命令，并在 PR 的“证据”一节提交回执摘要。测试发现、分片和通过判定继续由原有 `run.mjs` 完成；本地入口负责准备环境、收齐结果、记录回执和清理服务。

本检查只使用本机一次性 PostgreSQL 16、Azurite 和合成模型响应，不调用真实模型。它不替代用户验收、真实模型质量验证或统一发布。

## 一条命令

前提：本机安装 Node.js 22 或更新版本、npm、Git 和 Docker，Docker 正在运行 Linux 容器，并可下载所需镜像与依赖。Windows/macOS 可使用 Docker Desktop 的 Linux 容器环境；Linux 可使用本机 Docker Engine。命令不连接远程 Docker 主机。

先 `git fetch` 并 rebase 到最新 `origin/develop`，提交全部改动，确认工作区干净，然后从仓库根目录运行：

```sh
npm run pr-gate
```

命令依次完成：

1. 检查已跟踪和未跟踪文件均无改动，记录 HEAD commit、tree 和 develop 基点。
2. 从该提交准备固定源码，在本机 Linux 容器中启动一次性 PostgreSQL 16 和 Azurite；不挂载宿主凭据或已有数据库。
3. 安装 JavaScript、Python、浏览器和文档渲染依赖，执行 `npm run build` 与 `npm run check:contracts`。
4. 依次运行 `.github/workflows/pr-gate.yml` 矩阵的全部 8 行；每行使用全新的测试数据库和 Blob 状态。分片失败仍继续收集其余分片的结果。
5. 调用原有 `run.mjs merge` 汇总全部分片，写入 `.local/pr-gate/receipt.json`；保留失败和跳过清单、日志及脚本生成的建议例外。
6. 清理本次创建的一次性测试服务。

测试环境变量与工作流一致；本地输出目录映射到隔离的运行目录。`BB_TEST_LIVE_AUTHORING=0`、平台探测和公网检索关闭，宿主的模型密钥、数据库地址和本地 opt-in 开关不会被带入测试容器。不要通过补充开关或手工排除测试把失败变成通过。

## 回执与核对

```sh
npm run pr-gate:verify <commit>
# npm 的等价传参方式：
npm run pr-gate:verify -- <commit>
```

回执记录 commit、tree、工作区是否干净、所基于的 develop 提交、起止时间、平台、各分片的状态与数量，以及例外清单的条目数和 SHA-256。只有环境准备、构建、全部分片和汇总都通过，才写 `passed`。失败回执保留实际结果，不得当作通过凭据。

`verify` 核对回执属于指定提交及其源码树、所需分片完整且通过。回执中的通过数等分片数量按**测试文件**统计，不是单个测试用例数；例外数是清单条目数，不是匹配到的文件数。

在 PR 的“证据”一节填写：

```text
pr-gate 回执：commit=<完整提交>；tree=<完整树哈希>；通过数=<测试文件数>；例外数=<条目数>。
```

同时保留耗时、失败和跳过清单及 `exclusions.suggested.json` 的内容供审阅。rebase 或后续修改产生新提交后，需要对新提交重新全量运行。`.local/` 是本地证据目录，不提交到 Git；不能复制旧回执代替新提交的检查。

## 文件与矩阵

| 文件 | 作用 |
| --- | --- |
| `scripts/pr-gate/local.mjs` | 本地环境编排、回执写入与核对 |
| `.github/workflows/pr-gate.yml` | 测试环境、8 行矩阵及手动 GitHub Actions 入口 |
| `scripts/pr-gate/run.mjs` | 自动发现测试、逐个运行、判定和 merge 汇总；保持原判定规则 |
| `scripts/pr-gate/exclusions.json` | 经确认的例外清单，每条必须写原因 |
| `scripts/pr-gate/run.test.mjs` | 原有检查脚本回归测试，也由全量检查自动发现 |

| 分片 | 分组 | 分片范围 | 附加环境 |
| --- | --- | --- | --- |
| `api-1` | `api` | `1/2` | — |
| `api-2` | `api` | `2/2` | — |
| `worker-1` | `worker` | `1/2` | Chromium |
| `worker-2` | `worker` | `2/2` | Chromium |
| `misc` | `packages,web-unit,scripts,python` | `1/1` | 文档渲染 |
| `browser-1` | `browser` | `1/3` | Chromium |
| `browser-2` | `browser` | `2/3` | Chromium |
| `browser-3` | `browser` | `3/3` | Chromium |

测试按源码目录发现，新加文件不需手工登记：

| 分组 | 发现规则 |
| --- | --- |
| `api` | `apps/api/src/**/*.test.ts` |
| `worker` | `apps/worker/src/**/*.test.ts` |
| `packages` | `packages/*/src/**/*.test.ts` |
| `web-unit` | `apps/web/src/*.test.ts` |
| `scripts` | `scripts/**/*.test.mjs`、`deploy/**/*.test.mjs` |
| `python` | `python/tests/test_*.py` |
| `browser` | `apps/web/tests/*.spec.ts` |

TypeScript 测试运行编译产物；页面单元测试由原脚本另外编译。浏览器测试仍使用原 Playwright 配置。实际发现数量以本次回执和分片结果为准。

## 例外清单

修改 `scripts/pr-gate/exclusions.json` 必须取得 **Maxy 确认**。不得自行添加例外，不得修改或跳过现有测试，不得改变原有判定规则。

| 清单 | 含义 |
| --- | --- |
| `notInCi` | 不在本检查内运行，适用于已登记的真实模型、真实环境或人工时段测试 |
| `knownFailing` | 照常运行，已登记的失败不拦合并；恢复通过后提示移出 |
| `allowSkip` | 已登记的文件允许出现跳过；其它文件出现跳过会拦合并 |

每条必须有 `pattern` 和 `reason`。`pattern` 使用源码路径，`*` 匹配一层目录，`**` 可以跨目录。缺少原因、字段无效或匹配不到任何测试文件都会使检查失败。

`run.mjs merge` 在发现未登记失败或跳过时生成 `exclusions.suggested.json`，仅供逐项审阅，**不会自动应用**。应先定位问题；确需调整例外时由 Maxy 确认。没有建议时原脚本不生成此文件，如实记录“未生成”，不要把它解释为测试已经全部通过。

## 判定与失败处理

以下任一情况使检查不通过：

- 测试失败、超时或没有运行任何用例，且不在既有 `knownFailing` 中。
- 存在未获既有 `allowSkip` 允许的跳过。
- 浏览器测试重试后才通过。
- 某个分组没有发现测试，或任一分片缺少结果。
- 例外清单、环境准备、依赖安装、构建或汇总失败。

原有单文件默认超时为 5 分钟，每行默认时间预算为 70 分钟；本地入口不提高阈值来改变判定。准备失败的范围记为未执行，不能报告为零失败的通过结果。单独运行某个分组、`--list` 或 `--report` 仅用于排查，不能签发全量通过回执。

```sh
# 仅列举当前源码中将运行的文件
node scripts/pr-gate/run.mjs run --group api --list

# 原脚本自身回归测试
node --test scripts/pr-gate/run.test.mjs
```

失败后查看 `.local/pr-gate/` 中本次运行证据，区分环境准备问题、测试失败、跳过和未执行，不删除第一次失败记录后只展示重跑成功。

## GitHub Actions 与发布边界

`pr-gate.yml` 暂时仅保留 `workflow_dispatch`，不再由 PR、push 或 merge queue 自动触发，以免 GitHub 账户计费限制使每个 PR 显示失败。原有工作流矩阵、环境变量、执行步骤及其他工作流保持原样；手动运行中的 `report_only` 仍只用于诊断，不能作为本地通过回执。

自行合并的前提是 rebase 到最新 develop 后本地全量检查通过，并在 PR 贴回执摘要。当前本地回执不会自动配置 GitHub 分支保护，也不会部署。本 PR 不修改 `deploy.sh`；部署前核对回执另开 PR。

真实模型的生成质量、用户实际验收、现有发布门禁、原生沙箱和独立兼容性测试仍按各自范围执行。仓库根目录旧 Cowork `tests/` 不属于本脚本的发现范围。任何未覆盖或跳过的检查均不能据此称为已验证。
