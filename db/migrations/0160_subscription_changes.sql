-- Immediate month upgrades and month-to-year changes preserve original cash
-- provenance. A new channel order records only new cash, never transferred value.
ALTER TABLE bb_subscription_periods ADD COLUMN funding_kind text NOT NULL DEFAULT 'cash' CHECK(funding_kind IN ('cash','mixed'));
ALTER TABLE bb_subscription_periods ADD COLUMN face_amount_fen bigint;
UPDATE bb_subscription_periods SET face_amount_fen=amount_fen;
ALTER TABLE bb_subscription_periods ALTER COLUMN face_amount_fen SET NOT NULL;
ALTER TABLE bb_subscription_periods ADD COLUMN consideration_numerator bigint;
ALTER TABLE bb_subscription_periods ADD COLUMN consideration_denominator bigint;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='bb_subscription_periods'::regclass AND contype='c' LOOP
  IF r.def LIKE '%status%' OR r.def LIKE '%amount_fen =%' AND r.def LIKE '%plan_id%' THEN
   EXECUTE format('ALTER TABLE bb_subscription_periods DROP CONSTRAINT %I',r.conname);
  END IF;
 END LOOP;
END $$;
ALTER TABLE bb_subscription_periods ADD CHECK(status IN ('pending','active','superseded','refunded','failed'));
ALTER TABLE bb_subscription_periods ADD CHECK((status IN ('active','superseded','refunded'))=(lot_id IS NOT NULL));
ALTER TABLE bb_subscription_periods ADD CHECK(face_amount_fen>0 AND amount_fen<=face_amount_fen AND
 ((funding_kind='cash' AND face_amount_fen=amount_fen AND consideration_numerator IS NULL AND consideration_denominator IS NULL) OR
  (funding_kind='mixed' AND consideration_numerator IS NOT NULL AND consideration_denominator IS NOT NULL AND consideration_numerator>0 AND consideration_denominator>0)));
ALTER TABLE bb_subscription_periods ADD CHECK(
 (billing_cycle='monthly' AND ((plan_id='light' AND face_amount_fen=19900 AND points=21000) OR (plan_id='professional' AND face_amount_fen=49900 AND points=55000) OR (plan_id='intensive' AND face_amount_fen=99900 AND points=114000))) OR
 (billing_cycle='annual' AND ((plan_id='light' AND face_amount_fen=214920 AND points=252000) OR (plan_id='professional' AND face_amount_fen=538920 AND points=660000) OR (plan_id='intensive' AND face_amount_fen=1078920 AND points=1368000))));
CREATE FUNCTION bb_subscription_period_funding_default() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.face_amount_fen IS NULL THEN NEW.face_amount_fen:=NEW.amount_fen;END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_period_funding_default BEFORE INSERT ON bb_subscription_periods FOR EACH ROW EXECUTE FUNCTION bb_subscription_period_funding_default();
CREATE FUNCTION bb_subscription_period_funding_locked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.funding_kind,NEW.face_amount_fen,NEW.consideration_numerator,NEW.consideration_denominator) IS DISTINCT FROM ROW(OLD.funding_kind,OLD.face_amount_fen,OLD.consideration_numerator,OLD.consideration_denominator)
 THEN RAISE EXCEPTION 'Original contract funding is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_period_funding_locked BEFORE UPDATE ON bb_subscription_periods FOR EACH ROW EXECUTE FUNCTION bb_subscription_period_funding_locked();

