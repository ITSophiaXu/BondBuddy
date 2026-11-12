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

## 浏览器分片的真实本地环境

本地入口为每个 browser 分片保存 `browser-plan.json`：按照原自动发现与取模分片顺序列出全部测试文件、候选源码 SHA-256、每文件 profile 和证据目录。`run.mjs` 仍以原 `npx playwright test <完整分片文件表> --reporter=line,json` 一次执行，沿用原 Playwright 配置、70 分钟分片预算及失败/跳过判定；不逐文件重跑、筛选用例或增加例外。

`browser-profiles.mjs` 明确启用 10 个真实本地 API 文件的原开关：account-live、account-recovery-live、live、register-live、project-management-live、update-form.integration、material-processing.integration、ocr.integration、project-events.integration、project-execution.integration。准备层按需创建独立 PostgreSQL 16，固定为 core 私有网络中的 `127.0.0.1:55433/bondbuddy_local`，执行当前迁移并使用本分片新建的 Azurite。API 使用当前编译产物及正常商业计费语义，不启用历史计费 fixture；实际 worker 解析/OCR 函数由原用例调用，运行消费者和真实模型调用关闭。

所有分片使用 HTTPS `https://127.0.0.1:5173` 的当前 Vite 网页。API 固定为 `http://127.0.0.1:3000`，注册协议版本固定为 `synthetic-web-test-v1`；准备探针实际经过 HTTPS 代理读取协议，并核对严格 CA 校验、PG 端口/数据库/版本。review-agent-progress-prototype、review-readable-prototype 和 review-workspace 三个文件按需启动 `127.0.0.1:4320` 的仓库原型及独立临时状态目录；前两者使用原 `BB_E2E_PROTOTYPE_URL`，workspace 的原消费者使用 `BB_PROTOTYPE_URL`。以上端口均不发布到宿主，不接入现有用户服务。

`review-workspace.spec.ts` 的完整场景 producer 必须先把 JSON/CSS 写入本轮源树外的 `BB_WORKSPACE_SCENES_DIR`，两个原型消费者只读取同 worker 完成的同一产物。该维护修复在独立 PR #1152（`4bac6f12`），固定集成候选必须包含它；旧候选会写 tracked 产品资产，最终源码证明必须失败，不能用旧产物或修改后的 source proof 兜底。`M4_UX_EVIDENCE_DIR` 与原 `M4_UX_EVIDENCE=1` 同时提供。部分用例自行 route `prototype.test` 或本地固定 URL 到候选静态文件，保持原 fixture，不额外启动服务；project-entry/task-results 的可选产品原型导出开关不启用，它们不属于 skip 条件。

OCR 分片从 `--host-worker-image` 指定的已有不可变本地镜像复制 Tesseract、完整 ELF 依赖、eng/chi_sim/osd 和 Noto 字体。文件写入本次 core 的专用目录，以独立 ELF loader/library path 调用；逐文件 hash、CPU ABI、真实中文/数字 OCR 探针及测试后的文件复验均进入回执。Windows 传输后的可执行位仅按已校验 manifest 在临时 core 恢复。此步骤无软件安装、下载或宿主设置修改；缺工具/语言包、ABI 不符或探针失败均停止该分片。

浏览器子进程从明确的环境允许清单启动，清除继承的 reference/baseline、旧 evidence 路径、模型/支付凭据、服务地址和 Node 启动钩子，再应用该分片 profile。可选截图用例获得独立证据目录；共用 `BB_UX_EVIDENCE_DIR` 的用例在计划中明确列出 shard 共享目录。不打开历史模式代替当前模式，缺失的历史封存源码、基线或断言仍按原规则真实失败。

`browser-services.json`、`browser/runtime.json` 与原 summary 记录服务身份、实际环境/探针、完整命令、测试和清理时间。最终回执必须与同一 run、commit/tree、原文件表及脚本调用一致，并通过宿主服务清理和 core 原字节复验。小单元、环境预检和局部诊断都不能代替完整 PR gate，更不能代替 `test:release` 的真实模型与质量凭据。

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

## 使用本机已有依赖缓存（不下载）

当本机已有包含依赖与浏览器的PR gate缓存镜像时，可指定不可变本地镜像ID：

```sh
npm run pr-gate -- --offline-image sha256:<64位本地镜像ID> --host-worker-image sha256:<64位已有worker镜像ID> --host-dependency-root <本机已有同锁依赖缓存的绝对目录>
```

此模式仍执行原工作流的全部八个分片。它只改变环境准备，不改变自动发现、例外清单、300秒单文件预算、跳过判定或回执完整性；尚未准备好的能力仍按原测试失败或skip阻断。每次仍需干净HEAD和最新develop基点。镜像ID由本机`docker image inspect`取得，不接受tag，不自动构建或拉取。PG16和Azurite也必须已缓存，启动时固定解析后的image ID。

