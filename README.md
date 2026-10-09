# 募集书 Cowork

> BondBuddy 测试执行：见 [Test Plan v6 执行入口](docs/testing/bondbuddy-test-plan-v6/README.md)。先完成受控用户测试准入U的Agent七包和Human短预检；完整发布验收并行推进，当前结果尚未执行。

> 2026-09-30 [最新产品范围](docs/product-decisions/2026-09-30-m1-simplification.md)：M1 两类自带稿＋手填原市场/品类/报告期＋末尾补充要求；M2 仅增加相关付费且无余额退款/用户消费记录页；库推荐/维护归 M3。旧聊天、自动源识别及库依赖须迁移，正文工程历史不代表新范围已实现。进度/成果展示方案待布局确认。

> M1 网页版项目工作台：见 [apps/web 启动与交接说明](apps/web/README.md)。这是接真实 `/api/v1` 的 #10 首个切片，与下文旧 Cowork 应用独立。

> 新产品设计交接：请查看 [设计目录导航](DESIGN.md)、[BondBuddy 新产品原型](product-prototype/HANDOFF.md) 和 [BondBuddy Landing Page](landing-page/README.md)。下文描述仓库原有的线上 Cowork 应用。

网页版募集说明书更新与审阅工作台。支持财务数据更新和全文更新，后端通过子进程直接调用 Codex CLI。默认仍按本机单用户方式运行；另提供受密码保护的 Azure VM 和 Azure Container Apps 部署。

## Cowork OS UX 预览

