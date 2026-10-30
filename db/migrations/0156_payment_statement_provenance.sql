-- Keep WeChat's signed-manifest SHA1 proof separate from Alipay's RSA2 URL proof.
-- Historical evidence stays immutable. No payment, lot, refund or wallet changes.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM bb_payment_statements s JOIN bb_payment_statement_jobs j ON j.id=s.job_id WHERE j.provider<>'wechat') THEN
   RAISE EXCEPTION 'Existing non-WeChat evidence needs explicit provenance review';
 END IF;
END $$;
ALTER TABLE bb_payment_statements
 ADD COLUMN verification_method text NOT NULL DEFAULT 'wechat_sha1',
 ADD COLUMN signed_response_sha256 char(64),
 ADD COLUMN verification_context jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ DECLARE constraint_name text; matches integer; BEGIN
 SELECT count(*),min(conname) INTO matches,constraint_name FROM pg_constraint
 WHERE conrelid='bb_payment_statements'::regclass AND contype='c'
   AND pg_get_expr(conbin,conrelid) LIKE '%availability%' AND pg_get_expr(conbin,conrelid) LIKE '%evidence_key%';
 IF matches<>1 THEN RAISE EXCEPTION 'Exactly one existing statement evidence constraint required'; END IF;
 EXECUTE format('ALTER TABLE bb_payment_statements DROP CONSTRAINT %I',constraint_name);
END $$;

ALTER TABLE bb_payment_statements ADD CONSTRAINT bb_payment_statement_verified_provenance CHECK ((
 (verification_method='wechat_sha1' AND signed_response_sha256 IS NULL AND verification_context='{}'::jsonb AND (
   (availability='absent' AND evidence_key='absent' AND sha1 IS NULL AND sha256 IS NULL AND byte_length=0)
   OR (availability='available' AND sha1 IS NOT NULL AND sha1 ~ '^[a-f0-9]{40}$'
     AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND evidence_key=sha256 AND byte_length>0)))
 OR (verification_method='alipay_rsa2_download_url' AND availability='available' AND sha1 IS NULL
   AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND evidence_key=sha256 AND byte_length>0
   AND signed_response_sha256 IS NOT NULL AND signed_response_sha256 ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(verification_context)='object'
   AND verification_context->>'request_app_id' ~ '^20[0-9]{14}$'
   AND verification_context->>'merchant_id' ~ '^2088[0-9]{12}$'
   AND verification_context->>'requested_bill_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND verification_context->>'request_bill_type'='trade'
   AND verification_context->'normalization'='{"status":"unresolved","reasons":["ALIPAY_CSV_FORMAT_UNVERIFIED"]}'::jsonb
   AND jsonb_typeof(verification_context->'documents')='array' AND totals='null'::jsonb)
) IS TRUE);

CREATE FUNCTION bb_payment_statement_provider_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE statement_job bb_payment_statement_jobs; BEGIN
 SELECT * INTO STRICT statement_job FROM bb_payment_statement_jobs WHERE id=NEW.job_id;
 IF statement_job.provider='wechat' AND NEW.verification_method<>'wechat_sha1'
   OR statement_job.provider='alipay' AND NEW.verification_method<>'alipay_rsa2_download_url' THEN
   RAISE EXCEPTION 'Statement verification method does not match provider';
 END IF;
 IF statement_job.provider='alipay' AND (statement_job.kind<>'trade' OR statement_job.account_type<>''
   OR NEW.verification_context->>'merchant_id' IS DISTINCT FROM statement_job.merchant_id
   OR NEW.verification_context->>'requested_bill_date' IS DISTINCT FROM statement_job.bill_date::text) THEN
   RAISE EXCEPTION 'Alipay statement verification scope mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_statement_provider_proof BEFORE INSERT ON bb_payment_statements
 FOR EACH ROW EXECUTE FUNCTION bb_payment_statement_provider_proof();
