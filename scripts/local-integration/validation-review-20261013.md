# 2026-10-13 复核过程与动态积分集成

状态：开发和自测完成；**本地集成版可验收**；用户尚未验收；代码完成，尚未部署，待统一发布。

来源 [PR #696](https://github.com/ITSophiaXu/BondBuddy/pull/696)：`8361e8f8`（功能/原型）及 `60eb0656`（证据/产品决定），分别 cherry-pick 为 `3628767` 和 `0556ca5a673460ea73f4bd9805c54df180384c5a`。保留 #694/#695 和原集成基线。最终交接提交只补本测试、证据和文档；运行产品源码固定为 `0556ca5a673460ea73f4bd9805c54df180384c5a`。

入口仍为 **http://localhost:5178**，原账号 `integration_user` / `Local-Test-2026!`。刷新后检查材料标题对齐，点击“开始复核”直接进入任务；新完整/差异复核按实际服务端账本动态扣分，展示可用余额与已返回的复核过程，支持暂停/继续。旧任务沿用开始时计费；独立修订不改价格或预留。无新增迁移和依赖。

用户选择保留当前复核，结束后切换。11:02 核对该任务已成功完成且没有活动 run，才使用原 stop/start 脚本切换；保留原 PostgreSQL 数据、Azurite 文件、用户账号、成果和 parse volume。未取消或重跑用户复核。

候选及当前镜像 `sha256:e6fe1694717c7b8e415e59293dcebc38ac10f32e62373562cbdcef09ac9713db`（tag `bondbuddy-local-review:20261013`，原启动 tag `bondbuddy-local-worker:20261012` 同指此版本）。基于旧 `bf8a9d10` 的已验证依赖，覆盖已编译 API/worker/contracts 与测试文件；逐项核对编译文件 hash 与已测试开发源码一致。正常完整重建仍使用 `build-linux-worker.mjs`，其快照来自当前 checkout。旧镜像 ID 和 `linux-worker-before-review-20261013.json` 保留供本地回退；回退前同样先确认没有活动任务。

## 验证结果

- 集成 contracts/API/worker/web TypeScript 和 Vite 构建通过。前端产物 `index-CWYOWPCL.css` / `index-BC8JkEUa.js`，保留原有大包提示。来源回归：复核页面 59 通过/4 旧可选取证跳过，编制动态积分 2/2；隔离 PostgreSQL 11/11，Linux 文件复核和状态 7/7。
- **真实本地浏览器 2/2**：注册独立合成账号、复核项目创建、真实 DOCX 上传、保存/刷新；新增 `local-review-live.spec.ts` 用一个测试积分直接开始，当前 Linux worker 在输入检查点实际扣 1 分并暂停。刷新保持同一 run，账本余额为 0，过程显示“准备本次材料”；主动结束后仍扣 1 分。未拦截 API，未替换实际 worker。查询确认这次复核模型调用为 **0**（余额耗尽发生在模型执行前）。没有改动用户积分。
- 新镜像另执行一次最小真实模型连通探针：14,900 ms，exit 0，usage measured，生成两个 36,653 字节 Word，10 份运行资源校验通过。该探针只验证认证/权限/文件工具，不是完整复核质量验收。原 10/12 最小真实生成记录保留；新镜像 `endToEndVerified=false` 如实表示未重跑完整生成用例，不用旧镜像证据冒充新验证。
- 11:09 最终网页/API 200，ready=true，worker 运行且镜像 ID 正确，model verified=true。项目/材料/run 由 28/33/6 变为 30/35/7，增量全为两个独立合成测试；用户原复核仍为 succeeded，新测试 run 为 cancelled，无活动任务。
- 首次浏览器验证早于服务启动完毕而连接被拒；等待 start 返回 ready=true 后重跑 2/2 通过，无产品改动或断言放宽。

合成截图/验证见 `apps/web/test-evidence/local-review-live-20261013/`，详细过程日志在共享运行目录 `evidence/review-live-20261013/`、`model-preflight-review-20261013.log`、`status.json`。源码/原型对照随 #696 保留；旧用户项目不提交截图或文件。

## 验收与启停

用原账号打开复核材料页检查对齐，输入要求，点击开始；确认无重复确认框，观察积分和活动，刷新后确认同一任务。可暂停/继续，余额归零时充值后续跑。旧已完成任务显示原账务，动态规则用于新版开始的完整/差异复核。

启动 `node scripts/local-integration/start.mjs`；状态 `node scripts/local-integration/status.mjs`；停止 `node scripts/local-integration/stop.mjs`。本机服务使用 Node 22 便携路径（见 README），脚本会拒绝在活动任务未结束时停止。原登录信息、数据库和存储无需重建，不再次执行种子脚本覆盖账号。

本地流程及扣分自测通过不等于用户验收，也不代表完整募集书的行业内容已验收。本次没有生产操作。
