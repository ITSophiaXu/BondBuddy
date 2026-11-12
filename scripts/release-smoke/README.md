# 本地发布前五流程检查

`npm run test:release` 在独立的本地 Docker Compose 项目运行待发布版本，使用一个新建的 `release_test` 账号验证任丘九月募集书更新、东营复核、东营七题问答、东营诚信核查和固定五项底稿。五个独立项目串行执行：上一流程完成成果和账务核对后才提交下一流程。真实材料、网页、API、PostgreSQL、Azurite、worker、模型调用和浏览器下载都参与执行。不会修改生产环境或发送真实支付请求；初始测试积分明确为 synthetic。

本地 worker 启用异步上传确认消费者，在自身 parse 卷内使用独立、有界的暂存目录。上传检查等待同一原文件声明的最终 HTTP 200 并核对 material/upload ID、版本、持久时间、原文件名、字节数和 SHA-256；HTTP 202 仅表示已排队，不能当作材料已保存。等待预算与网页现有的十分钟确认预算一致。Windows 上传使用 Playwright 原始字节、文件名和 MIME，避免长路径在 Edge 中变成空文件；报告明确记录这项浏览器传输适配，不改样本字节。

问答募集书上传会自动采用并关闭弹窗。脚本先以项目当前稿、指定物料版本的 HTTP 200 持久记录和原文件名/大小/SHA-256 确认来源就绪，再刷新项目资料并重新加载页面核对相同版本。新浏览器恢复时，本轮材料可能尚未选入；问题识别完成后通过页面保存准备，提交回答前再核对服务端 draft.materials 包含准确来源 pin，刷新/重载后仍保持。来源可以由 QA API 解析到关联更新工作区，不强制等于导航项目。不等待消失的弹窗，也不以弹窗关闭作为成功。上传完成回执原校验仍保留；恢复已就绪来源不重复上传。

问题清单识别也有独立 prepare run。脚本在上传前监听实际请求及其接受回执，请求发出时先持久化 request ID 和来源 pin；回执到达后再保存 preparationId，随后等待原页面完成跳转和七题识别。已发出但回执丢失的请求保持未决，恢复不自动重传；已取得 preparationId 时，prepared=false 的恢复只读取原 prepare。候选 worker 默认有独立交互槽，两个长任务占用 general 槽不等于识别会被阻塞；识别现有 180 秒断言和运行总预算保持不变。

## 运行

需要 Node 22+、Git、Docker（Linux containers）、Compose、Buildx、Playwright 浏览器，以及可用于现有适配器的 Copilot 授权。Mac 可用 Docker Desktop / Colima，Windows 在 PowerShell 使用 Docker Desktop 的 WSL 2 Linux 后端；业务容器始终是 Linux。

Docker context 按环境变量 `BB_RELEASE_DOCKER_CONTEXT`、本机配置 `dockerContext`、恢复报告中记录的 context、`docker context show` 的顺序选择。接受本机 Unix socket 和 Windows 本机 named pipe，拒绝 SSH/TCP 远程 Docker 以及远程 named pipe。仅网页端口5288绑定在本机回环地址，数据库与存储不发布端口。

Mac 的一次性安装及运行：

```sh
npm ci
npx playwright install chromium
npm run test:release -- --ref HEAD
# 本机已有 Edge 时也可使用：
BB_RELEASE_BROWSER_CHANNEL=msedge npm run test:release -- --ref HEAD
```

Windows PowerShell 对应命令（先进入本机仓库目录）：

```powershell
npm.cmd ci
npx.cmd playwright install chromium
docker info --format '{{.OSType}}'  # 应为 linux
npm.cmd run test:release -- --ref HEAD
```

Windows 通过已有 Python 3.12+ 标准库的 Unicode 路径和 `tarfile.data_filter` 展开源码与样本，避免系统 `tar.exe` 跳过中文路径。默认使用 `python`，可设置 `$env:BB_RELEASE_TEST_PYTHON = 'C:\path\to\existing\python.exe'` 指定已有解释器；脚本不安装软件。整份归档先检查路径，拒绝越界、盘符/ADS、Windows设备名、链接和特殊文件，保留每个普通文件的原始字节。Mac/Linux继续使用本机tar。主机子进程只保留启动所需的系统环境，不继承业务数据库/支付/模型或远程 Docker 变量。挂载使用 Compose 的长格式，支持盘符、空格及中文路径。本次私有运行目录与 OAuth 副本使用 Windows ACL 限定为当前用户和 SYSTEM；Mac 使用原有文件权限。脚本不修改原凭据文件权限。 Windows 续跑会先核验运行目录的 owner、受保护 DACL、当前用户和 SYSTEM 的完整权限及继承范围；已完全符合时不重复写 ACL，避免无实际变更却请求系统审计特权。不符合时仍须收紧并复核，失败即拒绝续跑，不跳过权限检查。

