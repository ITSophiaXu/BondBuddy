-- A rejected manual subscription request must stay rejected after the active
-- period/mandate changes. It has no order and must not be treated as unknown pay.
CREATE TABLE bb_subscription_checkout_rejections (
  owner_user_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, request_id)
);
CREATE TRIGGER bb_subscription_checkout_rejection_immutable
  BEFORE UPDATE OR DELETE ON bb_subscription_checkout_rejections
  FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