CREATE TABLE bb_subscription_change_quotes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,request_id text NOT NULL,request_hash text NOT NULL,
 subscription_id text NOT NULL REFERENCES bb_subscriptions(id),source_period_id text NOT NULL REFERENCES bb_subscription_periods(id),
 source_plan_id text NOT NULL,target_plan_id text NOT NULL,billing_cycle text NOT NULL CHECK(billing_cycle IN ('monthly','annual')),
 face_amount_fen bigint NOT NULL CHECK(face_amount_fen>0),credit_offset_fen bigint NOT NULL CHECK(credit_offset_fen>=0),pay_now_fen bigint NOT NULL CHECK(pay_now_fen>0),
 transfer_points bigint NOT NULL CHECK(transfer_points>=0),excluded_held_points bigint NOT NULL CHECK(excluded_held_points>=0),monthly_points bigint NOT NULL CHECK(monthly_points>0),total_points bigint NOT NULL CHECK(total_points>0),
 transfer_numerator bigint NOT NULL CHECK(transfer_numerator>=0),transfer_denominator bigint NOT NULL CHECK(transfer_denominator>0),
 consideration_numerator bigint NOT NULL CHECK(consideration_numerator>0),consideration_denominator bigint NOT NULL CHECK(consideration_denominator>0),
 source_snapshot jsonb NOT NULL,task_price_version text NOT NULL REFERENCES bb_credit_price_versions(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id),CHECK(pay_now_fen+credit_offset_fen=face_amount_fen),
 CHECK(credit_offset_fen=ceil(transfer_numerator::numeric/transfer_denominator)),
 CHECK(consideration_numerator::numeric*transfer_denominator*total_points=(pay_now_fen::numeric*transfer_denominator+transfer_numerator)*consideration_denominator)
);
CREATE TRIGGER bb_subscription_change_quote_immutable BEFORE UPDATE OR DELETE ON bb_subscription_change_quotes FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TABLE bb_subscription_change_rejections(owner_user_id text NOT NULL,request_id text NOT NULL,request_hash text NOT NULL,quote_id text NOT NULL REFERENCES bb_subscription_change_quotes(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,request_id));
CREATE TRIGGER bb_subscription_change_rejection_immutable BEFORE UPDATE OR DELETE ON bb_subscription_change_rejections FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TABLE bb_subscription_changes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,quote_id text NOT NULL UNIQUE REFERENCES bb_subscription_change_quotes(id),
 source_period_id text NOT NULL REFERENCES bb_subscription_periods(id),target_period_id text NOT NULL UNIQUE REFERENCES bb_subscription_periods(id),
 order_id text NOT NULL UNIQUE REFERENCES bb_recharge_orders(id),state text NOT NULL CHECK(state IN ('held','applied','failed','refunded')),
 created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,finalized_at timestamptz
);
CREATE TABLE bb_subscription_change_allocations (
 change_id text NOT NULL REFERENCES bb_subscription_changes(id),owner_user_id text NOT NULL,lot_id text NOT NULL,points bigint NOT NULL CHECK(points>0),
 PRIMARY KEY(change_id,lot_id),FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id)
);
CREATE TRIGGER bb_subscription_change_allocation_immutable BEFORE UPDATE OR DELETE ON bb_subscription_change_allocations FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TABLE bb_subscription_funding_sources (
 id text PRIMARY KEY,period_id text NOT NULL REFERENCES bb_subscription_periods(id),owner_user_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('new_cash','transfer')),source_order_id text NOT NULL REFERENCES bb_recharge_orders(id),source_lot_id text REFERENCES bb_credit_lots(id),
 amount_numerator bigint NOT NULL CHECK(amount_numerator>=0),amount_denominator bigint NOT NULL CHECK(amount_denominator>0),
 point_numerator bigint NOT NULL CHECK(point_numerator>=0),point_denominator bigint NOT NULL CHECK(point_denominator>0)
);
CREATE TRIGGER bb_subscription_funding_source_immutable BEFORE UPDATE OR DELETE ON bb_subscription_funding_sources FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TABLE bb_subscription_lot_funding (
 lot_id text NOT NULL REFERENCES bb_credit_lots(id),funding_source_id text NOT NULL REFERENCES bb_subscription_funding_sources(id),
 owner_user_id text NOT NULL,point_numerator bigint NOT NULL CHECK(point_numerator>=0),point_denominator bigint NOT NULL CHECK(point_denominator>0),PRIMARY KEY(lot_id,funding_source_id)
);
CREATE TRIGGER bb_subscription_lot_funding_immutable BEFORE UPDATE OR DELETE ON bb_subscription_lot_funding FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE INDEX bb_subscription_funding_period ON bb_subscription_funding_sources(period_id);
CREATE INDEX bb_subscription_change_source ON bb_subscription_changes(source_period_id,state);
CREATE UNIQUE INDEX bb_subscription_one_cash_funding ON bb_subscription_funding_sources(period_id) WHERE kind='new_cash';
CREATE UNIQUE INDEX bb_subscription_one_transfer_funding ON bb_subscription_funding_sources(period_id,source_order_id,source_lot_id) WHERE kind='transfer';
CREATE FUNCTION bb_subscription_change_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ch record;l bb_credit_lots%ROWTYPE;BEGIN
 PERFORM bb_assert_wallet_writable(NEW.owner_user_id);
 SELECT c.*,q.source_snapshot,p.lot_id root_lot INTO ch FROM bb_subscription_changes c JOIN bb_subscription_change_quotes q ON q.id=c.quote_id
  JOIN bb_subscription_periods p ON p.id=c.source_period_id WHERE c.id=NEW.change_id AND c.owner_user_id=NEW.owner_user_id;
 SELECT * INTO l FROM bb_credit_lots WHERE id=NEW.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
 IF ch.id IS NULL OR ch.state<>'held' OR l.id IS NULL OR l.source<>'subscription' OR (l.id=ch.root_lot OR l.cash_origin_lot_id=ch.root_lot) IS NOT TRUE
  OR l.remaining-l.frozen<NEW.points OR l.expires_at<=now() OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ch.source_snapshot) s WHERE s->>'lot_id'=NEW.lot_id AND (s->>'points')::bigint=NEW.points)
 THEN RAISE EXCEPTION 'Change allocation requires exact available original rights' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_change_allocation_valid BEFORE INSERT ON bb_subscription_change_allocations FOR EACH ROW EXECUTE FUNCTION bb_subscription_change_allocation_guard();
