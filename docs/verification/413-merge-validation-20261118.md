# 413 修复整合与合并验证（2026-11-18）

Refs #994、#1559；本次将 PR #1483 更新到 develop `cead19c2fd9d48321cc40eaa60d574098371fbd4`，保留已合并 PR #1560 的模型网关 origin/base path 固定。未部署、未重跑生产客户任务、未签发发布凭据。

## 最终实现

- 更新募集书及其篇幅修复：按页读取 PDF 原生文字/本地OCR缓存；受控 JPEG 单图128KiB，每上下文图片data URL512KiB。原生 view_image 禁用；真实CLI请求工具目录增加断言。
- 更新募集书实际请求在转发前检查 wire及解码body，默认2MiB是本地策略。首个明确413停止相同body重发，完整工作区快照校验后在原run新上下文续跑，保持原deadline、重试额度、输入、预留和历史unknown用量。
- 保留有界续跑检查点、SessionStart压缩后状态注入、精确PDF游标和最终宿主渲染交接。内容失败/混合质量失败不允许通过渲染交接。
- 合并前发现并修正跨路线回归：review/M4无自动轮换恢复，不能套用512KiB低累计额度。宿主仅为具备快照恢复能力的update显式传 `--rotate-context`；其他文件路线使用单图受控JPEG，不承诺自动续跑，不把图片额度标记伪造成供应商413。其HTTP网关模式仍遵循自身配置。
- 没有新增SQL迁移。API/contracts/worker及Python/helpers/catalog需由部署负责人协调更新；合入develop不代表线上已启用。

## 验证环境

Linux arm64 / Node22.23.4 / PostgreSQL16；真实 Codex0.169.0，binary SHA256 `3bb41c9a80187773e2a59278d4fc355b1a163c31bb5a79581e37d4fe428af047`。源码在Linux中全仓构建后只读挂载到已有worker依赖镜像，固定CLI及当前catalog单独只读挂载。真实CLI测试使用network none、cap-drop ALL、仓库seccomp和已加载的 `bondbuddy-codex-v1` AppArmor profile；没有取消沙箱限制。此为源码集成验证，不是重新构建后的发布镜像验收。

数据库是本次独立Docker内部网络内的临时PostgreSQL容器，无宿主端口、无业务数据；迁移至0190。PG测试显式 `NODE_ENV=test`，fixture上传合成参考稿和审计报告，保留实际准入检查。

## 最终结果

| 检查 | 结果 |
|---|---|
| `npm run build`，Linux，工作区锁定依赖 | PASS，contracts/domain/registry/context/API/worker/web |
| `npm run check:contracts` | 72测试，179公共+12内部示例、4生命周期示例通过 |
| 16个定向Node suite | 180/180 PASS，0 fail/skip |
| Python bounded_image/pdf_pages/continuation/fixed_edit | 116/116 PASS，0 fail/skip |
| 4个真实PG恢复/锁/账务suite | 10/10 PASS，0 fail/skip |
| Linux VM worker-isolation / split-deploy | 37/37 PASS，0 fail/skip |
| `scripts/preflight-host-render/verify.mjs` | PASS；纯分页失败可交接后host通过，混合事实/正文骤减仍拒绝，60→20页仍拒绝 |

Node覆盖adapter、exec-log、gateway、origin、图片和continuation工具、文件输出限制/恢复/说明/SessionStart、格式/交付/篇幅修复、真实Copilot协议和真实CLI模型请求。真实CLI目录断言确认没有原生view_image且受控MCP实际输出JPEG。

PG覆盖 `file-authoring-payload-recovery.pg.test`、`unified-timeout-recovery.test`、API `file-authoring-recovery.test`、`provider-runtime-locks.pg.integration.test`。验证完整快照、并发恢复、用户pause/cancel、固定deadline、恢复额度、原积分预留、unknown保留、完成结果复用和跨类型隔离。

## 初始失败与修正

初始Linux构建遇到宿主macOS安装的rolldown二进制，按同一package-lock重装Linux arm64可选依赖后全仓通过，未修改依赖版本。新develop要求审计报告，恢复测试fixture已按真实上传接口补齐。测试容器继承production环境导致大量合成fixture触发试用额度，改为明确NODE_ENV=test后通过，未改生产额度。

真实CLI初次读文件回归失败：Copilot fixture把CODEX_HOME与TMPDIR放在同一路径，已改为和生产一致的兄弟目录。另Colima的unconfined AppArmor被宿主userns限制拒绝创建loopback；使用已加载生产profile后同断言通过，未放宽profile/sysctl。官方0.169 bundled bwrap与依赖镜像原bwrap的SHA相同，排除资源版本问题。

## 与沧州原件证据的关系

先前同一沧州8页原件、真实CLI0.169的传输实验显示原生看图最高22,637,785 bytes；候选受控图片分3个fresh上下文，8/8页实际传输，最高548,616 bytes。该实验源码为此前固定83d63ddc，不能冒充本次最终自动恢复/业务交付；它是本次选择修复机制的直接依据。

本次Node/PG均为合成供应商响应和合成业务记录，Word分页为合成DOCX；不是DeepSeek或Copilot真实业务调用。#994保持部分修复，沧州完整输入→财务/内容/实际分页验收→双Word下载仍为最终统一验收待办。用户已授权代码修复并合并，部署由发布负责人另行执行。

## 可核对证据

本地收据 `receipt.json` SHA256：`5a02fadfe3ba9cfb138895c8ad23e96613ff1e225e5c6f0c6c6c7ceee6d12de5`，目录 `/Users/chrisliu/Downloads/BondBuddy-413-merge-20261118/`。日志不包含客户材料或真实凭据。

| 日志 | SHA256 |
|---|---|
| `build-contracts.log` | `3f2d57702285bbd3f29a7dff6d2b3da15f22031408d488b9f18889e3e21971a5` |
| `python.log` | `72d8273fe234bf07c995f0eb3cbd12a0af3d491000be4bbde28643d1703c95d5` |
| `node-final.tap` | `620709c10897a93b3c2b4fb98ac19d401a591f2431be7319bbbc00aeae50465e` |
| `pg-confirmed.tap` | `6f92e5099899664ffafcd952920c77436ddc69851a5319e4f5d2466c7a7c5207` |
| `host-render-final.json` | `4b190ae1478fd9ec09dd4f3c35225c850df9fc88e992de462dd9e473510c5b61` |

补充部署检查：先前唯一export-target失败在develop基线相同，定位为Linux测试VM缺少脚本必需的ripgrep。临时提供官方ripgrep15.2.0（发行包SHA256=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915）后，原脚本和全部断言不变，37/37通过；未修改产品导出逻辑。

部署日志 `deploy-confirmed.tap` SHA256：`b8479ac879c892c836d371f56304be34c48fe70a37969d423c09f02faea39a8d`。全部产品与测试源码对应 `c8464fcf82927c0beecad99c377ea5f4cd66998f`，此后仅补充本文验证记录。
