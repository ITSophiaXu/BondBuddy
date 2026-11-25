# BondBuddy 本地测试文档（Windows / Mac / Linux）

只需这三个文件：本说明、`requirements.txt`（主机安装依赖）、`configuration.example.json`（节点配置）。
业务代码使用自己的 BondBuddy 仓库，不需要之前的脚本包，不包含账号、材料或凭据。

## 1. 环境搭建

Windows 和 Mac 都可以作为本地测试主机，**业务容器和三节点资源限制统一运行在 Ubuntu 内**：

| 自己的电脑 | 运行方式 | 后续命令在哪里执行 |
|---|---|---|
| Windows 11 | WSL2 Ubuntu 24.04 | Ubuntu 终端 |
| Mac（Intel / Apple Silicon） | 本地 Ubuntu 24.04 虚拟机 | 虚拟机 Ubuntu 终端 |
| Linux | Ubuntu 24.04 原生运行 | Ubuntu 终端 |

本文是**三节点资源模拟 + 人工业务测试**，不是三台真实服务器。
Windows PowerShell / macOS Terminal 本身不能直接创建 Linux systemd slice，
也不能将本文配置直接交给 Docker Desktop 的 daemon。
单纯给三个容器设置内存，不能替代 A 节点全部服务的合计资源限制。

完整配置的业务内存上限合计 24 GiB。建议给 Linux 环境至少 **28–32 GiB 内存、
8 个逻辑 CPU、80 GiB 可用磁盘**，主机还要给 Windows/macOS 留资源，
因此推荐物理内存 48 GiB 或以上。32 GiB 主机可尝试但资源较紧，
16 GiB 主机不适合原额度三节点压测。

### Windows：准备 WSL2

在**管理员 PowerShell** 安装发行版；如提示重启，先重启：

```powershell
wsl --install -d Ubuntu-24.04
wsl --list --verbose
```

确认 Ubuntu 的 VERSION 为 `2`；否则对刚安装的发行版执行：

```powershell
wsl --set-version Ubuntu-24.04 2
```

从开始菜单打开 **Ubuntu 24.04**，创建自己的 Linux 用户。以下都在 Ubuntu 中执行。
检查 systemd 是否为 PID 1：

```bash
ps -p 1 -o comm=
# 预期：systemd
```

如果不是，在 Ubuntu 中执行 `sudoedit /etc/wsl.conf`，保留已有配置，
新增或修改 `[boot]` 下的 `systemd=true`：

```ini
[boot]
systemd=true
```

更改后需重启该 WSL 发行版才生效。**先保存所有 WSL 工作、停止相关任务**，
再退出并重启发行版；不要为了应用设置直接关闭承载其他工作负载的 WSL。

WSL 分配给 Linux 的内存可能远小于物理内存，可用 `free -h` 和 `nproc` 检查。
如需调整，在 Windows 的 `%UserProfile%\.wslconfig` 中合并以下示例，
不要覆盖已有设置；具体值按自己的主机容量调整：

```ini
[wsl2]
memory=32GB
processors=8
localhostForwarding=true
```

