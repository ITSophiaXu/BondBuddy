-- Exact message requirements and template references cannot later acquire different content.
CREATE FUNCTION bb_m4_message_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.owner_user_id,NEW.topic_id,NEW.role,NEW.version,NEW.content,NEW.context,NEW.submission_request_id,NEW.request_hash,NEW.reply_to,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.topic_id,OLD.role,OLD.version,OLD.content,OLD.context,OLD.submission_request_id,OLD.request_hash,OLD.reply_to,OLD.created_at)
   OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
   OR NEW.reply IS DISTINCT FROM OLD.reply
 THEN RAISE EXCEPTION 'M4 message snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_m4_message_identity BEFORE UPDATE ON bb_m4_messages FOR EACH ROW EXECUTE FUNCTION bb_m4_message_identity_guard();
CREATE FUNCTION bb_m4_template_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.version,NEW.owner_user_id,NEW.document_type,NEW.name,NEW.broker,NEW.material,NEW.sha256,NEW.creation_request_id,NEW.request_hash,NEW.market,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.version,OLD.owner_user_id,OLD.document_type,OLD.name,OLD.broker,OLD.material,OLD.sha256,OLD.creation_request_id,OLD.request_hash,OLD.market,OLD.created_at)
 THEN RAISE EXCEPTION 'M4 template snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_m4_template_identity BEFORE UPDATE ON bb_m4_templates FOR EACH ROW EXECUTE FUNCTION bb_m4_template_identity_guard();
