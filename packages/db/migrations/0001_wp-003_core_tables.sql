-- These trusted extensions are database-scoped. Local Compose preinstalls them,
-- but Railway and test databases must also be migratable from a blank database.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE locale AS ENUM ('en', 'es');
CREATE TYPE display_mode AS ENUM ('standard', 'easy');
CREATE TYPE account_state AS ENUM ('active', 'held_for_review', 'deactivated');
CREATE TYPE user_role AS ENUM ('senior', 'caregiver', 'staff', 'admin', 'partner', 'support');

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  locale_default locale NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'America/New_York',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  email citext,
  phone text,
  account_state account_state NOT NULL DEFAULT 'active',
  mode display_mode NOT NULL DEFAULT 'standard',
  locale locale NOT NULL DEFAULT 'en',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT users_org_id_email_key UNIQUE (org_id, email)
);
CREATE INDEX users_org_id_account_state_idx ON users (org_id, account_state);

CREATE TABLE user_roles (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role user_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, role),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE
);
CREATE INDEX user_roles_org_id_role_idx ON user_roles (org_id, role);

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  preferred_name text,
  birth_year integer,
  birth_month integer,
  contact_email citext,
  contact_phone text,
  accessibility_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT profiles_org_id_user_id_key UNIQUE (org_id, user_id),
  CONSTRAINT profiles_user_key FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE,
  CONSTRAINT profiles_birth_year_check CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  CONSTRAINT profiles_birth_month_check CHECK (birth_month IS NULL OR birth_month BETWEEN 1 AND 12)
);
CREATE INDEX profiles_org_id_created_at_idx ON profiles (org_id, created_at);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug text NOT NULL,
  label_en text NOT NULL,
  label_es text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_categories_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT service_categories_org_id_slug_key UNIQUE (org_id, slug)
);
CREATE INDEX service_categories_org_id_label_en_idx ON service_categories (org_id, label_en);

CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partners_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT partners_org_id_name_key UNIQUE (org_id, name)
);
CREATE INDEX partners_org_id_created_at_idx ON partners (org_id, created_at);

CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON orgs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_categories_set_updated_at BEFORE UPDATE ON service_categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER partners_set_updated_at BEFORE UPDATE ON partners
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seniorsocial_app') THEN
    CREATE ROLE seniorsocial_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seniorsocial_runtime') THEN
    EXECUTE 'GRANT seniorsocial_app TO seniorsocial_runtime';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO seniorsocial_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_roles, profiles, service_categories, partners TO seniorsocial_app;
GRANT SELECT ON orgs TO seniorsocial_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON users, user_roles, profiles, service_categories, partners FROM seniorsocial_app;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners FORCE ROW LEVEL SECURITY;

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;

CREATE POLICY orgs_org_isolation ON orgs
  USING (id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY users_org_isolation ON users
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY user_roles_org_isolation ON user_roles
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY profiles_org_isolation ON profiles
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY service_categories_org_isolation ON service_categories
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY partners_org_isolation ON partners
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
