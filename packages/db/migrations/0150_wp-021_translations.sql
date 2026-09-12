CREATE TYPE translation_review_status AS ENUM ('draft', 'awaiting_review', 'approved', 'invalidated');
CREATE TYPE translation_draft_provenance AS ENUM ('manual', 'machine');
CREATE TYPE translation_event_kind AS ENUM ('source_updated', 'draft_created', 'approved', 'published', 'invalidated');
CREATE TYPE translation_reviewer_event_kind AS ENUM ('granted', 'revoked');
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE translation_sources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  source_text text NOT NULL CHECK (length(btrim(source_text)) > 0),
  source_hash char(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_version bigint NOT NULL DEFAULT 1 CHECK (source_version > 0),
  critical boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, resource_key),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES users(org_id, id)
);

-- This is a server-owned capability registry. Client-supplied reviewer claims
-- never enter the workflow functions.
CREATE TABLE translation_qualified_reviewers (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  qualification text NOT NULL CHECK (length(btrim(qualification)) > 0),
  granted_by uuid NOT NULL,
  grant_reason text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 500),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, granted_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, revoked_by) REFERENCES users(org_id, id),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(btrim(revocation_reason)) BETWEEN 1 AND 500))
);

CREATE TABLE translation_reviewer_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  event_type translation_reviewer_event_kind NOT NULL,
  actor_id uuid NOT NULL,
  qualification text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, reviewer_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id)
);

CREATE TABLE translation_drafts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_version bigint NOT NULL CHECK (source_version > 0),
  translated_text text NOT NULL CHECK (length(btrim(translated_text)) > 0),
  provenance translation_draft_provenance NOT NULL,
  machine_generated boolean NOT NULL,
  ai_event_id uuid,
  status translation_review_status NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewer_qualification text,
  reviewer_note text,
  reviewed_at timestamptz,
  published_by uuid,
  published_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES translation_sources(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, created_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, reviewed_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, published_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, ai_event_id) REFERENCES ai_events(org_id, id) ON DELETE RESTRICT,
  CHECK (machine_generated = (provenance = 'machine')),
  CHECK ((provenance = 'machine' AND ai_event_id IS NOT NULL) OR (provenance = 'manual' AND ai_event_id IS NULL)),
  CHECK ((status = 'approved' AND reviewed_by IS NOT NULL AND reviewer_qualification IS NOT NULL AND reviewer_note IS NOT NULL AND reviewed_at IS NOT NULL) OR status <> 'approved'),
  CHECK ((status = 'invalidated' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL) OR status <> 'invalidated'),
  CHECK ((published_at IS NULL AND published_by IS NULL) OR (published_at IS NOT NULL AND published_by IS NOT NULL AND status IN ('approved','invalidated')))
);
CREATE INDEX translation_drafts_history ON translation_drafts (org_id, source_id, created_at DESC);
CREATE UNIQUE INDEX translation_one_published_current ON translation_drafts (org_id, source_id) WHERE published_at IS NOT NULL AND status = 'approved';

CREATE TABLE translation_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  draft_id uuid,
  event_type translation_event_kind NOT NULL,
  actor_id uuid NOT NULL,
  from_source_version bigint,
  to_source_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, source_id) REFERENCES translation_sources(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, draft_id) REFERENCES translation_drafts(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id)
);
CREATE INDEX translation_events_history ON translation_events(org_id,source_id,occurred_at,id);

