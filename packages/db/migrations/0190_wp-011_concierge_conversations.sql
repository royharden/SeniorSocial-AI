CREATE TABLE concierge_conversations (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  handoff_key uuid NOT NULL,
  turns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(turns) = 'array'),
  ai_enabled boolean NOT NULL,
  last_question text NOT NULL DEFAULT '' CHECK (length(last_question) <= 1000),
  handoff jsonb CHECK (handoff IS NULL OR jsonb_typeof(handoff) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, user_id, handoff_key),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX concierge_conversations_resident
  ON concierge_conversations (org_id, user_id, updated_at DESC, id);

CREATE FUNCTION guard_concierge_conversation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.handoff_key IS DISTINCT FROM OLD.handoff_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at OR jsonb_array_length(NEW.turns) < jsonb_array_length(OLD.turns)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.turns) WITH ORDINALITY AS previous(turn, position)
      WHERE NEW.turns -> (previous.position::integer - 1) IS DISTINCT FROM previous.turn
    ) OR (NOT OLD.ai_enabled AND NEW.ai_enabled)
    OR (OLD.handoff IS NOT NULL AND NEW.handoff IS DISTINCT FROM OLD.handoff) THEN
    RAISE EXCEPTION 'concierge conversation update violates append-only continuity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concierge_conversation_update_guard BEFORE UPDATE ON concierge_conversations
FOR EACH ROW EXECUTE FUNCTION guard_concierge_conversation_update();

ALTER TABLE concierge_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE concierge_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY concierge_conversations_identity ON concierge_conversations
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );

GRANT SELECT, INSERT ON concierge_conversations TO seniorsocial_app;
GRANT UPDATE (turns, ai_enabled, last_question, handoff, revision, updated_at)
  ON concierge_conversations TO seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON concierge_conversations FROM seniorsocial_app;
