CREATE TYPE flag_scope AS ENUM ('global', 'org');

CREATE TABLE feature_flag_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('dev', 'test', 'staging', 'production'))
);
INSERT INTO feature_flag_environment (singleton, environment)
VALUES (true, coalesce(nullif(current_setting('seniorsocial.deploy_environment', true), ''), 'test'));

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor text NOT NULL,
  on_behalf_of text,
  action text NOT NULL,
  target text NOT NULL,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'error')),
  reason text CHECK (reason IS NULL OR (length(reason) <= 500 AND reason !~ E'[\r\n]')),
  prompt_version text,
  ai_event_id uuid,
  request_id text,
  ip_hash text,
  CHECK (actor ~* '^(user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z0-9_-]+|ai:[a-z0-9_]+)$'),
  CHECK (on_behalf_of IS NULL OR on_behalf_of ~* '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (action IN (
    'auth.signed_in', 'auth.signed_out', 'auth.code_requested', 'auth.demo_code_used',
    'consent.granted', 'consent.revoked', 'consent.read_back_confirmed',
    'caregiver.invited', 'caregiver.accepted', 'caregiver.acted', 'caregiver.denied',
    'ride.created', 'ride.transitioned', 'ride.send_failed', 'assistance.opened',
    'assistance.owned', 'assistance.transitioned', 'assistance.sla_breached',
    'moderation.flagged', 'moderation.decided', 'content.updated', 'service.updated',
    'partner.updated', 'translation.approved', 'translation.invalidated',
    'user.role_changed', 'user.held_for_review', 'flag.changed', 'export.created',
    'export.downloaded', 'ai.recommended', 'ai.refused', 'ai.killed'
  )),
  CHECK (target ~ '^[a-z][a-z0-9_]*:[A-Za-z0-9._-]+$'),
  CHECK (outcome = 'allowed' OR reason IS NOT NULL),
  CHECK (action NOT IN ('flag.changed', 'moderation.decided') OR reason IS NOT NULL)
);

CREATE TABLE ai_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  feature text NOT NULL,
  prompt_version text,
  prompt_hash text,
  provider text NOT NULL CHECK (provider IN ('stub', 'anthropic-api', 'openai-api', 'claude-cli-bridge', 'codex-cli-bridge')),
  model text NOT NULL,
  tokens_in integer CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out integer CHECK (tokens_out IS NULL OR tokens_out >= 0),
  tokens_cached integer CHECK (tokens_cached IS NULL OR tokens_cached >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  cache_hit boolean NOT NULL,
  user_role text NOT NULL CHECK (user_role IN ('senior', 'caregiver', 'staff', 'admin', 'partner', 'support')),
  on_behalf_of text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'refused', 'error', 'killed', 'egress_blocked')),
  reason text CHECK (reason IS NULL OR (length(reason) <= 500 AND reason !~ E'[\r\n]')),
  cost_usd numeric(12, 6) NOT NULL CHECK (cost_usd >= 0),
  reservation_id uuid,
  settled_usd numeric(12, 6) CHECK (settled_usd IS NULL OR settled_usd >= 0),
  usage_known boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (feature IN ('concierge', 'moderation', 'translation_assist', 'triage', 'intake_routing', 'event_rerank', 'conversation_starters', 'summaries')),
  CHECK (outcome NOT IN ('refused', 'error', 'killed') OR reason IS NOT NULL)
);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_ai_event_fk
  FOREIGN KEY (org_id, ai_event_id) REFERENCES ai_events(org_id, id) ON DELETE RESTRICT;

