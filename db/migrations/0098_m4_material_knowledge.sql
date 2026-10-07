-- 2026-10-07: user-approved underwriter/legal drafts. No changes to existing runs or prices.
ALTER TABLE bb_m4_templates DROP CONSTRAINT bb_m4_templates_document_type_check;
ALTER TABLE bb_m4_templates ADD CONSTRAINT bb_m4_templates_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal'));
ALTER TABLE bb_m4_drafts DROP CONSTRAINT bb_m4_drafts_document_type_check;
ALTER TABLE bb_m4_drafts ADD CONSTRAINT bb_m4_drafts_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal'));
ALTER TABLE bb_m4_artifacts DROP CONSTRAINT bb_m4_artifacts_document_type_check;
ALTER TABLE bb_m4_artifacts ADD CONSTRAINT bb_m4_artifacts_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal'));
ALTER TABLE bb_m4_pending_requirements DROP CONSTRAINT bb_m4_pending_requirements_consumed_document_type_check;
ALTER TABLE bb_m4_pending_requirements ADD CONSTRAINT bb_m4_pending_requirements_consumed_document_type_check
 CHECK(consumed_document_type IS NULL OR consumed_document_type IN ('init','private_summary','underwriter','legal'));
