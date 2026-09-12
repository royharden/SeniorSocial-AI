DROP TABLE IF EXISTS consent_read_backs;
DROP FUNCTION IF EXISTS enforce_consent_read_back_link();
DROP TABLE IF EXISTS caregiver_invitations;
ALTER TABLE consent_scopes DROP CONSTRAINT IF EXISTS consent_scopes_no_event_delegation;
CREATE OR REPLACE FUNCTION enforce_caregiver_link_version() RETURNS trigger
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
ALTER TABLE caregiver_links DROP COLUMN IF EXISTS state;
