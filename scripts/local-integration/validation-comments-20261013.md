# 2026-10-13 复核批注来源验证

来源 PR #698，开发 `33e42cc2` / `e40574b3` → 集成产品源码 `f9ea16564d613deab68b850a4f34fa1fadccbad0`。本次仅替换本地 worker 的两份 Python 生产文件及对应测试。前端仍为 `f13c8c6`（PR #697），API 仍为 `0556ca5a`；保留 #694–#697 的功能。

## 行为及验收

- 新批注署名 **BondBuddy · 本轮复核**；已知旧工具（包括“募集书 Cowork”）的原稿批注署名 **BondBuddy · 原稿批注**。
- 历史内容、日期、依据和定位保留，人工/未知作者不变。报告说明原稿批注不代表本轮已核验。
- 既有保存成果不静默覆盖；新规则适用于后续生成。用户当前成功复核已离线生成修正副本，无须重跑和扣费。
- 同一入口 http://localhost:5178，账号 `integration_user` / `Local-Test-2026!`。后续复核可下载原文批注版检查两类署名；本次修正副本位于共享证据目录 `evidence/review-comment-authors-20261013/regenerated/comments.docx`，不写回不可变成果。

## 验证结果与边界

- Windows Python 30/30；无网络/无凭据 Linux 候选镜像 30/30。
- 候选镜像实际 worker → Python 原文批注交付 4/4，合成模型响应，不冒充真实模型验收。
- 真实本地原稿和已保存复核报告离线再生成：152 条原稿批注、52 条本轮批注；所有批注文字/日期、正文签名和原文件 hash 一致，52 处成功定位、18 处保留原有定位限制。没有新的模型调用、业务数据库写入或扣费。
- 12:44 切换前活动任务 0；使用带进程身份检查和空闲检查的既有 restartWorker，仅替换本实例 worker，保留 parse volume。网页/API/数据库/存储进程身份不变，项目/材料/run 仍为 30/35/7。
- 新镜像 `sha256:85e2a227ec1f0197750f05f03204f59c39bae671edd2548f47e5331fd861b01d`。运行容器内两份 Python 文件 hash 与固定集成源码一致；网页/API 200，worker 心跳正常。
- 本次没有重新调用真实模型探针，`modelGeneration.verified=false`、`endToEndVerified=false` 如实记录；旧探针证据保存在 previousPreflight，不能冒充新镜像验证。模型运行时和凭据配置未变。
- 无契约、依赖或迁移；页面布局不变，无原型差异。启停继续使用 `node scripts/local-integration/start.mjs` / `stop.mjs`，状态用 `status.mjs`。

证据仅保存在共享本地运行目录：`comment-worker-switch-20261013.json`、`comments-status-after-20261013.json`、`evidence/review-comment-authors-20261013/verification.json`。真实原稿及成果不提交 GitHub。

**开发和自测完成，本地集成版可验收；用户尚未验收；代码完成，尚未部署，待统一发布。**