使用仓库 `deploy/m1/Dockerfile` 的正式 api/worker/web targets，从固定 Git commit 的 archive 构建，不包含工作区未提交的产品代码。报告记录 SHA、tree、镜像 ID、样本 hash、任务 ID 和下载文件 hash；发布时应使用本次验证过的镜像。改动产品代码后先提交，再验证新的提交。

源码和样本归档均以单次 Git 命令的 `core.autocrlf=false`、`core.eol=lf` 覆盖宿主换行配置，避免 Windows 将 Linux helper 的 shebang 改为 CRLF；不修改用户/仓库 Git 配置，也不在解包后重写文件。归档文件按 Git 中固定的内容提取，样本另按既有 manifest 核对 SHA-256。

不带 `--ref` 时要求工作区干净，避免用旧提交的通过结果误认未提交修改已通过。显式 `--ref` 表示只验证指定提交；报告始终写出解析后的完整 SHA。

默认构建本地 Docker 引擎的原生架构；本机 Apple Silicon 为 `linux/arm64`，常见 Windows x64 机器为 `linux/amd64`。需要指定架构时用本机 JSON 配置 `"platform": "linux/amd64"`，或设置 `BB_RELEASE_PLATFORM`；非原生架构需要引擎提供对应仿真。报告记录实际镜像架构，不把一种架构的结果冒充另一种架构已经验证。

依赖网络受限时，可显式设置 `BB_RELEASE_NODE_IMAGE` 为已经存在的本地Node依赖基底，使用正式Dockerfile的 `NODE_IMAGE` 参数；报告记录镜像引用及ID，并在构建前后核对ID未变。该镜像应来自可信来源，只配置无认证的包源，不包含凭据，不关闭TLS。脚本不自动寻找或切换镜像，也不修改主机网络。

若该镜像含已核验的官方同版本Codex包，可同时设置 `BB_RELEASE_CODEX_TARBALL_IN_NODE_IMAGE=/opt/.../openai-codex-版本-架构.tgz`。脚本仅在固定候选的下载语句唯一匹配且SHA512/CLI版本检查仍存在时，生成临时Dockerfile，把 `npm pack` 改为复制该包；原完整性和版本检查继续执行，原Dockerfile与源码归档不改写，专用Dockerfile忽略规则保留。报告记录缓存路径及原/实际Dockerfile的SHA256，不能将这次依赖适配构建称为默认Dockerfile成功。

Python包源可显式设置 `BB_RELEASE_PIP_INDEX_URL` 为无认证、无查询参数的HTTPS地址，通过正式Dockerfile已有的 `PIP_INDEX_URL` 参数传入并记录。以上三个选项仅通过环境变量启用，不存储令牌、不安装主机软件，未配置时保持默认获取路径。一次本地示例：

```powershell
$env:BB_RELEASE_NODE_IMAGE = 'existing-local-node:tag'
$env:BB_RELEASE_CODEX_TARBALL_IN_NODE_IMAGE = '/opt/cache/openai-codex-0.167.0-linux-x64.tgz'
$env:BB_RELEASE_PIP_INDEX_URL = 'https://your-approved-feed.example/pypi/simple/'
```

默认模型沿用现有适配器 `copilot_enterprise / gpt-6-sol / max`，凭据默认读取当前用户的 `~/.local/share/copilot-api/github_token`，可用 `copilotOAuthFile` 或 `BB_RELEASE_COPILOT_OAUTH_FILE` 指定已有 OAuth 文件。Windows 推荐明确配置实际文件路径，例如 `C:/Users/your-name/.bondbuddy-test/copilot-oauth`。这是 Copilot OAuth 文件，不是任意厂商 API key；测试人员应由项目负责人按现有安全方式取得可用凭据，不在聊天或命令行粘贴令牌。

