CREATE TABLE assistance_requests (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  requester_id uuid NOT NULL,
  summary_ciphertext text NOT NULL CHECK (length(summary_ciphertext) BETWEEN 1 AND 12000),
  locale text NOT NULL CHECK (locale IN ('en', 'es')),
  triage_category text NOT NULL CHECK (triage_category IN ('immediate_safety', 'food', 'housing', 'transportation', 'social_support', 'general')),
  triage_source text NOT NULL CHECK (triage_source IN ('rules', 'ai', 'staff')),
  after_hours boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, requester_id, idempotency_key),
  FOREIGN KEY (org_id, requester_id) REFERENCES users(org_id, id) ON DELETE RESTRICT
);

CREATE TABLE assistance_transitions (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  from_state text CHECK (from_state IN ('pending_unowned', 'owned', 'in_progress', 'resolved', 'closed_unable')),
  to_state text NOT NULL CHECK (to_state IN ('pending_unowned', 'owned', 'in_progress', 'resolved', 'closed_unable')),
  owner_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason !~ E'[\r\n]'),
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, request_id) REFERENCES assistance_requests(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, owner_id) REFERENCES users(org_id, id) ON DELETE RESTRICT,
  CHECK ((to_state = 'pending_unowned' AND from_state IS NULL AND owner_id IS NULL)
    OR (to_state <> 'pending_unowned' AND from_state IS NOT NULL AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX assistance_transitions_sequence ON assistance_transitions (sequence);
CREATE INDEX assistance_transitions_latest ON assistance_transitions (org_id, request_id, sequence DESC);
-- The trigger validates the previous state, while these constraints make the
-- validation race-safe: exactly one initial row and one departure from each
-- state can win for a request, even when two staff transactions start together.
CREATE UNIQUE INDEX assistance_transition_one_initial ON assistance_transitions (org_id, request_id)
  WHERE from_state IS NULL;
CREATE UNIQUE INDEX assistance_transition_one_departure ON assistance_transitions (org_id, request_id, from_state)
  WHERE from_state IS NOT NULL;

CREATE TABLE sla_clocks (
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  breached_at timestamptz CHECK (breached_at IS NULL OR breached_at >= due_at),
  PRIMARY KEY (org_id, request_id),
  FOREIGN KEY (org_id, request_id) REFERENCES assistance_requests(org_id, id) ON DELETE RESTRICT
);
CREATE INDEX assistance_sla_queue ON sla_clocks (org_id, due_at, request_id) WHERE breached_at IS NULL;

CREATE FUNCTION enforce_assistance_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous assistance_transitions%ROWTYPE;
BEGIN
  -- Serialize each request's transition stream without requiring UPDATE on the
  -- immutable ledger merely to acquire a row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text || ':' || NEW.request_id::text, 0));
  SELECT * INTO previous FROM assistance_transitions
    WHERE org_id = NEW.org_id AND request_id = NEW.request_id
    ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.from_state IS NOT NULL OR NEW.to_state <> 'pending_unowned' THEN
      RAISE EXCEPTION 'first assistance transition must be pending_unowned';
    END IF;
    IF NEW.actor_id <> (SELECT requester_id FROM assistance_requests WHERE org_id = NEW.org_id AND id = NEW.request_id) THEN
      RAISE EXCEPTION 'requester must open assistance request';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.from_state IS DISTINCT FROM previous.to_state OR NEW.at < previous.at THEN
    RAISE EXCEPTION 'stale assistance transition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id = NEW.org_id AND user_id = NEW.actor_id AND role IN ('staff', 'admin')) THEN
    RAISE EXCEPTION 'assistance transition requires staff or admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id = NEW.org_id AND user_id = NEW.owner_id AND role IN ('staff', 'admin')) THEN
    RAISE EXCEPTION 'assistance owner must be staff or admin';
  END IF;
  IF NOT ((NEW.from_state = 'pending_unowned' AND NEW.to_state = 'owned')
    OR (NEW.from_state = 'owned' AND NEW.to_state IN ('in_progress', 'closed_unable'))
    OR (NEW.from_state = 'in_progress' AND NEW.to_state IN ('resolved', 'closed_unable'))) THEN
    RAISE EXCEPTION 'illegal assistance transition';
  END IF;
  IF NEW.from_state <> 'pending_unowned' AND NEW.owner_id IS DISTINCT FROM previous.owner_id THEN
    RAISE EXCEPTION 'owner cannot change during a state transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assistance_transition_guard BEFORE INSERT ON assistance_transitions
FOR EACH ROW EXECUTE FUNCTION enforce_assistance_transition();

CREATE FUNCTION reject_assistance_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER assistance_requests_identity_immutable BEFORE UPDATE OR DELETE ON assistance_requests
FOR EACH ROW EXECUTE FUNCTION reject_assistance_history_change();
CREATE TRIGGER assistance_transitions_immutable BEFORE UPDATE OR DELETE ON assistance_transitions
FOR EACH ROW EXECUTE FUNCTION reject_assistance_history_change();

CREATE FUNCTION enforce_assistance_sla_due() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_due timestamptz;
BEGIN
  SELECT request.created_at + CASE request.triage_category
    WHEN 'immediate_safety' THEN interval '15 minutes'
    WHEN 'food' THEN interval '60 minutes'
    WHEN 'housing' THEN interval '60 minutes'
    WHEN 'transportation' THEN interval '120 minutes'
    ELSE interval '240 minutes' END
  INTO expected_due FROM assistance_requests request
  WHERE request.org_id = NEW.org_id AND request.id = NEW.request_id;
  IF expected_due IS NULL OR NEW.due_at IS DISTINCT FROM expected_due OR NEW.breached_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid deterministic assistance SLA clock';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assistance_sla_due_guard BEFORE INSERT ON sla_clocks
FOR EACH ROW EXECUTE FUNCTION enforce_assistance_sla_due();

CREATE FUNCTION constrain_sla_breach() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.due_at IS DISTINCT FROM OLD.due_at OR OLD.breached_at IS NOT NULL
    OR NEW.breached_at IS NULL OR NEW.breached_at < OLD.due_at THEN
    RAISE EXCEPTION 'SLA clock is immutable except for its first valid breach mark';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sla_breach_guard BEFORE UPDATE OR DELETE ON sla_clocks
FOR EACH ROW EXECUTE FUNCTION constrain_sla_breach();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['assistance_requests', 'assistance_transitions', 'sla_clocks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON assistance_requests, assistance_transitions TO seniorsocial_app;
GRANT USAGE, SELECT ON SEQUENCE assistance_transitions_sequence_seq TO seniorsocial_app;
GRANT SELECT, INSERT, UPDATE (breached_at) ON sla_clocks TO seniorsocial_app;
REVOKE UPDATE, DELETE, TRUNCATE ON assistance_requests, assistance_transitions FROM seniorsocial_app;
REVOKE DELETE, TRUNCATE ON sla_clocks FROM seniorsocial_app;
