-- Read-only account history: stable owner/keyset pagination and per-task ledger totals.
CREATE INDEX bb_credit_reservations_history_idx ON bb_credit_reservations(owner_user_id,created_at DESC,id DESC);
CREATE INDEX bb_recharge_orders_history_idx ON bb_recharge_orders(owner_user_id,created_at DESC,id DESC);
CREATE INDEX bb_credit_events_reservation_idx ON bb_credit_events(owner_user_id,reservation_id,kind) WHERE reservation_id IS NOT NULL;
