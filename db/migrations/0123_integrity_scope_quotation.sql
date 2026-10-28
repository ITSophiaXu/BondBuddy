ALTER TABLE bb_integrity_quotes ADD COLUMN scope_quote_id text;
ALTER TABLE bb_integrity_quotes ADD COLUMN scope_lines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE bb_integrity_quotes ADD COLUMN scope_work_hash char(64);
ALTER TABLE bb_integrity_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quotes_points_check;
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quotes_price_version_check;
ALTER TABLE bb_integrity_quotes ADD CONSTRAINT bb_integrity_quote_price_terms CHECK(
 (scope_quote_id IS NULL AND price_version='integrity-round-5000-v1' AND points=5000) OR
 (scope_quote_id IS NOT NULL AND price_version='outcome-cny-20261028-v1' AND points>0));
CREATE TRIGGER bb_integrity_scope_price BEFORE INSERT ON bb_integrity_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
