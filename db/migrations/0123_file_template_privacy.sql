ALTER TABLE bb_material_versions ADD COLUMN internal_template boolean NOT NULL DEFAULT false;
CREATE TABLE bb_file_generation_cancellations (
 owner_user_id text NOT NULL,project_id text NOT NULL,request_id text NOT NULL,request_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