默认通过正式 credential helper 交换短期令牌，不要求安装本机 Copilot API 代理、不修改代理配置、不静默切换模型。凭据不进入镜像或 Git，运行目录受本机文件权限保护。模型调用会使用该账号的额度。

已获准使用本机现成 Copilot 凭据时，可显式设置 `BB_RELEASE_COPILOT_AUTH_FILE` 或本机配置 `copilotAuthFile`，指向含非空 `OPENAI_API_KEY` 的私有 Codex auth JSON。它优先于 OAuth 文件；没有显式设置时仍走原 OAuth 路径，OAuth 换票失败不会自动切换。JSON 必须为对象，密钥必须为不含空白或控制字符的 ASCII 字符串；解析错误不会回显原值。只将这一字段复制到受私有权限保护的运行目录，不复制其他认证信息，不修改原文件。

该选项只读挂载本地 command helper，保持 `copilot_enterprise / gpt-6-sol / max`、专用工具 catalog 和沙箱配置。不要改成通用 auth-file 模式。报告记录 `credentialMode`、helper SHA-256，并明确正式 OAuth 换票未经验证；不能把本地功能测试通过称为正式换票通过。恢复时沿用原报告模式并核对 helper 散列与只读挂载，不根据新配置切换凭据路径。令牌不得写入聊天、命令参数、Git 或日志。

网络需要本地代理时，显式设置容器内可访问的 `BB_RELEASE_HTTP_PROXY`（例如 Colima 的宿主地址 `http://192.168.5.2:10808`）。它用于依赖下载及模型请求，数据库/存储走内部网络。不要填写带用户名或密码的代理 URL。必须安装并启用 Docker Buildx，旧 builder 不支持此仓库的 Dockerfile 专属忽略规则，脚本会提前拒绝。

本机固定设置可保存到已忽略的 `scripts/release-smoke/.local.json`，之后直接运行 npm 命令。可用字段为 `dockerContext`、`httpProxy`、`platform`、`copilotOAuthFile`、`copilotAuthFile`；环境变量优先。不把令牌内容写入此文件。例如本机 Colima 配置：

```json
{"dockerContext":"colima-bondbuddy-release","httpProxy":"http://192.168.5.2:10808"}
```

上面的 `192.168.5.2` 是这台 Mac 的 Colima 宿主地址，不是通用 Windows 地址。Windows 示例可只写：

```json
{"copilotOAuthFile":"C:/Users/your-name/.bondbuddy-test/copilot-oauth"}
```

脚本接受 Windows PowerShell 生成的 UTF-8 BOM 配置文件。除明确设置的配置外，不会复制其他人的网络、用户目录或凭据位置。

Mac 使用专用 Colima 时，重启后如 VM 未运行，先执行 `colima start --profile bondbuddy-release --activate=false`。Docker Desktop 用户打开应用并确认 Linux 引擎已启动即可。不需要在 Windows 安装 Colima。

启用 AppArmor 的 Colima 实例会加载该候选版本的 `bondbuddy-codex-v1` 配置；其他 Linux 引擎须预先按仓库脚本安装该配置。缺少配置时拒绝启动 worker，不改用 privileged/unconfined。worker采用仓库integrity-browser-seccomp.json并启用init，保留只读根目录、cap_drop ALL、no-new-privileges、Codex文件权限和proc mount额外限制，不使用unconfined或额外capability。

样本来自既有授权批次：9 月任丘九月，以及 PR #903 的固定数据提交 `6480f7c1bda41e3d49dc757e1b305de21de4edfa` 中的东营原件。后者无需合并产品代码；本地需要已有该 Git object（缺少时先 `git fetch origin codex/regression-samples-20261105`）。每次复制后校验 SHA-256，原件不裁剪、不改写，源生产 ID 不重放。

这是使用真实原件新建的基础流程：任丘目标为 2023、2024 年度及 2025 年 1–9 月，原稿截至 2025 年 6 月；东营复核走当前默认完整复核，问答使用原七题。没有恢复原账号的历史报价、暂停状态或补充要求，不宣称精确重放旧任务。

## 判定与证据

单次文件编制预算与正式适配器及部署Compose一致为5小时。文件编制允许首轮及最多两轮篇幅修复，共3次；它使用text输出，不叠加JSON schema重问。因此本地业务监测预算为3×5小时+30分钟收尾=15.5小时（55,800,000ms）。这是严格上限，不是完成时间预测，也不增加产品重试次数；失败、暂停、模型超时或成果检查失败仍不能通过。

