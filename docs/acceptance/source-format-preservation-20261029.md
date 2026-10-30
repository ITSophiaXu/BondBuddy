# 募集说明书原稿格式保留：首期工程验收

日期：2026-10-29。分支：`fix/prospectus-template-fidelity-20261029`；基线：`develop c7d0c42`。用户要求开始执行模板遵循修改方案，本次交付方案 PR 1–3 的首期闭环，尚未合并或部署。

## 实现与验证边界

材料区选择精确 DOCX/PDF 版本，API 把格式策略固定在不可变输入。首次 DOCX 编制在该包上受控编辑；成果续改继承所选清洁版，包括后来保存了其他格式模板但本轮仍续改旧成果的场景。旧任务没有 format_policy 时继续旧路径。

同一次 CLI 分章提交数据操作日志，模型输出的任意 DOCX 不作为正式成果。模型阶段持久化原稿、输入、清单和操作日志；可重试的 word_delivery 阶段调用受信任程序生成真实修订版和清洁版，定稿或存储失败不会为了重做文件再次调用模型。格式诊断独立于下载与 run 状态。

本期支持普通文字、单元格、多段落单元格、新增同级段落、普通表行和正文/表格批注；不支持增列、复杂合并变更、删除段落/行、整章迁移、复杂域及与旧修订重叠的修改。PDF 使用重建路径，无原稿使用新编路径，不能称作原 DOCX 版式保留。

修订稿保留原稿已有修订。清洁版沿用系统现有定义，接受包括历史修订在内的所有受支持修订；不能把它描述成“只接受本轮”。拒绝本轮新增修订的诊断与清洁版生成是两个不同操作。遇到尚不支持的历史结构修订会明确失败，不静默吞掉。

## 自动化证据

所有账号、任务、金额更新及网络回执均明确标记为 synthetic。真实数据库为独立本地 PostgreSQL 16 测试库（各套件克隆隔离数据库），对象存储为 Azurite。未使用生产账号或供应商密钥。

| 范围 | 命令/文件 | 结果 |
| --- | --- | --- |
| 全仓构建 | `npm run build` | 通过；Vite 保留现有大 chunk 提示 |
| 公共契约 | `npm run check:contracts` | 通过，171 个公开合成样例、12 个内部库样例；9 + 29 + 11 个契约检查测试通过 |
| 格式契约与 API 单元 | `node --test packages/contracts/dist/source-format.test.js apps/api/dist/source-format.test.js` | 7 项通过 |
| API、真实上传下载和生命周期 | `source-format.pg.test.js`、`update-project-e2e.pg.test.js`、`source-format-lifecycle.pg.test.js`、`deletion-lifecycle.test.js`、`storage-inventory.test.js` | Linux 最终合计 10 项通过，无跳过；新增生命周期 2 项单独同步后运行 |
| Worker 受控定稿与旧交付 | `file-authoring-format.test.js`、`file-authoring-delivery.test.js` | 9 项通过，无跳过；真实 Python，模型阶段为合成适配器 |
| Worker 后置诊断 | `word-format-diagnostic.pg.test.js` | 17 项通过（含 16 个子用例），无跳过；真实 PostgreSQL，覆盖并发、上传前持久化、项目清理后迟到上传、删除失败重试及外来引用隔离 |
| 固定编辑与已有文档回归 | `python/tests/test_fixed_edit.py`、`test_file_authoring.py`、`test_word_delivery.py` | 16 + 12 个唯一测试通过；最后诊断修复定向重跑 3 项通过 |
| 授权原稿引擎回归 | `python/tests/test_fixed_edit_authorized.py` | 1 项通过，内含 4 个已登记真实原稿子样本；仅临时合成文字修改，原件未改 |
| 页面与原型 | `source-format-template.spec.ts`、续改定向测试、原 source guide 定向回归 | 7 + 1 + 2 项通过；Edge，独立 Vite 5197，服务已停止 |

Windows Python 使用本机 bundled runtime，Node 24.22.1；Linux 使用 `BondBuddyM3` WSL 环境和 `/opt/venv/bin/python`。Python 可复现命令：设置 `PYTHONPATH=python` 后运行 `python -B -m unittest python.tests.test_fixed_edit python.tests.test_file_authoring python.tests.test_word_delivery python.tests.test_fixed_edit_authorized`。PG 测试需显式设置 `BB_TEST_DATABASE_URL`；上传下载套件还需 `BB_TEST_AZURITE_CONNECTION_STRING`；worker 的实际 Python 定稿测试需设置 `BONDBUDDY_TEST_PYTHON`。不要把未配置环境变量时的跳过算作通过。

授权原稿模板清单约 4.7–11.2 MB，低于 worker 的 32 MiB 限制；清单准备约 4–8 秒。单个 10,308 节点原稿只读基准：Editor 初载 1.705 秒，单批 100 个短段落更新 4.393 秒，tracked XML 序列化 0.535 秒。这些不是完整模型编制耗时。inspect/apply 每次仍会读原稿并重放累计日志，说明已要求按同章/同表合批，跨运行缓存尚未实现。

UI 证据在 [template-fidelity-20261029](../../apps/web/test-evidence/template-fidelity-20261029/README.md)。同宽 1440/390 原型和实现截图、源码/截图 SHA-256 及测试命令见该目录 provenance.json。对照为 c7d0c42 上本次修改，控件位于既有材料区，无新增页面。原型关联前端 Issue #361；本次不自动发送外部 Issue 消息。

## 完整 CLI 验证未通过

Linux 全仓构建通过；完整 `codex-file-authoring.test.js` 4 项及 `file-authoring.pg.test.js` 1 项失败于现有 `AUTHORING_FILE_SANDBOX_UNAVAILABLE` 预检，未进入模型编制或受控定稿。直接用相同 filePermissionArgs 做合成探针，得到 `file_boundary_failed: /proc/1/environ`：当前 Codex 0.154.0 + WSL 6.18.33.2 环境未按现有 `/proc` deny 规则隔离读取。root 与 nobody 均可复现；nobody 的附加重跑还出现共享 spool 权限问题，该重跑不计作应用回归证据。

未修改或绕过生产沙箱检查，没有真实供应商调用、完整 CLI 成功或线上下载验收。此限制阻止本分支直接合并发布；在具备兼容沙箱的隔离环境重跑上述 5 项，并做授权原稿从页面到双 Word 下载的完整试运行后再推进。

## 数据、发布与回滚

新增迁移仅 `0122_source_format_storage_inventory.sql`：扩展 inventory cursor 允许的 owned-run 前缀；自动 inventory 删除权限不扩大。原稿副本、输入、操作日志、定稿和格式报告均在账号/项目/run 私有前缀，删除任务受既有保留期、活动任务 pin 和持久化 receipt 约束。报告上传前保存 pending_report；删除失败保留该引用，项目已有 purge receipt 也可以重试清理。恢复测试采用模拟中断及重建连接池，没有终止真实进程。

上线先在隔离测试流量上验证支持范围，确认沙箱、字体及样本差异后逐步开放。旧输入不迁移；新格式执行版本单独记录。回滚前停止新任务进入新版本并排空正在编制/定稿的任务，保留能重放 controlled-docx-v1 持久化日志的 worker，不把已完成模型调用交给不识别该结果形态的旧 worker。

复杂结构、页面裁切/溢出、字体替代及 Word/WPS 兼容性属于后续增强与最终统一验收；XML/操作重放通过不表示这些检查已执行，也不表示募集说明书内容或法规适用已经审核。
