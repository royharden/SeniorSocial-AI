CREATE TABLE content_pages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  critical boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (org_id, slug),
  FOREIGN KEY (org_id, updated_by) REFERENCES users(org_id, id) ON DELETE RESTRICT
);
CREATE TABLE faqs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES users(org_id, id) ON DELETE RESTRICT
);
CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  publish_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES users(org_id, id) ON DELETE RESTRICT
);

ALTER TABLE users ADD COLUMN admin_version integer NOT NULL DEFAULT 1 CHECK (admin_version > 0);
ALTER TABLE partners ADD COLUMN admin_version integer NOT NULL DEFAULT 1 CHECK (admin_version > 0);
CREATE TABLE admin_mutations (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  mutation_key text NOT NULL CHECK (length(mutation_key) BETWEEN 1 AND 160 AND mutation_key ~ '^[A-Za-z0-9._~-]{1,160}$'),
  operation text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_id uuid,
  response_status integer CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,actor_id,operation,mutation_key),
  FOREIGN KEY (org_id,actor_id) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION protect_admin_mutation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.org_id <> NEW.org_id OR OLD.actor_id <> NEW.actor_id OR OLD.mutation_key <> NEW.mutation_key
    OR OLD.operation <> NEW.operation OR OLD.request_hash <> NEW.request_hash
    OR OLD.resource_id IS NOT NULL OR OLD.response_status IS NOT NULL OR OLD.response_body IS NOT NULL
    OR NEW.resource_id IS NULL OR NEW.response_status IS NULL OR NEW.response_body IS NULL THEN
    RAISE EXCEPTION 'admin mutation identity and completed result are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_mutations_protect BEFORE UPDATE ON admin_mutations
FOR EACH ROW EXECUTE FUNCTION protect_admin_mutation_update();

CREATE INDEX content_pages_org_updated_idx ON content_pages(org_id, updated_at DESC);
CREATE INDEX faqs_org_updated_idx ON faqs(org_id, updated_at DESC);
CREATE INDEX announcements_org_publish_idx ON announcements(org_id, publish_at DESC);

ALTER TABLE content_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs FORCE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY content_pages_org_isolation ON content_pages USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY faqs_org_isolation ON faqs USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY announcements_org_isolation ON announcements USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY admin_mutations_org_isolation ON admin_mutations USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON content_pages, faqs, announcements TO seniorsocial_app;
GRANT SELECT, INSERT, UPDATE ON admin_mutations TO seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON content_pages, faqs, announcements FROM seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON admin_mutations FROM seniorsocial_app;
