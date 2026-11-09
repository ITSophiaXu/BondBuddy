# 募集书更新质量与发布门禁

用户于 2026-11-01 要求定位并修复模板脱离、错误更新、格式丢失及原 104 页缩至 39 页等回归，并规定后续版本必须通过门禁才能发布。此要求覆盖 2026-10-02 决定中“生成双 Word 即交付、取消内容和格式拦截”的部分。

历史募集书以原始 OOXML 包、章节结构、表格、样式和未修改内容为基线。可信服务端校验失败的结果不能记录为成功或交付为正常成果。没有可确认的新数据时保留原文并明确待确认，禁止为了补齐更新而伪造事实。PDF 原稿及无原稿首稿与 DOCX 模板更新区分处理；不得把无法检查写成检查通过。

## 发布要求

`npm run quality:prospectus` 在已安装依赖的干净 Linux checkout 执行完整构建、公共契约、门禁自身反例、隔离测试库迁移、独立 API 原稿选择与输入锁定、worker 原稿更新集成与真实失败终态/checkpoint 持久化、固定编辑与结构保留、四份授权真实 DOCX、清洁/修订双稿以及 LibreOffice PDF 渲染回归。测试清单固定于 `scripts/prospectus-quality-gate.mjs` 与 `scripts/run-document-quality-tests.py`；不使用调用者传入的任意命令清单。失败、取消、跳过、TODO、空测试、缺失依赖或样本均阻断。授权样本验证 manifest SHA256；真实原稿的固定编辑输入为 synthetic，不能称为真实模型更新或专业验收。

`api-source-selection` 在迁移后独立运行 `prospectus-source-lock.pg.test.js`、`prospectus-auto-adoption.pg.test.js`、`source-format.pg.test.js` 和 `none-baseline.pg.test.js`，使用真实 PostgreSQL 的隔离克隆库验证已采用原稿不可遗漏/替换版本、过期选择不写输入、精确原稿 SHA 与模板锁定，以及自动采用修复不重写既有输入。此项不调用模型或 Blob，不要求 Azurite；缺测试库会产生 skip 并阻断。它必须产生非空、全部通过且 fail/cancelled/skipped/todo 均为零的独立 TAP 摘要及日志 hash；部署和回滚的凭据验证同样检查这一项，旧凭据缺少此项或只声明 passed 均不能通过。

2026-11-03 修改清单新增无基线不变量：服务端在锁定输入时查询项目中未删除、角色为 historical 且未包含的全部材料版本；update 项目有遗漏即拒绝，generation 项目须单独确认“按首稿执行”。确认绑定准确版本/hash 集合，主体及时间由服务端写入不可变输入，不能用目标期间确认代替。worker 在模型调用及恢复时重新核验；集合或项目类型变化使旧无基线输入失效，不回填旧确认。已有采用稿及准确清洁稿续改仍按原保护执行。此输入行为与其他尚待确认的 v2 放宽规则分开，不自行开启影子检查、拆分发布或限时发布例外。

`browser-input-chain` 是单独的必需检查：用真实 Chromium、正常 Vite HTTPS 代理、隔离 API/PostgreSQL 16 和专用 Azurite，执行合成账号登录、新建项目、历史 DOCX 与补充材料上传、原稿采用、源/目标期间填写及明确开始任务。上传先核对真实 202、原上传编号及尚未发布材料，再调用生产用的独立上传确认消费者，等待浏览器以同一声明轮询得到 200，并核对持久化确认、outbox 和材料 hash。直接读数据库和真实 worker 输入函数，核对版本、角色、原字节 hash、模板来源和不可变输入，验证遗漏/错版拒绝、幂等与重登录恢复。只在模型执行边界停止，不启动 worker runtime、解析作业或供应商；模型调用记录、观测记录和非本机连接均须为零。它不使用 `page.route`、假 principal 或替身 API/数据库，不替代真实生成验收。独立 runner 采用环境白名单及空凭据目录，每次创建并清理自己的服务；需要 Docker、OpenSSL 及 `npx --no-install playwright install --with-deps chromium` 安装的浏览器。失败、空测试或 skip 拒绝凭据，不能复用 API 测试摘要代替。

