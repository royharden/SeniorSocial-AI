CREATE TABLE ride_transitions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  ride_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  from_state text NOT NULL CHECK (from_state IN ('draft','requested','waiting_for_dispatcher','confirmed_by','completed','cancelled','unable_to_fulfill')),
  to_state text NOT NULL CHECK (to_state IN ('draft','requested','waiting_for_dispatcher','confirmed_by','completed','cancelled','unable_to_fulfill')),
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 500 AND reason !~ E'[\\r\\n]')),
  provider_evidence text CHECK (provider_evidence IS NULL OR length(provider_evidence) BETWEEN 1 AND 240),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  request_hash text NOT NULL CHECK (length(request_hash) BETWEEN 1 AND 240),
  UNIQUE (org_id, ride_id, idempotency_key),
  FOREIGN KEY (org_id, ride_id) REFERENCES ride_requests(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id),
  CHECK (to_state <> 'confirmed_by' OR provider_evidence IS NOT NULL)
);
CREATE INDEX ride_transitions_history ON ride_transitions(org_id,ride_id,at,id);
CREATE FUNCTION ride_transition_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ride transition history is immutable'; END; $$;
CREATE TRIGGER ride_transition_immutable BEFORE UPDATE OR DELETE ON ride_transitions FOR EACH ROW EXECUTE FUNCTION ride_transition_immutable();
ALTER TABLE ride_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ride_transitions USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
GRANT SELECT,INSERT ON ride_transitions TO seniorsocial_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON ride_transitions FROM seniorsocial_app;