这个文件影响共享 WSL2 虚拟机，不是只影响本项目；重启应用前需协调其他 WSL 工作。
若有 Docker Desktop，关闭它对**本测试发行版**的 WSL integration，
在该 Ubuntu 内安装下一节的原生 Docker，避免连接错 daemon。
仓库和三个文档建议放在 Ubuntu 的 `~/` 下，而不是 Windows 同步盘。
Windows 文件可在资源管理器 `\\wsl.localhost\Ubuntu-24.04\home\<Linux用户名>\` 中复制进去。

### Mac：准备本地 Ubuntu 虚拟机

使用支持完整 Ubuntu 虚拟机的工具，例如 [UTM](https://mac.getutm.app/)。
这里选一台 Ubuntu VM，再在里面划分三个模拟节点；不需要创建三台 VM。

1. 从 [Ubuntu 官方下载页](https://ubuntu.com/download/server) 获取 Ubuntu Server 24.04 LTS。
   Intel Mac 选 `amd64`，Apple Silicon（M 系列）选 `arm64`；不要为了性能测试强制跨架构仿真。
2. 在虚拟机工具中创建 **Virtualize / Linux** 虚拟机，挂载对应安装镜像。
   建议分配 8 vCPU、28–32 GiB RAM、至少 100 GiB 虚拟磁盘，并确保宿主机有足够实际空间。
3. 安装 Ubuntu，创建用户；网络使用可联网的 NAT/共享模式即可。
   为后面的浏览器访问安装 OpenSSH Server，可在安装界面勾选或安装后执行
   `sudo apt-get update && sudo apt-get install -y openssh-server`。
4. 通过虚拟机控制台进入 Ubuntu。后续仓库、三个文档、依赖和 Docker 都放在虚拟机里，
   不要使用 Mac 上的 Docker context，也不要把含密钥的运行目录同步回共享目录。

固定历史 Dockerfile 为 Codex 提供了 `amd64` / `arm64` 分支，但**本文没有在 Mac、
Apple Silicon 或其完整模型链路上实测**。镜像依赖、内核隔离和模型调用仍需在自己的 VM
验收；ARM 上的结果不能直接与之前 x86 WSL 的 CPU 秒/耗时作等价比较。

### 共同准备

Ubuntu 内需启用 systemd，Docker 使用 cgroup v2 / systemd driver。
测试期间保持 WSL 终端或 Mac 虚拟机运行；休眠/暂停会影响任务耗时和模型连接，
不要将这样的区间计作连续压测。

将这三个文件放到 `~/bond-simulation-guide`，进入该目录：

```bash
cd ~/bond-simulation-guide
export GUIDE="$PWD"
```

### 安装依赖

无论 Windows、Mac 还是 Linux，下面的安装命令均在 **Ubuntu 内**执行，
不要在 PowerShell 或 macOS 的 zsh 中运行 `apt-get`。
`requirements.txt` 是 **Ubuntu apt 软件包清单，不是 pip 的 Python 依赖文件**，
也不是用来安装 Windows/macOS 宿主机软件的。
应用自身的 npm/Python 依赖由仓库 Dockerfile 安装，不需要在主机手工安装。

首次安装先配置 Docker 和 Node.js 22 软件源；已有相同环境可跳过：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  sudo gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg /etc/apt/keyrings/nodesource.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" |
  sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
sudo apt-get update
grep -vE '^[[:space:]]*(#|$)' requirements.txt | xargs sudo apt-get install -y
sudo systemctl enable --now docker
```

以下命令使用当前用户访问 Docker。如 `docker info` 提示权限不足，按 Docker 官方方式
将本人加入 docker 组，再重新登录；**docker 组权限等价于 root**：

```bash
sudo usermod -aG docker "$USER"
# 重新登录/重新打开终端后，重新设置 GUIDE，再检查：
node --version                         # 22 或以上
docker compose version                 # 至少 2.24.4
docker buildx version
docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}'
# 最后一条必须输出：2 systemd
```

### 准备独立业务代码和镜像

先按团队方式取得私有仓库权限，并在 Ubuntu 内取得自己的仓库副本
（Mac 虚拟机里的路径不是 Mac 宿主机上的路径）。
下面将自己的仓库克隆为**全新实验目录**，
不会携带原工作区未提交的修改。不要使用正在运行其他测试的 checkout。

```bash
git -c core.autocrlf=false clone --no-local /你的本地仓库/BondBuddy ~/bond-three-node-lab
cd ~/bond-three-node-lab
git config core.autocrlf false
git config core.eol lf
git checkout --detach f67087628c64ea753014f32b80b4a6f17ec5ca7b
node scripts/local-prelaunch/build.mjs
```

固定的是之前测试使用的历史版本，不是当前 develop。找不到该 commit 时，
先在原仓库按团队流程获取；不要随意换版本后假定此配置仍兼容。

