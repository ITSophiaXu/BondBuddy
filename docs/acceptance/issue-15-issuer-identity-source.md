# 发行人身份来源与审核交接

`0035_m1_issuer_identity_source.sql` 追加 owner、项目、材料版本限定的身份观察及审核。每条观察绑定一条不可变 `bb_parse_evidence`，保存快照、解析记录及内容 hash、locator、原文。解析生产者从完整快照选择显式名称陈述；同名多锚点分别写观察，冲突名称不自动择一。重跑使用快照、规范化名称和单个锚点决定的稳定请求 ID。

观察行数据库列 `entity_id` 对外称 `candidate_key`。生产值 `issuer-name:v1:<sha256 前 32 位>` 只聚类候选名称，不是工商主体 ID。0045 为审核行另存 `verified_entity_id`、`entity_basis_kind`（`uscc`、`registry_record`、`manual_attestation`）和不超过 512 字符的 `entity_basis_ref`。verified 必须有三者；主体 ID 只能为 `uscc:<18 位统一社会信用代码>` 或 `entity:<uuid>`；`uscc` 依据引用必须与代码一致。依据不足时审核人可 rejected/conflict，不得把候选键提升为 verified。审核追加且不可修改；历史 verified 行缺审核后主体 ID 时，loader 返回 null。

审核人必须持有效 `issuer_identity_reviewer` grant，授权由数据库管理员在公开 API 之外记录授予人、依据、理由和时间；撤权后审核无效。GET 按 owner 列出全部锚点及审核状态；verified 请求的主体依据缺失或无效返回 400 `ISSUER_IDENTITY_VERIFICATION_INVALID`。同一完整审核决定重放幂等，变更决定或依据冲突。

`loadVerifiedIssuerIdentitySourceRecord` 是 input revision、run 和事实候选的可信主体入口。一个材料版本的所有观察都需有效 grant 下的 verified/rejected 审核，且 verified 的 `verified_entity_id` 唯一；同项目相同 `candidate_key` 跨材料指向不同主体时也拒绝绑定。返回的 `entityId` 是审核后的主体 ID，事实键不得直接读取观察行 `entity_id`。审核不会修改旧 input revision；须创建新 revision。获授权 DOCX 回归中的 `evidence-000306` 与 `evidence-000428` 是两条独立待审观察，其原文定位均可在 GET 检查。

合成/获授权材料回归验证数据边界和审核接缝，不代表真实发行人身份、实体登记来源或行业成果完成专业核验。
