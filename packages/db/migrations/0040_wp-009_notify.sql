CREATE TABLE notification_preferences (
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL,
  preferences jsonb NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
  CHECK (jsonb_typeof(preferences) = 'object')
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'voice')),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'send_failed', 'ambiguous', 'delivered', 'suppressed')),
  due_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, channel, idempotency_key),
  UNIQUE (org_id, user_id, id),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id),
  CHECK (payload->>'org_id' = org_id::text AND payload->>'user_id' = user_id::text AND payload->>'idempotency_key' = idempotency_key)
);
CREATE INDEX notification_outbox_due ON notification_outbox (org_id, due_at) WHERE state IN ('pending', 'send_failed');

-- Two immutable facts per attempt: started followed by the adapter result. A
-- crash leaves started visible; it is never silently converted to delivered.
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  outcome text NOT NULL CHECK (outcome IN ('started', 'confirmed', 'failed', 'ambiguous', 'suppressed')),
  synthetic boolean NOT NULL CHECK (synthetic),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, job_id, sequence, outcome),
  FOREIGN KEY (org_id, user_id, job_id) REFERENCES notification_outbox(org_id, user_id, id)
);
CREATE UNIQUE INDEX notification_attempt_one_result ON notification_attempts (org_id, job_id, sequence) WHERE outcome <> 'started';

CREATE FUNCTION notification_delivery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'delivered' AND NOT EXISTS (
    SELECT 1 FROM notification_attempts WHERE org_id = NEW.org_id AND job_id = NEW.id
      AND sequence = NEW.attempts AND outcome = 'confirmed' AND synthetic
  ) THEN RAISE EXCEPTION 'notification delivery requires confirmation evidence'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER notification_delivery_evidence AFTER UPDATE ON notification_outbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notification_delivery_evidence();

-- Transactional intent buffer; WP-006 owns canonical audit materialization.
CREATE TABLE notification_audit_pending (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL,
  intent jsonb NOT NULL,
  emitted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(intent) = 'object' AND intent->>'org_id' = org_id::text)
);

CREATE FUNCTION notification_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'notification attempt history is immutable'; END;
$$;
CREATE TRIGGER notification_attempt_immutable BEFORE UPDATE OR DELETE ON notification_attempts
FOR EACH ROW EXECUTE FUNCTION notification_attempt_immutable();

CREATE FUNCTION notification_outbox_constrained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.user_id, NEW.actor_id, NEW.channel, NEW.idempotency_key, NEW.payload, NEW.synthetic, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.user_id, OLD.actor_id, OLD.channel, OLD.idempotency_key, OLD.payload, OLD.synthetic, OLD.created_at) THEN
    RAISE EXCEPTION 'notification identity and content are immutable';
  END IF;
  IF NOT ((OLD.state IN ('pending', 'send_failed') AND NEW.state IN (OLD.state, 'sending', 'suppressed')) OR
          (OLD.state = 'sending' AND NEW.state IN ('delivered', 'send_failed', 'ambiguous', 'suppressed'))) THEN
    RAISE EXCEPTION 'invalid notification transition';
  END IF;
  IF NEW.attempts <> OLD.attempts + (CASE WHEN NEW.state = 'sending' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'invalid notification attempt sequence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_outbox_constrained BEFORE UPDATE ON notification_outbox
FOR EACH ROW EXECUTE FUNCTION notification_outbox_constrained();

CREATE FUNCTION notification_audit_constrained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.user_id, NEW.intent, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.user_id, OLD.intent, OLD.created_at) OR OLD.emitted OR NOT NEW.emitted THEN
    RAISE EXCEPTION 'notification audit intent is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_audit_constrained BEFORE UPDATE ON notification_audit_pending
FOR EACH ROW EXECUTE FUNCTION notification_audit_constrained();

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['notification_preferences', 'notification_outbox', 'notification_attempts', 'notification_audit_pending'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid)', name);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE ON notification_preferences, notification_outbox, notification_audit_pending TO seniorsocial_app;
GRANT SELECT, INSERT ON notification_attempts TO seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_preferences, notification_outbox, notification_attempts, notification_audit_pending FROM seniorsocial_app;
