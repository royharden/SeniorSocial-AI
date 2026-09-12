ALTER TABLE caregiver_links
  ADD COLUMN state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'revoked'));
UPDATE caregiver_links l SET state = 'active'
WHERE EXISTS (
  SELECT 1 FROM consent_scopes s
  WHERE s.org_id = l.org_id AND s.link_id = l.id AND s.revoked_at IS NULL
);
ALTER TABLE consent_scopes
  ADD CONSTRAINT consent_scopes_no_event_delegation CHECK (scope <> 'manage_events');

-- Extend WP-005's version trigger so state follows the applied scope mutation.
-- A pending link with no grants may also be revoked without fabricating history.
CREATE OR REPLACE FUNCTION enforce_caregiver_link_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 0 OR NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'A caregiver link must start pending at version zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version = OLD.version AND OLD.state = 'pending' AND NEW.state = 'revoked'
    AND NOT EXISTS (SELECT 1 FROM consent_scopes s WHERE s.org_id = NEW.org_id AND s.link_id = NEW.id AND s.revoked_at IS NULL) THEN
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
    RAISE EXCEPTION 'Consent version and state require the next applied history entry' USING ERRCODE = '23514';
  END IF;
  -- Existing WP-005 writers update only version. Derive active/pending from the
  -- committed scope rows while preserving an explicit whole-link revocation.
  IF EXISTS (SELECT 1 FROM consent_scopes s WHERE s.org_id = NEW.org_id AND s.link_id = NEW.id AND s.revoked_at IS NULL) THEN
    NEW.state := 'active';
  ELSIF NEW.state <> 'revoked' THEN
    NEW.state := 'pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE caregiver_invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  resident_id uuid NOT NULL,
  recipient_digest char(64) NOT NULL CHECK (recipient_digest ~ '^[0-9a-f]{64}$'),
  token_digest char(64) NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  relationship_note text CHECK (relationship_note IS NULL OR (char_length(relationship_note) BETWEEN 1 AND 500)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  caregiver_id uuid,
  UNIQUE (org_id, id),
  UNIQUE (org_id, token_digest),
  CHECK (expires_at = created_at + interval '24 hours'),
  CHECK ((accepted_at IS NULL) = (caregiver_id IS NULL)),
  CHECK (accepted_at IS NULL OR (accepted_at >= created_at AND accepted_at < expires_at)),
  FOREIGN KEY (org_id, resident_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, caregiver_id) REFERENCES users(org_id, id)
);
CREATE INDEX caregiver_invitations_recipient_idx
  ON caregiver_invitations (org_id, recipient_digest, expires_at);

CREATE TABLE consent_read_backs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  link_id uuid NOT NULL,
  resident_id uuid NOT NULL,
  entry_actor_id uuid NOT NULL,
  scopes consent_scope_name[] NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (cardinality(scopes) <= 5),
  CHECK (NOT ('manage_events'::consent_scope_name = ANY(scopes))),
  CHECK (resident_id = entry_actor_id),
  FOREIGN KEY (org_id, link_id) REFERENCES caregiver_links(org_id, id),
  FOREIGN KEY (org_id, resident_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, entry_actor_id) REFERENCES users(org_id, id)
);
CREATE FUNCTION enforce_consent_read_back_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM caregiver_links l
    WHERE l.org_id = NEW.org_id AND l.id = NEW.link_id AND l.resident_id = NEW.resident_id
  ) THEN
    RAISE EXCEPTION 'Consent read-back resident mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consent_read_backs_link BEFORE INSERT ON consent_read_backs
FOR EACH ROW EXECUTE FUNCTION enforce_consent_read_back_link();
CREATE INDEX consent_read_backs_link_idx ON consent_read_backs (org_id, link_id, confirmed_at DESC);

ALTER TABLE caregiver_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_read_backs ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_read_backs FORCE ROW LEVEL SECURITY;

CREATE POLICY caregiver_invitations_org_isolation ON caregiver_invitations
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY consent_read_backs_org_isolation ON consent_read_backs
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON caregiver_invitations, consent_read_backs TO seniorsocial_app;
GRANT UPDATE (accepted_at, caregiver_id) ON caregiver_invitations TO seniorsocial_app;
GRANT UPDATE (state) ON caregiver_links TO seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON caregiver_invitations, consent_read_backs FROM seniorsocial_app;