CREATE TABLE feature_flags (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_key text NOT NULL,
  scope flag_scope NOT NULL,
  org_id uuid REFERENCES orgs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'global' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL)),
  CHECK (flag_key IN (
    'ai.master', 'ai.concierge', 'ai.moderation', 'ai.translation_assist', 'ai.triage',
    'ai.intake_routing', 'ai.event_rerank', 'ai.conversation_starters', 'ai.summaries',
    'ai.provider.anthropic_api', 'ai.provider.cli_bridge', 'ai.cache.exact_match',
    'ai.batch.moderation', 'rag.enabled', 'notify.sms.real_send', 'notify.voice.real_send',
    'notify.web_push', 'messages.one_to_one', 'intake.health', 'translate.review_queue_ui',
    'admin.analytics_extended', 'events.resident_proposals', 'easy_mode.voice_io', 'demo.reset_endpoint'
  ))
);
CREATE UNIQUE INDEX feature_flags_global_key ON feature_flags (flag_key) WHERE scope = 'global';
CREATE UNIQUE INDEX feature_flags_org_key ON feature_flags (org_id, flag_key) WHERE scope = 'org';

CREATE TABLE flag_changes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_id uuid NOT NULL REFERENCES feature_flags(id) ON DELETE RESTRICT,
  flag_key text NOT NULL,
  scope flag_scope NOT NULL,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  old_enabled boolean NOT NULL,
  new_enabled boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 400 AND reason !~ E'[\r\n]'),
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX audit_events_org_page ON audit_events (org_id, at DESC, id DESC);
CREATE INDEX audit_events_org_action ON audit_events (org_id, action, at DESC);
CREATE INDEX ai_events_org_page ON ai_events (org_id, created_at DESC, id DESC);
CREATE INDEX ai_events_org_feature ON ai_events (org_id, feature, created_at DESC);
CREATE INDEX flag_changes_org_page ON flag_changes (org_id, changed_at DESC);

CREATE FUNCTION reject_immutable_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_change();
CREATE TRIGGER ai_events_immutable BEFORE UPDATE OR DELETE ON ai_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_change();
CREATE TRIGGER flag_changes_immutable BEFORE UPDATE OR DELETE ON flag_changes
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_change();

CREATE FUNCTION configured_flag_defaults() RETURNS TABLE(flag_key text, enabled boolean)
LANGUAGE sql STABLE AS $$
  SELECT matrix.flag_key,
    CASE environment.environment
      WHEN 'dev' THEN matrix.dev
      WHEN 'test' THEN matrix.test
      WHEN 'staging' THEN matrix.staging
      WHEN 'production' THEN matrix.production
    END
  FROM feature_flag_environment environment
  CROSS JOIN (VALUES
    ('ai.master', true, false, true, true),
    ('ai.concierge', true, false, true, true),
    ('ai.moderation', true, false, true, true),
    ('ai.translation_assist', true, false, true, true),
    ('ai.triage', true, false, true, true),
    ('ai.intake_routing', true, false, true, true),
    ('ai.event_rerank', false, false, false, false),
    ('ai.conversation_starters', false, false, false, false),
    ('ai.summaries', false, false, false, false),
    ('ai.provider.anthropic_api', true, false, true, true),
    ('ai.provider.cli_bridge', false, false, false, false),
    ('ai.cache.exact_match', true, true, true, true),
    ('ai.batch.moderation', false, false, true, true),
    ('rag.enabled', false, false, false, false),
    ('notify.sms.real_send', false, false, false, false),
    ('notify.voice.real_send', false, false, false, false),
    ('notify.web_push', false, false, false, false),
    ('messages.one_to_one', true, true, true, true),
    ('intake.health', true, true, true, true),
    ('translate.review_queue_ui', true, true, true, true),
    ('admin.analytics_extended', true, true, true, true),
    ('events.resident_proposals', true, true, true, true),
    ('easy_mode.voice_io', true, true, true, true),
    ('demo.reset_endpoint', true, true, true, false)
  ) matrix(flag_key, dev, test, staging, production)
  WHERE environment.singleton;
$$;

