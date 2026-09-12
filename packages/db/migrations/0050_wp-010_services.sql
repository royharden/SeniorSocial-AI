CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  external_id text,
  category_id uuid NOT NULL,
  name_en text NOT NULL CHECK (length(btrim(name_en)) > 0),
  name_es text NOT NULL CHECK (length(btrim(name_es)) > 0),
  description_en text NOT NULL DEFAULT '',
  description_es text NOT NULL DEFAULT '',
  eligibility_note_en text NOT NULL DEFAULT '',
  eligibility_note_es text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  source_updated_at timestamptz NOT NULL,
  publication_state text NOT NULL DEFAULT 'draft' CHECK (publication_state IN ('draft', 'published')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  search_en tsvector GENERATED ALWAYS AS
    (setweight(to_tsvector('english', name_en), 'A') || setweight(to_tsvector('english', description_en), 'B') ||
      setweight(to_tsvector('english', eligibility_note_en), 'C')) STORED,
  search_es tsvector GENERATED ALWAYS AS
    (setweight(to_tsvector('spanish', name_es), 'A') || setweight(to_tsvector('spanish', description_es), 'B') ||
      setweight(to_tsvector('spanish', eligibility_note_es), 'C')) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, external_id),
  FOREIGN KEY (org_id, category_id) REFERENCES service_categories(org_id, id),
  FOREIGN KEY (org_id, reviewed_by) REFERENCES users(org_id, id),
  CHECK ((publication_state = 'draft' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (publication_state = 'published' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX services_org_category_idx ON services (org_id, category_id);
CREATE INDEX services_org_publication_idx ON services (org_id, publication_state, category_id);
CREATE INDEX services_org_source_updated_idx ON services (org_id, source_updated_at DESC);
CREATE INDEX services_search_en_idx ON services USING gin (search_en);
CREATE INDEX services_search_es_idx ON services USING gin (search_es);
CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_languages (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  PRIMARY KEY (org_id, service_id, language_code),
  FOREIGN KEY (org_id, service_id) REFERENCES services(org_id, id) ON DELETE CASCADE
);
CREATE INDEX service_languages_lookup_idx ON service_languages (org_id, language_code, service_id);

CREATE TABLE service_accessibility (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  accessibility_code text NOT NULL CHECK (accessibility_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  PRIMARY KEY (org_id, service_id, accessibility_code),
  FOREIGN KEY (org_id, service_id) REFERENCES services(org_id, id) ON DELETE CASCADE
);
CREATE INDEX service_accessibility_lookup_idx ON service_accessibility (org_id, accessibility_code, service_id);

CREATE TABLE service_imports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('committed', 'failed')),
  accepted_rows integer NOT NULL CHECK (accepted_rows >= 0 AND accepted_rows <= 5000),
  rejected_rows integer NOT NULL CHECK (rejected_rows >= 0 AND rejected_rows <= 5000),
  CHECK (accepted_rows + rejected_rows <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id)
);
CREATE INDEX service_imports_org_created_idx ON service_imports (org_id, created_at DESC);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE service_languages ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_languages FORCE ROW LEVEL SECURITY;
ALTER TABLE service_accessibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_accessibility FORCE ROW LEVEL SECURITY;
ALTER TABLE service_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_imports FORCE ROW LEVEL SECURITY;

CREATE POLICY services_org_isolation ON services
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY service_languages_org_isolation ON service_languages
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY service_accessibility_org_isolation ON service_accessibility
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY service_imports_org_isolation ON service_imports
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON services, service_languages, service_accessibility TO seniorsocial_app;
GRANT SELECT, INSERT ON service_imports TO seniorsocial_app;
GRANT UPDATE (accepted_rows, rejected_rows) ON service_imports TO seniorsocial_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON services, service_languages, service_accessibility, service_imports FROM seniorsocial_app;
REVOKE DELETE ON service_imports FROM seniorsocial_app;
