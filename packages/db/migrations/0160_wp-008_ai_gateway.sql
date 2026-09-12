CREATE TYPE ai_cost_reservation_state AS ENUM ('held', 'settled', 'released', 'pending_reconciliation', 'expired');
CREATE TYPE ai_attempt_kind AS ENUM ('initial', 'gateway-retry', 'tool-round', 'fallback', 'judge');

CREATE TABLE prompt_versions (
  feature text NOT NULL,
  version text NOT NULL,
  prompt_hash char(64) NOT NULL,
  prompt_path text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (feature, version),
  UNIQUE (feature, prompt_hash),
  CHECK (prompt_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE ai_cost_caps (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  feature text NOT NULL,
  daily_cap_usd numeric(12,6) NOT NULL CHECK (daily_cap_usd >= 0),
  total_cap_usd numeric(12,6) NOT NULL CHECK (total_cap_usd >= daily_cap_usd),
  PRIMARY KEY (org_id, feature)
);
CREATE TABLE ai_org_cost_caps (
  org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  daily_cap_usd numeric(12,6) NOT NULL CHECK (daily_cap_usd >= 0),
  total_cap_usd numeric(12,6) NOT NULL CHECK (total_cap_usd >= daily_cap_usd)
);
CREATE TABLE ai_cost_reservations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  feature text NOT NULL,
  request_id text NOT NULL,
  reserved_usd numeric(12,6) NOT NULL CHECK (reserved_usd >= 0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
  state ai_cost_reservation_state NOT NULL DEFAULT 'held',
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  settled_usd numeric(12,6) CHECK (settled_usd IS NULL OR settled_usd >= 0),
  UNIQUE (org_id, id),
  CHECK (feature IN ('concierge','moderation','translation_assist','triage','intake_routing','event_rerank','conversation_starters','summaries')),
  CHECK ((state IN ('held','pending_reconciliation') AND closed_at IS NULL) OR (state IN ('settled','released','expired') AND closed_at IS NOT NULL))
);
CREATE TABLE ai_cost_attempts (
  id bigserial PRIMARY KEY,
  reservation_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  kind ai_attempt_kind NOT NULL,
  model text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  tokens_in integer CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out integer CHECK (tokens_out IS NULL OR tokens_out >= 0),
  tokens_cached integer CHECK (tokens_cached IS NULL OR tokens_cached >= 0),
  FOREIGN KEY (org_id, reservation_id) REFERENCES ai_cost_reservations(org_id, id) ON DELETE RESTRICT
);
CREATE TABLE ai_rate_limit_observations (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  feature text NOT NULL,
  window_started_at timestamptz NOT NULL,
  user_count integer NOT NULL CHECK (user_count >= 0),
  feature_count integer NOT NULL CHECK (feature_count >= 0),
  denied boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id) ON DELETE CASCADE
);
CREATE TABLE ai_cache (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('en','es')), feature text NOT NULL, prompt_version text NOT NULL,
  model text NOT NULL, source_content_version_set jsonb NOT NULL, input_hash char(64) NOT NULL,
  response jsonb NOT NULL, hit_count integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, locale, feature, prompt_version, model, source_content_version_set, input_hash)
);
CREATE INDEX ai_cost_reservations_open ON ai_cost_reservations(org_id, feature, state) WHERE state IN ('held','pending_reconciliation');
CREATE INDEX ai_rate_limit_recent ON ai_rate_limit_observations(org_id, feature, observed_at DESC);
ALTER TABLE ai_events ADD CONSTRAINT ai_events_reservation_fk FOREIGN KEY (org_id, reservation_id) REFERENCES ai_cost_reservations(org_id, id) ON DELETE RESTRICT;

CREATE FUNCTION reserve_ai_cost(requested_org uuid, requested_feature text, requested_request_id text, requested_usd numeric, requested_max_tokens integer)
RETURNS SETOF ai_cost_reservations LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cap ai_cost_caps%ROWTYPE; org_cap ai_org_cost_caps%ROWTYPE; spent numeric; reserved numeric; org_spent numeric; org_reserved numeric; in_flight integer; result ai_cost_reservations%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_org_id', true), '')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text || ':' || requested_feature, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text, 0));
  SELECT * INTO cap FROM ai_cost_caps WHERE org_id=requested_org AND feature=requested_feature FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI cost cap is not configured'; END IF;
  SELECT * INTO org_cap FROM ai_org_cost_caps WHERE org_id=requested_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI organisation cost cap is not configured'; END IF;
  SELECT coalesce(sum(settled_usd),0) INTO spent FROM ai_cost_reservations WHERE org_id=requested_org AND feature=requested_feature AND state IN ('settled','expired');
  SELECT coalesce(sum(reserved_usd),0) INTO reserved FROM ai_cost_reservations WHERE org_id=requested_org AND feature=requested_feature AND state IN ('held','pending_reconciliation');
  SELECT coalesce(sum(settled_usd),0), coalesce(sum(reserved_usd) FILTER (WHERE state IN ('held','pending_reconciliation')),0), count(*) FILTER (WHERE state IN ('held','pending_reconciliation')) INTO org_spent,org_reserved,in_flight FROM ai_cost_reservations WHERE org_id=requested_org AND state IN ('held','pending_reconciliation','settled','expired');
  IF in_flight >= 8 THEN RAISE EXCEPTION 'AI organisation concurrency cap exceeded' USING ERRCODE='P0001'; END IF;
  IF spent + reserved + requested_usd > cap.total_cap_usd OR
     (SELECT coalesce(sum(coalesce(settled_usd,reserved_usd)),0) FROM ai_cost_reservations WHERE org_id=requested_org AND feature=requested_feature AND created_at >= date_trunc('day', now()) AND state <> 'released') + requested_usd > cap.daily_cap_usd
     OR org_spent + org_reserved + requested_usd > org_cap.total_cap_usd
     OR (SELECT coalesce(sum(coalesce(settled_usd,reserved_usd)),0) FROM ai_cost_reservations WHERE org_id=requested_org AND created_at >= date_trunc('day', now()) AND state <> 'released') + requested_usd > org_cap.daily_cap_usd
  THEN RAISE EXCEPTION 'AI cost cap exceeded' USING ERRCODE='P0001'; END IF;
  INSERT INTO ai_cost_reservations(org_id,feature,request_id,reserved_usd,max_output_tokens) VALUES(requested_org,requested_feature,requested_request_id,requested_usd,requested_max_tokens) RETURNING * INTO result;
  RETURN NEXT result;