CREATE FUNCTION wp021_upsert_translation_source(requested_org uuid, requested_key text, requested_text text, requested_critical boolean, requested_actor uuid)
RETURNS SETOF translation_sources LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row translation_sources%ROWTYPE; canonical_hash char(64) := encode(digest(convert_to(requested_text,'UTF8'),'sha256'),'hex');
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role IN ('staff','admin')) THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text || ':' || requested_key, 21));
  SELECT * INTO row FROM translation_sources WHERE org_id=requested_org AND resource_key=requested_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO translation_sources(org_id,resource_key,source_text,source_hash,critical,updated_by)
      VALUES(requested_org,requested_key,requested_text,canonical_hash,requested_critical,requested_actor) RETURNING * INTO row;
    INSERT INTO translation_events(org_id,source_id,event_type,actor_id,to_source_version)
      VALUES(requested_org,row.id,'source_updated',requested_actor,row.source_version);
  ELSIF row.source_hash <> canonical_hash OR row.critical <> requested_critical THEN
    -- Invalidation and source replacement share this transaction and lock, so
    -- no stale approved Spanish row remains renderable after the source edit.
    INSERT INTO translation_events(org_id,source_id,draft_id,event_type,actor_id,from_source_version,to_source_version)
      SELECT requested_org,row.id,id,'invalidated',requested_actor,row.source_version,row.source_version+1
      FROM translation_drafts WHERE org_id=requested_org AND source_id=row.id AND status <> 'invalidated';
    INSERT INTO audit_events(actor,action,target,org_id,outcome,reason,fields)
      SELECT 'user:'||requested_actor::text,'translation.invalidated','translation:'||id::text,requested_org,'allowed',
        'source_changed:'||row.source_version::text||'->'||(row.source_version+1)::text,ARRAY['source_hash','source_version','status']
      FROM translation_drafts WHERE org_id=requested_org AND source_id=row.id AND status <> 'invalidated';
    UPDATE translation_drafts SET status='invalidated', invalidated_at=now(), invalidation_reason='source_changed'
      WHERE org_id=requested_org AND source_id=row.id AND status <> 'invalidated';
    UPDATE translation_sources SET source_text=requested_text,source_hash=canonical_hash,source_version=source_version+1,
      critical=requested_critical,updated_by=requested_actor,updated_at=now() WHERE org_id=requested_org AND id=row.id RETURNING * INTO row;
    INSERT INTO translation_events(org_id,source_id,event_type,actor_id,from_source_version,to_source_version)
      VALUES(requested_org,row.id,'source_updated',requested_actor,row.source_version-1,row.source_version);
  END IF;
  RETURN NEXT row;
END $$;

CREATE FUNCTION wp021_create_translation_draft(requested_org uuid, requested_source uuid, expected_hash char(64), expected_version bigint, requested_text text, requested_provenance translation_draft_provenance, requested_ai_event uuid, requested_actor uuid)
RETURNS SETOF translation_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result translation_drafts%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role IN ('staff','admin')) THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM translation_sources WHERE org_id=requested_org AND id=requested_source AND source_hash=expected_hash AND source_version=expected_version FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  IF requested_provenance='machine' AND (
    requested_ai_event IS NULL OR NOT EXISTS (
      SELECT 1 FROM ai_events WHERE org_id=requested_org AND id=requested_ai_event
        AND feature='translation_assist' AND outcome='ok' AND user_role IN ('staff','admin')
    )
  ) THEN RETURN; END IF;
  IF requested_provenance='manual' AND requested_ai_event IS NOT NULL THEN RETURN; END IF;
  INSERT INTO translation_drafts(org_id,source_id,source_hash,source_version,translated_text,provenance,machine_generated,ai_event_id,created_by)
    VALUES(requested_org,requested_source,expected_hash,expected_version,requested_text,requested_provenance,requested_provenance='machine',requested_ai_event,requested_actor)
    RETURNING * INTO result;
  INSERT INTO translation_events(org_id,source_id,draft_id,event_type,actor_id,to_source_version)
    VALUES(requested_org,requested_source,result.id,'draft_created',requested_actor,expected_version);
  RETURN NEXT result;
END $$;

