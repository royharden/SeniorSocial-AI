CREATE TYPE consent_scope_name AS ENUM
  ('view_schedule', 'book_rides', 'receive_alerts', 'view_assistance', 'manage_events', 'view_profile');

CREATE TABLE caregiver_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  resident_id uuid NOT NULL,
  caregiver_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, resident_id, caregiver_id),
  UNIQUE (org_id, id, resident_id, caregiver_id),
  CHECK (resident_id <> caregiver_id),
  FOREIGN KEY (org_id, resident_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, caregiver_id) REFERENCES users(org_id, id)
);

-- Append-only history covers both grants and revocations with both actors.
CREATE TABLE consent_grants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  link_id uuid NOT NULL,
  scope consent_scope_name NOT NULL,
  operation text NOT NULL CHECK (operation IN ('grant', 'revoke')),
  entry_actor_id uuid NOT NULL,
  decision_actor_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, link_id, scope),
  UNIQUE (org_id, link_id, version),
  FOREIGN KEY (org_id, link_id) REFERENCES caregiver_links(org_id, id),
  FOREIGN KEY (org_id, entry_actor_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, decision_actor_id) REFERENCES users(org_id, id)
);

CREATE TABLE consent_scopes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  link_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  revocation_id uuid,
  granted_by uuid NOT NULL,
  granted_to uuid NOT NULL,
  scope consent_scope_name NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  entry_actor_id uuid NOT NULL,
  decision_actor_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  read_back_confirmed_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (org_id, id),
  CHECK (decision_actor_id = granted_by),
  CHECK (entry_actor_id <> granted_to),
  CHECK ((revoked_at IS NULL) = (revocation_id IS NULL)),
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK ((scope = 'view_schedule' AND resource = 'schedule' AND action = 'read')
    OR (scope = 'book_rides' AND resource = 'ride' AND action = 'book')
    OR (scope = 'receive_alerts' AND resource = 'alert' AND action = 'read')
    OR (scope = 'view_assistance' AND resource = 'assistance' AND action = 'read')
    OR (scope = 'manage_events' AND resource = 'event' AND action = 'manage')
    OR (scope = 'view_profile' AND resource = 'profile' AND action = 'read')),
  FOREIGN KEY (org_id, link_id, granted_by, granted_to)
    REFERENCES caregiver_links(org_id, id, resident_id, caregiver_id),
  FOREIGN KEY (org_id, grant_id, link_id, scope) REFERENCES consent_grants(org_id, id, link_id, scope),
  FOREIGN KEY (org_id, revocation_id, link_id, scope) REFERENCES consent_grants(org_id, id, link_id, scope),
  FOREIGN KEY (org_id, entry_actor_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, decision_actor_id) REFERENCES users(org_id, id)
);
CREATE UNIQUE INDEX consent_scopes_active_idx ON consent_scopes (org_id, link_id, scope) WHERE revoked_at IS NULL;
CREATE INDEX consent_scopes_lookup_idx ON consent_scopes (org_id, granted_by, granted_to, scope);

-- A revocation is one-way; renewed consent creates a new scope and history row.
-- Also bind the visible scope attribution to its immutable grant/revoke history.
CREATE FUNCTION enforce_consent_scope_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A revoked consent scope is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM consent_grants g WHERE g.org_id = NEW.org_id AND g.id = NEW.grant_id
      AND g.link_id = NEW.link_id AND g.scope = NEW.scope AND g.operation = 'grant'
      AND g.entry_actor_id = NEW.entry_actor_id AND g.decision_actor_id = NEW.decision_actor_id
  ) THEN
    RAISE EXCEPTION 'Consent grant history mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.revocation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM consent_grants r JOIN consent_grants g
      ON g.org_id = r.org_id AND g.id = NEW.grant_id
    WHERE r.org_id = NEW.org_id AND r.id = NEW.revocation_id
      AND r.link_id = NEW.link_id AND r.scope = NEW.scope AND r.operation = 'revoke'
      AND r.decision_actor_id = NEW.granted_by AND r.version > g.version
  ) THEN
    RAISE EXCEPTION 'Consent revocation history mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consent_scopes_history BEFORE INSERT OR UPDATE ON consent_scopes
FOR EACH ROW EXECUTE FUNCTION enforce_consent_scope_history();

-- A version is a committed consent-history cursor, not a caller-editable counter.
-- Keep the repository's UPDATE usable, but reject rewinds, jumps, and increments
-- not backed by the corresponding immutable history AND applied scope change.
CREATE FUNCTION enforce_caregiver_link_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 0 THEN
      RAISE EXCEPTION 'A caregiver link must start at version zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 OR NOT EXISTS (
    SELECT 1 FROM consent_grants g JOIN consent_scopes s
      ON s.org_id = g.org_id AND s.link_id = g.link_id AND s.scope = g.scope
    WHERE g.org_id = NEW.org_id AND g.link_id = NEW.id AND g.version = NEW.version
      AND g.decision_actor_id = NEW.resident_id
      AND ((g.operation = 'grant' AND s.grant_id = g.id AND s.revoked_at IS NULL)
        OR (g.operation = 'revoke' AND s.revocation_id = g.id AND s.revoked_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'Consent version requires the next applied history entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER caregiver_links_version BEFORE INSERT OR UPDATE ON caregiver_links
FOR EACH ROW EXECUTE FUNCTION enforce_caregiver_link_version();

CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  entry_actor_id uuid NOT NULL,
  decision_actor_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason text NOT NULL CHECK (reason IN ('policy_allowed', 'policy_denied')),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entry_actor_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, decision_actor_id) REFERENCES users(org_id, id)
);
CREATE INDEX policy_decisions_org_at_idx ON policy_decisions (org_id, at);

ALTER TABLE caregiver_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_links FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY caregiver_links_org_isolation ON caregiver_links
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY consent_grants_org_isolation ON consent_grants
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY consent_scopes_org_isolation ON consent_scopes
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY policy_decisions_org_isolation ON policy_decisions
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON caregiver_links, consent_grants, consent_scopes, policy_decisions TO seniorsocial_app;
GRANT UPDATE (version) ON caregiver_links TO seniorsocial_app;
GRANT UPDATE (revoked_at, revocation_id) ON consent_scopes TO seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON caregiver_links, consent_grants, consent_scopes, policy_decisions FROM seniorsocial_app;
