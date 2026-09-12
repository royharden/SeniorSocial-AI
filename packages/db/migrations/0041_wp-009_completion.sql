CREATE TABLE notification_inbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 160),
  purpose text NOT NULL CHECK (purpose IN ('task_notice','urgent_assistance','event_reminder','message','forums_digest','recommendations')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 4000),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, source_key),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id)
);
CREATE INDEX notification_inbox_recipient ON notification_inbox (org_id, user_id, created_at DESC, id DESC);
CREATE TABLE print_requests (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  week_of date NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,user_id,idempotency_key),
  FOREIGN KEY (org_id,user_id) REFERENCES users(org_id,id)
);
CREATE FUNCTION print_items_valid(items jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_typeof(items) = 'array' THEN
    octet_length(items::text) <= 100000 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(items) AS item WHERE jsonb_typeof(item) <> 'object'
    ) ELSE false END;
$$;
CREATE FUNCTION print_source_instant_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE parsed timestamptz;
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
    OR left(value,5) = '0000-' THEN RETURN false; END IF;
  parsed := value::timestamptz;
  RETURN to_char(parsed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') = left(value,19);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;
CREATE FUNCTION print_sources_valid(sources jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_typeof(sources) = 'array' THEN
    jsonb_array_length(sources) <= 8 AND octet_length(sources::text) <= 8192 AND
    (SELECT count(DISTINCT source->>'key') = jsonb_array_length(sources) FROM jsonb_array_elements(sources) AS source) AND
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(sources) AS source
      WHERE CASE WHEN jsonb_typeof(source) <> 'object' THEN true ELSE
        (SELECT count(*) FROM jsonb_object_keys(source)) <> 5
          OR NOT (source ?& ARRAY['key','status','source_version','as_of','item_count'])
          OR jsonb_typeof(source->'key') <> 'string'
          OR NOT ((source->>'key') ~ '^[a-z][a-z0-9-]{0,39}$')
          OR jsonb_typeof(source->'status') <> 'string'
          OR (source->>'status') NOT IN ('available','not_registered','unavailable')
          OR CASE WHEN jsonb_typeof(source->'item_count') = 'number' THEN
            (source->>'item_count')::numeric < 0 OR (source->>'item_count')::numeric > 9999
            OR trunc((source->>'item_count')::numeric) <> (source->>'item_count')::numeric
          ELSE true END
          OR CASE WHEN source->>'status' = 'available' THEN
            jsonb_typeof(source->'source_version') <> 'string'
            OR NOT ((source->>'source_version') ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$')
            OR jsonb_typeof(source->'as_of') <> 'string'
            OR NOT print_source_instant_valid(source->>'as_of')
          ELSE source->'source_version' <> 'null'::jsonb OR source->'as_of' <> 'null'::jsonb
            OR source->'item_count' <> '0'::jsonb END
      END
    )
  ELSE false END;
$$;
CREATE TABLE print_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  week_of date NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  as_of timestamptz NOT NULL,
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  items jsonb NOT NULL CHECK (print_items_valid(items)),
  sources jsonb CHECK (sources IS NULL OR print_sources_valid(sources)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, idempotency_key),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id)
);
CREATE INDEX notification_print_recipient ON print_jobs (org_id, user_id, week_of, as_of DESC, created_at DESC);
CREATE FUNCTION notification_inbox_constrained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.read_at IS NOT NULL AND (NEW.read_at < NEW.created_at OR NEW.read_at > statement_timestamp()) THEN
    RAISE EXCEPTION 'invalid inbox read marker';
  END IF;
  IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.org_id, NEW.user_id, NEW.source_key, NEW.purpose, NEW.title, NEW.body, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.user_id, OLD.source_key, OLD.purpose, OLD.title, OLD.body, OLD.created_at)
    OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL) THEN RAISE EXCEPTION 'inbox content is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_inbox_constrained BEFORE INSERT OR UPDATE ON notification_inbox FOR EACH ROW EXECUTE FUNCTION notification_inbox_constrained();
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['notification_inbox', 'print_jobs', 'print_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_recipient ON %I USING (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid AND user_id = nullif(current_setting(''app.current_user_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'', true), '''')::uuid AND user_id = nullif(current_setting(''app.current_user_id'', true), '''')::uuid)', name);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT ON notification_inbox, print_jobs, print_requests TO seniorsocial_app;
GRANT UPDATE (read_at) ON notification_inbox TO seniorsocial_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON print_jobs, print_requests FROM seniorsocial_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_inbox FROM seniorsocial_app;
