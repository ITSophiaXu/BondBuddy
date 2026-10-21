-- Project files keep exact source/template references and append-only output versions.
CREATE TABLE bb_project_file_workspaces (
 owner_user_id text NOT NULL, project_id text PRIMARY KEY, topic_id text NOT NULL UNIQUE,
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id)
);
CREATE TABLE bb_project_files (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, document_type text NOT NULL,
 latest_version_id text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), UNIQUE(project_id,document_type),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_project_file_versions (
 id text PRIMARY KEY, owner_user_id text NOT NULL, file_id text NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
 filename text NOT NULL, asset jsonb NOT NULL, revision_asset jsonb, source_version_id text,
 template_id text, template_version integer, run_id text, links jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,id), UNIQUE(file_id,sequence), UNIQUE(run_id),
 FOREIGN KEY(owner_user_id,file_id) REFERENCES bb_project_files(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,template_id,template_version) REFERENCES bb_m4_templates(owner_user_id,id,version)
);
ALTER TABLE bb_project_files ADD FOREIGN KEY(owner_user_id,latest_version_id) REFERENCES bb_project_file_versions(owner_user_id,id);
CREATE TRIGGER bb_project_file_versions_immutable BEFORE UPDATE OR DELETE ON bb_project_file_versions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_project_file_batches (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, topic_id text NOT NULL,
 request_id text NOT NULL, request_hash char(64) NOT NULL, items jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','paused','complete','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), UNIQUE(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id)
);
CREATE INDEX bb_project_file_batches_pending ON bb_project_file_batches(created_at) WHERE state IN ('queued','running');
CREATE TABLE bb_project_file_operations (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('check','patch')), manifest jsonb NOT NULL, input_hash char(64) NOT NULL,
 result jsonb, result_hash char(64), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,run_id), FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_project_file_import_requests (
 owner_user_id text NOT NULL, request_id text NOT NULL, request_hash char(64) NOT NULL, file_version_id text NOT NULL,
 PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id)
);
CREATE TABLE bb_project_file_generation_links (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL, result jsonb NOT NULL, result_hash char(64) NOT NULL,
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_project_file_generation_links_immutable BEFORE UPDATE OR DELETE ON bb_project_file_generation_links
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_project_file_acceptances (
 owner_user_id text NOT NULL, check_run_id text NOT NULL, file_version_id text NOT NULL, issue_ids jsonb NOT NULL,
 run_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(check_run_id,run_id), FOREIGN KEY(owner_user_id,check_run_id) REFERENCES bb_project_file_operations(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE FUNCTION bb_project_file_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.owner_user_id,NEW.project_id,NEW.operation,NEW.manifest,NEW.input_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.project_id,OLD.operation,OLD.manifest,OLD.input_hash,OLD.created_at)
 OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.result_hash) IS DISTINCT FROM ROW(OLD.result,OLD.result_hash))
 THEN RAISE EXCEPTION 'Project file operation snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- Adopt previously delivered M4 documents without pretending old outputs have verified links.
WITH old_files AS (
 SELECT DISTINCT a.owner_user_id,coalesce(w.source_project_id,t.source_project_id,t.project_id) AS project_id,a.document_type
 FROM bb_m4_artifacts a JOIN bb_m4_topics t ON t.owner_user_id=a.owner_user_id AND t.id=a.topic_id
 JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
 LEFT JOIN bb_update_workspaces w ON w.owner_user_id=t.owner_user_id AND w.update_project_id=t.source_project_id
 WHERE a.kind='document' AND t.surface<>'assistant' AND r.state='succeeded'
) INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type)
 SELECT 'legacy-file-'||md5(owner_user_id||':'||project_id||':'||document_type),owner_user_id,project_id,document_type FROM old_files;
INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,run_id,created_at)
 SELECT 'legacy-file-version-'||a.artifact_id,a.owner_user_id,f.id,
 row_number() OVER(PARTITION BY f.id ORDER BY a.created_at,a.run_id)::int,
 CASE a.document_type WHEN 'init' THEN '立项报告' WHEN 'private_summary' THEN '募集说明书摘要' WHEN 'underwriter' THEN '主承销商核查意见'
 WHEN 'legal' THEN '法律意见书' WHEN 'application' THEN '申请书' ELSE '推荐函' END||'.docx',
 jsonb_build_object('kind','artifact','pin',jsonb_build_object('source_project_id',r.project_id,'artifact_id',v.id,'artifact_version',v.version,'sha256',trim(v.sha256))),r.id,a.created_at
 FROM bb_m4_artifacts a JOIN bb_m4_topics t ON t.owner_user_id=a.owner_user_id AND t.id=a.topic_id
 JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
 JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
 LEFT JOIN bb_update_workspaces w ON w.owner_user_id=t.owner_user_id AND w.update_project_id=t.source_project_id
 JOIN bb_project_files f ON f.owner_user_id=a.owner_user_id AND f.project_id=coalesce(w.source_project_id,t.source_project_id,t.project_id) AND f.document_type=a.document_type
 WHERE a.kind='document' AND t.surface<>'assistant' AND r.state='succeeded' AND v.delivery_status='available' AND v.quality_status='passed';