CREATE FUNCTION bb_subscription_funding_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p bb_subscription_periods%ROWTYPE; original bb_credit_lots%ROWTYPE; r record; allocation bigint; n numeric:=0;d numeric:=1;g numeric;BEGIN
 SELECT * INTO p FROM bb_subscription_periods WHERE id=NEW.period_id AND owner_user_id=NEW.owner_user_id;
 IF p.id IS NULL OR p.funding_kind<>'mixed' OR p.status<>'pending' OR NEW.point_numerator::numeric*NEW.amount_denominator*p.points<>NEW.amount_numerator::numeric*NEW.point_denominator
 THEN RAISE EXCEPTION 'Funding must match immutable target rights' USING ERRCODE='23514';END IF;
 IF NEW.kind='new_cash' THEN
  IF NEW.source_order_id<>p.order_id OR NEW.source_lot_id IS NOT NULL OR NEW.amount_numerator::numeric<>p.amount_fen::numeric*NEW.amount_denominator
  THEN RAISE EXCEPTION 'New funding is only the new channel amount' USING ERRCODE='23514';END IF;
 ELSE
  SELECT a.points INTO allocation FROM bb_subscription_change_allocations a JOIN bb_subscription_changes ch ON ch.id=a.change_id
   WHERE ch.target_period_id=p.id AND ch.state='held' AND a.owner_user_id=NEW.owner_user_id AND a.lot_id=NEW.source_lot_id;
  SELECT * INTO original FROM bb_credit_lots WHERE id=NEW.source_lot_id AND owner_user_id=NEW.owner_user_id;
  IF allocation IS NULL OR original.id IS NULL OR NOT EXISTS(SELECT 1 FROM bb_recharge_orders o JOIN bb_payment_cash_proofs proof ON proof.order_id=o.id AND proof.owner_user_id=o.owner_user_id
    WHERE o.id=NEW.source_order_id AND o.owner_user_id=NEW.owner_user_id AND o.state='paid' AND proof.cash_amount_fen=o.amount_fen)
  THEN RAISE EXCEPTION 'Transfer requires exact authenticated source cash' USING ERRCODE='23514';END IF;
  IF original.cash_order_id=NEW.source_order_id THEN n:=original.cash_basis_fen;d:=original.cash_basis_points;
  ELSE
   FOR r IN SELECT lf.point_numerator,lf.point_denominator FROM bb_subscription_lot_funding lf JOIN bb_subscription_funding_sources f ON f.id=lf.funding_source_id
    WHERE lf.lot_id=original.id AND lf.owner_user_id=NEW.owner_user_id AND f.source_order_id=NEW.source_order_id LOOP
    n:=n*r.point_denominator+r.point_numerator*d;d:=d*r.point_denominator;g:=gcd(n,d);n:=n/g;d:=d/g;
   END LOOP;
  END IF;
  IF n IS NULL OR d IS NULL OR n<=0 OR NEW.amount_numerator::numeric*d<>n*allocation*NEW.amount_denominator THEN RAISE EXCEPTION 'Transferred consideration must preserve source A times R over Q' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_funding_source_valid BEFORE INSERT ON bb_subscription_funding_sources FOR EACH ROW EXECUTE FUNCTION bb_subscription_funding_source_guard();
