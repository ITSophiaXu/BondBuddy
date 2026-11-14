# 文件编制超时后的受信工作恢复（#1341）

首次发现：2026-11-14（北京时间），静态审查。基于冻结候选 dc7a83683603b91504f0c6efb037507cb226774d 的独立补修；不修改正在运行的真实 Copilot attempt，不延长其五小时上限，不将预计超时写成已发生。

## 原因与修复

文件编制达到 authoring timeout 后，适配器关闭本机子进程并保存 `pending_reconcile / MODEL_TIMEOUT`，原恢复快照 hook 未覆盖此错误，临时工作区随后删除。旧 unified-v3/v4 timeout 恢复不适用于 `file-authoring-v1`。

现在仅在适配器已收到子进程关闭、明确 exit 证据、且任务 signal 未取消时调用原受信快照程序：核对原输入与只读文件，保存 `input.json`、全部 `scratch/` 和 `output/`，逐个回读 hash，在有效租约下发布完整检查点，再清理临时目录。中途取消、租约丢失、存储或完整性失败不能获得有效续跑快照。

自动扫描与手动重试复用原任务和逻辑调用，逐项核验身份、输入版本/hash、已结束的最新尝试、唯一且无矛盾的 unknown 用量观察、没有该尝试成果、原账务可恢复及完整快照。原调用观察和 unknown 用量保持原样，不伪造未发送或零用量。HTTP 413、输出超限、超时和手动重新处理共用每个逻辑调用两次、全任务六次的预算；用户暂停、积分暂停、取消和账务隔离继续优先。

旧版本 `file-authoring-v1` 超时若根本没有快照，仅提供需用户确认的 `restart_materials`，保留原输入和失败记录。无效或身份错误的已有快照不能冒充旧版本缺失，也不能回退为重新开始。手动重新处理后的 timeout 自动/手动恢复继续选择精确的后继提示词快照，不重放旧初始化提示。

## 界面与契约

沿用 #1302 已有状态卡、步骤、重试入口和确认对话框布局。新增超时的“正在核对恢复条件”“已安排自动续跑”“恢复不可用”“次数耗尽”原因及准确文案；核验前不声称进度已保存。旧无快照入口明确说明重新处理；用户撤销暂停后仍须单独确认重新处理。保持编制步骤，不回退成尚未开始。

公共事件原因在 `packages/contracts/src/worker-runtime.ts` 唯一定义，新增 `file_authoring_timeout_*` 四项。run 状态、重试 DTO/mode、业务门禁及费用政策不变；无数据库迁移、无新依赖。API、worker 与 web 应同批集成。

## 验证记录

2026-11-14 在独立工作区完成下列自测。所有测试均为 synthetic，零真实模型调用；不替代当前真实 Copilot 任务的终态、Word 或专业内容验收。

- Windows / Node 22.14.0：`npm run build` 通过；仅 Vite 既有大 chunk 提示。
- `npm run check:contracts` 通过：72 个测试、179 个合成样例、12 个内部库样例和4个数据生命周期样例，0 fail / 0 skip。
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json` 通过；`node --test --test-concurrency=1 apps/web/dist-test/authoring-progress.test.js apps/web/dist-test/authoring-status.test.js`：19 pass / 0 fail / 0 skip。
- Linux 定向组使用 `node --test --test-concurrency=1` 执行 worker 的 `codex-file-output-limits`、`codex-file-authoring`、`file-authoring-recovery`、`file-authoring-restart`、`file-authoring-instructions`、`file-authoring-payload-recovery.pg`、`unified-timeout-recovery` 及 API `file-authoring-recovery` 编译测试。首轮38 pass / 2 fail / 0 skip；两项 PG 矩阵均在准备21个活动任务的扫描场景时，被测试容器继承的生产模式并发限制拒绝（429 active_runs_per_user）。恢复逻辑不因该测试配置问题修改。
- 明确测试容器 `NODE_ENV=test` 后，仅复跑 `apps/worker/dist/file-authoring-payload-recovery.pg.test.js`：2 pass / 0 fail / 0 skip（2026-11-14 05:43:33 UTC完成）；首轮其余38项不重复运行。最终定向40项均有通过证据。
- 独立 PostgreSQL 16 临时库、内部 Docker 网络、只读代码挂载及受限测试容器；worker镜像固定 `sha256:2a1bbe5398f0c204cfedbf43789be0b04ba6093be67240d27e86c2a708a66741`。测试资源结束后清理，未接触真实任务、数据库或模型。首轮与复跑的manifest、测试文件hash和原日志分别保留于未提交的 `work/bb-timeout-1341-6ac61af5-1ea` 与 `work/bb-timeout-1341-206d7a94-62c`。
- 独立代理只读审查通过，无剩余可操作的生产代码发现；`git diff --check` 通过。新增超时文案已有单元测试，未新增浏览器对照截图，最后集成时仍须进行界面对照。

回归覆盖：实际合成子进程到时关闭后才调用实际快照/恢复 helper；取消、关闭后 abort、快照保存失败、未知错误不擅自重发；PG 自动/手动竞争与幂等、原用量/预留不变、跨错误共享预算、旧无快照重启、用户暂停/继续、积分暂停、取消、租约、输入/尝试/结果冲突和隔离账务拒绝。

## 集成边界

本分支只补 #1302 的 timeout 遗漏，未合入 #1339 的页数渲染交接。整合 #1339 时以 #1302 的完整 bootstrap/recovery stage 为骨架，加入 `defer_page_rendering_to_host` / `not_verified` 指引，保留完整 task/fixed-edit 首次注入、64KiB 界限和 timeout 恢复 hooks，不能整文件覆盖为 #1339 的旧基线 stage。模型完成后 worker 独立重建、真实渲染、事实/结构/格式及70%门禁保持不变。

当前真实任务和临时诊断备份均未被本修复操作；诊断副本不得回灌应用检查点。代码交付与自测、真实运行、用户验收和部署分别记录。尚未部署，待统一发布。