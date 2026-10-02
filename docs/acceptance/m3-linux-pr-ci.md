# M3 Linux PR 集成检查

工作流：`.github/workflows/m3-linux-pr.yml`。普通 `pull_request` 向 `develop` 打开、重开或推送新提交时触发，包括 draft PR；不使用 `pull_request_target`，仅授予 `contents: read`，检出后不保留 Git 凭据，不读取仓库 secrets，不部署或访问生产服务。

## 固定环境与执行入口

- GitHub-hosted `ubuntu-24.04`；Node 24.14.0、Python 3.11.11、PostgreSQL 16.10、Azurite 3.35.0。三个官方 Actions 固定到已核对的完整提交 SHA；JavaScript 使用 `npm ci` 和仓库 lockfile，Python 直接及传递依赖约束写在工作流中。
- 检出完整工作树；不能只取 apps/packages，因为既有统一编制测试读取 `knowledge/exchange-bonds/drafts/sse-private` 等固定知识文件。
- PostgreSQL 服务在当前 job 内创建 `bb_m3_ci`，账号和口令明确是一次性 synthetic 值。初始化采用实际接口：`DATABASE_URL="$BB_TEST_DATABASE_URL" node db/migrate.mjs`。迁移进程结束连接后，测试辅助程序通过具有 CREATEDB 的临时角色，为每个文件克隆并清理独立数据库；不存在生产连接或数据库 dump。
- Azurite 只将 Blob 端口绑定本机回环地址，使用公开的开发存储连接配置；SDK 写入/删除 readiness 容器后才测试。job 结束移除容器。
- `npm run build`、`npm run check:contracts` 后，执行 workflow 中列出的 runtime-entry、解析并发/私有 staging、共享 adapter/material-tools/router/统一编制及 M3 API/domain/assistant/review/revision/PG-Azurite 定向集。parser1.0.8追加原生解析、证据存储、财务提取、显式公式及已授权样本兼容性检查；随后运行Python原生parser、file-authoring和三个Word测试模块。

真实 Linux 的 `0700` 私有目录、`flock`、孤儿目录清理、进程信号和 SIGTERM 测试原样运行；没有平台跳过或放宽断言。测试环境提供绝对 Python 路径；Node TAP 只要出现非零 skipped/TODO 或无测试就失败，Python 跳过也失败。模型和搜索响应均来自显式 synthetic 夹具；`BB_TEST_LIVE_AUTHORING=0`、`BB_REVIEW_WEB_SEARCH_ENABLED=0`，不调用模型供应商。解析/财务提取集另启用`BB_RUN_AUTHORIZED_LARGE_XLSX`、`BB_RUN_AUTHORIZED_SAMPLE_TESTS`和`BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_TESTS`，读取仓库已登记授权的原件；不将授权样本测试说成真实模型或专业验收。数据库、Azurite、Python解析/Word、子进程和下载/恢复代码实际运行。

## 首次触发与证据要求

主协调分支提交上述 workflow 后，创建或更新以 `develop` 为 base 的 PR，查看 **M3 Linux integration / linux-integration**。首次工作流若等待仓库 Actions 策略或贡献者批准，应记录实际状态；没有运行记录不能视为通过，也不据此修改仓库权限设置。

首次完成需记录 run URL、PR merge SHA、runner 和依赖版本、迁移日志、Node pass/fail/skipped 计数及 Python结果；应确认 runtime-entry 的完整子进程/SIGTERM 用例和 M3 完整上传到 Word 流程均执行。失败时保留 Actions 步骤日志并在同一 PR 修复，不将缺环境导致的跳过或未启动记为验收。

## 首次实际运行结果

[Actions run 37004818931](https://github.com/ITSophiaXu/BondBuddy/actions/runs/37004818931) 于2026-10-02T12:11:19Z成功结束。检出的PR合并树为`f989cc94a49fc6f60b57fb178218fda6dc35650a`，由head `90ac2565bcc4fb0f126a0bddf05944bb5941eb76`与develop `987f11e1764e831bad95735b5e44ad0cebc31660`组成。

- 上述固定Linux环境实际安装依赖，构建、contracts、Azurite读写及全部迁移成功。
- Node定向集：169 tests / 169 pass / 0 fail / 0 skipped / 0 todo；完整`production entry: heartbeat, parse claim, capability_not_ready run, probe loop, SIGTERM`用例及M3上传→解析→报告/批注→修订Word→不可变历史均实际执行。
- Python Word交付与修订：20 tests，全部通过，无跳过。

Python wheel dry-run已由上述runner实际安装和运行证据补充。该结果覆盖synthetic模型输入下的真实Linux/数据库/存储/解析/Word工程链路；真实供应商、专业质量、WPS和生产部署/回滚验收仍独立跟踪。

同步develop `1b06287`后，定向集追加`run-runtime.test.js`及`unified-timeout-recovery.test.js`，覆盖新增长编制deadline和只读材料工具恢复的共用队列边界。[run 37006145251](https://github.com/ITSophiaXu/BondBuddy/actions/runs/37006145251)于2026-10-02T12:25:13Z成功，head`9ea8ed8`、合并树`1ab1c77`，Node173/173、Python Word20/20，零失败/跳过/TODO。

上述计数保留为新增parser/样本/公式/供应商schema修复前的历史证据；扩展后的最终提交及合并树、计数、结论见[PR #523 checks](https://github.com/ITSophiaXu/BondBuddy/pull/523/checks)。不会将旧SHA的成功用于宣称新提交已经通过。

整合develop `c2c3448`的固定审计知识后，Node清单还包含知识源/hash、审计勾稽、修订冲突、实际worker组合回归及原生页眉/目录检查，以验证其与M3原文语义、差异范围和显式公式的组合；不仅验证独立知识模块。

继续整合develop `babbe37` / #526后，追加`codex-file-authoring.test.js`、`file-authoring.pg.test.js`和Python `test_file_authoring`，验证共用适配器与原始文件编制。M3修订需保留独立的锁定报告、解析快照、已采纳问题和允许修改位置路径；CI中的router及M3 PG链路对此分别断言。Linux文件权限与信号行为仍按原测试执行，不把Windows跳过当成通过。

两个Node文件编制测试使用既有`deploy/m1/Dockerfile`的worker target，Node镜像指定24.14.0，镜像内Python/OCR依赖沿用生产Dockerfile；其Codex0.154.0二进制按既有sha512校验。不能在仅有setup-python的runner直接执行，因为真实权限预检要求`/usr/local/bin/codex`、`/opt/venv/bin/python`和`/app/python`。CI只在一次性runner加载仓库既有AppArmor profile，容器保留只读根目录、cap_drop ALL、no-new-privileges、指定seccomp和/tmp临时空间；没有privileged/unconfined、凭据或生产挂载。容器通过host网络访问同job的PG/Azurite，内部Codex文件沙盒仍禁用网络，并真实验证输入只读、输出可写及沙盒外文件不可读。模型回复为synthetic；该测试不代表真实provider或生产主机已验收。