CREATE FUNCTION bb_subscription_lot_funding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_credit_lots l JOIN bb_subscription_funding_sources f ON f.id=NEW.funding_source_id AND f.owner_user_id=l.owner_user_id
  WHERE l.id=NEW.lot_id AND l.owner_user_id=NEW.owner_user_id AND l.source='subscription' AND l.cash_order_id IS NULL
   AND NEW.point_numerator=f.point_numerator AND NEW.point_denominator=f.point_denominator)
 THEN RAISE EXCEPTION 'Funding slice ownership or original ratio mismatch' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_lot_funding_valid BEFORE INSERT ON bb_subscription_lot_funding FOR EACH ROW EXECUTE FUNCTION bb_subscription_lot_funding_guard();
CREATE FUNCTION bb_subscription_lot_funding_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l bb_credit_lots%ROWTYPE;r record;n numeric:=0;d numeric:=1;g numeric;BEGIN
 SELECT * INTO l FROM bb_credit_lots WHERE id=NEW.lot_id;
 FOR r IN SELECT point_numerator,point_denominator FROM bb_subscription_lot_funding WHERE lot_id=l.id LOOP
  n:=n*r.point_denominator+r.point_numerator*d;d:=d*r.point_denominator;g:=gcd(n,d);n:=n/g;d:=d/g;
 END LOOP;
 IF n*l.cash_basis_points<>l.cash_basis_fen::numeric*d THEN RAISE EXCEPTION 'Funding sum must equal exact lot consideration' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER bb_subscription_lot_funding_complete AFTER INSERT ON bb_subscription_lot_funding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_subscription_lot_funding_complete();
CREATE FUNCTION bb_subscription_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.owner_user_id,NEW.quote_id,NEW.source_period_id,NEW.target_period_id,NEW.order_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.quote_id,OLD.source_period_id,OLD.target_period_id,OLD.order_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Subscription change identity is immutable' USING ERRCODE='23514';END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT(
  OLD.state='held' AND NEW.state='applied' AND EXISTS(SELECT 1 FROM bb_recharge_orders WHERE id=NEW.order_id AND state='paid') OR
  OLD.state='held' AND NEW.state='failed' AND EXISTS(SELECT 1 FROM bb_recharge_orders WHERE id=NEW.order_id AND state IN ('failed','expired')) OR
  OLD.state='applied' AND NEW.state='refunded' AND EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=NEW.order_id AND state='succeeded'))
 THEN RAISE EXCEPTION 'Change requires verified original payment or refund' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_subscription_change_locked BEFORE UPDATE OR DELETE ON bb_subscription_changes FOR EACH ROW EXECUTE FUNCTION bb_subscription_change_guard();
