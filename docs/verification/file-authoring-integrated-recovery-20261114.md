> 后续现代快照保存失败、512 MiB 容量与最新页面整合结果见[2026-11-14补修验证](file-authoring-recovery-followup-20261114.md)。本页保留 ae6dd025 固定候选的历史验证与当时任务状态。

# 文件编制恢复整合验证（2026-11-14）

固定运行候选：`ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1`，tree `68c10bd66e1b6edaa230121262fe23f80856d781`。关联 PR #1302；Refs #994、#1323、#1324、#1339、#1341、#1342。开发自测与真实生成、用户验收及部署分别记录。

## 整合内容

在 #1302 的完整首次说明、精确恢复 stage 和快照 hook 上整合三项补修：超时进程确认退出后的工作区快照及同任务有界恢复；API/worker 共用 4,096 文件容量；模型沙箱分页失败的宿主交接。手动/自动恢复共用每 logical call 两次、全 run 六次预算，原 unknown 用量、暂停/取消、账务、身份和输入边界不变。

宿主交接仅在当前操作 hash 匹配、snapshot_current=true、所有失败都是 WORD_PAGE_COUNT_UNAVAILABLE 时成立，返回 `defer_page_rendering_to_host / authoring_completion=not_verified`。它不表示业务编制完成；模型完成剩余工作后须对最终操作重新预检。worker 独立重建、渲染及执行全部质量检查，正文和实际页数 70% 要求继续保留。

## 自动化结果（全部 synthetic）

| 层次 | 环境和命令 | 结果 |
| --- | --- | --- |
| 编译 | Windows / Node 22.14.0；contracts、domain、registries、API、worker TypeScript 编译，web typecheck/Vite build | 全部通过，仅既有大 chunk 提示 |
| 各补修契约与边界 | [timeout 原验证](file-authoring-timeout-recovery-20261114.md)、[容量原验证](file-authoring-recovery-capacity-20261114.md) | contracts 72 测试＋195样例；timeout 定向40项最终通过；容量11/11。timeout 首次2项测试环境并发限制失败及定向复跑记录保留 |
| 整合后格式/质量/修复/说明 | Linux，固定 02db1f35（与 ae6dd025 的后端相同）；`node --test --test-concurrency=1 apps/worker/dist/file-authoring-{format,repair,quality,instructions}.test.js` | 40/40，0 fail/skip；测试前后源和dist哈希不变 |
| Python 预检和篇幅 | Linux；`python -B -m unittest test_fixed_edit.WordQualityPreflightTests test_document_size -v` | 38/38，0 fail/skip |
| 真实沙箱→宿主渲染 | `node scripts/preflight-host-render/verify.mjs`，network=none | good/mixed/body-collapse三场景及页数反例通过；60→60页宿主通过，60→20页拒绝；中间30操作→最终60操作重新核验 |
| 网页 | Edge / Playwright；project-execution 中 timeout、output-limit、payload、legacy及回执恢复相关测试 | 15/15，0 fail/skip；同任务、同输入及不重复请求断言通过 |
| 最终候选镜像内测试 | Linux；实际镜像内 codex-file-authoring、codex-file-output-limits、file-authoring-recovery、file-authoring-restart、file-authoring-instructions、file-authoring-format | 57/57，0 fail/skip，125.6秒；CLI 0.167.0，禁网、无凭据、无数据库、无host dist覆盖 |

四组合测试覆盖首次/恢复 × 普通/篇幅修复的实际完整说明与64 KiB限制、hook及stage/version绑定。没有用单条测试完整执行“controlled size repair中断后fresh prepare”的全部组合；恢复与修复各自的测试不能扩大为该组合的独立端到端实证。

候选镜像完全替换应用代码与资源，复用已审计且依赖锁一致的本地Linux依赖层。API/worker各1,137个tracked资源按原始Git字节逐一验证，零差异，避免Windows换行改变资源hash。

- worker：`sha256:e1565d1d423a9216578950137434ced32652b67ca42484602a5a26ff4ebb8410`
- API：`sha256:54b154e815c87156ca0aa5ffee9c3b11af208d0f5056ff211b1386dfe273af2a`
- web：`sha256:6695331054ab7cffe541cbea79edb9af5504c523ece813c994d48cfc8e96ca12`

私有完整日志/构建证明保留在 `work/integrated-checks-20261114` 和 `work/candidate-ae6dd0255ca3`，未提交客户材料、原始财务日志或凭据。新镜像中的57项是synthetic供应商响应；不是Copilot真实生成结果。

## 状态页对照

原型 `product-prototype/public/authoring-live-progress.html` 的实际版本为 `02db1f3567718490d63ac7039678ed6c4ae03fc7`，实现截图版本为 `ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1`。受影响迁移页为 project-execution、authoring-status、authoring-progress。

[16张同尺寸对照截图、manifest与视觉检查](../../apps/web/test-evidence/timeout-recovery-20261114/README.md)。四种状态在1440×1000与390×844下逐对检查，状态卡、按钮和步骤无遮挡；截图记录真实边界，未声称原型和产品外壳坐标相同。旧手机按钮顺序、图标及示例材料数量差异如实列出，产品负责人确认及用户验收仍待完成。原型登记：[#361](https://github.com/ITSophiaXu/BondBuddy/issues/361#issuecomment-6873285002)。

## 真实任务状态

原本地任务的第一次真实Copilot调用在3小时15分钟后输出超限。第二次固定使用 `dc7a8368`，于2026-11-14北京时间13:58:38达到5小时上限，`paused/provider_reconcile`、MODEL_TIMEOUT、SIGTERM、duration_ms=18000189、usage unknown。没有provider result、正式Word或系统恢复快照。第二次超时前仍有实质编辑，日志证实773项成功操作；这不是durable checkpoint或完整成果。

完整第二次exec.log为13,905,068字节、未截断，SHA-256 `70b9fda1b81b97b0e1c8a8e89819bd2180302d71bfa7bb78394d77c349ea7656`。诊断副本没有回灌，旧任务、用量及账务保留。该旧候选未包含本次timeout补修；不能以新代码已测试通过声称旧调用已自动恢复。

下一次采用同三份原字节、同业务目标及本机Copilot，另建独立本地测试项目/数据库/存储/账号。原因是旧run已使用一次手动重新处理，没有可恢复快照；再次手动重启将耗尽该logical的恢复预算，不能用于验证完整自动恢复余量。旧同scope报价也已绑定原run，单换execution_request并不是独立入口。不通过删run、清用量或改账务制造续跑。

本记录形成时，新候选镜像已通过上述验证，新业务run尚未提交，真实双Word与最终服务端质量验收仍待完成。后续终态须单独追加。此前GitHub CI因账户付款/支出限制未启动，远程检查未通过；未绕过保护。

无SQL迁移或新npm/pip依赖；API、worker、web需同批集成。尚未部署，待统一发布。未取得用户验收，不是生产发布凭据。
