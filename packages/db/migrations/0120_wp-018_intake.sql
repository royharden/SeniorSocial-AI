CREATE FUNCTION wp018_guard_intake_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'only draft intake submissions may be updated';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.resident_id <> OLD.resident_id
    OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'intake submission identity is immutable';
  END IF;
  IF NEW.state NOT IN ('draft','routed') THEN
    RAISE EXCEPTION 'unsupported intake transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE intake_submissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resident_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('legal','health')),
  answers_ciphertext bytea NOT NULL CHECK (octet_length(answers_ciphertext) <= 20000),
  answers_iv bytea NOT NULL CHECK (octet_length(answers_iv) = 12),
  answers_tag bytea NOT NULL CHECK (octet_length(answers_tag) = 16),
  locale text NOT NULL CHECK (locale IN ('en','es')),
  disclaimer_acknowledged boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','routed','closed')),
  routed_category_id uuid,
  route_reason_code text CHECK (route_reason_code IS NULL OR route_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,resident_id) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,routed_category_id) REFERENCES service_categories(org_id,id),
  CHECK ((state = 'draft' AND routed_category_id IS NULL AND route_reason_code IS NULL)
    OR (state IN ('routed','closed') AND disclaimer_acknowledged AND routed_category_id IS NOT NULL AND route_reason_code IS NOT NULL))
);
CREATE INDEX intake_submissions_resident_updated_idx ON intake_submissions (org_id,resident_id,updated_at DESC,id);
CREATE INDEX intake_submissions_route_idx ON intake_submissions (org_id,routed_category_id,state);
CREATE TRIGGER intake_submissions_guard_update BEFORE UPDATE ON intake_submissions
  FOR EACH ROW EXECUTE FUNCTION wp018_guard_intake_update();

CREATE TABLE intake_mutations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resident_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  mutation_scope text NOT NULL CHECK (length(mutation_scope) BETWEEN 1 AND 80),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (org_id,resident_id,mutation_scope,idempotency_key),
  FOREIGN KEY (org_id,resident_id) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,submission_id) REFERENCES intake_submissions(org_id,id) ON DELETE CASCADE
);

ALTER TABLE intake_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE intake_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_mutations FORCE ROW LEVEL SECURITY;

CREATE POLICY intake_submissions_select ON intake_submissions FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY intake_submissions_insert ON intake_submissions FOR INSERT
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY intake_submissions_update_drafts ON intake_submissions FOR UPDATE
  USING (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid AND state = 'draft')
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY intake_mutations_org_isolation ON intake_mutations
  USING (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id',true),'')::uuid);

GRANT SELECT,INSERT ON intake_submissions,intake_mutations TO seniorsocial_app;
GRANT UPDATE (answers_ciphertext,answers_iv,answers_tag,locale,disclaimer_acknowledged,state,routed_category_id,route_reason_code,updated_at)
  ON intake_submissions TO seniorsocial_app;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON intake_submissions,intake_mutations FROM seniorsocial_app;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'auth.signed_in','auth.signed_out','auth.code_requested','auth.demo_code_used',
  'consent.granted','consent.revoked','consent.read_back_confirmed',
  'caregiver.invited','caregiver.accepted','caregiver.acted','caregiver.denied',
  'ride.created','ride.transitioned','ride.send_failed','assistance.opened',
  'assistance.owned','assistance.transitioned','assistance.sla_breached',
  'moderation.flagged','moderation.decided','content.updated','service.updated',
  'partner.updated','intake.saved','intake.routed','intake.closed',
  'translation.approved','translation.invalidated',
  'notification.preferences_changed','notification.queued','notification.attempted','notification.suppressed',
  'user.role_changed','user.held_for_review','flag.changed','export.created',
  'export.downloaded','ai.recommended','ai.refused','ai.killed'
));
