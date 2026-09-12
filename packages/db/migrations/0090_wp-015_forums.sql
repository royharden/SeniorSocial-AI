CREATE TABLE forum_topics (
  id uuid NOT NULL DEFAULT uuid_generate_v4(), org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  sort_order integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE forum_posts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(), org_id uuid NOT NULL, topic_id uuid NOT NULL, author_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000), flag_state text NOT NULL DEFAULT 'none'
    CHECK(flag_state IN('none','flagged_awaiting_human','cleared_by_human','removed_by_human')),
  visibility text NOT NULL DEFAULT 'visible' CHECK(visibility IN('visible','removed')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(org_id,id),
  FOREIGN KEY(org_id,topic_id) REFERENCES forum_topics(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,author_id) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
CREATE INDEX forum_posts_feed ON forum_posts(org_id,topic_id,created_at DESC,id DESC);
CREATE TABLE forum_replies (
  id uuid NOT NULL DEFAULT uuid_generate_v4(), org_id uuid NOT NULL, post_id uuid NOT NULL, author_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000), visibility text NOT NULL DEFAULT 'visible' CHECK(visibility IN('visible','removed')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(org_id,id),
  FOREIGN KEY(org_id,post_id) REFERENCES forum_posts(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,author_id) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE blocks (
  org_id uuid NOT NULL, blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,blocker_id,blocked_id), CHECK(blocker_id<>blocked_id),
  FOREIGN KEY(org_id,blocker_id) REFERENCES users(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,blocked_id) REFERENCES users(org_id,id) ON DELETE CASCADE
);
CREATE INDEX blocks_reverse ON blocks(org_id,blocked_id,blocker_id);
CREATE TABLE reports (
  id uuid NOT NULL DEFAULT uuid_generate_v4(), org_id uuid NOT NULL, reporter_id uuid NOT NULL,
  target_type text NOT NULL CHECK(target_type IN('post','reply','message')), target_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 100 AND reason !~ E'[\r\n]'), note text CHECK(note IS NULL OR length(note)<=2000),
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','decided')), created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,reporter_id) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE moderation_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(), org_id uuid NOT NULL, source text NOT NULL CHECK(source IN('ai_flag','user_report')),
  target_type text NOT NULL CHECK(target_type IN('post','reply','message')), target_id uuid NOT NULL,
  report_id uuid, ai_event_id uuid, decision text CHECK(decision IN('keep','remove','warn')), decision_reason text,
  decided_by uuid, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(org_id,id),
  FOREIGN KEY(org_id,report_id) REFERENCES reports(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,decided_by) REFERENCES users(org_id,id) ON DELETE RESTRICT,
  CHECK((source='user_report' AND report_id IS NOT NULL AND ai_event_id IS NULL) OR (source='ai_flag' AND ai_event_id IS NOT NULL AND report_id IS NULL)),
  CHECK((decision IS NULL AND decision_reason IS NULL AND decided_by IS NULL AND decided_at IS NULL) OR
        (decision IS NOT NULL AND length(decision_reason) BETWEEN 1 AND 500 AND decision_reason !~ E'[\r\n]' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX moderation_one_ai_flag ON moderation_items(org_id,target_type,target_id) WHERE source='ai_flag';
CREATE INDEX moderation_open_queue ON moderation_items(org_id,created_at,id) WHERE decision IS NULL;

CREATE FUNCTION enforce_human_moderation_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision IS NOT NULL AND OLD.decision IS NULL AND NOT EXISTS(
    SELECT 1 FROM user_roles WHERE org_id=NEW.org_id AND user_id=NEW.decided_by AND role IN('staff','admin')) THEN
    RAISE EXCEPTION 'moderation decision requires staff or admin';
  END IF;
  IF OLD.decision IS NOT NULL THEN RAISE EXCEPTION 'moderation decision is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_human_guard BEFORE UPDATE ON moderation_items FOR EACH ROW EXECUTE FUNCTION enforce_human_moderation_decision();

DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['forum_topics','forum_posts','forum_replies','blocks','reports','moderation_items'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id=nullif(current_setting(''app.current_org_id'',true),'''')::uuid) WITH CHECK (org_id=nullif(current_setting(''app.current_org_id'',true),'''')::uuid)',n);
END LOOP; END $$;
CREATE POLICY block_participant ON blocks AS RESTRICTIVE USING (
  nullif(current_setting('app.current_user_id',true),'')::uuid IN (blocker_id,blocked_id)
) WITH CHECK (blocker_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
GRANT SELECT ON forum_topics TO seniorsocial_app;
GRANT SELECT,INSERT,UPDATE(flag_state,visibility) ON forum_posts TO seniorsocial_app;
GRANT SELECT,INSERT,UPDATE(visibility) ON forum_replies TO seniorsocial_app;
GRANT SELECT,INSERT ON blocks TO seniorsocial_app;
GRANT SELECT,INSERT,UPDATE(state) ON reports TO seniorsocial_app;
GRANT SELECT,INSERT,UPDATE(decision,decision_reason,decided_by,decided_at) ON moderation_items TO seniorsocial_app;