- 缓存必须把package-lock.json及两份Python requirements保留在/workspace。三份输入分别与候选Git原字节比较，只允许CRLF转LF；不按JSON等价或大致版本放行。原始字节与哈希保留。
- 确认/workspace没有bind/volume及子挂载后，在一次性容器中删除旧源码、node_modules和编译输出，再用原Git snapshot恢复准确commit/tree。宿主源码和Git配置不挂入。
- 每条进程使用env -i白名单，旧镜像的SHA、opt-in、NODE_OPTIONS等环境不会继承。runner network=none；专用PG/HTTP Blob/HTTPS Blob只共享该容器网络，无宿主端口、Docker socket或生产连接。记录实际隔离检查和服务镜像身份。
- JavaScript仅npm ci --offline和npm ls --all；Python仅核对候选requirements与已安装版本并运行pip check，不运行pip install。Chromium必须已存在，真实启动本地合成页面探针后关闭，不运行Playwright install。缺缓存或不匹配直接失败。
- 普通模式保留原下载准备。两种模式都按本次创建的精确容器ID和名称核对后清理，并inspect确认不存在；中途启动失败同样清理。

离线准备回执在`.local/pr-gate/runs/<id>/offline-cache/record.json`，含原始/转换/候选输入哈希、源码恢复、依赖检查和真实浏览器探针。只有八分片与其余既有能力均通过、清理成功时才能签发PR gate通过回执。单独环境探针或旧定向日志均不能替代本次完整结果。

## 同轮宿主能力调度

完整本地入口还需上述`--host-worker-image`和`--host-dependency-root`。宿主只使用已经存在的依赖，不安装软件、不拉取镜像。Windows计费适配器使用一个本轮Git snapshot还原的独立checkout；第三方依赖来自同锁缓存，产品workspace和构建产物属于本次候选。普通core容器仍没有Docker socket、宿主源码或宿主凭据挂载。

当前五个精确文件走宿主调度：原生文件沙箱2个、诚信桌面1个、OCR1个、Windows计费面板1个。`host-profiles.mjs`只决定执行环境；发现、原矩阵、原文件顺序、5分钟文件预算、70分钟分片预算、断言和失败/skip判定保持不变。浏览器分片仍批量按原配置执行，尚缺的真实API或历史基准不会因此获得通过。

宿主从固定候选和原发现结果生成内存计划。容器请求仅含run ID、计划hash、顺序、分片和精确test ID，不能传命令、argv、环境、路径或镜像。拒绝额外字段、重复、错序、旧版本以及符号/硬链接请求。每个适配器执行原完整文件，保留原stdout、stderr、退出码、耗时、环境准备与资源清理证据。准备或清理失败会独立阻断，不能把原测试退出码0改写成“全部通过”。

原生能力把本轮core完成构建后的源码、依赖和编译产物导出到新的专用volume，覆盖旧worker镜像的整个`/app`；volume初始化后只读。逐项非root、无网络、只读rootfs、drop ALL、no-new-privileges、资源限额，原生沙箱/桌面使用仓库收窄seccomp；不使用unconfined。沙箱先运行原权限探针；OCR先核验真实Tesseract语言包/中文字体/ReportLab；桌面先核验X11/面板/Chromium。缺失前提直接失败，不静默skip，也不安装依赖。

worker生产依赖中没有ReportLab时，准备阶段从本轮已验证的core依赖缓存导出其包及distribution metadata，逐文件留hash并放入同一只读volume的`.pr-gate-python`；Python按实际导入后的完整候选requirements和`pip check`核验。此过程不下载或执行安装器，不能代用未核对的宿主模块。导出编译产物前额外核验全部Git原始blob字节，不能只以`git status`干净判定同源。

全部分片结束后、清理core容器之前，host控制器再次将当前Git commit中的原始核验器字节传入core执行`verifyGitSnapshotSource`，不从测试可写目录导入核验器。`receipt.core_source_final`记录本轮run、commit/tree、核验器hash、全部受跟踪文件的原字节证明及执行时间；必须与准备阶段证明一致，且时间晚于全部分片完成。缺失、失败或源码变化均阻断凭据，不能用外层工作区干净替代core核对。

宿主原始证据放在`.local/pr-gate/host-evidence/<runId>`，普通core不挂载此目录。分片引用和宿主内存结果必须逐项匹配相同候选、计划、输出hash、原执行结果与零skip；还必须完成本轮全部八分片及全局资源清理。旧专项回执不能导入或拼接。本轮host源码使用系统临时目录下独有的`bb-pg-*/src`短路径，避免Windows Git长路径失败；创建时核对实际父路径、非链接目录及唯一所有权记录，`owner.json`保留本轮run ID和进程身份。具体源码路径及原字节证明写入`receipt.host_source`，与core证明一致后才有效。不修改系统或全局Git设置，不省略任何长路径文件；保留此独立源码便于核对。