启动服务后打开 [新版首页](http://127.0.0.1:8766/cowork.html?screen=home)。入口分为首页、项目、收件箱、生态，沿用现有项目和成果；原入口 `/` 保留。

- 首页整理待办、已准备成果和执行状态。默认可选择“不关联项目 · 直接对话”；选择具体项目后发送一次，直接进入项目 Cowork 对话，无需再次发送。首页请求不会带上原来选中的段落，也不会夹带项目中未发送的草稿。
- 有募集书时，中间是文档，右侧是 Cowork、修改依据与待办；尚无募集书时，先显示完整项目对话和添加材料入口。募集书工作区保留左侧文档、右侧协作的布局，顶部展示有来源修改、人工待办、缺来源、待系统处理、表格结构及已确认数量，点击直接筛选；保留修订/最终视图、来源定位、人工审核和 Word 原格式导出。
- 收件箱汇总现有 AI 成果与执行提醒，支持查看成果、返回具体修改及标记已读。已读不改变审核决定，新版本可重新提示。
- 主动任务可配置和编辑方案，保存在本浏览器；自动调度、事件触发、外部主动查询和邮件通知尚未接入。保存方案不会执行任务。
- 生态按业务插件、专业技能（Skills）、数据连接（MCP）分组，展示真实能力状态。自定义扩展和商业数据平台接入仍待实现。
- 现阶段未实现个人身份与任务分派，首页按当前工作空间的非演示项目汇总；对话草稿与阅读位置在当前页面会话保留。

入口为 `web/cowork.html`，新界面在 `web/cowork-os.js`、`web/cowork-os.css`，独立对话位于 `web/conversations.js` 和 `backend/conversations.py`，继续复用 `web/app.js` 和 `web/project-workspace.js` 的专业功能。`/api/knowledge` 只读展示 68 条整理规则、17 项来源差异及现有专家审阅版全文；整理结果不代表专家全部确认。

选择项目时，对话属于具体项目，可在没有募集书时提问或讨论。后端按回答/更新处理结果；明确要求只回答时，拒绝文档修改结果。发送失败保留输入，重试复用消息标识，避免重复启动任务。支持不关联项目的独立会话：单独保存、最近对话、继续提问、停止回复和失败重试；不会向模型带入当前项目的材料、选中段落或历史消息。独立会话通过同一 Codex CLI 执行，只提供回答，不修改项目。后台需重启后加载新功能。

新增检查：`node tests/ui_cowork_os.js`、`node tests/ui_home_conversation.js`、`python -m unittest tests.test_chat_entry tests.test_standalone_conversations`。

## 启动

本机使用可直接双击 [打开募集书工作台.cmd](打开募集书工作台.cmd)。它在后台启动服务并打开 `http://127.0.0.1:8766`，沿用已导入的项目。启动日志保存在 `.local/server-8766.out.log` 和 `.local/server-8766.err.log`。不要同时在两个服务实例中编辑同一项目。

更新后台代码后，在本机双击 [重启募集书工作台.cmd](重启募集书工作台.cmd) 加载新版本。存在正在运行的更新任务时会拒绝重启；项目、材料与已保存的修改会保留。重启结果记录在 `.local/restart.log`；健康接口包含版本、实例编号和启动时间，以确认新后台确实生效。

在这个目录打开 PowerShell，运行：

```powershell
.\start.ps1
```

然后访问 **http://127.0.0.1:8765**。也可以用 `start.ps1 -Port 8766` 指定端口。

启动脚本优先使用 Codex 桌面端附带的 Python。其他环境需要 Python 3.11+：

```powershell
python -m pip install -r requirements.txt
python -m backend.server --port 8765
```

页面自带可操作的虚构示例。示例修改由程序预置，用于体验审阅交互，不表示 Codex 已完成真实更新。

## 如何使用

1. 点击“新建更新任务”，选择“只更新财务数据”或“全文更新”，填写实际目标报告期末。
2. 上传一份旧版募集说明书。建议使用 DOCX，可直接解析正文和表格。
3. 添加财务报表、报表附注或审计报告。全文模式可再添加征信、工商、评级等材料，并选择是否允许公开网页查询。
4. 点击“开始更新”。也可选中一段文字或表格单元格，在右侧告诉 Agent 要如何修改。
5. 切换“修订模式”和“最终模式”。正文显示完整金额的删改；表格的更新值带背景色。两种模式都保留未解决的【】。
6. 点击修改内容，在“修改依据”查看原文、新文、修改原因和来源引文。再点击来源文件，定位到 DOCX 段落/表格单元格、XLSX 工作表/单元格或 PDF 实际页码。
7. 逐条接受、拒绝或人工编辑。去掉已解决的【】并保存，会记录为人工确认。保留【】的内容继续出现在待办里。
8. 导出 Word 修订版、Word 最终视图，或包含完整历史和来源的审核记录 JSON。

“待办”中的“尚未核对”列出尚未得到逐项判断的位置。这些位置不一定都需要修改；没有获得判断也不等于已经核对通过。

“待 Agent 处理”是系统尚未完成匹配的扫描候选，不计入“人工待办”，也不显示成已更新的修订。来源尚未匹配不等于材料缺失。原稿已有的【】及 Agent 核对后仍有疑问的内容进入“人工待办”；两种状态都保留原有标记。Agent 启动失败且没有生成修改时，文档顶部明确显示“实际修改 0 处”。

## 上传、存储与多人使用

- 选择多份材料后按队列逐份上传。上传过程中再次选择文件会追加到队列，不会静默丢弃；页面显示每份文件的上传百分比、服务器解析状态和失败原因。切换项目或关闭材料窗口不会中断当前上传，刷新或关闭浏览器会中断正在传输的文件。
- Azure VM 部署将原文件、解析结果和审核记录保存在 Docker 持久化卷。原文件用于来源定位、原文下载和保持 Word 格式，不能在解析后立即删除。持久化主要占用磁盘而不是常驻内存。
- VM 默认限制单项目原文件合计 500 MB，磁盘可用空间低于 1 GB 时拒绝新上传，并只保留最近 3 次 Agent 运行目录。可通过 `BOND_PROJECT_STORAGE_LIMIT_MB`、`BOND_MIN_FREE_STORAGE_MB` 和 `BOND_RUN_RETENTION` 调整。
- 当前 JSON 文件存储和共享密码模式适合受信任的小团队，不是多租户架构。所有持有共享密码的人都能查看全部项目。面向独立客户时，应将原文件迁移到 Azure Blob Storage，将项目与权限迁移到数据库，并使用用户级身份认证。
- 并发容量取决于同时运行的 Agent 数量，而不是登录人数。VM 默认 `BOND_MAX_CONCURRENT_JOBS=1`，其余任务排队，防止小内存实例同时启动多个 Codex 进程。
- 原型规模可参考：1 个并发任务使用 2–4 vCPU、8 GB 内存；2–3 个并发任务使用 4–8 vCPU、16 GB 内存。更高并发应拆分 Web、任务队列和 Worker，并基于实际材料大小与任务耗时压测，不应只提高单机内存。

## Codex CLI

先在正常的本机终端确认：

```powershell
codex --version
codex login status
```

未登录时，运行 `codex login` 完成登录，然后在工作台左下角重新检测连接。

程序优先查找 `BOND_CODEX_PATH`、系统 PATH 和 Codex 桌面端安装目录。可用以下环境变量配置：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `BOND_CODEX_PATH` | Codex 可执行文件路径 | 自动发现 |
| `BOND_CODEX_HOME` | 可选：已有 Codex 配置目录的绝对路径 | 保留既有 `CODEX_HOME`；Windows 默认使用 `USERPROFILE/.codex` |
| `BOND_CODEX_LINUX_SANDBOX` | Linux 容器兼容模式；设为 `legacy_landlock` 时避免嵌套 Bubblewrap 限制 | 不设置 |
| `BOND_CODEX_MODEL` | 模型名称 | CLI 当前配置 |
| `BOND_CLI_TIMEOUT` | 单组任务最长秒数 | 900 |
| `BOND_DATA_DIR` | 本地项目与文件存放目录 | `.local/data` |
| `BOND_OCR` | `auto` 自动选择 Windows OCR 或 Tesseract；`off` 关闭识别 | `auto` |
| `BOND_OCR_LANG` | Linux/Tesseract 识别语言 | `chi_sim+eng` |
| `BOND_OCR_MAX_PAGES` | 单份 PDF 最多自动识别的扫描页数 | 100 |
| `BOND_OCR_PAGE_TIMEOUT` | 每个扫描页的识别超时秒数 | 45 |
| `BOND_OCR_TOTAL_TIMEOUT` | 单次上传全部扫描页的总识别时限 | 210 |
| `BOND_PROJECT_STORAGE_LIMIT_MB` | 单项目原文件合计上限 | 500 |
| `BOND_MIN_FREE_STORAGE_MB` | 低于该磁盘余量时停止上传 | 1024 |
| `BOND_RUN_RETENTION` | 每个项目保留的 Agent 运行目录数 | 3 |
| `BOND_MAX_CONCURRENT_JOBS` | 同时运行的 Codex 任务数 | 1 |
| `BOND_SHARED_WORKSPACE` / `BOND_WORKSPACE_LABEL` | 标记共享部署并显示工作空间名称 | 本机工作区 |
| `BOND_HOST` | HTTP 监听地址 | `127.0.0.1` |
| `BOND_AUTH_USERNAME` / `BOND_AUTH_PASSWORD` | 可选：为整个工作台启用 HTTP Basic 登录 | 不启用 |
| `BOND_ALLOWED_HOSTS` | 逗号分隔的公网 Host 白名单 | 当前本机端口 |
| `BOND_TRUST_PROXY` | 设为 `1` 时信任平台提供的 `X-Forwarded-Proto` | 关闭 |

CLI 使用 `exec --json --output-schema --output-last-message`，以参数列表启动，不拼接用户输入为命令。使用只读沙箱和禁止交互审批的执行方式，保留用户原有的 CLI 配置；没有启用跳过安全限制的选项。任务指令通过标准输入传入。

文件和审核记录保存在本机；运行任务时，相关文本会发送给 Codex 当前配置的模型服务。本产品并不是离线模型。

后台现在会把本机已有的 Codex 配置目录明确传给登录检查和执行进程，避免 Windows 受限进程无法自动发现用户目录。不会修改父进程环境、复制凭证或改变文件权限。

“CLI 已登录”只代表登录检查通过；完成一次任务调用后才显示“Agent 已就绪”。若报告“执行权限不足”，说明运行服务的进程不能写入 Codex 自己的状态数据库或初始化执行服务。此时需从本机打开上述启动入口。不要移动登录凭证、改数据库权限或关闭沙箱来绕过限制。

每组任务先获取相关片段，同时可检索本次任务目录内的完整已提取来源材料。初步检索缺少科目、分母或报告期时，Agent 须先补充检索，不能直接要求用户重新提供已经上传的数据。完整材料按任务共享保存，包含来源编号、原文、上下文和定位，不包含用户原文件路径。

## 当前实现范围

- 财务模式以报表、附注、审计报告为主要依据。注册资本、实缴资本归工商模块；报表中的实收资本、股本是不同字段。
- 引用必须匹配真实来源文件、段落或单元格，且引文须存在于原文。匹配失败、没有材料或模型不确定时，保留【待确认】。
- 另有新增数字检查：无法在引用原段及其表格上下文找到、且没有已支持的换算/计算依据的新增数字，会单独用【待确认】括起。这是辅助检查，不能代替财务口径判断。
- 引文匹配只证明引用的文字确实存在，不代表主体、报告期、单位、会计口径或推导已由独立规则完全验证。这些仍需要项目组审阅。
- DOCX 保留原表列数和列宽；确需新增报告期列时，保留【待确认】列安排事项，并随 Word 批注导出。早期版本暂存的新列建议仍在审核记录中。非 Word 演示底稿沿用新列占位。
- 财务模式不自动编造变动原因、行业分析或经营判断；原结论受新数据影响时提示复核。
- 全文模式支持已上传的多种材料，以及无需登录的公开 HTTPS 网页。未接入付费征信服务、工商数据库账户或任何私人账号。

## 文件与版式限制

- 支持 DOCX、PDF、XLSX、CSV、TXT、MD。单份 25 MB，一个项目最多 60 份材料。
- Windows 使用系统 OCR，Linux/Azure 容器使用内置的 Tesseract 简体中文及英文语言包，识别 PDF 中没有文字层的页面；识别过程完全在当前服务器内完成，不上传给外部 OCR 服务。识别页会注明“扫描识别”，引用这些内容的修改始终保留【待确认】；小数点、数字、列名仍可能识别错误，必须对照原页。OCR 全局单并发，并逐页渲染、识别和释放临时图片；默认单份 PDF 最多自动识别 100 个扫描页、每页最长 45 秒、整次上传最长 210 秒。超限、缺少识别组件或识别失败时会明确列出未识别页。
- PDF 来源可定位原页，复杂 PDF 表格目前按文字提取，建议用 DOCX 作为募集书底稿。XLSX 来源保留报表名称、报告日期、单位、多行表头及单元格地址。
- 材料中的无效日期会列入提示；只有引用该异常位置的修改会保持待确认，不会因为同一文件其他位置存在异常而污染全部引文。系统不擅自改写来源原文。
- DOCX 导出直接修改历史 Word 原文件的文字节点，保留字体、字号、标题样式、段落属性、表格列宽与合并、图片、目录域、脚注、页眉页脚及其他文件部件。最终视图保留原底色；修订视图使用 Word 原生删改记录。未修改时返回原文件原始字节。跨段落结构修改、位置不匹配或原文件校验不符会明确报错，不降级为重新排版。
- 网页按用户要求使用普通预览，保留修订／最终模式、【】、表格修改底色及点击来源定位；Word 附注也以已提取原文显示并保留段落和单元格定位。预览不依赖原格式渲染接口。导出继续在历史 Word 原文件上替换文字，保留原字体、标题、段落、表格、图片和页眉页脚，网页排版不会写入 Word。当前已通过真实原稿的文件部件与结构保留检查，尚未完成逐页视觉核验。
- 对用户明确提供本机路径的导入材料，可记录原始来源路径；缓存不可读时，仅使用这条已记录路径并验证上传 SHA-256。不会搜索任意本机文件，也不更改文件权限。
- 含权限保护的文件会拒绝读取。已有未处理修订的底稿会给出提示，应先在 Word 中处理旧修订。
- 本机模式仅监听 `127.0.0.1`。Azure 部署模式是一个受共享密码保护的单副本共享工作区，不提供项目级用户隔离：持有同一账号密码的人可以查看全部云端项目和材料。

## Azure VM 部署

现有 Ubuntu VM 可使用 [deploy/vm/compose.yaml](deploy/vm/compose.yaml) 构建应用容器，并通过 [deploy/vm/bonddraftai.nginx.conf](deploy/vm/bonddraftai.nginx.conf) 接入主机已有的 Nginx。Compose 只把后端映射到 `127.0.0.1:18766`，公网必须经过 Nginx 和 HTTPS。容器保持非 root、无额外 Linux capabilities、Docker 默认 seccomp 和 `no-new-privileges`。由于嵌套容器不能运行 Codex 当前默认 Bubblewrap 后端，VM Compose 显式启用 CLI 自带的 `use_legacy_landlock` 兼容模式，同时继续使用 `-s read-only`；不要改成 Codex `danger-full-access`。

VM Compose 使用两个职责分离的容器：`app` 是项目、材料和独立对话 JSON 的唯一写入者；`conversation-worker` 只运行未关联项目的 Codex 请求。Worker 不挂载项目卷，也不接收网页登录密码，只能看到当前对话的角色和文本。独立对话使用单独的干净 Codex 用户目录，并通过 CLI feature flag 禁用 shell 和图片读取工具，避免对话读取 Codex 凭据或容器文件。两个容器通过专用文件锁共用一个全局 Codex 并发名额；App 意外重启时，仍在运行的 Worker 不会与新项目任务并发。五个命名卷分别保存项目数据、两套 Codex 登录、独立对话临时运行目录和任务锁：

- `bonddraftai_data` → App 的 `/data`，保存项目、上传文件、审核记录和独立对话 JSON。
- `bonddraftai_codex` → App 的 `/data/codex`，保存项目任务使用的 Codex 登录状态和配置。
- `bonddraftai_worker_codex` → Worker 的 `/data/worker-codex`，只保存独立对话专用的 Codex 登录状态。
- `bonddraftai_conversation_runs` → Worker 的 `/data/conversations`，只保存独立对话临时运行文件。
- `bonddraftai_job_lock` → 两个容器的 `/data/job-lock`，只保存跨容器并发锁。

当前正式环境使用现有 Azure VM，而不是 Container Apps：

- 正式入口：`https://bonddraftai-openclaw.japaneast.cloudapp.azure.com/cowork.html`
- 兼容入口：`https://bonddraftai-openclaw.japaneast.cloudapp.azure.com/`
- 服务器代码目录：`/opt/bonddraftai`
- 持久化卷：`bonddraftai_data`、`bonddraftai_codex`、`bonddraftai_worker_codex`、`bonddraftai_conversation_runs` 和 `bonddraftai_job_lock`
- Nginx 反向代理：公网 HTTPS → `127.0.0.1:18766` → 容器 `8000`
- Compose 固定单个 App、单个独立对话 Worker 和单个项目 Codex 并发任务，继续使用当前 JSON 文件存储。更新代码不得删除或重新创建任何持久化卷。

生产目录不是 Git 工作区。后续发布应先在本机完成测试并推送 Git，再从已提交的 commit 生成只含跟踪文件的发布包，复制到服务器构建。不要直接打包工作目录，否则可能把 `.local`、客户材料、凭据或忽略文件带入服务器：

```powershell
$Repo = 'C:\path\to\BondDraftAI'
$Branch = 'feat/review-classification-optimization'
$Vm = 'azureuser@20.243.2.34'
$Key = 'C:\path\to\azure-vm-key.pem'

git -C $Repo fetch origin
git -C $Repo checkout $Branch
git -C $Repo pull --ff-only origin $Branch
git -C $Repo archive --format=tar HEAD -o "$env:TEMP\bonddraftai-release.tar"
scp -i $Key "$env:TEMP\bonddraftai-release.tar" "${Vm}:/tmp/bonddraftai-release.tar"
```

在 VM 上将发布包解压到临时目录，复制现有 `/opt/bonddraftai/.env`，先构建镜像，再替换代码目录并启动同一个 Compose 项目。首次从旧版升级时，必须先创建 `bonddraftai_codex`，把 `bonddraftai_data` 中原有的 `/data/codex` 完整复制到新卷并核对文件数量；再创建 `bonddraftai_worker_codex`，只复制可复用的 Codex 登录文件，不复制项目配置、MCP 或 Skills。不要删除旧目录，确认两个容器的 Codex 真实调用成功后再保留其作为回滚副本。发布前须确认项目任务和独立对话均不处于 `queued` 或 `running`；发布后检查 `/api/health`、`/cowork.html`、两个容器的健康状态、Codex 真实调用和 Word 导出。整个过程保留命名卷，不迁移本机 `.local` 项目数据。

镜像采用 `.dockerignore` 白名单，只复制 `backend`、`web`、运行依赖和唯一的专家审阅规则文件 `outputs/上交所私募公司债财务数据更新规则_专家审阅版.md`。`backend/data/financial_rules.json` 随后端一起进入镜像；本机 `outputs` 中的 DOCX、知识整理中间文件和其他忽略文件不会打包。

容器启动后，进入容器完成一次 ChatGPT 设备登录：

```bash
docker compose --env-file .env -f deploy/vm/compose.yaml exec app codex login --device-auth
```

项目任务的设备登录凭据会写入 `bonddraftai_codex` 卷中的 `/data/codex`，项目数据卷不再承载新的登录状态。独立对话使用单独的 `bonddraftai_worker_codex`；如复制后的登录失效，运行 `docker compose --env-file .env -f deploy/vm/compose.yaml exec conversation-worker codex login --device-auth` 单独登录。共享密码只保护整个入口，不等于多租户权限系统；只应分享给受信任的协作者。

## Azure Container Apps 部署

容器镜像内安装 Codex CLI，Python 后端仍直接启动 `codex exec` 子进程。Azure Container Apps 提供 HTTPS 公网入口，Azure Files 保存项目、上传文件、运行记录和 Codex 登录目录；实例固定为单副本，避免本地 JSON 存储被多个副本同时写入。当前脚本没有部署独立的隔离 Worker，因此会关闭“未关联项目的独立对话”；项目内协作不受影响。需要该能力时应先增加不挂载项目 Azure Files 的独立 Worker，不能退回同容器执行。

先登录 Azure CLI，再运行部署脚本。脚本会用隐藏输入提示共享密码；密码至少 16 位，不会写入脚本或提交到仓库：

```powershell
az login
.\deploy\azure.ps1 -Location eastasia
```

脚本创建空白云端实例，不会上传本机 `.local` 数据。首次部署后，按脚本返回的命令进入容器并完成 ChatGPT 设备登录：

```powershell
az containerapp exec --name bond-draft-ai --resource-group rg-bonddraftai --command "codex login --device-auth"
```

完成设备授权后，在网页左下角重新检测 Agent。共享密码只保护整个入口，不等于多租户权限系统；只应分享给受信任的协作者。

## 验证

```powershell
python -m unittest discover -s tests -v
```

测试中的 PDF 样例生成额外需要 `reportlab`，Codex 附带环境已包含；其他环境可以安装 `requirements-dev.txt`。

自动测试覆盖来源校验、【】保留、工商边界、历史列、人工审核和并发版本校验、DOCX/XLSX/PDF 解析、修订导出、HTTP 接口、访问边界，以及 CLI 子进程成功/失败/超时/取消。子进程成功响应使用明确标注的测试替身，不等于真实模型验证成功。

真实 CLI 连通性检查只使用虚构材料，可单独运行：

```powershell
python -m tests.live_cli_check
```

首次开发验证时，本机已安装 Codex CLI 0.153.4，但当前代理运行环境返回 `Could not find home directory`，因此未完成真实模型更新。浏览器自动检查另被环境自动审批以 `model_not_supported` 拦截；没有声称已通过浏览器视觉验收。

2026 年 9 月 11 日，用户双击启动入口后，8766 服务已完成一次真实 Codex 模型任务：依据虚构财务材料将资产总额从 100 万元更新为 120 万元，并返回可定位的来源。健康接口确认 `execution_verified: true`。这证明后台连接与修改链路成功，不代表真实募集书已经全文更新完成。详见 [CLI 启动修复记录](docs/CLI启动修复记录.md)。

产品结构与后续扩展说明见 [docs/product.md](docs/product.md)。
