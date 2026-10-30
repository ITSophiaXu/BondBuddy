-- Task-quality credit returns are independent of cash refunds. Historical
-- settlement facts remain immutable; a deterministic partition of their exact
-- scope and lot allocations is retained as refund evidence.
CREATE TABLE bb_task_refund_units(
 owner_user_id text NOT NULL,reservation_id text NOT NULL,item_id text NOT NULL,run_id text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0),source_item_key text NOT NULL,label text NOT NULL,
 points bigint NOT NULL CHECK(points>0),scope_quote_id text,evidence_kind text NOT NULL,
 evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(reservation_id,item_id),UNIQUE(reservation_id,ordinal),UNIQUE(reservation_id,source_item_key),
 FOREIGN KEY(owner_user_id,reservation_id) REFERENCES bb_credit_reservations(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id),
 CHECK(evidence_kind IN ('automatic_scope','priced_scope','legacy_scope','legacy_task'))
);
CREATE TABLE bb_task_refund_unit_slices(
 reservation_id text NOT NULL,item_id text NOT NULL,origin_lot_id text NOT NULL,points bigint NOT NULL CHECK(points>0),
 PRIMARY KEY(reservation_id,item_id,origin_lot_id),
 FOREIGN KEY(reservation_id,item_id) REFERENCES bb_task_refund_units(reservation_id,item_id),
 FOREIGN KEY(reservation_id,origin_lot_id) REFERENCES bb_credit_allocations(reservation_id,lot_id)
);
CREATE TABLE bb_task_refund_requests(
 id text PRIMARY KEY,owner_user_id text NOT NULL,run_id text NOT NULL,reservation_id text NOT NULL,
 request_id text NOT NULL,request_hash char(64) NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,request_id),UNIQUE(id,reservation_id),
 FOREIGN KEY(owner_user_id,reservation_id) REFERENCES bb_credit_reservations(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE INDEX bb_task_refund_requests_owner ON bb_task_refund_requests(owner_user_id,created_at,id);
CREATE TABLE bb_task_refund_request_items(
 request_id text NOT NULL,reservation_id text NOT NULL,item_id text NOT NULL,
 PRIMARY KEY(request_id,item_id),
 FOREIGN KEY(request_id,reservation_id) REFERENCES bb_task_refund_requests(id,reservation_id),
 FOREIGN KEY(reservation_id,item_id) REFERENCES bb_task_refund_units(reservation_id,item_id)
);
CREATE TABLE bb_task_refund_decisions(
 request_id text PRIMARY KEY REFERENCES bb_task_refund_requests(id),decision_id text NOT NULL,
 actor text NOT NULL REFERENCES bb_users(id),permission_grant_id text NOT NULL REFERENCES bb_billing_operator_grants(id),
 request_hash char(64) NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor,decision_id)
);
CREATE TABLE bb_task_refund_returned_items(
 reservation_id text NOT NULL,item_id text NOT NULL,request_id text NOT NULL,
 PRIMARY KEY(reservation_id,item_id),UNIQUE(request_id,item_id),
 FOREIGN KEY(request_id) REFERENCES bb_task_refund_decisions(request_id),
 FOREIGN KEY(request_id,reservation_id) REFERENCES bb_task_refund_requests(id,reservation_id),
 FOREIGN KEY(request_id,item_id) REFERENCES bb_task_refund_request_items(request_id,item_id),
 FOREIGN KEY(reservation_id,item_id) REFERENCES bb_task_refund_units(reservation_id,item_id)
);
CREATE TABLE bb_task_refund_credits(
 id text PRIMARY KEY,owner_user_id text NOT NULL,reservation_id text NOT NULL,item_id text NOT NULL,origin_lot_id text NOT NULL,
 points bigint NOT NULL CHECK(points>0),return_lot_id text NOT NULL UNIQUE,
 FOREIGN KEY(reservation_id,item_id) REFERENCES bb_task_refund_returned_items(reservation_id,item_id),
 FOREIGN KEY(reservation_id,item_id,origin_lot_id) REFERENCES bb_task_refund_unit_slices(reservation_id,item_id,origin_lot_id),
 UNIQUE(reservation_id,item_id,origin_lot_id),
 FOREIGN KEY(owner_user_id,return_lot_id) REFERENCES bb_credit_lots(owner_user_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION bb_task_refund_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM 1 FROM bb_billing_operator_grants g JOIN bb_users u ON u.id=g.user_id
 WHERE g.id=NEW.permission_grant_id AND g.user_id=NEW.actor AND g.permission='task_refund_approve' AND g.revoked_at IS NULL AND u.status='active' FOR SHARE OF g,u;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM bb_task_refund_requests WHERE id=NEW.request_id AND owner_user_id=NEW.actor)
 THEN RAISE EXCEPTION 'Independent task-refund approval authority required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_task_refund_decision_checked BEFORE INSERT ON bb_task_refund_decisions FOR EACH ROW EXECUTE FUNCTION bb_task_refund_decision_guard();
CREATE FUNCTION bb_task_refund_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap bigint; old_returns bigint; allocated bigint; unit_owner text; BEGIN
 SELECT u.owner_user_id,s.points INTO unit_owner,cap FROM bb_task_refund_units u JOIN bb_task_refund_unit_slices s USING(reservation_id,item_id)
 WHERE s.reservation_id=NEW.reservation_id AND s.item_id=NEW.item_id AND s.origin_lot_id=NEW.origin_lot_id;
 IF unit_owner IS DISTINCT FROM NEW.owner_user_id OR cap IS DISTINCT FROM NEW.points THEN RAISE EXCEPTION 'Original task slice required' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT COALESCE(charged_points,points) INTO allocated FROM bb_credit_allocations WHERE reservation_id=NEW.reservation_id AND lot_id=NEW.origin_lot_id;
 SELECT COALESCE(sum(points),0) INTO old_returns FROM bb_task_refund_credits WHERE reservation_id=NEW.reservation_id AND origin_lot_id=NEW.origin_lot_id;
 SELECT old_returns+COALESCE(sum(original_points),0) INTO old_returns FROM bb_credit_lots
 WHERE owner_user_id=NEW.owner_user_id AND source_key IN ('settlement-correction:'||NEW.reservation_id||':'||NEW.origin_lot_id,'failure:'||NEW.reservation_id||':'||NEW.origin_lot_id,'dynamic-failure:'||NEW.reservation_id||':'||NEW.origin_lot_id);
 IF old_returns+NEW.points>allocated THEN RAISE EXCEPTION 'Task return exceeds original charge' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_task_refund_credit_checked BEFORE INSERT ON bb_task_refund_credits FOR EACH ROW EXECUTE FUNCTION bb_task_refund_credit_guard();

-- Capture at task acceptance, in the very transaction that freezes the actual
-- lots. A deferred trigger sees all allocation rows and the bound family quote.
-- Existing reservations are intentionally not retroactively split into items.
CREATE FUNCTION bb_capture_task_refund_units() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations; s bb_scope_quotations; ln jsonb; lines jsonb; lot record;
 kind text; unit_id text; item_key text; item_points bigint; pos bigint:=0; lot_pos bigint; take bigint; ord integer:=0; total bigint;
BEGIN
 SELECT * INTO r FROM bb_credit_reservations WHERE id=NEW.reservation_id;
 IF r.billing_policy<>'on_delivery' OR r.state='released' OR EXISTS(SELECT 1 FROM bb_task_refund_units WHERE reservation_id=r.id) THEN RETURN NULL; END IF;
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=r.owner_user_id FOR UPDATE;
 SELECT sum(points) INTO total FROM bb_credit_allocations WHERE reservation_id=r.id;
 IF total IS DISTINCT FROM r.points THEN RAISE EXCEPTION 'Complete task allocation required' USING ERRCODE='23514'; END IF;
 SELECT scope.* INTO s FROM bb_scope_quotations scope JOIN LATERAL bb_commerce_scope_source_quotes(r.owner_user_id,scope.id,r.run_id) q ON q.quote_id=r.quote_id
 WHERE scope.owner_user_id=r.owner_user_id AND scope.status='quoted' LIMIT 1;
 IF s.id IS NOT NULL THEN
  IF s.automatic_price IS NOT NULL THEN lines:=s.automatic_price->'lines';kind:='automatic_scope';
  ELSIF jsonb_array_length(s.pricing_items)>0 THEN
   SELECT jsonb_agg(jsonb_build_object('key',v->>'key','label',COALESCE((SELECT l->>'label' FROM jsonb_array_elements(s.lines) l WHERE l->>'key'=v->>'key'),v->>'key'),'amount_fen',v->'due_fen') ORDER BY n)
    INTO lines FROM jsonb_array_elements(s.pricing_items) WITH ORDINALITY p(v,n);kind:='priced_scope';
  ELSE lines:=s.lines;kind:='legacy_scope'; END IF;
 ELSE lines:=jsonb_build_array(jsonb_build_object('key','legacy-task','label','原任务整体成果（原账单无独立条目）','amount_fen',r.points::text));kind:='legacy_task'; END IF;
 SELECT sum((v->>'amount_fen')::bigint) INTO total FROM jsonb_array_elements(lines) v;
 IF total IS DISTINCT FROM r.points THEN RAISE EXCEPTION 'Scope and frozen allocation disagree' USING ERRCODE='23514'; END IF;
 FOR ln IN SELECT * FROM jsonb_array_elements(lines) LOOP
  item_points:=(ln->>'amount_fen')::bigint;IF item_points=0 THEN CONTINUE;END IF;
  item_key:=ln->>'key';unit_id:='unit-'||md5(r.id||':'||length(item_key)||':'||item_key);
  INSERT INTO bb_task_refund_units(owner_user_id,reservation_id,item_id,run_id,ordinal,source_item_key,label,points,scope_quote_id,evidence_kind,evidence)
   VALUES(r.owner_user_id,r.id,unit_id,r.run_id,ord,item_key,ln->>'label',item_points,s.id,kind,
    jsonb_build_object('algorithm','scope-order-original-lot-order-v1','capture','acceptance_transaction','source_quote_id',r.quote_id,'scope_line',ln));
  lot_pos:=0;
  FOR lot IN SELECT a.lot_id,a.points FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
   WHERE a.reservation_id=r.id ORDER BY CASE WHEN l.source='purchase' THEN 1 ELSE 0 END,l.expires_at ASC NULLS LAST,l.created_at,l.id LOOP
   take:=GREATEST(0,LEAST(pos+item_points,lot_pos+lot.points)-GREATEST(pos,lot_pos));
   IF take>0 THEN INSERT INTO bb_task_refund_unit_slices VALUES(r.id,unit_id,lot.lot_id,take);END IF;
   lot_pos:=lot_pos+lot.points;
  END LOOP;
  pos:=pos+item_points;ord:=ord+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bb_capture_task_units_at_acceptance AFTER INSERT ON bb_credit_allocations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION bb_capture_task_refund_units();

CREATE FUNCTION bb_task_refund_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_credit_lots l JOIN bb_credit_events e ON e.owner_user_id=l.owner_user_id AND e.lot_id=l.id
  WHERE l.id=NEW.return_lot_id AND l.owner_user_id=NEW.owner_user_id AND l.source_key='task-refund:'||NEW.id
  AND l.original_points=NEW.points AND e.kind='correction' AND e.reservation_id=NEW.reservation_id AND e.points=NEW.points)
 THEN RAISE EXCEPTION 'Task return lot and event must commit together' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bb_task_refund_complete AFTER INSERT ON bb_task_refund_credits DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION bb_task_refund_complete_guard();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['bb_task_refund_units','bb_task_refund_unit_slices','bb_task_refund_requests','bb_task_refund_request_items','bb_task_refund_decisions','bb_task_refund_returned_items','bb_task_refund_credits'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable()',tab||'_immutable',tab);
 END LOOP;
END $$;

-- Extend existing evidence-derived consideration; callers never supply A/Q.
CREATE OR REPLACE FUNCTION bb_credit_cash_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin bb_credit_lots%ROWTYPE; paid bb_recharge_orders%ROWTYPE; BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.cash_basis_fen,NEW.cash_basis_points,NEW.cash_order_id,NEW.cash_origin_lot_id) IS DISTINCT FROM ROW(OLD.cash_basis_fen,OLD.cash_basis_points,OLD.cash_order_id,OLD.cash_origin_lot_id)
   THEN RAISE EXCEPTION 'Lot consideration evidence is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  NEW.cash_basis_fen:=NULL; NEW.cash_basis_points:=NULL; NEW.cash_order_id:=NULL; NEW.cash_origin_lot_id:=NULL;
  SELECT * INTO paid FROM bb_recharge_orders WHERE owner_user_id=NEW.owner_user_id AND 'recharge:'||id=NEW.source_key AND state='paid';
  IF paid.id IS NOT NULL AND NEW.source IN ('purchase','subscription') AND NEW.original_points=paid.points THEN
   NEW.cash_basis_fen:=paid.amount_fen; NEW.cash_basis_points:=paid.points; NEW.cash_order_id:=paid.id; NEW.cash_origin_lot_id:=NEW.id;
  ELSE
   SELECT l.* INTO origin FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
    WHERE l.owner_user_id=NEW.owner_user_id AND NEW.source_key IN
     ('failure:'||a.reservation_id||':'||a.lot_id,'dynamic-failure:'||a.reservation_id||':'||a.lot_id,'settlement-correction:'||a.reservation_id||':'||a.lot_id) LIMIT 1;
   IF origin.id IS NULL THEN
    SELECT l.* INTO origin FROM bb_task_refund_credits t JOIN bb_credit_lots l ON l.id=t.origin_lot_id AND l.owner_user_id=t.owner_user_id
    WHERE t.owner_user_id=NEW.owner_user_id AND t.return_lot_id=NEW.id AND NEW.source_key='task-refund:'||t.id AND NEW.original_points=t.points;
   END IF;
   IF origin.id IS NOT NULL THEN
    NEW.cash_basis_fen:=origin.cash_basis_fen; NEW.cash_basis_points:=origin.cash_basis_points;
    NEW.cash_order_id:=origin.cash_order_id; NEW.cash_origin_lot_id:=COALESCE(origin.cash_origin_lot_id,origin.id);
    IF origin.source='subscription' THEN NEW.source:='subscription'; END IF;
   ELSIF NEW.source='existing_grant' THEN NEW.cash_basis_fen:=0; NEW.cash_basis_points:=1;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Quality returns are selective. Older whole-settlement returns invalidate all
-- items, while a new return only invalidates its exact pinned business key.
CREATE FUNCTION bb_task_item_was_refunded(p_owner text,p_run text,p_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_credit_reservations r JOIN bb_credit_events e ON e.reservation_id=r.id AND e.owner_user_id=r.owner_user_id
 JOIN bb_credit_lots l ON l.id=e.lot_id AND l.owner_user_id=e.owner_user_id
 WHERE r.owner_user_id=p_owner AND r.run_id=p_run AND e.kind='correction'
 AND (l.source_key LIKE 'settlement-correction:%' OR l.source_key LIKE 'failure:%' OR l.source_key LIKE 'dynamic-failure:%'))
 OR EXISTS(SELECT 1 FROM bb_task_refund_units u JOIN bb_task_refund_returned_items x USING(reservation_id,item_id)
 WHERE u.owner_user_id=p_owner AND u.run_id=p_run AND u.source_item_key=p_key)
$$;
