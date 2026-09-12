CREATE TABLE report_activity_facts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), org_id uuid NOT NULL REFERENCES orgs(id),
  period timestamptz NOT NULL CHECK(period=(date_trunc('day',period AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
  channel text NOT NULL CHECK (channel IN ('screen','phone','sms','paper','front_desk','staff_assisted')),
  metric text NOT NULL CHECK (metric IN ('requests','registrations','attendance','capacity','unmet_requests')), activity_count integer NOT NULL CHECK (activity_count >= 0),
  source_version text NOT NULL CHECK (source_version~'^[a-z0-9][a-z0-9._:-]{0,127}$'), evidence text NOT NULL CHECK (evidence~'^[a-z][a-z0-9_.:-]{0,63}$'),
  UNIQUE(org_id,period,channel,metric,source_version)
);
CREATE TABLE report_channel_coverage (
  org_id uuid NOT NULL REFERENCES orgs(id), channel text NOT NULL CHECK (channel IN ('screen','phone','sms','paper','front_desk','staff_assisted')),
  completeness text NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
  source_version text NOT NULL CHECK (source_version~'^[a-z0-9][a-z0-9._:-]{0,127}$'), evidence text NOT NULL CHECK (evidence~'^[a-z][a-z0-9_.:-]{0,63}$'),
  coverage_from timestamptz NOT NULL, coverage_to timestamptz NOT NULL, known_omission text, overlap_uncertainty text, PRIMARY KEY(org_id,channel),
  CHECK(coverage_from=(date_trunc('day',coverage_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
  CHECK(coverage_to=(date_trunc('day',coverage_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
  CHECK(coverage_from<coverage_to AND coverage_to-coverage_from<=interval '366 days')
);
CREATE TABLE report_source_imports (
  org_id uuid NOT NULL REFERENCES orgs(id), source_version text NOT NULL CHECK(source_version~'^[a-z0-9][a-z0-9._:-]{0,127}$'),
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'), imported_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,source_version)
);
CREATE TABLE report_exports (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid NOT NULL, mutation_key text NOT NULL CHECK(length(mutation_key) BETWEEN 1 AND 160),request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
  report_name text NOT NULL CHECK(report_name='channel-activity'),format text NOT NULL CHECK(format IN ('json','csv')),state text NOT NULL CHECK(state IN ('queued','running','ready','failed')),
  filters jsonb NOT NULL,completeness_note text NOT NULL,artifact bytea NOT NULL,content_digest text NOT NULL CHECK(content_digest~'^[0-9a-f]{64}$'),content_type text NOT NULL,as_of timestamptz NOT NULL,source_version text NOT NULL,
  included_channels text[] NOT NULL,completeness text NOT NULL CHECK(completeness IN ('complete','partial','unknown')),known_omissions text[] NOT NULL,overlap_uncertainty text[] NOT NULL,row_count integer NOT NULL CHECK(row_count>=0),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
  FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),UNIQUE(org_id,actor_id,mutation_key)
);
CREATE TABLE individual_report_exports (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, subject_id uuid NOT NULL, actor_id uuid NOT NULL,
  mutation_key text NOT NULL CHECK(length(mutation_key) BETWEEN 1 AND 160), request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
  scope text[] NOT NULL CHECK(cardinality(scope) BETWEEN 1 AND 5), format text NOT NULL CHECK(format IN ('json','csv')),
  state text NOT NULL CHECK(state IN ('generating','ready','failed')), selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object'),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, as_of timestamptz, source_version text, plaintext_bytes integer CHECK(plaintext_bytes BETWEEN 0 AND 5242880), failure_code text,
  encryption_algorithm text CHECK(encryption_algorithm IS NULL OR encryption_algorithm='aes-256-gcm'), key_version text,
  nonce bytea CHECK(nonce IS NULL OR octet_length(nonce)=12), auth_tag bytea CHECK(auth_tag IS NULL OR octet_length(auth_tag)=16), ciphertext bytea CHECK(ciphertext IS NULL OR octet_length(ciphertext)<=5242880), released_at timestamptz,
  FOREIGN KEY(org_id,subject_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
  UNIQUE(org_id,actor_id,mutation_key),
  CHECK((state='ready')=(as_of IS NOT NULL AND source_version IS NOT NULL AND plaintext_bytes IS NOT NULL AND encryption_algorithm IS NOT NULL AND key_version IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND ciphertext IS NOT NULL)),
  CHECK(state<>'failed' OR failure_code IS NOT NULL)
);
GRANT SELECT,INSERT ON report_activity_facts,report_source_imports TO seniorsocial_app;
GRANT SELECT,INSERT,UPDATE ON report_channel_coverage TO seniorsocial_app;
GRANT SELECT,INSERT ON report_exports TO seniorsocial_app;
GRANT SELECT,INSERT ON individual_report_exports TO seniorsocial_app;
GRANT UPDATE(state,as_of,source_version,plaintext_bytes,failure_code,encryption_algorithm,key_version,nonce,auth_tag,ciphertext,released_at) ON individual_report_exports TO seniorsocial_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON report_activity_facts,report_source_imports FROM seniorsocial_app;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON report_channel_coverage FROM seniorsocial_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON report_exports FROM seniorsocial_app;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON individual_report_exports FROM seniorsocial_app;
ALTER TABLE report_activity_facts ENABLE ROW LEVEL SECURITY; ALTER TABLE report_activity_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE report_channel_coverage ENABLE ROW LEVEL SECURITY; ALTER TABLE report_channel_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE report_source_imports ENABLE ROW LEVEL SECURITY; ALTER TABLE report_source_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY; ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE individual_report_exports ENABLE ROW LEVEL SECURITY; ALTER TABLE individual_report_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY report_activity_facts_org_isolation ON report_activity_facts USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY report_channel_coverage_org_isolation ON report_channel_coverage USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY report_source_imports_org_isolation ON report_source_imports USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY report_exports_org_isolation ON report_exports USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY individual_report_exports_org_isolation ON individual_report_exports USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