CREATE FUNCTION seed_org_flags(target_org uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO feature_flags (flag_key, scope, org_id, enabled, updated_by)
  SELECT flag_key, 'org', target_org, enabled, '00000000-0000-4000-8000-000000000000'
  FROM configured_flag_defaults()
  ON CONFLICT DO NOTHING;
$$;

INSERT INTO feature_flags (flag_key, scope, org_id, enabled, updated_by)
SELECT flag_key, 'global', NULL, enabled, '00000000-0000-4000-8000-000000000000'
FROM configured_flag_defaults();
SELECT seed_org_flags(id) FROM orgs;

CREATE FUNCTION seed_flags_for_new_org() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.seed_org_flags(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER orgs_seed_feature_flags AFTER INSERT ON orgs
FOR EACH ROW EXECUTE FUNCTION seed_flags_for_new_org();

CREATE FUNCTION set_feature_flag(
  requested_org uuid,
  requested_actor uuid,
  requested_scope flag_scope,
  requested_key text,
  requested_enabled boolean,
  requested_reason text,
  requested_request_id text DEFAULT NULL
) RETURNS TABLE(key text, enabled boolean, scope flag_scope, updated_by uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_org uuid;
  current_flag public.feature_flags%ROWTYPE;
  clean_reason text;
  safe_actor constant uuid := '00000000-0000-4000-8000-000000000000';
BEGIN
  bound_org := nullif(current_setting('app.current_org_id', true), '')::uuid;
  IF bound_org IS NULL OR bound_org <> requested_org THEN
    RAISE EXCEPTION 'tenant context does not match requested organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles r ON r.org_id = u.org_id AND r.user_id = u.id
    WHERE u.org_id = requested_org AND u.id = requested_actor AND r.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'actor is not an administrator in the requested organisation' USING ERRCODE = '42501';
  END IF;
  clean_reason := btrim(requested_reason);
  IF clean_reason = '' OR length(clean_reason) > 400 OR clean_reason ~ E'[\r\n]' THEN
    RAISE EXCEPTION 'reason must be one line between 1 and 400 characters' USING ERRCODE = '22023';
  END IF;

  SELECT f.* INTO current_flag
  FROM public.feature_flags f
  WHERE f.flag_key = requested_key
    AND ((requested_scope = 'global' AND f.scope = 'global' AND f.org_id IS NULL)
      OR (requested_scope = 'org' AND f.scope = 'org' AND f.org_id = requested_org))
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'flag is not provisioned or key is outside the closed vocabulary' USING ERRCODE = '22023';
  END IF;

  IF requested_scope = 'global' THEN
    UPDATE public.feature_flags f
    SET enabled = requested_enabled, updated_by = safe_actor
    WHERE f.id = current_flag.id;
  ELSE
    UPDATE public.feature_flags f
    SET enabled = requested_enabled, updated_by = requested_actor, updated_at = now()
    WHERE f.id = current_flag.id;
  END IF;

  INSERT INTO public.flag_changes (flag_id, flag_key, scope, org_id, actor_id, old_enabled, new_enabled, reason)
  VALUES (current_flag.id, requested_key, requested_scope, requested_org, requested_actor, current_flag.enabled, requested_enabled, clean_reason);
  INSERT INTO public.audit_events (actor, action, target, org_id, outcome, reason, request_id)
  VALUES (
    'user:' || requested_actor::text,
    'flag.changed',
    'flag:' || requested_key,
    requested_org,
    'allowed',
    format('old=%s; new=%s; %s', current_flag.enabled, requested_enabled, clean_reason),
    requested_request_id
  );

  RETURN QUERY SELECT requested_key, requested_enabled, requested_scope,
    CASE WHEN requested_scope = 'global' THEN safe_actor ELSE requested_actor END;
END;
$$;
REVOKE ALL ON FUNCTION public.set_feature_flag(uuid, uuid, flag_scope, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_feature_flag(uuid, uuid, flag_scope, text, boolean, text, text) TO seniorsocial_app;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_events FORCE ROW LEVEL SECURITY;
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE flag_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_org_isolation ON audit_events USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY ai_events_org_isolation ON ai_events USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY feature_flags_org_isolation ON feature_flags USING (scope = 'global' OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (scope = 'global' OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY flag_changes_org_isolation ON flag_changes USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT ON feature_flag_environment TO seniorsocial_app;
GRANT SELECT, INSERT ON audit_events, ai_events TO seniorsocial_app;
GRANT SELECT ON flag_changes, feature_flags TO seniorsocial_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, ai_events, flag_changes FROM seniorsocial_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON flag_changes, feature_flags FROM seniorsocial_app;