ALTER TABLE bb_credit_events DROP CONSTRAINT bb_credit_events_kind_check;
ALTER TABLE bb_credit_events ADD CHECK(kind IN ('grant','reserve','settle','release','correction','refund_hold','refund_settle','refund_release','subscription_change_hold','subscription_change_settle','subscription_change_release'));

-- Extend the existing guard rather than discarding legacy refund provenance.
DO $$ DECLARE definition text;marker text;BEGIN
 SELECT pg_get_functiondef('bb_credit_cash_basis_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'installment record;','installment record; changed record; restored record;');
 marker:='SELECT r.*,p.order_id,p.status period_status,o.state order_state INTO installment';
 IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'Annual consideration anchor missing';END IF;
 definition:=replace(definition,marker,$code$
 SELECT p.*,o.state order_state,ch.state change_state,r.due_at INTO changed FROM bb_subscription_periods p
 JOIN bb_recharge_orders o ON o.id=p.order_id JOIN bb_subscription_changes ch ON ch.target_period_id=p.id
 LEFT JOIN bb_subscription_credit_releases r ON r.period_id=p.id AND NEW.source_key='subscription-release:'||r.id
 WHERE p.owner_user_id=NEW.owner_user_id AND p.funding_kind='mixed' AND (NEW.source_key='recharge:'||p.order_id OR r.id IS NOT NULL);
 IF changed.id IS NOT NULL THEN
  PERFORM bb_assert_wallet_writable(NEW.owner_user_id);
  IF changed.order_state<>'paid' OR changed.change_state<>'applied' OR changed.status NOT IN ('pending','active') OR NEW.source<>'subscription'
   OR NEW.original_points<>changed.monthly_points OR NEW.expires_at IS DISTINCT FROM bb_subscription_clock(NEW.owner_user_id)+interval '90 days'
   OR changed.due_at>bb_subscription_clock(NEW.owner_user_id) OR EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=changed.order_id AND state IN ('requested','processing','succeeded'))
  THEN RAISE EXCEPTION 'Mixed rights require exact paid contract funding' USING ERRCODE='23514';END IF;
  NEW.cash_basis_fen:=changed.consideration_numerator;NEW.cash_basis_points:=changed.consideration_denominator;
  NEW.cash_order_id:=NULL;NEW.cash_origin_lot_id:=NEW.id;RETURN NEW;
 END IF;
 SELECT l.*,a.points returned_points INTO restored FROM bb_subscription_change_allocations a JOIN bb_subscription_changes ch ON ch.id=a.change_id
 JOIN bb_credit_lots l ON l.id=a.lot_id AND l.owner_user_id=a.owner_user_id
 WHERE ch.state='refunded' AND a.owner_user_id=NEW.owner_user_id AND NEW.source_key='subscription-change-restore:'||a.change_id||':'||a.lot_id;
 IF restored.id IS NOT NULL THEN
  PERFORM bb_assert_wallet_writable(NEW.owner_user_id);
  IF NEW.original_points<>restored.returned_points OR NEW.source<>'subscription'
   OR NEW.expires_at IS DISTINCT FROM (CASE WHEN restored.expires_at<=date_trunc('milliseconds',now()) THEN date_trunc('milliseconds',now())+interval '7 days' ELSE restored.expires_at END)
  THEN RAISE EXCEPTION 'Restore exact transferred rights and expiry' USING ERRCODE='23514';END IF;
  NEW.cash_basis_fen:=restored.cash_basis_fen;NEW.cash_basis_points:=restored.cash_basis_points;NEW.cash_order_id:=restored.cash_order_id;
  NEW.cash_origin_lot_id:=restored.cash_origin_lot_id;RETURN NEW;
 END IF;
 $code$||marker);EXECUTE definition;
