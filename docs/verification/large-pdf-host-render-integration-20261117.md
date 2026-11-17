# 大 PDF 候选的渲染交接整合（2026-11-17）

Refs #994、#1324、#1339；Fix PR #1483。本文记录终态后的代码补修和本地验证，不把合成渲染当作真实大 PDF 业务验收。

## 问题与改动

真实隔离 run `1792b8a7-3c84-479a-a24f-f3b54c051998` 已按原 deadline 自然超时，未交付双 Word。终态首次窄范围解析曾把最后一次预检记为 `NOT_PARSED`；后续完整原始日志重读已在 `item_633` 确认当前 2,111 操作快照的 failed 预检仅含 `WORD_PAGE_COUNT_UNAVAILABLE`，未带 `host_handoff`。这是分页失败证据，不证明所有业务处理已完成；完整根因和接续补修见[续跑与分页交接](large-pdf-continuation-20261117.md)。已有 #1339 / PR #1340 独立合成证据证明原文件沙箱内 LibreOffice 无法真实渲染；这不是本轮全部耗时或超时的唯一已证原因。

选择性整合 PR #1340 的 `2168b643389694a4fd1b4528d06c7bbfa5d61966`：预检重新核对当前输入、底稿和操作日志，仅在快照有效、顶层与质量报告均 failed、报告版本一致、非空 issues 完全相同且全部为 `WORD_PAGE_COUNT_UNAVAILABLE` 时，给出绑定当前 `operations_sha256` 的 `host_handoff`。简短 stdout 继续 failed、退出码 1；完整失败报告保留，`authoring_completion=not_verified` 不证明业务完成。

保留当前较新的完整 `task.md` / `fixed-edit.md` 初次注入、64 KiB 预算、2 MiB 请求保护、128k 文件工作窗口、快照和原绝对 deadline。没有采用旧 PR 的短 bootstrap。受控首次/修复提示、旧 pinned prompt 的固定 runtime developer instructions 和 custom compact handoff 均包含精确交接限制；日志变化或混合失败不得沿用旧指引。模型先完成剩余材料阅读、事实和章节更新、来源回查，再对最终日志预检；不能仅为渲染环境反复改正文。

宿主不消费模型报告作为批准；仍从锁定底稿和最终操作独立重建双稿、真实渲染并检查全部质量项及正文/实际页数 70% 下限。渲染故障继续既有有界基础设施重试，不新增模型改稿。无公共契约、数据库迁移、前端页面或计费政策变更。

## 本次验证

- `npm run build -w @bondbuddy/worker` PASS；实际 first/direct/controlled、repair、recovery 共 8 组提示组合在同一集成测试中全部通过，完整指令原样各出现一次，64 KiB、2 MiB、恢复 flag/deadline 和新模板版本均检查。
- Linux `PYTHONPATH=python /opt/venv/bin/python -B -m unittest discover -s python/tests -p test_fixed_edit.py -v`：55/55 PASS，含纯渲染失败、混合失败、日志变化、旧报告清除、短 stdout 隐私和 CLI exit 1。首次 shell 包装器在 suite OK 后返回 exit 格式错误；不把该包装器退出码称为测试成功。
- 断网容器开发 overlay：104 项非协议测试全部通过，涵盖 adapter、instructions、format、quality、delivery、repair、recovery。再以 Git 原字节夹具单独完成固定 CLI0.169 协议 4/4，合计 108 个不同测试通过，0 最终失败/跳过/取消/TODO。不是一次 108/108 的单独运行。
- 无网络真实沙箱→宿主验证通过：中途 30 操作继续到最终 60 操作；最终日志 hash 重新预检并由宿主重放同一版本，60→60 页通过；混合事实失败、正文缩减及相同正文 60→20 页仍拒绝。模型调用为 0。

容器使用历史准确 b962 官方运行时镜像 `sha256:9c3225d380909d1fd2c472a37aba314e443f735718d2a707702f65a049811ce7` 加当前 worker 编译产物/Python/scripts 的只读挂载；这是开发 overlay，不是新提交准确镜像。Node22、UID1000:1000、network none、只读 rootfs、cap-drop ALL、NNP 和既有 seccomp，无真实凭据、供应商调用或业务服务启动。WSL AppArmor 不可用。

| 私有本地证据 | SHA256 |
| --- | --- |
| 非协议 PASS 所在完整 r2 TAP | `06f0bae7476b97a511d20df04185708ce2e72421765bda7953f6715dfa61d6a0` |
| 修正夹具后的固定 CLI 协议 4/4 TAP | `4beb321f852c604f85d855a66a3d3164abbf40cd5738080c2c692a4f39d32fba` |
| 真实沙箱→宿主完整合成渲染报告 | `3d83038bbd6f6a034eb00a4651cac0c93dd3819f7fc2c874e9f37f9301c9e397` |

首次容器验证因遗漏四个只读源文件夹具出现 6 个 ENOENT；补齐后 104 非协议项及静态协议项通过，余下 3 协议项在 packaged LF 与 Windows CRLF 字节比较失败。未改产品或削弱断言；改用未变更文件的 HEAD 原始 Git blob（无换行归一化），仅复跑受影响的协议套件 4/4。旧失败及完整日志均保留。

复跑入口：`scripts/preflight-host-render/verify.mjs` 与相邻 `fixtures.py`；在一次性无网络 Linux worker 容器内运行 `node /app/scripts/preflight-host-render/verify.mjs`，并保留原 file permission/seccomp 隔离。脚本只生成合成输入；不使用任何真实任务卷、客户原件或凭据。正式镜像未复制 scripts 时需只读挂载这两份源码及测试需要的 Git 原字节目录夹具。

全仓 `npm run build` 与 `npm run check:contracts` 均通过；构建在 Windows Node26.13.0，以上运行时回归使用 Linux Node22。构建仅有既有前端 chunk 大小提示。

## 仍未通过的真实验收

本轮没有第三次业务提交、模型重跑、原 deadline 修改、余额/预留修改、合并、部署或发布凭据。真实任务仍为 `FAIL_NOT_DELIVERED`，财务成果 0/36、视觉 NOT_RUN；新补修尚未用真实四材料完成双 Word。原累计提交报价 69,140 已使用完，退款不重置该授权上限；新业务执行须取得追加范围授权。#1534 单独跟踪已知超时原因在页面被泛化的问题，不由本次修复宣称完成。
