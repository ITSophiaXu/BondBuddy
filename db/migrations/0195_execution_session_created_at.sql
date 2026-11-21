-- Existing sessions have no trustworthy creation timestamp. Keep them unknown.
ALTER TABLE bb_execution_node_sessions ADD COLUMN created_at timestamptz;
ALTER TABLE bb_execution_node_sessions ALTER COLUMN created_at SET DEFAULT clock_timestamp();
CREATE FUNCTION bb_execution_session_created_at_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.created_at:=COALESCE(NEW.created_at,clock_timestamp());
 ELSIF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Execution session creation time is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_session_created_at_guard
 BEFORE INSERT OR UPDATE OF created_at ON bb_execution_node_sessions
 FOR EACH ROW EXECUTE FUNCTION bb_execution_session_created_at_guard();