CREATE FUNCTION wp021_approve_translation(requested_org uuid, requested_draft uuid, expected_hash char(64), expected_version bigint, requested_actor uuid, requested_note text)
RETURNS SETOF translation_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE capability text; result translation_drafts%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role IN ('staff','admin')) THEN RETURN; END IF;
  SELECT qualification INTO capability FROM translation_qualified_reviewers WHERE org_id=requested_org AND user_id=requested_actor AND revoked_at IS NULL;
  IF capability IS NULL THEN RETURN; END IF;
  UPDATE translation_drafts d SET status='approved',reviewed_by=requested_actor,reviewer_qualification=capability,reviewer_note=requested_note,reviewed_at=now()
    FROM translation_sources s WHERE d.org_id=requested_org AND d.id=requested_draft AND s.org_id=d.org_id AND s.id=d.source_id
      AND d.status IN ('draft','awaiting_review') AND d.source_hash=expected_hash AND d.source_version=expected_version
      AND s.source_hash=expected_hash AND s.source_version=expected_version RETURNING d.* INTO result;
  IF FOUND THEN
    INSERT INTO translation_events(org_id,source_id,draft_id,event_type,actor_id,to_source_version)
      VALUES(requested_org,result.source_id,result.id,'approved',requested_actor,expected_version);
    INSERT INTO audit_events(actor,action,target,org_id,outcome,reason,fields)
      VALUES('user:'||requested_actor::text,'translation.approved','translation:'||result.id::text,requested_org,'allowed',
        left('source_version='||expected_version::text||';'||requested_note,500),ARRAY['source_hash','source_version','status','reviewer_qualification']);
    RETURN NEXT result;
  END IF;
END $$;

CREATE FUNCTION wp021_grant_translation_reviewer(requested_org uuid, requested_reviewer uuid, requested_qualification text, requested_actor uuid, requested_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org OR
     NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role='admin') OR
     NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_reviewer AND role IN ('staff','admin'))
  THEN RETURN false; END IF;
  INSERT INTO translation_qualified_reviewers(org_id,user_id,qualification,granted_by,grant_reason,granted_at,revoked_by,revoked_at,revocation_reason)
    VALUES(requested_org,requested_reviewer,requested_qualification,requested_actor,requested_reason,now(),NULL,NULL,NULL)
    ON CONFLICT(org_id,user_id) DO UPDATE SET qualification=excluded.qualification,granted_by=excluded.granted_by,grant_reason=excluded.grant_reason,granted_at=now(),revoked_by=NULL,revoked_at=NULL,revocation_reason=NULL;
  INSERT INTO translation_reviewer_events(org_id,reviewer_id,event_type,actor_id,qualification,reason)
    VALUES(requested_org,requested_reviewer,'granted',requested_actor,requested_qualification,requested_reason);
  RETURN true;
END $$;

CREATE FUNCTION wp021_revoke_translation_reviewer(requested_org uuid, requested_reviewer uuid, requested_actor uuid, requested_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE capability text;
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org OR
     NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role='admin')
  THEN RETURN false; END IF;
  UPDATE translation_qualified_reviewers SET revoked_by=requested_actor,revoked_at=now(),revocation_reason=requested_reason
    WHERE org_id=requested_org AND user_id=requested_reviewer AND revoked_at IS NULL RETURNING qualification INTO capability;
  IF capability IS NULL THEN RETURN false; END IF;
  INSERT INTO translation_reviewer_events(org_id,reviewer_id,event_type,actor_id,qualification,reason)
    VALUES(requested_org,requested_reviewer,'revoked',requested_actor,capability,requested_reason);
  RETURN true;
END $$;

