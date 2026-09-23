# BondBuddy 开发约定

本文件适用于整个仓库。接到任务后，先阅读对应的 GitHub Issue 和下列文档。具体技术设计写在架构文档中；只有协作约定变化时才修改本文件。

## 依据与优先级

1. 用户当前要求和已分配的 GitHub Issue 确定任务范围与验收标准。
2. `product-prototype/product-specs/00-产品边界与需求决策.md`、`16-数据模型接口与状态机.md`、`17-验收测试与实施路线.md` 确定产品行为、数据语义和验收要求。
3. `docs/M1-TECH-ARCHITECTURE.md` 规定 M1 技术栈、组件边界、公共契约及四人分工。实现决策变化时同步更新。
4. `product-prototype/` 是 BondBuddy 的交互与算法原型。根目录的 `backend/`、`web/` 和当前 `deploy/vm/` 属于旧 Cowork 应用，不要通过扩展旧 Cowork 服务再造一套 M1 生产 API。

若上述依据冲突，先在 Issue 或 PR 中说明，并与受影响负责人确定公共契约，再开发依赖该契约的代码。不要自行改变业务规则或接口格式。

## M1 技术基线

- 浏览器：保留 `product-prototype/public/` 现有体验，渐进迁移至 Vite 和公共 API 类型；新模块使用 TypeScript。M1 不整体重写 UI 框架。
- API：Node.js 22、TypeScript、Fastify、JSON Schema/OpenAPI，公开接口统一使用 `/api/v1`。
- 数据：PostgreSQL 16 保存身份、项目、版本、任务、参考资料元数据、审计和 outbox；私有 Azure Blob Storage 保存材料、prompt 快照和成果。本地使用 Azurite。
- 后台任务：独立 Node worker，通过 PostgreSQL 租约和持久化检查点执行；Python 3.11+ 子进程通过带版本的 JSON 输入输出处理解析、OCR 和 Word。
- AI：服务端隔离 Codex/DeepSeek 适配器。#16 必须先验证准确模型 ID 和协议行为；每次调用记录真实用量，缺失时记为 `unknown`。
- 部署：M1 使用 Azure VM 上的 Docker Compose、Nginx 和 TLS。试用成本由平台承担并记录，不把演示积分当作生产账务。

以上是架构评审基线。实现若需改变选型，先在架构文档及受影响的契约中记录决定，再合并代码。

## 公共契约

- API 请求/响应 schema、错误码、枚举、任务事件和公开 DTO 只在 `packages/contracts/` 定义一次，并由此生成或导入客户端。页面和 worker 不得各自复制市场、发行方式、状态或错误码枚举。
- 所有个人资源按 `user_id` 隔离；API 和 worker 读写时均校验归属。浏览器状态或客户端传入的 ID 不能作为授权依据。
- 执行时锁定不可变的 `input_revision`、`input_hash` 以及材料、规则、模板和参考资料版本。相同输入重复提交同一个 `execution_request_id`，必须返回同一个 run。
- 业务变更和对应 outbox 事件在同一数据库事务中持久化。关闭浏览器不取消任务；worker 恢复时先核对既有模型调用，再决定是否重试。
- 文件字节存私有对象存储，元数据和 hash 存 PostgreSQL。生产账号、项目、任务和参考资料发布记录不得写入原型 JSON 文件。
- OCR 存疑数字、证据缺失、模型用量缺失、未发布或已撤回的参考资料都要保留明确的待处理状态，不能当成已确认事实、零用量或成功成果。
- 只有 Word 成果通过交付检查且授权用户可以获取时，run 才能标为成功。向真实用户开放更新任务前，#79 日志能力必须就绪。

## 四人协作与分支

- 每个 Issue 从最新 `develop` 创建独立分支和工作区。功能、修复、文档和基础设施 PR 一律以 `develop` 为 base；不要投向旧的 `feat/review-classification-optimization` 分支，也不要直接推送 `develop`。
- `master` 是稳定发版分支。只有经过评审的 `develop → master` 发版 PR 才推进它；从合入的 `master` 提交部署，并记录提交/tag、迁移、验证和回滚方案。不要为了让两个分支持续一致而把未完成的 M1 工作合入 `master`。
- 紧急生产修复从 `master` 建分支，评审后合入 `master`，再把同一修复合入或 cherry-pick 回 `develop`。
- PR 保持可审阅的范围，写明 Issue 编号、契约或迁移变化、样本证据及剩余阻碍。仓库默认分支目前可能仍指向别处，创建 PR 时明确指定 `develop`。
- Chris 负责浏览器 UI 和 API client；Felix 负责 API、任务基础设施、数据库迁移、部署和可观测性；Maxy 负责债券业务规则、市场/品种适用性与参考库验收；Xuefeng 负责抽取、OCR、事实处理、匹配和生成算法。详细边界见架构文档。
- 修改 `packages/contracts/`、`db/migrations/`、run 状态机或公共市场/规则枚举时，请受影响负责人 review。迁移只能新增，不能修改已部署的迁移。
- 跨模块联调使用稳定 schema 样例和已获授权的样本材料，并标明合成数据。模拟模型响应或演示流程不能冒充真实供应商联调或专业验收。
- 不提交凭证、客户材料、本地运行目录或生成成果；部署密钥留在目标环境。

## Codex 接到 Issue 后

1. 拉取最新 `develop`，为该 Issue 建独立分支与工作区；阅读本文件、完整 Issue（含前置任务和验收标准）及其关联规格。部分 Issue 链接仍指向旧默认分支，应以当前 `develop` 中的对应文件为准。
2. 开始修改前明确交付物、涉及模块、公共契约、前置任务和验收证据。GitHub assignee 对 Issue 交付负责；涉及其他人的模块时，请该模块负责人 review。同一 Issue 的多个 Codex 会话由 assignee 协调，避免各自实现不同契约。
3. 架构文档中的目录是迁移目标，不代表骨架已完成。#6 建立首批公共契约和项目骨架之前，可并行做独立 UI、解析、规则及供应商调研；跨模块代码先与受影响负责人对齐 schema。不得自行再造 API、复制公共枚举，或把模拟接入说成完成。前置任务未满足时，不能声称该 Issue 已验收。
4. 使用所改包中实际存在的脚本和启动说明；目前没有全仓库统一的 M1 构建命令。每个 PR 聚焦一个 Issue 或已约定的集成切片。公共决策变化时，同一 PR 更新契约/schema 样例和架构文档。
5. PR 显式以 `develop` 为 base，列出 Issue 编号、已覆盖的验收项、契约/迁移变化、证据和剩余依赖；合并前请受影响负责人 review。只有验收标准和前置条件都满足，Issue 才算完成；未解决事项写在 PR 或 Issue 中。

## 首个集成目标

真实登录 → 创建项目 → 上传并核验 DOCX/PDF → 保存材料版本 → 提交持久化 run → 关闭并重开浏览器后恢复状态 → 获取通过检查的 Word 成果。这条链路必须留存 prompt、任务、模型调用尝试、token、错误和终态证据。
