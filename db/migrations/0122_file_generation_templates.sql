-- Originals and previews are private, separate immutable assets. Browser DTOs
-- never include original object keys, original names, or document text.
CREATE TABLE bb_file_template_sets (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL,
 request_id text NOT NULL, request_hash char(64) NOT NULL,
 name text NOT NULL, version text NOT NULL, origin text NOT NULL CHECK(origin IN ('builtin','private')),
 records jsonb NOT NULL, warnings jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id), UNIQUE(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_file_template_adoptions (
 owner_user_id text NOT NULL, project_id text NOT NULL, set_id text NOT NULL, record_id text NOT NULL,
 template_ref jsonb NOT NULL, material jsonb NOT NULL,
 PRIMARY KEY(owner_user_id,project_id,set_id,record_id),
 FOREIGN KEY(owner_user_id,project_id,set_id) REFERENCES bb_file_template_sets(owner_user_id,project_id,id)
);
CREATE TABLE bb_file_generation_preparations (
 owner_user_id text NOT NULL, project_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 preparation jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,project_id), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_file_generation_batches (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL,
 request_id text NOT NULL, request_hash char(64) NOT NULL, snapshot jsonb NOT NULL,
 workpaper_batch_id text REFERENCES bb_workpaper_batches(id), document_batch_id text REFERENCES bb_project_file_batches(id),
 points bigint NOT NULL CHECK(points>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK(workpaper_batch_id IS NOT NULL OR document_batch_id IS NOT NULL)
);
CREATE FUNCTION bb_file_generation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable file generation input'; END $$;
CREATE TRIGGER bb_file_template_sets_immutable BEFORE UPDATE ON bb_file_template_sets FOR EACH ROW EXECUTE FUNCTION bb_file_generation_immutable();
CREATE TRIGGER bb_file_generation_batches_immutable BEFORE UPDATE ON bb_file_generation_batches FOR EACH ROW EXECUTE FUNCTION bb_file_generation_immutable();