CREATE FUNCTION wp021_publish_translation(requested_org uuid, requested_draft uuid, expected_hash char(64), expected_version bigint, requested_actor uuid)
RETURNS SETOF translation_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result translation_drafts%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN RAISE EXCEPTION 'not found' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE org_id=requested_org AND user_id=requested_actor AND role IN ('staff','admin')) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM translation_qualified_reviewers WHERE org_id=requested_org AND user_id=requested_actor AND revoked_at IS NULL) THEN RETURN; END IF;
  PERFORM 1 FROM translation_sources WHERE org_id=requested_org AND source_hash=expected_hash AND source_version=expected_version
    AND id=(SELECT source_id FROM translation_drafts WHERE org_id=requested_org AND id=requested_draft) FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM translation_drafts WHERE org_id=requested_org
      AND source_id=(SELECT source_id FROM translation_drafts WHERE org_id=requested_org AND id=requested_draft)
      AND status='approved' AND published_at IS NOT NULL
  ) THEN RETURN; END IF;
  UPDATE translation_drafts SET published_by=requested_actor,published_at=now()
    WHERE org_id=requested_org AND id=requested_draft AND status='approved' AND published_at IS NULL
      AND source_hash=expected_hash AND source_version=expected_version AND reviewed_by IS NOT NULL AND reviewer_qualification IS NOT NULL
      RETURNING * INTO result;
  IF FOUND THEN
    INSERT INTO translation_events(org_id,source_id,draft_id,event_type,actor_id,to_source_version)
      VALUES(requested_org,result.source_id,result.id,'published',requested_actor,expected_version);
    RETURN NEXT result;
  END IF;
END $$;

CREATE VIEW current_published_translations WITH (security_invoker=true) AS
  SELECT s.org_id,s.resource_key,s.source_hash,s.source_version,d.translated_text,d.id AS draft_id,d.reviewed_by,d.reviewer_qualification,d.reviewed_at,d.published_at
  FROM translation_sources s JOIN translation_drafts d ON d.org_id=s.org_id AND d.source_id=s.id
  WHERE d.status='approved' AND d.published_at IS NOT NULL AND d.source_hash=s.source_hash AND d.source_version=s.source_version;

REVOKE ALL ON FUNCTION wp021_upsert_translation_source(uuid,text,text,boolean,uuid), wp021_create_translation_draft(uuid,uuid,char(64),bigint,text,translation_draft_provenance,uuid,uuid), wp021_approve_translation(uuid,uuid,char(64),bigint,uuid,text), wp021_publish_translation(uuid,uuid,char(64),bigint,uuid), wp021_grant_translation_reviewer(uuid,uuid,text,uuid,text), wp021_revoke_translation_reviewer(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wp021_upsert_translation_source(uuid,text,text,boolean,uuid), wp021_create_translation_draft(uuid,uuid,char(64),bigint,text,translation_draft_provenance,uuid,uuid), wp021_approve_translation(uuid,uuid,char(64),bigint,uuid,text), wp021_publish_translation(uuid,uuid,char(64),bigint,uuid) TO seniorsocial_app;

ALTER TABLE translation_sources ENABLE ROW LEVEL SECURITY; ALTER TABLE translation_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE translation_qualified_reviewers ENABLE ROW LEVEL SECURITY; ALTER TABLE translation_qualified_reviewers FORCE ROW LEVEL SECURITY;
ALTER TABLE translation_reviewer_events ENABLE ROW LEVEL SECURITY; ALTER TABLE translation_reviewer_events FORCE ROW LEVEL SECURITY;
ALTER TABLE translation_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE translation_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE translation_events ENABLE ROW LEVEL SECURITY; ALTER TABLE translation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY translation_sources_org ON translation_sources USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY translation_reviewers_org ON translation_qualified_reviewers USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY translation_reviewer_events_org ON translation_reviewer_events USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY translation_drafts_org ON translation_drafts USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY translation_events_org ON translation_events USING (org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
GRANT SELECT ON translation_sources,translation_qualified_reviewers,translation_reviewer_events,translation_drafts,translation_events TO seniorsocial_app;
GRANT SELECT ON current_published_translations TO seniorsocial_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON translation_sources,translation_qualified_reviewers,translation_drafts FROM seniorsocial_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON translation_reviewer_events FROM seniorsocial_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON translation_events FROM seniorsocial_app;
