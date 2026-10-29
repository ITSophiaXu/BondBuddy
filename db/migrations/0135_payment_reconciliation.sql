-- Scheduling metadata only. No order terms, credit balances or payment facts are changed.
ALTER TABLE bb_recharge_orders ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bb_recharge_orders ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0);
ALTER TABLE bb_payment_refunds ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bb_payment_refunds ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0);
CREATE INDEX bb_recharge_reconcile_due ON bb_recharge_orders(next_reconcile_at,id) WHERE state<>'paid';
CREATE INDEX bb_refund_reconcile_due ON bb_payment_refunds(next_reconcile_at,id) WHERE state IN ('requested','processing');