报告在启动前保存 `executionBudget` 和 `flowBudget`，监测开始时保存suite及各case的原始绝对截止时间。更新15.5小时；复核、诚信、底稿各5.5小时；问答按七题、每题最多一次schema重问的十分钟调用及30分钟收尾，合计170分钟。底稿共享一次编制计划，不能把五文件解释为五次编制调用。suite预算为五条之和；这些有限监测预算不增加产品重试次数，也不是完成时间承诺。resume核对原预算、Compose及实际worker单次超时一致，沿用各自绝对截止时间；过期不提交其他用例。缺少原预算的旧报告拒绝自动续跑，原任务保留，不能据此重建付费任务。到期只结束测试监测并记失败，不终止原业务任务或触发新的模型调用。

- 五条流程全部完成、所有必需成果和刷新下载通过、报价/冻结/结算/钱包核对一致，才返回 0。旧三流程、缺项或重复项报告均拒绝。
- 任一失败、暂停、超时或未执行均返回非零；`report.json` 保留每项状态和原因。
- 更新检查双 Word；复核检查报告；问答检查七个问题都有可见内容和回答 Word。每个角色刷新后独立再次下载，全部副本保留并要求hash一致。
- 诚信核对一个发行人及信用中国、失信被执行人、被执行人、证监会、上交所五站。真实查询记录、结果capture下载hash与数据库有效pair必须一致；全阻断/失败/未经核验不能通过。未知代码/地区留空，不预设无失信结论。
- 底稿使用原f009目录中的2-1-4、2-3-6、2-4-2、1-5-7-1、1-5-5五项，不代表原目录1的全量。保存原recipe及本次明确五项范围；batch complete、五项全部成功、ZIP全部DOCX的路径和hash对应可信API映射才通过。缺资料说明不得伪造记录，说明免费。
- 所有ZIP普通文件CRC、XML、关系和正文在同一固定API镜像内断网只读校验；采用现有有界流式解析，保留原大小和膨胀限制。结构检查不替代内容/版式/人工审核。
- HTTP明确采用int64十进制字符串，完整分页；隔离库只读事务核对原报价、所有底稿attempts、事件、积分lot、钱包差额。刷新下载不得新增扣费。v4诚信按实际验证pair核对，不强套旧版本价格。
- 这是基础功能冒烟检查，不声称验证了全部财务数字、专业结论、全部排版、收费渠道、跨账号权限或浏览器兼容性。
- `.runtime/<时间>/` 内保存报告、截图、trace、日志和成果，均为本地私有数据，不提交 Git。trace 会包含这个测试账号的会话，只在受控本机查看。

任务已提交后不自动重建或重试模型。保留独立容器供诊断，可以按报告目录继续检查原任务：

```sh
npm run test:release -- --resume /absolute/path/to/scripts/release-smoke/.runtime/<run>
```

`--resume` 跳过已经通过的用例，已记录 run ID 的用例只读取原任务并重试成果检查。实际POST发送时先保存request ID/原字节hash，接受后立即保存run/batch ID。回执丢失拒绝自动重提，已接受任务只读回原任务；错误与每次attempt证据保留。继续检查前自动保存报告副本，每次尝试使用独立证据目录，保留原始失败和 trace。

全部通过后自动清理本次容器和测试卷，保留本机报告、trace、下载成果和镜像缓存，释放 5288 端口供下次执行。需要手动查看测试账号时加 `--keep`。清理失败会返回非零，报告仍保留各业务流程已通过的事实。

失败或未完成时保留环境，不自动停止业务任务。此时先用 `--resume` 继续检查原任务；不要直接另开一次测试抢占相同端口。确认无需保留后，使用报告中的准确 project 和该次 Compose 文件清理：

```sh
DOCKER_CONTEXT=colima-bondbuddy-release docker-compose -p <report.project> -f <run>/compose.json down --volumes
```

不要使用全局 prune。当前脚本只提供发布前检查及退出码，不自动发布或更改生产部署规则。

## 验证状态

原Windows三流程在固定f298bc80候选已跑通；其原报告、失败和后续结构诊断分别保留，不能拼接为新五流程通过。五流程实现的无模型单元和实际隔离账务只读查询已验证；最终固定候选真实五流程报告应以本次.runtime实际运行结果为准。脚本本身不签发专业人工验收，也不自动部署。