## 2. 配置节点和模型

打开 `configuration.example.json`。主要配置含义：

| 配置位置 | 默认值 | 含义 |
|---|---|---|
| `x-simulated-nodes.a` | 4 CPU / 16 GiB | A 节点所有业务容器的合计资源上限 |
| `x-simulated-nodes.b/c` | 各 2 CPU / 4 GiB | B/C 节点各自的合计资源上限 |
| `services.worker.environment.BB_WORKER_CONCURRENCY` | 2 | A 生成 Worker 并发 |
| `services.worker-b/c.environment.BB_WORKER_CONCURRENCY` | 各 2 | B/C 生成 Worker 并发 |

A 放 API、数据库、Blob、Web、解析/复核/生成 Worker 及辅助服务；B/C 各放一个生成 Worker。
节点总额度由父 cgroup 限制；容器自身的 `deploy.resources.limits` 是额外子上限，
不是再增加资源。保留示例的 slice 名称；如提高节点资源，同时检查容器子上限。
主机系统、Docker daemon、浏览器和构建不在这三个业务节点预算内。

**简版保留历史源码支持的全局模型上限 4**，所以 `2+2+2=6` 个生成任务槽，
不等于 6 个模型能同时调用。此前 27 项测试使用过模型许可 20 的临时 JS/数据库补丁，
这三个文件不包含该补丁，也不声称完整复现那批任务。复核服务仍另有自身槽位。

### 使用同事自己的 Copilot 授权

本节使用历史仓库自带的 `copilot_enterprise` 适配器，不使用普通 API Key。
每位同事必须有自己获准使用的 Copilot 账号、模型权限，并通过团队批准的授权流程
取得该适配器可用的 **OAuth access token**。不能用别人的 token，也不能拿普通 GitHub PAT 代替。
组织是否允许这种预生产调用方式，应先由账号/平台管理员确认。

**在 Copilot App、VS Code 或 CLI 登录，不代表容器会自动继承登录状态。**
这个固定版本只读取指定的纯文本授权文件，没有“一键登录并导出”的实现；
仓库也没有提供通用的授权获取命令。若团队尚未提供批准的获取方式，
应先找管理员完成授权，不能根据文档假定已具备可用凭据。
不要从系统凭据库、其他人的配置或浏览器 Cookie 中提取凭据。

认证链路为：

```text
本人获准使用的 OAuth 文件（宿主 Ubuntu）
  → 只读挂载 /run/secrets/bb-copilot-oauth
  → 镜像自带 bb-copilot-token 换取短期令牌
  → Codex 调用 Copilot 模型
```

仓库实现说明见 `docs/runbooks/copilot-model-provider.md`。
它使用 `api.github.com/copilot_internal/v2/token` 换取短期令牌，
不是承诺稳定的通用公开模型 API。若组织策略、接口或模型可用性变化，
需先核实兼容性；不要通过更换别人凭据或取消权限检查绕过。

**第一步：在运行 Docker 的 Ubuntu 内存放自己的授权文件。**
Windows 用户在 WSL 内操作，Mac 用户在 Ubuntu VM 内操作；不是在宿主 Windows/Mac 上建文件。
固定使用以下私有目录，不放进仓库、网盘或三个分享文件中：

```bash
sudo install -d -m 0700 /var/lib/bondbuddy-local-secrets
# 仅在该文件不存在时创建；已有文件不得用 /dev/null 覆盖：
if ! sudo test -e /var/lib/bondbuddy-local-secrets/copilot-oauth; then
  sudo install -m 0600 /dev/null /var/lib/bondbuddy-local-secrets/copilot-oauth
fi
sudoedit /var/lib/bondbuddy-local-secrets/copilot-oauth
# 编辑器内只保存本人获准使用的 OAuth token：单行纯文本，无引号、无 JSON。
sudo chown 1000:1000 /var/lib/bondbuddy-local-secrets/copilot-oauth
sudo chmod 0400 /var/lib/bondbuddy-local-secrets/copilot-oauth
sudo test -s /var/lib/bondbuddy-local-secrets/copilot-oauth
```

