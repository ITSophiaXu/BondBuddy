-- Keep existing alert kinds and add the durable billing-isolation incident.
DO $$ DECLARE previous_expression text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_expression FROM pg_constraint
 WHERE conrelid='bb_ops_alerts'::regclass AND conname='bb_ops_alerts_kind_check';
 ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
 EXECUTE format('ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK ((%s) OR kind = ''billing_safety_isolated'')',previous_expression);
END $$;