UPDATE bb_project_files f SET latest_version_id=(SELECT v.id FROM bb_project_file_versions v WHERE v.file_id=f.id ORDER BY v.sequence DESC LIMIT 1);
CREATE TRIGGER bb_project_file_operation_identity BEFORE UPDATE ON bb_project_file_operations
 FOR EACH ROW EXECUTE FUNCTION bb_project_file_operation_guard();

-- User templates cover the twelve explicit file types; old quotations/inputs retain their terms.
DO $$ DECLARE tab text; col text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['bb_m4_templates','bb_m4_drafts','bb_m4_artifacts','bb_m4_pending_requirements'] LOOP
  col:=CASE WHEN tab='bb_m4_pending_requirements' THEN 'consumed_document_type' ELSE 'document_type' END;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',tab,tab||'_'||col||'_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(%I IN (''init'',''private_summary'',''underwriter'',''legal'',''application'',''recommendation'',''annual'',''semiannual'',''issuer'',''financial'',''credit'',''proceeds''))',tab,tab||'_'||col||'_check',col);
 END LOOP;
END $$;
ALTER TABLE bb_m4_templates DROP CONSTRAINT bb_m4_templates_market_check;
ALTER TABLE bb_m4_templates ADD CONSTRAINT bb_m4_templates_market_check CHECK(market IN ('sse','szse','nafmii'));
ALTER TABLE bb_m4_templates ADD COLUMN offering text NOT NULL DEFAULT 'private';
ALTER TABLE bb_m4_templates ADD CONSTRAINT bb_m4_templates_offering_scope CHECK(
 (market IN ('sse','szse') AND offering IN ('private','public','public_all')) OR
 (market='nafmii' AND offering IN ('ppn','mtn','scp','cp','dfi')));
CREATE FUNCTION bb_m4_template_offering_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.offering IS DISTINCT FROM OLD.offering THEN RAISE EXCEPTION 'Template scope is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_m4_template_offering_identity BEFORE UPDATE ON bb_m4_templates FOR EACH ROW EXECUTE FUNCTION bb_m4_template_offering_guard();

ALTER TABLE bb_prospectus_versions ADD CONSTRAINT bb_prospectus_version_owner_key UNIQUE(owner_user_id,id);
ALTER TABLE bb_project_file_versions ADD FOREIGN KEY(owner_user_id,source_version_id) REFERENCES bb_prospectus_versions(owner_user_id,id);
CREATE TABLE bb_project_file_update_batches (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, check_run_id text NOT NULL,
 request_id text NOT NULL, request_hash char(64) NOT NULL, items jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','paused','complete','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,check_run_id) REFERENCES bb_project_file_operations(owner_user_id,run_id)
);
CREATE INDEX bb_project_file_update_batches_pending ON bb_project_file_update_batches(updated_at) WHERE state IN ('queued','running');
CREATE TRIGGER bb_project_file_acceptances_immutable BEFORE UPDATE OR DELETE ON bb_project_file_acceptances
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_project_file_operations_no_delete BEFORE DELETE ON bb_project_file_operations
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_fixed_quote_terms;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_fixed_quote_terms CHECK(
 (billing_method='metered_capped' AND fixed_price_version IS NULL) OR
 (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05','m4_G04','m4_application','m4_annual','m4_semiannual','m4_issuer','m4_financial','m4_credit','m4_proceeds','m4_Q01','m4_Q02','m4_Q03','m4_Q04','m4_Q05')
 AND config_id IS NULL AND reserve_points>0 AND fixed_price_version IS NOT NULL));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_dynamic_document_policy;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_dynamic_document_policy CHECK(billing_policy='on_delivery' OR
 (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05','m4_G04','m4_application','m4_annual','m4_semiannual','m4_issuer','m4_financial','m4_credit','m4_proceeds')));
DO $$ DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,'''m4_application''')=0 OR strpos(definition,'authoring_balance_v2')=0 THEN RAISE EXCEPTION 'Unexpected M4 finalizer definition'; END IF;
 EXECUTE replace(definition,'''m4_application''','''m4_application'',''m4_annual'',''m4_semiannual'',''m4_issuer'',''m4_financial'',''m4_credit'',''m4_proceeds''');
END $$;