已采用主稿存在时，自动模板选择必须绑定其准确 material/version/hash，不能再由辅助参考稿的格式、关系或输入顺序取代。明确选择另一格式须先改用对应原稿；当前为生成成果时，普通请求默认续改准确清洁稿，显式历史成果选择仍可保留并经原有归属/来源校验，不能因显式 null 退回首稿。worker 按不可变输入中的 selection 版本核验，不查询后来发生变化的当前选择；安全的旧输入可继续执行，冲突旧输入拒绝但不重写。UI 沿用同一选择，并在现有 Desktop UX job 固定执行原稿格式及成果续改 suite。

`gate-regressions` 还固定运行 `deploy/m1/scripts/codex-bwrap.test.mjs`，验证 `/proc` 加固 wrapper 保留 sandbox 参数与文件描述符、追加限制及传递退出状态。这些 Linux shell 反例必须真实执行，任何 skip 均阻断；不因本地缺少环境而移出清单。该合成套件不替代生产 worker 镜像中的真实 sandbox canary 检查。

`worker-authoring` 还固定运行 `codex-exec-log.test.js`，验证原始 stdout/stderr 捕获、凭据脱敏、journal 持久化及包含 section markers 的 20 MiB 总字节上限和配置边界；它使用同一严格 TAP 摘要要求，不能只在本次修复中手动验证后从发布清单遗漏。

**最后必须通过当前 commit/tree 的真实模型金样验收。** 通过 `BB_PROSPECTUS_ACCEPTANCE_FILE` 指向受控私有验收记录，由 `scripts/verify-prospectus-acceptance.mjs` 核对真实模型调用、锁定原稿/输入/输出 hash 及独立财务事实、章节与渲染验收证据。缺记录、仅合成响应、旧提交验收或缺少独立确认一律失败，不能自动填成通过。原始客户材料和验收记录不放进公共仓库或 CI 日志/artifact；发布凭据仅保存检查摘要及证据 hash。真实模型金样不能被模板保真和机械单元测试替代。

任丘三季报金样的最小财务回归由固定政策 `scripts/prospectus-financial-policy.json` v3 指定 21 个指标／口径组合（20 个金额及 1 个派生比例）、43 个实际位置（28 个表格金额、14 个正文金额及 1 个正文比例）。独立读取准确来源单元格及可见表头、主体、期间、单位和原始缓存，不接受相同数值的其他单元格替代。应付债券占非流动负债比例同时绑定原始分子和分母，按百分数独立计算；只检查正确表格不能掩盖正文旧金额或旧比例。正文位置从真实输出重找，未支持的旧金额断言不能靠新增正确副本掩盖；合法历史比较数须保留。这个最低清单不替代全文金额、其他比率公式、身份／法律时点和独立业务审核。运行时的 `reverse_audit` 来源行清单及未修改报告期正文队列只辅助模型逐处核对，不推断口径、期间或预期值，所有条目仍待核，不能作为财务通过凭据；工具和反例进入版本指纹及必需测试。

固定编辑的 `preflight` 使用当前操作日志在私有临时目录重放并调用同一 Word 检查器，返回绑定原稿、输入及操作 hash 的章节／标题定位。它只提供模型修复诊断，不登记成果，不替代模型结束后服务端独立检查。正文中连续编号的已知财务公式与标题分别识别，原公式编号、标签、顺序、所在章节及完整表达式仍独立保护；附加说明不代表公式已通过业务审核。章节内容阈值保持，更新时保留明确标注历史期间的有效事实和解释，再补本期分析及待核项；历史聚合现金流项目不能在沿用历史金额时改成范围更窄的子项名称。