END $$;
CREATE FUNCTION transition_ai_cost(requested_org uuid, requested_id uuid, requested_state ai_cost_reservation_state, requested_settled numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE row ai_cost_reservations%ROWTYPE;
BEGIN
  IF requested_org IS DISTINCT FROM nullif(current_setting('app.current_org_id', true), '')::uuid THEN RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO row FROM ai_cost_reservations WHERE org_id=requested_org AND id=requested_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation not found' USING ERRCODE='42501'; END IF;
  IF row.state = requested_state THEN RETURN; END IF;
  IF row.state <> 'held' AND NOT (row.state='pending_reconciliation' AND requested_state IN ('settled','expired')) THEN RAISE EXCEPTION 'invalid reservation transition'; END IF;
  UPDATE ai_cost_reservations SET state=requested_state, settled_usd=CASE WHEN requested_state='expired' THEN row.reserved_usd ELSE requested_settled END,
    closed_at=CASE WHEN requested_state='pending_reconciliation' THEN NULL ELSE now() END WHERE org_id=requested_org AND id=requested_id;
END $$;
CREATE FUNCTION consume_ai_rate_limit(requested_org uuid, requested_user uuid, requested_feature text, user_limit integer, feature_limit integer, window_seconds integer)
RETURNS TABLE(allowed boolean,retry_after_seconds integer,user_remaining integer,feature_remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE window_start timestamptz := now() - make_interval(secs => window_seconds); user_used integer; feature_used integer;
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text || ':' || requested_feature,1));
  SELECT count(*) FILTER (WHERE user_id=requested_user),count(*) INTO user_used,feature_used FROM ai_rate_limit_observations WHERE org_id=requested_org AND feature=requested_feature AND observed_at>=window_start AND NOT denied;
  allowed := user_used < user_limit AND feature_used < feature_limit;
  user_remaining := greatest(0,user_limit-user_used-(allowed::integer)); feature_remaining := greatest(0,feature_limit-feature_used-(allowed::integer));
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE window_seconds END;
  INSERT INTO ai_rate_limit_observations(org_id,user_id,feature,window_started_at,user_count,feature_count,denied) VALUES(requested_org,requested_user,requested_feature,window_start,user_used+(allowed::integer),feature_used+(allowed::integer),NOT allowed);
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION reserve_ai_cost(uuid,text,text,numeric,integer), transition_ai_cost(uuid,uuid,ai_cost_reservation_state,numeric), consume_ai_rate_limit(uuid,uuid,text,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_ai_cost(uuid,text,text,numeric,integer), transition_ai_cost(uuid,uuid,ai_cost_reservation_state,numeric), consume_ai_rate_limit(uuid,uuid,text,integer,integer,integer) TO seniorsocial_app;

ALTER TABLE ai_cost_caps ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_cost_caps FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_org_cost_caps ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_org_cost_caps FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_cost_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_cost_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_cost_attempts ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_cost_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_rate_limit_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_rate_limit_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_cost_caps_tenant ON ai_cost_caps USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY ai_org_cost_caps_tenant ON ai_org_cost_caps USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY ai_cost_reservations_tenant ON ai_cost_reservations USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY ai_cost_attempts_tenant ON ai_cost_attempts USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY ai_rate_limit_tenant ON ai_rate_limit_observations USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY ai_cache_tenant ON ai_cache USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid) WITH CHECK (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
GRANT SELECT ON prompt_versions, ai_cost_caps, ai_org_cost_caps, ai_cost_reservations, ai_cost_attempts, ai_rate_limit_observations, ai_cache TO seniorsocial_app;
GRANT INSERT ON ai_cost_attempts, ai_rate_limit_observations, ai_cache TO seniorsocial_app;
GRANT USAGE, SELECT ON SEQUENCE ai_cost_attempts_id_seq TO seniorsocial_app;
GRANT UPDATE(hit_count) ON ai_cache TO seniorsocial_app;
