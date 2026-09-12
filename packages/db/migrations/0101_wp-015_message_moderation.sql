CREATE INDEX messaging_reports_human_queue ON messaging_reports
  (org_id,uuid_generate_v5('7699a1f4-6b0f-4f69-8dc7-1da9236df15e'::uuid,id::text)) WHERE state='open';

CREATE POLICY human_reviewer_select ON messaging_reports FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles role
    WHERE role.org_id = messaging_reports.org_id
      AND role.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND role.role IN ('staff', 'admin'))
);
CREATE POLICY human_reviewer_decide ON messaging_reports FOR UPDATE USING (
  state = 'open' AND EXISTS (SELECT 1 FROM user_roles role
    WHERE role.org_id = messaging_reports.org_id
      AND role.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND role.role IN ('staff', 'admin'))
) WITH CHECK (
  state = 'decided' AND EXISTS (SELECT 1 FROM user_roles role
    WHERE role.org_id = messaging_reports.org_id
      AND role.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND role.role IN ('staff', 'admin'))
);

CREATE FUNCTION enforce_messaging_report_human_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_roles role
      WHERE role.org_id=OLD.org_id
        AND role.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
        AND role.role IN ('staff','admin'))
    OR OLD.state <> 'open' OR NEW.state <> 'decided'
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.note IS DISTINCT FROM OLD.note OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'messaging report permits only one human open-to-decided transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messaging_report_human_decision BEFORE UPDATE ON messaging_reports
FOR EACH ROW EXECUTE FUNCTION enforce_messaging_report_human_decision();

CREATE TABLE messaging_moderation_decisions (
  queue_id uuid NOT NULL,
  org_id uuid NOT NULL,
  report_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('keep','remove','warn')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason !~ E'[\r\n]'),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,queue_id),
  UNIQUE(org_id,report_id),
  FOREIGN KEY(org_id,report_id) REFERENCES messaging_reports(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,decided_by) REFERENCES users(org_id,id) ON DELETE RESTRICT
);
ALTER TABLE messaging_moderation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_moderation_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messaging_moderation_decisions AS RESTRICTIVE
  USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid)
  WITH CHECK(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY human_reviewer ON messaging_moderation_decisions
  USING(EXISTS(SELECT 1 FROM user_roles role WHERE role.org_id=messaging_moderation_decisions.org_id
    AND role.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role.role IN('staff','admin')))
  WITH CHECK(decided_by=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM user_roles role WHERE role.org_id=messaging_moderation_decisions.org_id
      AND role.user_id=decided_by AND role.role IN('staff','admin')));

CREATE FUNCTION enforce_safe_messaging_moderation_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE conversation uuid;
BEGIN
  SELECT report.conversation_id INTO conversation FROM messaging_reports report
    WHERE report.org_id=NEW.org_id AND report.id=NEW.report_id;
  IF NEW.org_id IS DISTINCT FROM nullif(current_setting('app.current_org_id',true),'')::uuid
    OR conversation IS NULL OR NEW.decided_by IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR NEW.queue_id IS DISTINCT FROM public.uuid_generate_v5('7699a1f4-6b0f-4f69-8dc7-1da9236df15e'::uuid,NEW.report_id::text)
    OR NOT EXISTS(SELECT 1 FROM user_roles role WHERE role.org_id=NEW.org_id AND role.user_id=NEW.decided_by
      AND role.role IN('staff','admin')) THEN
    RAISE EXCEPTION 'messaging moderation decision requires an authorized human';
  END IF;
  -- Literal full-value copy guard, not a semantic DLP classifier. Short native
  -- messages ("a", "%", "_") must not veto unrelated policy explanations.
  -- Bound inspected values by the rationale limit; the conversation index scopes
  -- message lookup. Arbitrary excerpts/paraphrases cannot be detected this way.
  IF EXISTS(SELECT 1 FROM (
      SELECT report.reason AS value,8 AS minimum FROM messaging_reports report WHERE report.org_id=NEW.org_id AND report.id=NEW.report_id
      UNION ALL SELECT report.note,8 FROM messaging_reports report WHERE report.org_id=NEW.org_id AND report.id=NEW.report_id
      UNION ALL SELECT message.body,8 FROM messaging_messages message WHERE message.org_id=NEW.org_id AND message.conversation_id=conversation AND length(message.body)<=500
      UNION ALL SELECT protected.value,3 FROM messaging_conversations c
        JOIN users u ON u.org_id=c.org_id AND u.id IN(c.participant_a,c.participant_b)
        CROSS JOIN LATERAL (VALUES(u.display_name),(u.email::text),(u.phone)) protected(value)
        WHERE c.org_id=NEW.org_id AND c.id=conversation
    ) sensitive WHERE length(sensitive.value)>0 AND
      (lower(NEW.reason)=lower(sensitive.value) OR
        (length(sensitive.value)>=sensitive.minimum AND strpos(lower(NEW.reason),lower(sensitive.value))>0))) THEN
    RAISE EXCEPTION 'moderation reason must name a rule without copying content';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_safe_messaging_moderation_reason() FROM PUBLIC;
CREATE TRIGGER safe_messaging_moderation_reason BEFORE INSERT ON messaging_moderation_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_safe_messaging_moderation_reason();

GRANT UPDATE (state) ON messaging_reports TO seniorsocial_app;
GRANT SELECT,INSERT ON messaging_moderation_decisions TO seniorsocial_app;
REVOKE UPDATE,DELETE,TRUNCATE ON messaging_moderation_decisions FROM seniorsocial_app;
