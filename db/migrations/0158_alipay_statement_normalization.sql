-- Preserve earlier unresolved download evidence. A recognized parser revision
-- appends a new evidence row for the same ZIP rather than rewriting its history.
ALTER TABLE bb_payment_statements DROP CONSTRAINT bb_payment_statement_verified_provenance;
ALTER TABLE bb_payment_statements ADD CONSTRAINT bb_payment_statement_verified_provenance CHECK ((
 (verification_method='wechat_sha1' AND signed_response_sha256 IS NULL AND verification_context='{}'::jsonb AND (
   (availability='absent' AND evidence_key='absent' AND sha1 IS NULL AND sha256 IS NULL AND byte_length=0)
   OR (availability='available' AND sha1 IS NOT NULL AND sha1 ~ '^[a-f0-9]{40}$'
     AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND evidence_key=sha256 AND byte_length>0)))
 OR (verification_method='alipay_rsa2_download_url' AND availability='available' AND sha1 IS NULL
   AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND byte_length>0
   AND signed_response_sha256 IS NOT NULL AND signed_response_sha256 ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(verification_context)='object'
   AND verification_context->>'request_app_id' ~ '^20[0-9]{14}$'
   AND verification_context->>'merchant_id' ~ '^2088[0-9]{12}$'
   AND verification_context->>'requested_bill_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND verification_context->>'request_bill_type'='trade'
   AND jsonb_typeof(verification_context->'documents')='array'
   AND (
     (verification_context->'normalization'='{"status":"unresolved","reasons":["ALIPAY_CSV_FORMAT_UNVERIFIED"]}'::jsonb
       AND evidence_key=sha256 AND totals='null'::jsonb)
     OR (verification_context->'normalization'='{"status":"normalized","format":"alipay-trade-cn-v1"}'::jsonb
       AND evidence_key=sha256::text||':alipay-trade-cn-v1' AND jsonb_typeof(totals)='object'
       AND jsonb_typeof(totals->'payment')='object' AND jsonb_typeof(totals->'refund')='object')
   ))
) IS TRUE);

CREATE FUNCTION bb_alipay_statement_entry_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof bb_payment_statements; job bb_payment_statement_jobs; BEGIN
 SELECT * INTO STRICT proof FROM bb_payment_statements WHERE id=NEW.statement_id;
 SELECT * INTO STRICT job FROM bb_payment_statement_jobs WHERE id=proof.job_id;
 IF job.provider='alipay' AND (
   proof.verification_context->'normalization' IS DISTINCT FROM '{"status":"normalized","format":"alipay-trade-cn-v1"}'::jsonb
   OR NEW.kind NOT IN ('payment','refund') OR NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
   OR NEW.payload->>'line' IS DISTINCT FROM NEW.line_no::text
   OR NEW.reference_id IS DISTINCT FROM CASE WHEN NEW.kind='refund' THEN NEW.payload->>'refundId' ELSE NEW.payload->>'orderId' END
   OR left(NEW.payload->>'completedLocalTime',10) IS DISTINCT FROM job.bill_date::text
   OR NEW.payload ? 'appId' OR NEW.payload ? 'payerCashFen'
 ) THEN RAISE EXCEPTION 'Alipay statement entry does not match normalized evidence scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_alipay_statement_entry_proof BEFORE INSERT ON bb_payment_statement_entries
 FOR EACH ROW EXECUTE FUNCTION bb_alipay_statement_entry_proof();
