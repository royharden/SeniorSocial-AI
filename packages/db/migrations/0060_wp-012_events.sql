CREATE TABLE event_proposals (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  proposer_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR char_length(note) <= 4000),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'published', 'declined')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, proposer_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, reviewed_by) REFERENCES users(org_id, id),
  CHECK ((state = 'proposed' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
    (state <> 'proposed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE events (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  proposal_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 400),
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  accessibility text[] NOT NULL DEFAULT '{}',
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  UNIQUE (org_id, proposal_id),
  FOREIGN KEY (org_id, proposal_id) REFERENCES event_proposals(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES users(org_id, id)
);
CREATE INDEX events_upcoming ON events (org_id, starts_at, id) WHERE published_at IS NOT NULL;

CREATE TABLE event_rsvps (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('attending', 'waitlisted', 'cancelled')),
  waitlisted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id, user_id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
  CHECK (state <> 'waitlisted' OR waitlisted_at IS NOT NULL)
);
CREATE INDEX event_rsvps_attending ON event_rsvps (org_id, event_id) WHERE state = 'attending';
CREATE INDEX event_rsvps_waitlist ON event_rsvps (org_id, event_id, waitlisted_at, id) WHERE state = 'waitlisted';

CREATE FUNCTION event_rsvp_transition_constrained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.event_id, NEW.user_id, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.event_id, OLD.user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'RSVP identity is immutable';
  END IF;
  IF NOT ((OLD.state = NEW.state) OR
          (OLD.state = 'attending' AND NEW.state = 'cancelled') OR
          (OLD.state = 'waitlisted' AND NEW.state IN ('attending', 'cancelled')) OR
          (OLD.state = 'cancelled' AND NEW.state IN ('attending', 'waitlisted'))) THEN
    RAISE EXCEPTION 'invalid RSVP transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_rsvp_transition_constrained BEFORE UPDATE ON event_rsvps
FOR EACH ROW EXECUTE FUNCTION event_rsvp_transition_constrained();

-- Transactional event-domain intent. RSVP/promotion creates this in the same
-- transaction; after commit the service drains it idempotently into WP-009's
-- notification_outbox, whose existing recovery owns queue delivery.
CREATE TABLE event_reminder_intents (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  rsvp_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'event_reminder'),
  idempotency_key text NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'drained')),
  drained_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, rsvp_id) REFERENCES event_rsvps(org_id, id),
  CHECK ((state = 'pending' AND drained_at IS NULL) OR (state = 'drained' AND drained_at IS NOT NULL))
);
CREATE INDEX event_reminder_intents_pending ON event_reminder_intents (org_id, due_at, id) WHERE state = 'pending';

CREATE FUNCTION event_reminder_intent_constrained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.user_id, NEW.event_id, NEW.rsvp_id, NEW.purpose, NEW.idempotency_key, NEW.due_at, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.user_id, OLD.event_id, OLD.rsvp_id, OLD.purpose, OLD.idempotency_key, OLD.due_at, OLD.created_at) OR
     OLD.state <> 'pending' OR NEW.state <> 'drained' OR NEW.drained_at IS NULL THEN
    RAISE EXCEPTION 'invalid reminder intent transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_reminder_intent_constrained BEFORE UPDATE ON event_reminder_intents
FOR EACH ROW EXECUTE FUNCTION event_reminder_intent_constrained();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['event_proposals', 'events', 'event_rsvps', 'event_reminder_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid)', table_name);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON event_proposals, event_rsvps, event_reminder_intents TO seniorsocial_app;
GRANT SELECT, INSERT ON events TO seniorsocial_app;
REVOKE UPDATE ON events FROM seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON event_proposals, events, event_rsvps, event_reminder_intents FROM seniorsocial_app;
