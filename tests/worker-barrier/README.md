# Worker 重试屏障本地测试

这是一套合成的并发回归，不调用真实 Codex、模型、云 API、支付或生产数据库。
使用当前工作区的真实 Worker、PostgreSQL 队列、租约、重试和任务级 cgroup broker/runner；
仅以 Linux `sleep` 替代模型执行。测试不把 `sleep` 当作成功生成的 Word，任务最终明确为
`failed`。程序退出码与报告中的 `passed` 表示并发断言通过，不表示这些业务任务成功。

## 文件与数据

| 文件 | 职责 |
| --- | --- |
| `matrix.json` | 全部测试输入：槽位、任务时长、重试及任务子进程尾部时长 |
| `scenario.mjs` | 生成账号、项目、任务；启动 sleep；采集时序和数据库状态并断言 |
| `entry.mjs` | 合成测试入口，保持 broker 所要求的受保护 Node/runtime 身份 |
| `run.py` | 复用真实 host broker/数据库夹具，逐组隔离执行与清理，生成报告 |
| `run.ps1` | Windows/VS Code 入口：编译当前源码、构建测试镜像、进入 WSL |
| `Dockerfile` | 不依赖个人现有镜像的最小 Linux 测试镜像 |

无需额外下载业务材料。UUID、账号、项目、不可变输入与文件 hash 占位均由脚本生成，
数据明确标记 synthetic；无客户文档、模型凭据或真实费用。每组新建独立 PostgreSQL
容器、内部网络、数据库、任务 cgroup 和 broker。复用的是
`deploy/tencent-elasticity/task-cgroup-broker.test.py` 中的 `NativeDatabaseTests` 启停夹具，
不复用其业务测试断言；注入的只是合成测试入口和 JSON 参数，不替换业务隔离函数。

## 默认六组

先运行 A 与 `slots-1` 个 B 长任务，把所有槽位填满。A 首次退出并触发重试后再加入 C。

| 组 ID | 槽位 | A 首次 / 后续秒数 | B 数量 × 秒数 | 特殊条件 |
| --- | --- | --- | --- | --- |
| `control-two-slots` | 2 | 1 / 不重试 | 1 × 5 | 无重试对照 |
| `retry-two-short` | 2 | 0.5 / 0.1 | 1 × 4 | 双槽短任务 |
| `retry-two-long` | 2 | 2 / 0.1 | 1 × 6 | 原三任务场景 |
| `retry-four-slots` | 4 | 1 / 0.1 | 3 × 6 | 多个无关长任务 |
| `retry-eight-slots` | 8 | 1 / 0.1 | 7 × 6 | 八槽并发 |
| `retry-native-tail` | 2 | 1 / 0.1 | 1 × 8 | A 首次退出后，仍有自身子进程运行 3 秒 |

C 执行 0.2 秒。重试组的 A 使用真实流水线的三次尝试预算。重点断言：

- C 必须在全部 B 退出之前开始；不能仅检查“最终完成”。
- A 的三次尝试必须在 B 仍运行时结束；B/C 只领取一次，终态租约释放。
- native-tail 组中，A **必须**等自己的子进程退出才重试，但 C 必须能在该子进程和 B
  仍运行时启动。不能通过删除清空检查让测试通过。
- 所有组使用真实隔离边界，无任务进程清点或 SQL handoff 的 mock。

不设置“必须低于 100ms”一类机器相关门槛；判断实际开始/退出的先后关系。
这不是 CPU 吞吐、模型名额占用、上传延迟或云扩容压测。

## 环境条件

- Windows：PowerShell 7、Node.js 22+、npm、Git；一套有 root 权限的 WSL2 Linux。
- Linux/WSL：Python 3.11+、systemd、Docker Engine，**Docker daemon 必须在同一个 Linux
  主机运行**，并提供可写 cgroup v2。root 仅用于 host broker 与临时测试资源；业务容器
  仍为 UID 1000、cap-drop ALL、只读根目录、无网络外联。
- Docker Desktop 的 daemon 不在当前 WSL 的 PID/cgroup 主机上，不能直接用它执行此
  host broker 测试。应在专用 WSL 发行版或一次性 Linux VM 安装原生 Docker Engine，
  参照 https://docs.docker.com/engine/install/ 。不用 production 主机。
- WSL 发行版名字可指定；`AlmaLinux-10` 只是当前机器的默认值，不是团队必需名字。
- 在同一 Linux Docker Engine 预拉取 `postgres:16`；首次最小测试镜像构建也需要下载
  Node 基础镜像、Debian 与 npm 包。无个人固定基础镜像要求。

先在目标 Linux/WSL 终端确认：

```sh
id -u
ps -p 1 -o comm=
findmnt -n -o FSTYPE,OPTIONS /sys/fs/cgroup
docker info --format '{{.Name}} {{.CgroupVersion}}'
hostname
docker pull postgres:16
```