容器中的模型进程使用 UID 1000，所以文件必须对该 UID 可读。
不要把 token 放到 shell 命令参数、聊天、截图或环境变量中。
若 `sudoedit` 拒绝编辑已属于 UID 1000 的文件，请由管理员按本机 sudo 策略安全更新，
不要通过放宽目录权限解决。上面的大小检查只证明文件非空，不证明授权有效。

**第二步：配置环境变量。** 构建后生成的私有模型配置位于：

```text
~/bond-three-node-lab/.local/local-prelaunch/model.env
```

在该文件中设置以下整组参数（只有路径，不填写 token 内容）：

```dotenv
BB_CODEX_AUTH_MODE='copilot_enterprise'
BB_COPILOT_OAUTH_HOST_FILE='/var/lib/bondbuddy-local-secrets/copilot-oauth'
BB_CODEX_CREDENTIAL_ENV=''
DEEPSEEK_API_KEY=''
BB_CODEX_PROVIDER='copilot_enterprise'
BB_CODEX_BASE_URL='https://api.enterprise.githubcopilot.com'
BB_CODEX_MODEL='gpt-6-sol'
BB_CODEX_REASONING_EFFORT='max'
BB_CODEX_CONFIG_VERSION='local-copilot-gpt6-max-v1'
BB_OPS_PROVIDER_BALANCE='off'
BB_EGRESS_ALLOW='api.github.com api.enterprise.githubcopilot.com'
```

不能同时配置 `BB_CODEX_AUTH_FILE` 或其他 API Key 认证方式；历史适配器对模型、
地址和 `max` 参数有固定校验，不支持随意改一项。本例使用本地 Azurite，
不需要增加云端 Blob 域名；若另有获批外部依赖，必须单独配置精确域名，
不能用 `*` 或绕过 egress 代理。

**第三步：按第 3 节生成本地配置并启动。** 仓库 Compose 已实现
`BB_COPILOT_OAUTH_HOST_FILE` 到 `/run/secrets/bb-copilot-oauth` 的只读文件挂载，
无需额外新增第四个配置文件。A、B、C 生成 Worker 和复核 Worker
使用同一位使用者在本机配置的授权，共享该账号的额度/策略限制；
全局模型并发 4 并不代表账号有无限额度。

原作者的历史测试还挂载过本机定制的 `local-copilot-token.mjs`，
**同事版不复制该辅助程序或作者凭据**，使用固定仓库镜像自带的 token exchange helper。
因此这里只复现认证配置方法，不声称与作者当时的定制令牌链路完全相同。
不要提交或分享授权文件、`model.env`、`.local/`、数据库或材料。

## 3. 应用配置并运行

下面都在 `~/bond-three-node-lab` 的**同一个终端**执行。
先将节点总额度应用到 systemd 父 slice；这个步骤读取示例文件中的 CPU/内存，
不是只写一份不会生效的配置：

```bash
export BB_SIMULATION_CONFIG="$GUIDE/configuration.example.json"
node --input-type=module <<'JS'
import {readFileSync} from "node:fs";
import {execFileSync as run} from "node:child_process";
const nodes = JSON.parse(readFileSync(process.env.BB_SIMULATION_CONFIG))["x-simulated-nodes"];
for (const n of Object.values(nodes)) {
  const unit = n.slice.replace(/\.slice$/, "") + "-anchor";
  const active = run("systemctl", ["list-units", "--all", "--plain", "--no-legend", unit + ".service"], {encoding:"utf8"});
  if (!active.trim()) run("sudo", ["systemd-run", "--quiet", "--unit=" + unit,
    "--slice=" + n.slice, "--property=Type=oneshot", "--property=RemainAfterExit=yes", "/bin/true"], {stdio:"inherit"});
  run("sudo", ["systemctl", "set-property", "--runtime", n.slice,
    `CPUQuota=${Number(n.cpus)*100}%`, `MemoryMax=${Number(n.memoryGiB)}G`, "MemorySwapMax=0"], {stdio:"inherit"});
}
JS
```

