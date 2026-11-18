-- A saved authoring manifest can have several input revision numbers with the
-- same hash. Each executable quote must pin its exact revision while preserving
-- the original immutable scope, price and historical quotes/reservations.
DROP INDEX bb_scope_credit_quote_identity;
CREATE UNIQUE INDEX bb_scope_authoring_quote_identity
  ON bb_credit_quotes(owner_user_id,scope_quote_id,input_revision)
  WHERE scope_quote_id IS NOT NULL AND intent_hash IS NULL;
CREATE UNIQUE INDEX bb_scope_review_quote_identity
  ON bb_credit_quotes(owner_user_id,scope_quote_id)
  WHERE scope_quote_id IS NOT NULL AND intent_hash IS NOT NULL;
-- Preserve the former one-purchase-per-scope invariant at the database boundary,
-- including old API processes and reviewed quotes without a work-plan binding.
CREATE TABLE bb_authoring_scope_reservations (
  owner_user_id text NOT NULL,
  scope_quote_id text NOT NULL,
  reservation_id text NOT NULL UNIQUE,
  PRIMARY KEY(owner_user_id,scope_quote_id),
  FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id),
  FOREIGN KEY(owner_user_id,reservation_id) REFERENCES bb_credit_reservations(owner_user_id,id)
);
INSERT INTO bb_authoring_scope_reservations(owner_user_id,scope_quote_id,reservation_id)
  SELECT q.owner_user_id,q.scope_quote_id,h.id
  FROM bb_credit_reservations h JOIN bb_credit_quotes q ON q.owner_user_id=h.owner_user_id AND q.id=h.quote_id
  WHERE q.scope_quote_id IS NOT NULL AND q.intent_hash IS NULL;
CREATE FUNCTION bb_authoring_scope_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO bb_authoring_scope_reservations(owner_user_id,scope_quote_id,reservation_id)
    SELECT q.owner_user_id,q.scope_quote_id,NEW.id FROM bb_credit_quotes q
    WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id
      AND q.scope_quote_id IS NOT NULL AND q.intent_hash IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_authoring_scope_reservation_claim AFTER INSERT ON bb_credit_reservations
  FOR EACH ROW EXECUTE FUNCTION bb_authoring_scope_reservation_guard();
CREATE TRIGGER bb_authoring_scope_reservations_immutable BEFORE UPDATE OR DELETE ON bb_authoring_scope_reservations
  FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();