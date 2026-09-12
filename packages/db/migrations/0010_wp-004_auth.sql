CREATE TYPE auth_verification_method AS ENUM ('magic_link', 'sms_code');

CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  method auth_verification_method NOT NULL,
  token_digest text NOT NULL,
  browser_nonce_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_tokens_user_key
    FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE,
  CONSTRAINT verification_tokens_org_digest_key UNIQUE (org_id, token_digest)
);
CREATE INDEX verification_tokens_active_idx
  ON verification_tokens (org_id, user_id, method, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  token_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_user_key
    FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE,
  CONSTRAINT sessions_org_digest_key UNIQUE (org_id, token_digest)
);
CREATE INDEX sessions_active_user_idx
  ON sessions (org_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE demo_accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  code_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_accounts_user_key
    FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE,
  CONSTRAINT demo_accounts_org_user_key UNIQUE (org_id, user_id),
  CONSTRAINT demo_accounts_org_digest_key UNIQUE (org_id, code_digest)
);
CREATE INDEX demo_accounts_active_idx
  ON demo_accounts (org_id, expires_at)
  WHERE used_at IS NULL;

CREATE TABLE recovery_contacts (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  second_phone text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT recovery_contacts_user_key
    FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE
);
CREATE TRIGGER recovery_contacts_set_updated_at BEFORE UPDATE ON recovery_contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON
  verification_tokens, sessions, demo_accounts, recovery_contacts TO seniorsocial_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON
  verification_tokens, sessions, demo_accounts, recovery_contacts FROM seniorsocial_app;

ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE recovery_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY verification_tokens_org_isolation ON verification_tokens
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY sessions_org_isolation ON sessions
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY demo_accounts_org_isolation ON demo_accounts
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY recovery_contacts_org_isolation ON recovery_contacts
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
