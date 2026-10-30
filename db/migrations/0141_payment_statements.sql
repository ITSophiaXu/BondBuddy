-- Statements are independent reconciliation evidence. No credit or refund mutation triggers.
CREATE TABLE bb_payment_statement_jobs (
 id text PRIMARY KEY,provider text NOT NULL CHECK(provider IN ('wechat','alipay')),merchant_id text NOT NULL,
 bill_date date NOT NULL,kind text NOT NULL CHECK(kind IN ('trade','funds')),account_type text NOT NULL DEFAULT '',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','unknown')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token text,lease_until timestamptz,last_check_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,merchant_id,bill_date,kind,account_type),
 CHECK((kind='trade' AND account_type='') OR (kind='funds' AND account_type IN ('BASIC','OPERATION','FEES'))),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX bb_payment_statement_jobs_due ON bb_payment_statement_jobs(next_attempt_at,id);
CREATE TABLE bb_payment_statements (
 id text PRIMARY KEY,job_id text NOT NULL REFERENCES bb_payment_statement_jobs(id),evidence_key text NOT NULL,
 availability text NOT NULL CHECK(availability IN ('available','absent')),sha1 char(40),sha256 char(64),byte_length integer NOT NULL CHECK(byte_length>=0 AND byte_length<=10485760),
 verified_at timestamptz NOT NULL,totals jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,evidence_key),
 CHECK((availability='absent' AND evidence_key='absent' AND sha1 IS NULL AND sha256 IS NULL AND byte_length=0)
   OR (availability='available' AND sha1 ~ '^[a-f0-9]{40}$' AND sha256 ~ '^[a-f0-9]{64}$' AND evidence_key=sha256 AND byte_length>0))
);
CREATE TABLE bb_payment_statement_entries (
 statement_id text NOT NULL REFERENCES bb_payment_statements(id),line_no integer NOT NULL CHECK(line_no>0),
 kind text NOT NULL CHECK(kind IN ('payment','refund','funds')),reference_id text NOT NULL CHECK(length(reference_id)<=128),
 payload jsonb NOT NULL,PRIMARY KEY(statement_id,line_no)
);
CREATE TABLE bb_payment_statement_checks (
 id text PRIMARY KEY,job_id text NOT NULL REFERENCES bb_payment_statement_jobs(id),statement_id text NOT NULL REFERENCES bb_payment_statements(id),
 difference_count integer NOT NULL CHECK(difference_count>=0),checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bb_payment_statement_jobs ADD CONSTRAINT bb_payment_statement_last_check FOREIGN KEY(last_check_id) REFERENCES bb_payment_statement_checks(id);
CREATE TABLE bb_payment_statement_differences (
 id text PRIMARY KEY,check_id text NOT NULL REFERENCES bb_payment_statement_checks(id),kind text NOT NULL CHECK(kind ~ '^[a-z_]{1,64}$'),
 line_no integer NOT NULL CHECK(line_no>=0),reference_id text NOT NULL CHECK(length(reference_id)<=128),
 unit text NOT NULL CHECK(unit IN ('cny_fen','points','identity','coverage','state')),expected_value bigint,observed_value bigint,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(check_id,kind,line_no,reference_id)
);
CREATE INDEX bb_payment_statement_difference_check ON bb_payment_statement_differences(check_id,kind);
CREATE TRIGGER bb_payment_statements_immutable BEFORE UPDATE OR DELETE ON bb_payment_statements FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_payment_statement_entries_immutable BEFORE UPDATE OR DELETE ON bb_payment_statement_entries FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_payment_statement_checks_immutable BEFORE UPDATE OR DELETE ON bb_payment_statement_checks FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_payment_statement_differences_immutable BEFORE UPDATE OR DELETE ON bb_payment_statement_differences FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

-- Extend the installed constraint, preserving every historical kind including 0137.
DO $$ DECLARE previous_expression text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous_expression FROM pg_constraint
 WHERE conrelid='bb_ops_alerts'::regclass AND conname='bb_ops_alerts_kind_check';
 IF previous_expression IS NULL THEN RAISE EXCEPTION 'Existing ops alert kind constraint required'; END IF;
 ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
 EXECUTE format('ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK ((%s) OR kind IN (''payment_statement_difference'',''payment_statement_unavailable''))',previous_expression);
END $$;