END $$;
CREATE FUNCTION bb_copy_subscription_lot_funding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source='subscription' AND NEW.cash_order_id IS NULL AND NEW.cash_basis_fen IS NOT NULL AND NEW.cash_origin_lot_id IS NOT NULL THEN
  IF NEW.cash_origin_lot_id=NEW.id THEN
   INSERT INTO bb_subscription_lot_funding(lot_id,funding_source_id,owner_user_id,point_numerator,point_denominator)
    SELECT NEW.id,f.id,NEW.owner_user_id,f.point_numerator,f.point_denominator FROM bb_subscription_funding_sources f
    JOIN bb_subscription_periods p ON p.id=f.period_id LEFT JOIN bb_subscription_credit_releases r ON r.period_id=p.id
    WHERE p.owner_user_id=NEW.owner_user_id AND (NEW.source_key='recharge:'||p.order_id OR NEW.source_key='subscription-release:'||r.id) GROUP BY f.id;
  ELSE
   INSERT INTO bb_subscription_lot_funding(lot_id,funding_source_id,owner_user_id,point_numerator,point_denominator)
    SELECT NEW.id,funding_source_id,NEW.owner_user_id,point_numerator,point_denominator FROM bb_subscription_lot_funding WHERE lot_id=NEW.cash_origin_lot_id;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM bb_subscription_lot_funding WHERE lot_id=NEW.id) THEN RAISE EXCEPTION 'Mixed lot funding lineage is required' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER bb_copy_subscription_lot_funding AFTER INSERT ON bb_credit_lots FOR EACH ROW EXECUTE FUNCTION bb_copy_subscription_lot_funding();

DO $$ DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('bb_subscription_credit_release_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'NEW.amount_fen*12<>p.amount_fen','NEW.amount_fen<>floor(p.amount_fen::numeric*NEW.installment_index/12)-floor(p.amount_fen::numeric*(NEW.installment_index-1)/12)');
 definition:=replace(definition,'l.cash_basis_fen IS DISTINCT FROM NEW.amount_fen OR l.cash_basis_points IS DISTINCT FROM NEW.points',
  'l.cash_basis_fen IS DISTINCT FROM (CASE WHEN p.funding_kind=''mixed'' THEN p.consideration_numerator ELSE NEW.amount_fen END) OR l.cash_basis_points IS DISTINCT FROM (CASE WHEN p.funding_kind=''mixed'' THEN p.consideration_denominator ELSE NEW.points END)');
 definition:=replace(definition,'l.cash_order_id IS DISTINCT FROM p.order_id','l.cash_order_id IS DISTINCT FROM (CASE WHEN p.funding_kind=''mixed'' THEN NULL ELSE p.order_id END)');
 EXECUTE definition;
 SELECT pg_get_functiondef('bb_payment_cash_proof_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'p.status=''active''','p.status IN (''active'',''superseded'',''refunded'')');
 definition:=replace(definition,'r.amount_fen*12=o.amount_fen','r.amount_fen=floor(o.amount_fen::numeric/12)');EXECUTE definition;
 SELECT pg_get_functiondef('bb_payment_refund_credit_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'IF sp.billing_cycle=''annual'' THEN','IF sp.billing_cycle=''annual'' OR sp.funding_kind=''mixed'' THEN');
 definition:=replace(definition,'OR (SELECT count(*) FROM bb_subscription_credit_releases WHERE period_id=sp.id AND state=''issued'')<>1',
  'OR sp.billing_cycle=''annual'' AND (SELECT count(*) FROM bb_subscription_credit_releases WHERE period_id=sp.id AND state=''issued'')<>1');
 definition:=replace(definition,'WHERE source.cash_order_id=o.id AND a.charged_points>0',
  'WHERE (source.cash_order_id=o.id OR source.id=sp.lot_id OR source.cash_origin_lot_id=sp.lot_id) AND a.charged_points>0');EXECUTE definition;
END $$;