要求 root、systemd、`cgroup2` 且包含 `rw`，Docker 主机名与 `hostname` 一致、cgroup
版本为 2。无 systemd 的专用 Linux 可显式 `--no-systemd`/`-NoSystemd`，报告会记录
未验证 systemd sandbox；不要通过 privileged 或关闭产品 fail-closed 检查绕过条件。

## VS Code / Windows

在 **修复仓库**打开 VS Code，选择 PowerShell 7 终端，在仓库根目录运行：

```powershell
# 第一次：自动安装缺失的 npm 依赖、编译当前改动并构建独立镜像，运行六组。
.\tests\worker-barrier\run.ps1 -Distribution AlmaLinux-10

# 六组各重复三次，共18次独立场景。
.\tests\worker-barrier\run.ps1 -Distribution AlmaLinux-10 -Repeat 3

# 只运行原场景和带存活子进程的安全性场景。
.\tests\worker-barrier\run.ps1 -Group retry-two-long,retry-native-tail
```

团队已有兼容的本地 worker 镜像时，可以省去 Linux npm 下载：

```powershell
.\tests\worker-barrier\run.ps1 -BaseImage 'your-local-worker:tag'
```

`BaseImage` 必须在目标 WSL 的原生 Docker daemon 内存在，具备当前仓库兼容的 Node、
Python、依赖与工作目录。此模式沿用仓库 test-only overlay Dockerfile；不拉取任意
个人镜像、不发布产品镜像。默认模式不需要该参数。

构建网络需要组织包镜像时用 `-NpmRegistry https://your-approved-registry.example/npm/`；
保持 TLS 和 lockfile integrity 校验，不关闭证书校验。不要填写含凭据的 URL。

没有改代码、只是重复运行已构建版本时：

```powershell
.\tests\worker-barrier\run.ps1 -SkipBuild -Repeat 3
```

`-SkipBuild` 不重新编译或更新镜像，不能用来验证后续源码改动。新代码用普通命令。
镜像标签由 `-Image` 自定义，默认 `bondbuddy-worker-barrier:test`。同一标签构建/同一
工作区编译不要并行；场景默认串行隔离，不影响已运行的其他本地服务。
Windows worktree 的 `.git` 可能引用 Windows 路径；入口使用 Windows Git 获取准确 HEAD，
再作为报告元数据传给 Linux，不修改 `.git` 或工作区关系。

## 原生 Linux

在仓库根目录准备当前编译产物：

```sh
npm ci --no-audit --no-fund
for workspace in contracts domain rule-pack-registry rule-applicability-context api worker; do
  npm run build -w "@bondbuddy/$workspace" -- --declaration || exit 1
done
docker build -f tests/worker-barrier/Dockerfile -t bondbuddy-worker-barrier:test .
sudo python3 -B tests/worker-barrier/run.py --image bondbuddy-worker-barrier:test
sudo python3 -B tests/worker-barrier/run.py --image bondbuddy-worker-barrier:test --repeat 3
sudo python3 -B tests/worker-barrier/run.py --image bondbuddy-worker-barrier:test \
  --group retry-two-long --group retry-native-tail
```

Docker build 在 rootless daemon、不同主机或无可写 cgroup 的环境通过，不代表后续 host
broker 测试条件满足。Runner 会在执行前拒绝不匹配的 Docker host。

## 输出与判定

报告在 `tests/worker-barrier/.runtime/<时间-PID>/`，被 Git 忽略：

- `report.json`：每组状态、镜像 ID、HEAD、关键源码/编译产物 SHA-256、是否启用 systemd。
- `<组ID>-<次数>.json`：C 排队时间、A 尝试次数、sleep 子进程 PID/时间线、任务状态。
- `<组ID>-<次数>.log`：Node 原始 TAP 和合成事件。

仅所有选择的场景通过、测试期间源码指纹未变化，才退出 0 并报告 `PASSED`。
失败、缺证据、超时、环境不满足均为非零；不会把跳过视为通过。
正常结束与失败清理均通过已有夹具只处理本次创建的具名容器、网络和临时目录，
不执行全局 prune，不动应用测试库或生产资源。

查看报告示例：

```powershell
Get-ChildItem .\tests\worker-barrier\.runtime
Get-Content .\tests\worker-barrier\.runtime\<本次目录>\report.json
```

旧版与修复版的结论不能只按耗时比例比较；不同机器/环境存在开销差异。这里直接
证明“C 和 A 的重试是否仍被无关 B 挡住”。AppArmor enforce、真实模型、全量文档质量、
线上节点迁移及生产症状验收不在本测试范围内。

## 本次本地验证

2026-11-21 在当前未提交修复上，六组全部通过且无跳过。另从公开 Node 基础镜像与
lockfile 构建最小测试镜像，通过 `retry-two-long`、`retry-native-tail`，并将
`retry-eight-slots` 连续执行两次通过。最小镜像构建使用本机已批准的 npm 镜像，
未关闭 TLS 校验。各轮报告保留准确镜像、源码指纹和原始日志；测试输出不提交 Git。
这些结果仅验证上述合成并发断言，不替代生产镜像、AppArmor enforce 或专业成果验收。