定义一个终端快捷命令，复用仓库原有启动依赖；不用另存脚本：

```bash
export BB_SIMULATION_BASE="$PWD/.local/local-prelaunch/simulation-base.json"
node --input-type=module <<'JS'
import {writeFileSync} from "node:fs";
import {readConfig} from "./scripts/local-prelaunch/config.mjs";
import {compose} from "./scripts/local-prelaunch/runtime.mjs";
const result = await compose(readConfig(), ["config", "--format", "json"]);
writeFileSync(process.env.BB_SIMULATION_BASE, result.stdout, {mode:0o600});
JS

bbcompose() {
  node --input-type=module -e '
    import {readConfig} from "./scripts/local-prelaunch/config.mjs";
    import {compose} from "./scripts/local-prelaunch/runtime.mjs";
    const r = await compose(readConfig(), ["-f", process.env.BB_SIMULATION_CONFIG, ...process.argv.slice(1)]);
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  ' "$@"
}

bbcompose config --quiet
bbcompose up -d --no-build --wait --wait-timeout 180
bbcompose ps
curl --fail http://localhost:18087/api/v1/ready
```

确认每个 Worker 能读取挂载文件，但**不要运行会向终端输出令牌的 helper**：

```bash
bbcompose exec -T worker sh -c 'test -r /run/secrets/bb-copilot-oauth && test -s /run/secrets/bb-copilot-oauth' &&
bbcompose exec -T worker-b sh -c 'test -r /run/secrets/bb-copilot-oauth && test -s /run/secrets/bb-copilot-oauth' &&
bbcompose exec -T worker-c sh -c 'test -r /run/secrets/bb-copilot-oauth && test -s /run/secrets/bb-copilot-oauth' &&
bbcompose exec -T worker-review sh -c 'test -r /run/secrets/bb-copilot-oauth && test -s /run/secrets/bb-copilot-oauth'
```

上述检查不校验 OAuth 是否过期、是否具备模型权限或能否成功换取短期令牌。
先手动提交一项小任务验证，并检查实际任务状态、认证错误和用量；
不要批量提交后才检查授权。不要把 helper 的 stdout、`docker inspect` 全量环境
或展开后的 Compose 配置贴给其他人。
如认证失败，先由本人/管理员检查账号授权、文件读取权限和出站域名；
如出现 429 则检查账号/供应商速率额度。不要盲目重试结果未知的旧模型调用。

`simulation-base.json` 是生成在私有 `.local/` 内的完整本地配置，
供 B/C Worker 继承镜像、数据库、卷和安全设置；**其中可能有密钥，不能分享**。
更改模型配置或重建镜像后，需在空闲时重新生成它。对外始终只有本目录三个文件。

默认地址是 **http://localhost:18087**。先确认该端口及 `10.238.87.0/24` 子网未被其他环境占用；
若已占用，请换干净的机器/发行版，不要关闭或复用别人的环境。
空库启动后在网页注册、使用标明 synthetic 的模拟充值、上传自备材料。
手动开始生成才消耗自己的模型额度；API ready 不代表模型或文档质量已验收。

### 从 Windows / Mac 浏览器访问

- **Windows + WSL2**：在 Windows 浏览器打开 `http://localhost:18087`。
  若失败，先在 Ubuntu 执行上面的 `curl`；Ubuntu 内正常而 Windows 不通时，
  检查 WSL localhost forwarding 和本机端口占用，不要把 Web 改为公网监听。
- **Mac + Ubuntu VM**：Mac 的 localhost 不自动等于 VM 的 localhost。
  配置虚拟机 SSH 端口转发，然后在 Mac 终端建立下面的隧道，保持终端打开，
  再用 Mac 浏览器打开 `http://localhost:18087`。

