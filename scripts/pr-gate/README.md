# 合并前检查（PR gate）

所有开发者和 agent 在合并前使用同一条本地命令，并在 PR 的“证据”一节提交回执摘要。测试发现、分片和通过判定继续由原有 `run.mjs` 完成；本地入口负责准备环境、收齐结果、记录回执和清理服务。

本检查只使用本机一次性 PostgreSQL 16、Azurite 和合成模型响应，不调用真实模型。它不替代用户验收、真实模型质量验证或统一发布。

## 一条命令

前提：本机安装 Node.js 22 或更新版本、npm、Git 和 Docker，Docker 正在运行 Linux 容器，并可下载所需镜像与依赖。Windows/macOS 可使用 Docker Desktop 的 Linux 容器环境；Linux 可使用本机 Docker Engine。命令不连接远程 Docker 主机。

依赖安装沿用 npm 传入的 registry 配置；也可用 `PR_GATE_NPM_REGISTRY`、`PR_GATE_PIP_INDEX_URL` 指定本机可访问的公共 HTTPS 包代理。地址不得携带凭据、查询参数或片段；下载源会记录在回执中，仅用于安装步骤，不传给测试。保留 npm 锁文件的完整性校验，不关闭 TLS 校验。npm 诊断日志与每次运行的回执保留在 `.local/pr-gate/runs/<运行编号>/`。

先 `git fetch` 并 rebase 到最新 `origin/develop`，提交全部改动，确认工作区干净，然后从仓库根目录运行：

```sh
npm run pr-gate
```

命令依次完成：

1. 检查已跟踪和未跟踪文件均无改动，记录 HEAD commit、tree 和 develop 基点。
2. 传递该提交及其完整源码树的 Git 对象，在本机 Linux 容器里还原同一 commit/tree 的干净浅检出，然后启动一次性 PostgreSQL 16 和 Azurite；不复制宿主 Git 配置、凭据、hooks 或父提交历史，不挂载已有数据库。
3. 安装 JavaScript、Python、浏览器和文档渲染依赖，执行 `npm run build` 与 `npm run check:contracts`。
4. 依次运行 `.github/workflows/pr-gate.yml` 矩阵的全部 8 行；每行使用全新的测试数据库和 Blob 状态。分片失败仍继续收集其余分片的结果。
5. 调用原有 `run.mjs merge` 汇总全部分片，写入 `.local/pr-gate/receipt.json`；保留失败和跳过清单、日志及脚本生成的建议例外。
6. 清理本次创建的一次性测试服务。

测试环境变量与工作流一致；本地输出目录映射到隔离的运行目录。`BB_TEST_LIVE_AUTHORING=0`、平台探测和公网检索关闭，宿主的模型密钥、数据库地址和本地 opt-in 开关不会被带入测试容器。不要通过补充开关或手工排除测试把失败变成通过。

## 按测试准备隔离能力（#1072）

本地入口在工作流的基础环境上读取 `capabilities.mjs` 的精确源码路径清单，为19个测试文件准备额外能力。清单不使用glob，不改变测试发现、分片、断言、失败/跳过判定或例外表。新的样本开关、历史解析器路径、专用数据库和CA信任仅传给指定测试子进程；其他测试不会继承这些开关。直接运行旧CI/脚本而没有能力准备记录，不能签发新的本地通过回执。

- `direct-upload.pg.test.ts` 使用同一私有容器网络中的第二个Azurite Blob服务：HTTPS `127.0.0.1:10003`。运行目录内生成有效期一天的专用CA与含localhost/127.0.0.1 SAN的服务器证书，仅使用进程级 `NODE_EXTRA_CA_CERTS`。HTTP `10000` 保留给原有测试。每个分片实际验证HTTPS Blob写入/读取和严格CORS后才执行测试，不修改宿主信任、不关闭TLS、不发布端口。
- 三个历史财务桥接测试使用 #196 的精确commit `fb6c12c60b98d14103780da882f0d4da2303f191`、tree `d4109eedad1c16f282170cd07ddd93030a723eb9`、Python subtree `cf2eb4ae549c6ff061c7a6a3d054627eb80e03c4`。归档显式固定 `core.autocrlf=false`、`core.eol=lf`、`tar.umask=0002` 并隔离系统/全局Git配置；`git archive --format=tar <commit> python` 必须匹配规范SHA-256 `9ee74af7fe4d0e47b3a9574a3161bd9fc9e82f5ed8e3a887ec683e2d90dcb9f5`。Windows系统autocrlf不能重写原字节；复制后逐文件比对归档，并通过独立只读mount传入。宿主需已有该Git对象；缺少时明确失败，不悄悄使用当前1.0.8。当前产品源码和parser版本保持不变。
- 14个已核实只做本地解析、合成API/PG或上传容量检查的文件，各自启用一个命名opt-in。使用仓库已授权样本及原manifest字节/hash检查，不启用真实模型、live浏览器或桌面开关。
- `target-period-candidate-snapshot-repository.test.ts` 使用本分片新建的 `bb_pr_gate_target_period` 数据库，从本次已迁移空模板克隆。重名立即失败，不采用、清空或替换现有数据库。

准备回执保存候选commit/tree、配置hash、固定历史源与归档hash、公开TLS身份/有效期、授权样本manifest hash。每个分片记录实际PG16与HTTPS/CORS探针，每个相关文件记录所用配置及实际测试/skip计数。缺能力、跨候选证据、遗漏/重复文件、准备失败或任何必需文件跳过均不能通过；旧失败报告保持原状。完成后移除本次测试私钥，保留公开证书和原始证据。历史解析器只读源位于 `.local/pr-gate/parser-sources/<run-id>/`，不提交Git。

这一切片仍不解决Codex sandbox、OCR/desktop、billing专属服务、真实备份容器、live API浏览器或截图历史基准准备；这些失败/跳过继续按原规则阻断。修改能力脚本后需先做纯Node/Git测试，再排队实际PG/HTTPS/blob回归，最后对完整固定候选运行全量门禁。纯测试或能力预检本身都不是全量pass、真实模型验收或部署证据。

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
| `scripts/pr-gate/git-snapshot.mjs` | 固定提交的对象传递、浅检出与 commit/tree 完整性校验 |
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
