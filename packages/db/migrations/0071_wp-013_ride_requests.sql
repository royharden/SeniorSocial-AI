CREATE TABLE ride_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  resident_id uuid NOT NULL,
  requested_by_actor_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 240),
  mode text NOT NULL CHECK (mode IN ('paratransit','taxi_voucher','rideshare','partner_van')),
  pickup_at timestamptz NOT NULL,
  pickup_tz text NOT NULL CHECK (length(pickup_tz) BETWEEN 1 AND 80),
  pickup_location text NOT NULL CHECK (length(pickup_location) BETWEEN 1 AND 240),
  destination_location text NOT NULL CHECK (length(destination_location) BETWEEN 1 AND 240),
  return_needed boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  send_state text NOT NULL DEFAULT 'not_sent' CHECK (send_state IN ('not_sent','sent','send_failed')),
  dispatch_reference text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (org_id, resident_id, idempotency_key),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, resident_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, requested_by_actor_id) REFERENCES users(org_id, id),
  CHECK ((send_state = 'sent') = (dispatch_reference IS NOT NULL))
);

CREATE TABLE ride_accessibility_conditions (
  org_id uuid NOT NULL,
  ride_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  code text NOT NULL CHECK (code IN ('wheelchair','walker','needs_an_arm','service_animal','oxygen','door_to_door')),
  verbatim_label text NOT NULL CHECK (length(verbatim_label) BETWEEN 1 AND 120),
  PRIMARY KEY (org_id, ride_id, position),
  UNIQUE (org_id, ride_id, code),
  FOREIGN KEY (org_id, ride_id) REFERENCES ride_requests(org_id, id)
);

CREATE FUNCTION ride_request_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.resident_id,NEW.requested_by_actor_id,NEW.purpose,NEW.mode,NEW.pickup_at,NEW.pickup_tz,NEW.pickup_location,NEW.destination_location,NEW.return_needed,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.resident_id,OLD.requested_by_actor_id,OLD.purpose,OLD.mode,OLD.pickup_at,OLD.pickup_tz,OLD.pickup_location,OLD.destination_location,OLD.return_needed,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'ride request identity and content are immutable';
  END IF;
  IF OLD.send_state='sent' OR (NEW.send_state='sent' AND NEW.dispatch_reference IS NULL) THEN RAISE EXCEPTION 'invalid ride send transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ride_request_identity_immutable BEFORE UPDATE ON ride_requests FOR EACH ROW EXECUTE FUNCTION ride_request_identity_immutable();

CREATE FUNCTION ride_accessibility_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ride accessibility handoff data is immutable'; END; $$;
CREATE TRIGGER ride_accessibility_immutable BEFORE UPDATE OR DELETE ON ride_accessibility_conditions FOR EACH ROW EXECUTE FUNCTION ride_accessibility_immutable();

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['ride_requests','ride_accessibility_conditions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id=nullif(current_setting(''app.current_org_id'',true),'''')::uuid) WITH CHECK (org_id=nullif(current_setting(''app.current_org_id'',true),'''')::uuid)',name);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON ride_requests TO seniorsocial_app;
GRANT SELECT,INSERT ON ride_accessibility_conditions TO seniorsocial_app;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON ride_requests,ride_accessibility_conditions FROM seniorsocial_app;
