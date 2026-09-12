CREATE TABLE messaging_conversations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  participant_a uuid NOT NULL,
  participant_b uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (participant_a < participant_b),
  UNIQUE (org_id, id),
  UNIQUE (org_id, participant_a, participant_b),
  FOREIGN KEY (org_id, participant_a) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, participant_b) REFERENCES users(org_id, id)
);
CREATE TABLE messaging_messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, conversation_id, sender_id, idempotency_key),
  FOREIGN KEY (org_id, conversation_id) REFERENCES messaging_conversations(org_id, id),
  FOREIGN KEY (org_id, sender_id) REFERENCES users(org_id, id)
);
CREATE INDEX messaging_messages_page ON messaging_messages (org_id, conversation_id, sent_at, id);
-- Native human-review records. No classifier, automatic hiding or content deletion.
-- Report text is sensitive native data and never copied to audit or notice payloads.
CREATE TABLE messaging_reports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'decided')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, conversation_id, reporter_id),
  UNIQUE (org_id, reporter_id, idempotency_key),
  FOREIGN KEY (org_id, conversation_id) REFERENCES messaging_conversations(org_id, id),
  FOREIGN KEY (org_id, reporter_id) REFERENCES users(org_id, id)
);
CREATE TABLE messaging_report_keys (
  org_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  report_id uuid NOT NULL,
  PRIMARY KEY (org_id, reporter_id, idempotency_key),
  FOREIGN KEY (org_id, report_id) REFERENCES messaging_reports(org_id, id)
);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['messaging_conversations', 'messaging_messages', 'messaging_reports', 'messaging_report_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid)', name);
  END LOOP;
END;
$$;
CREATE POLICY participant ON messaging_conversations USING (
  nullif(current_setting('app.current_user_id', true), '')::uuid IN (participant_a, participant_b)
) WITH CHECK (nullif(current_setting('app.current_user_id', true), '')::uuid IN (participant_a, participant_b));
CREATE POLICY unblocked ON messaging_conversations AS RESTRICTIVE USING (
  NOT EXISTS (SELECT 1 FROM blocks b WHERE b.org_id = messaging_conversations.org_id AND
    ((b.blocker_id = participant_a AND b.blocked_id = participant_b) OR
     (b.blocker_id = participant_b AND b.blocked_id = participant_a)))
);
CREATE POLICY participant ON messaging_messages USING (
  EXISTS (SELECT 1 FROM messaging_conversations c WHERE c.org_id = messaging_messages.org_id AND c.id = conversation_id)
) WITH CHECK (
  sender_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND
  EXISTS (SELECT 1 FROM messaging_conversations c WHERE c.org_id = messaging_messages.org_id AND c.id = conversation_id)
);
CREATE POLICY reporter ON messaging_reports USING (
  reporter_id = nullif(current_setting('app.current_user_id', true), '')::uuid
) WITH CHECK (
  reporter_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND
  EXISTS (SELECT 1 FROM messaging_conversations c WHERE c.org_id = messaging_reports.org_id AND c.id = conversation_id)
);
CREATE POLICY reporter ON messaging_report_keys USING (
  reporter_id = nullif(current_setting('app.current_user_id', true), '')::uuid
) WITH CHECK (
  reporter_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND
  EXISTS (SELECT 1 FROM messaging_reports r WHERE r.org_id = messaging_report_keys.org_id AND r.id = report_id AND r.reporter_id = messaging_report_keys.reporter_id)
);
GRANT SELECT, INSERT ON messaging_conversations, messaging_messages, messaging_reports, messaging_report_keys TO seniorsocial_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON messaging_conversations, messaging_messages, messaging_reports, messaging_report_keys FROM seniorsocial_app;

-- Every block writer, including the shared /blocks boundary, takes exactly the
-- same org lock as message reads/sends, then BOTH WP-009 recipient locks in
-- deterministic UUID order. Delivery holds its recipient lock through adapter
-- invocation: it starts before block commits, or observes the committed block.
-- Message sends use org -> recipient; notification authorization takes no org
-- lock, so neither delivery nor preference changes invert this ordering.
CREATE FUNCTION messaging_block_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('messaging:' || NEW.org_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text || ':' || least(NEW.blocker_id, NEW.blocked_id)::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text || ':' || greatest(NEW.blocker_id, NEW.blocked_id)::text, 0));
  RETURN NEW;
END;
$$;
CREATE TRIGGER messaging_block_lock BEFORE INSERT ON blocks
FOR EACH ROW EXECUTE FUNCTION messaging_block_lock();