Mac 的 SSH 接入方式二选一，按虚拟机工具实际网络设置操作：

```bash
# 方式一：VM 的 IP 能从 Mac 直接访问；替换用户名和 IP：
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18087:127.0.0.1:18087 ubuntuuser@VM_IP

# 方式二：虚拟机工具配置 Mac 127.0.0.1:2222 -> VM TCP 22：
ssh -N -o ExitOnForwardFailure=yes -p 2222 \
  -L 127.0.0.1:18087:127.0.0.1:18087 ubuntuuser@127.0.0.1
```

不要同时运行两条；确保 Mac 的 18087 未占用。首次连接核对虚拟机 SSH 主机指纹，
不要禁用 host-key 检查。SSH 只转发 Web 入口，不开放 PostgreSQL / Blob。
网页的 Origin 仍为 `http://localhost:18087`，不能随意换成 VM IP 绕过来源校验。

## 4. 本地测试步骤

| 步骤 | 操作 | 关注点 |
|---|---|---|
| 环境检查 | 查看 `bbcompose ps`、调用 ready 接口 | 服务就绪，不等于模型已可用 |
| 单任务验证 | 注册新账号、模拟充值、上传授权材料，手动开始一项生成 | 模型认证、任务状态、Word 能下载；产生真实模型费用 |
| 并发测试 | 单任务通过后，手动同时提交多项 | 三个生成 Worker 各 2 槽；模型全局上限仍为 4 |
| 资源观察 | Ubuntu 内运行 `docker stats --no-stream`，并检查父 slice | 容器开销、节点合计内存、OOM；不把 queued 时间当执行时间 |
| 停机保留 | 全部任务/诊断结束后按下一节停机 | 不删除卷、不强制取消模型 |

查看节点合计的当前资源和额度（Ubuntu 内）：

```bash
systemctl show bbdemoa.slice bbdemob.slice bbdemoc.slice \
  -p Id -p CPUQuotaPerSecUSec -p CPUUsageNSec -p MemoryCurrent -p MemoryMax
```

CPU 计数为该 slice 生命周期累计值，计算本轮消耗应取前后差值；
不同架构、休眠、重启或采样缺口都要单独记录。不要以一张 `docker stats` 截图代表整轮峰值。
本说明不自动提交任务、不导入历史测试账号/材料，也不连接线上数据库。

## 5. 调整并发和停机

等所有业务任务及后台 Word 诊断结束后，修改配置中三个生成 Worker 的并发，
例如各改成 `3`，再执行：

```bash
bbcompose up -d --no-build worker worker-b worker-c
bbcompose ps
```

可按各 2、3、4 槽做人工测试，但仍受模型总上限 4 和 API 全局/每用户 12 项准入限制。
若有失败、暂停或 OOM，先停加压、查日志，不自动重试或取消任务。

停机前关闭其他提交任务的客户端，用仓库只读探针确认空闲，再停止本配置里的全部服务：

```bash
node --input-type=module -e '
  import {readConfig} from "./scripts/local-prelaunch/config.mjs";
  import {docker,assertIdleWorkload} from "./scripts/local-prelaunch/runtime.mjs";
  const c=readConfig();
  assertIdleWorkload(await docker(["exec",c.projectName+"-api-1","node","/app/scripts/local-prelaunch/probe.mjs","idle"]));
' && bbcompose stop
```

**不运行 `down -v` 或 prune**，数据保留。示例禁用容器自动重启；
主机/WSL/虚拟机重启后重新应用父 slice 额度再启动。新终端还需重新设置 `GUIDE`、
`BB_SIMULATION_CONFIG`、`BB_SIMULATION_BASE` 并定义 `bbcompose`，
按第 3 节执行；不要直接运行原单栈的 `start.mjs`，
否则 B/C 和三节点资源配置不会一起应用。以上示例只在本人独立本地环境使用，
不要在同一 Docker daemon 上同时部署两份使用相同 slice 名称的模拟环境。
