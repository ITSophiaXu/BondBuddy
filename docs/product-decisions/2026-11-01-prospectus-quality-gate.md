# 募集书更新质量与发布门禁

用户于 2026-11-01 要求定位并修复模板脱离、错误更新、格式丢失及原 104 页缩至 39 页等回归，并规定后续版本必须通过门禁才能发布。此要求覆盖 2026-10-02 决定中“生成双 Word 即交付、取消内容和格式拦截”的部分。

历史募集书以原始 OOXML 包、章节结构、表格、样式和未修改内容为基线。可信服务端校验失败的结果不能记录为成功或交付为正常成果。没有可确认的新数据时保留原文并明确待确认，禁止为了补齐更新而伪造事实。PDF 原稿及无原稿首稿与 DOCX 模板更新区分处理；不得把无法检查写成检查通过。

## 发布要求

`npm run quality:prospectus` 在已安装依赖的干净 Linux checkout 执行完整构建、公共契约、门禁自身反例、隔离测试库迁移、worker 原稿更新集成与真实失败终态/checkpoint 持久化、固定编辑与结构保留、四份授权真实 DOCX、清洁/修订双稿以及 LibreOffice PDF 渲染回归。测试清单固定于 `scripts/prospectus-quality-gate.mjs` 与 `scripts/run-document-quality-tests.py`；不使用调用者传入的任意命令清单。失败、取消、跳过、TODO、空测试、缺失依赖或样本均阻断。授权样本验证 manifest SHA256；真实原稿的固定编辑输入为 synthetic，不能称为真实模型更新或专业验收。

**最后必须通过当前 commit/tree 的真实模型金样验收。** 通过 `BB_PROSPECTUS_ACCEPTANCE_FILE` 指向受控私有验收记录，由 `scripts/verify-prospectus-acceptance.mjs` 核对真实模型调用、锁定原稿/输入/输出 hash 及独立财务事实、章节与渲染验收证据。缺记录、仅合成响应、旧提交验收或缺少独立确认一律失败，不能自动填成通过。原始客户材料和验收记录不放进公共仓库或 CI 日志/artifact；发布凭据仅保存检查摘要及证据 hash。真实模型金样不能被模板保真和机械单元测试替代。

准备 PostgreSQL 16 的一次性本地模板数据库，角色需有 CREATEDB 权限供集成测试克隆。`BB_TEST_DATABASE_URL` 仅允许 loopback 主机及 `bb_prospectus_quality` 或 `bb_prospectus_quality_<suffix>` 库名，禁止 query 参数覆盖连接目标；runner 仅对此显式测试库运行迁移，不使用继承的生产 `DATABASE_URL`。CI 使用独立 service，禁止连接生产数据库。

通过后在 `.local/prospectus-quality.json` 写入 commit、完整 Git tree、Linux 平台、干净源码状态、每项结果和日志摘要；完整成功或失败日志保存在 `.local/prospectus-quality-logs/<commit>/`，CI 一并保留成功证据及原日志。测试前删除旧凭据，测试后复查源码未变。正常发布凭据 24 小时内有效；任何新 commit（包括只改文档的提交和合并提交）都需重新运行，不能复用 PR 旧 SHA 的凭据。渲染只证明可转换及页数保留等自动化条件，不替代逐页视觉检查与业务审核。

单独执行 `npm run quality:prospectus:validate` 可运行上述全部机械测试，并明确输出“未运行真实模型验收、未签发发布凭据”。该命令允许本地工作树验证，保留独立运行日志，不能用于部署授权。完整 `quality:prospectus` 最后未获真实验收时退出失败，并且不会留下通过凭据。

准备候选版本并执行：

```sh
npm ci --no-audit --no-fund
python3 -m pip install -r python/requirements-dev.txt
# Ubuntu: sudo apt-get install libreoffice-writer fonts-noto-cjk ripgrep
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

`.github/workflows/prospectus-quality.yml` 对 develop/master 的 PR、push 和 merge queue 运行同一门禁，没有 paths 过滤或允许失败步骤。仓库管理员应将 `prospectus-quality` 设置为 develop/master 的 required status check，要求与最新基线同步，并禁止管理员跳过及直接 push；部署执行者只允许走上述受控入口。

现有托管 CI 不携带客户材料或私有金样验收文件，因此没有受控证据时完整门禁必须失败；不因 CI 环境无法取得证据改为 skip。可在具备私有证据的受控 Linux runner 执行同一命令。若未来为 CI 增加私有证据传输，应只传到受控 job 的临时目录、绑定当前候选提交，并保持公共日志仅含摘要，不能把客户材料作为普通 artifact 上传。

本次读取远端状态时当前账号只有 push 权限、没有 admin 权限，规则 API 表示当前私有仓库套餐不支持 rulesets；GitHub Actions 还存在账单/额度限制。**新增 workflow 不代表远端分支保护已经启用，也不代表 Actions 已运行。** 在管理员解决套餐、额度及 required-check 配置前，受控 Linux runner 和部署入口的默认拒绝提供实际拦截；拥有服务器或仓库管理权限的人仍可绕开脚本，这一外部限制不能声称已经消除。
