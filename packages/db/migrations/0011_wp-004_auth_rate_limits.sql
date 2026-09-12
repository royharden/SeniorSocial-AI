CREATE TYPE auth_rate_limit_purpose AS ENUM (
  'request_identifier', 'request_ip', 'verify_device', 'verify_ip', 'demo_device', 'demo_ip'
);

CREATE TABLE auth_rate_limits (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  purpose auth_rate_limit_purpose NOT NULL,
  subject_digest text NOT NULL,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (org_id, purpose, subject_digest)
);
CREATE INDEX auth_rate_limits_cleanup_idx ON auth_rate_limits (window_started_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO seniorsocial_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON auth_rate_limits FROM seniorsocial_app;
ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_rate_limits_org_isolation ON auth_rate_limits
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