来源回查的待核正文不再以“已匹配完整 XLSX 行标签”为入队前提；保守显示别名保留原标签及限定范围，仅提供待核线索，不推断金额。报告期释义单独列出。共享 Word 检查器将明确属于当前募集说明书且可完整解析的期间定义与锁定目标比较，确定矛盾以 `WORD_REPORTING_PERIOD_DEFINITION_CONFLICT` 拒绝。只支持完整日历年度及一个累计季度的明确窗口；历史比较句、不同主体窗口、未知语法及无法绑定的定义保持待核，不扫描替换所有旧月份，也不声称已核财务事实。此检查对模型预检可见，属于生成行为相关变更，仍须真实验收。

固定 Word 重放会从原稿推导有限格式调整：已识别的表题、单位、表头与首条数据连排，准确表头跨页重复；原先空白的数值格优先参考同一行可见数字，必要时使用同列两处一致明细。范围、样式或继承不明则保留原式并记录未解决项。属性修订必须能拒绝还原原稿、接受后等于清洁稿，不能放宽整体模板比较。宿主推导的 `format-plan.json` 绑定输入及原稿，连同失败质量记录持久化；它是诊断，不是视觉或业务通过凭据。

准备 PostgreSQL 16 的一次性本地模板数据库，角色需有 CREATEDB 权限供集成测试克隆。`BB_TEST_DATABASE_URL` 仅允许 loopback 主机及 `bb_prospectus_quality` 或 `bb_prospectus_quality_<suffix>` 库名，禁止 query 参数覆盖连接目标；runner 仅对此显式测试库运行迁移，不使用继承的生产 `DATABASE_URL`。CI 使用独立 service，禁止连接生产数据库。

通过后在 `.local/prospectus-quality.json` 写入 commit、完整 Git tree、Linux 平台、干净源码状态、每项结果和日志摘要；完整成功或失败日志保存在 `.local/prospectus-quality-logs/<commit>/`，受控发布主机私有保留完整凭据和验收记录，托管 CI 仅保留机械测试日志。测试前删除旧凭据，测试后复查源码未变。正常发布凭据 24 小时内有效；任何新 commit（包括只改文档的提交和合并提交）都需重新运行，不能复用 PR 旧 SHA 的凭据。渲染只证明可转换及页数保留等自动化条件，不替代逐页视觉检查与业务审核。

单独执行 `npm run quality:prospectus:validate` 可运行上述全部机械测试，并明确输出“未运行真实模型验收、未签发发布凭据”。该命令允许本地工作树验证，保留独立运行日志，不能用于部署授权。完整 `quality:prospectus` 最后未获真实验收时退出失败，并且不会留下通过凭据。

准备候选版本并执行：

```sh
npm ci --no-audit --no-fund
python3 -m pip install -r python/requirements-dev.txt
# Ubuntu: sudo apt-get install libreoffice-writer fonts-noto-cjk ripgrep
npx --no-install playwright install --with-deps chromium
docker pull mcr.microsoft.com/azure-storage/azurite:3.35.0
export BONDBUDDY_TEST_PYTHON="$(command -v python3)"
# 在一次性本地 PostgreSQL 中预建此库；密码仅为本地 synthetic 示例。
export BB_TEST_DATABASE_URL=postgresql://bondbuddy:synthetic-quality-only@127.0.0.1:5432/bb_prospectus_quality
# 此路径及其引用的证据必须来自受控私有验收，不得用合成记录代填。
export BB_PROSPECTUS_ACCEPTANCE_FILE=/private/acceptance/current-candidate.json
npm run quality:prospectus
node scripts/prospectus-quality-gate.mjs verify HEAD .local/prospectus-quality.json
export BB_RELEASE_QUALITY_RECEIPT="$PWD/.local/prospectus-quality.json"
bash deploy/m1/scripts/export-images.sh HEAD /path/to/release-images.tar.gz
# 将已验证镜像、源码 commit 与凭据通过既有受控路径传到部署主机。
bash deploy/m1/scripts/deploy.sh HEAD
```

`deploy.sh`、`export-images.sh`、`rollback.sh` 均在构建、导出、迁移或切换前验证凭据。四个发布镜像必须带与凭据相同的完整 `org.opencontainers.image.revision`；旧镜像缺少标签时需重建。标签检查防止误装旧 tag，不是镜像签名。凭据是受控测试环境的执行记录，不是加密签名，必须从可信 CI 或受控 Linux runner 取得，不能接收模型或客户提交的凭据。保留现有迁移兼容性、在途任务检查与回滚记录要求。

紧急回滚允许使用已成功部署的同一提交的原通过凭据而不受 24 小时限制，但必须同时核对部署主机的 `state/releases.log` 中完整 commit 和该凭据文件 SHA256，不能用新生成的凭据或未曾成功发布的提交绕过正常发布。`deploy.sh` 仅在 smoke 成功后登记此记录，并将原凭据保存到 `state/quality/<full-sha>.json`。设置 `BB_RELEASE_QUALITY_RECEIPT` 为该已保存文件后执行既有 `rollback.sh <full-sha>`。部署历史及凭据均由受信任运维控制。

## 远端约束及启用事项

`.github/workflows/prospectus-quality.yml` 对 develop/master 的 PR、push 和 merge queue 运行 `validate`，没有 paths 过滤或允许失败步骤。它提供 `prospectus-quality-mechanical` 检查，不接收私有验收文件、不签发发布凭据。托管 job 可以独立完成机械回归，不再因没有私有文件而永久失败；它通过仍不授权发布。

受控 Linux 发布者执行 `node scripts/publish-prospectus-quality.mjs <完整40位候选SHA>`。CLI 要求同一干净 HEAD 和 canonical GitHub origin，在该 SHA 上先登记 `prospectus-release-acceptance: pending`，固定运行完整 `run` 和同 SHA 的 `verify`，复查源码未变后才登记 `success`；失败、缺证据或无凭据登记 `failure` 并退出失败。成功描述仅含结果和凭据 hash，任何客户文档、人审记录和私有路径均不发送 GitHub。具体操作见 [受控发布者说明](../../scripts/prospectus-quality-publisher.md)。本次未实际运行状态发布。

管理员应同时要求 `prospectus-quality-mechanical` 和 `prospectus-release-acceptance`，并将后者绑定到受信任的 GitHub App/发布服务身份，要求与最新基线同步、禁止管理员跳过及直接 push。不能仅凭相同 context 名接受任意作者提交的 status。当前不能配置这项远端限制时，不得声称 PR 状态不可伪造；实际部署仍必须核对当前发布提交的私有通过凭据。

PR head、GitHub PR 合并测试 SHA、merge queue SHA 和最终 master SHA 可能不同；状态只能说明其绑定的完整 SHA。先确认保护实际评估的 PR head 或测试合并 SHA，并对同一准确 SHA 验收和发布状态；为 merge queue 发布状态必须验收对应队列提交。最终部署使用 master 的确切提交，变化后需重新验收并由发布者重跑，不能用 PR 上的绿色状态代替最终提交的凭据。

首次读取远端状态时，当前账号只有 push 权限、没有 admin 权限，规则 API 表示当时的私有仓库套餐不支持 rulesets，Actions 也曾因账单/额度未启动。后续候选 `d4a5bea133c6f9edba02d879569653e82e6f2dd2` 的七项托管检查已实际成功，包括机械门禁和生产安全配置下的 CLI 原生测试；早期账单失败不能继续作为 Actions 无法运行的当前结论。**CI 成功不代表两个必需检查及可信发布身份已被远端分支保护强制启用。** 用户指定 Sophie 负责独立业务复核及管理员配置交接。2026-11-02 再次只读核对时，当前账号仍无 admin 权限；`develop` 和 `master` 的分支摘要均返回 `protected: false`、`protection.enabled: false`、必需检查列表为空且 enforcement 为 `off`。在管理员落实保护前，受控 Linux runner 和部署入口的默认拒绝提供实际拦截；拥有服务器或仓库管理权限的人仍可绕开脚本，这一外部限制不能声称已经消除。
