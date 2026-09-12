CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'auth.signed_in','auth.signed_out','auth.code_requested','auth.demo_code_used','consent.granted','consent.revoked','consent.read_back_confirmed',
  'caregiver.invited','caregiver.accepted','caregiver.acted','caregiver.denied','ride.created','ride.transitioned','ride.send_failed',
  'assistance.opened','assistance.owned','assistance.transitioned','assistance.sla_breached','moderation.flagged','moderation.decided',
  'content.updated','service.updated','partner.updated','translation.approved','translation.invalidated','notification.preferences_changed',
  'notification.queued','notification.attempted','notification.suppressed','user.role_changed','user.held_for_review','flag.changed',
  'export.created','export.downloaded','ai.recommended','ai.refused','ai.killed','demo.reset'
));

CREATE FUNCTION seniorsocial_reset_demo(requested_org uuid, requested_actor uuid, requested_version text, requested_pepper text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  demo_org constant uuid := '11111111-1111-4111-8111-111111111111';
  expected_version constant text := 'wp-034.v1';
  counts jsonb;
  table_name text;
BEGIN
  IF requested_org IS DISTINCT FROM demo_org OR nullif(current_setting('app.current_org_id',true),'')::uuid IS DISTINCT FROM requested_org THEN
    RAISE EXCEPTION 'not found' USING ERRCODE='42501';
  END IF;
  IF requested_actor IS NULL OR nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM requested_actor THEN
    RAISE EXCEPTION 'not found' USING ERRCODE='42501';
  END IF;
  IF requested_version IS DISTINCT FROM expected_version OR coalesce(length(requested_pepper),0) < 16 THEN RAISE EXCEPTION 'invalid demo reset request'; END IF;
  -- Serialize before reading authority; another reset must not invalidate that read.
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text,34));
  IF NOT EXISTS (SELECT 1 FROM users u JOIN user_roles r ON r.org_id=u.org_id AND r.user_id=u.id
    WHERE u.org_id=requested_org AND u.id=requested_actor AND u.is_demo AND u.account_state='active' AND r.role='admin') THEN
    IF requested_actor <> '34000000-0000-4000-8000-000000000006'::uuid
      OR EXISTS (SELECT 1 FROM users WHERE org_id=requested_org AND id=requested_actor) THEN
      RAISE EXCEPTION 'not found' USING ERRCODE='42501';
    END IF;
  END IF;

  -- Reset is a maintenance-owner operation. Disable user history guards only
  -- inside this transaction; rollback restores every trigger automatically.
  FOREACH table_name IN ARRAY ARRAY[
    'admin_mutations','ai_cache','ai_cost_attempts','ai_cost_caps','ai_cost_reservations','ai_events','ai_org_cost_caps','ai_rate_limit_observations',
    'announcements','assistance_requests','assistance_transitions','audit_events','auth_rate_limits','blocks','caregiver_invitations','caregiver_links',
    'consent_grants','consent_read_backs','consent_scopes','content_pages','demo_accounts','event_proposals','event_reminder_intents','event_rsvps','events',
    'faqs','feature_flags','flag_changes','forum_posts','forum_replies','forum_topics','intake_mutations','intake_submissions','messaging_conversations',
    'messaging_messages','messaging_report_keys','messaging_reports','moderation_items','notification_attempts','notification_audit_pending','notification_inbox',
    'notification_outbox','notification_preferences','partners','policy_decisions','print_jobs','print_requests','profiles','recovery_contacts','reports',
    'ride_accessibility_conditions','ride_requests','ride_transitions','service_accessibility','service_categories','service_embeddings','service_imports',
    'service_languages','services','sessions','sla_clocks','translation_drafts','translation_events','translation_qualified_reviewers',
    'translation_reviewer_events','translation_sources','user_roles','users','verification_tokens'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER',table_name);
  END LOOP;

  DELETE FROM translation_events WHERE org_id=requested_org; DELETE FROM translation_reviewer_events WHERE org_id=requested_org;
  DELETE FROM translation_drafts WHERE org_id=requested_org; DELETE FROM translation_qualified_reviewers WHERE org_id=requested_org; DELETE FROM translation_sources WHERE org_id=requested_org;
  DELETE FROM moderation_items WHERE org_id=requested_org; DELETE FROM reports WHERE org_id=requested_org; DELETE FROM forum_replies WHERE org_id=requested_org;
  DELETE FROM forum_posts WHERE org_id=requested_org; DELETE FROM forum_topics WHERE org_id=requested_org; DELETE FROM blocks WHERE org_id=requested_org;
  DELETE FROM messaging_report_keys WHERE org_id=requested_org; DELETE FROM messaging_reports WHERE org_id=requested_org;
  DELETE FROM messaging_messages WHERE org_id=requested_org; DELETE FROM messaging_conversations WHERE org_id=requested_org;
  DELETE FROM consent_scopes WHERE org_id=requested_org; DELETE FROM consent_read_backs WHERE org_id=requested_org;
  DELETE FROM consent_grants WHERE org_id=requested_org; DELETE FROM caregiver_invitations WHERE org_id=requested_org; DELETE FROM caregiver_links WHERE org_id=requested_org;
  DELETE FROM intake_mutations WHERE org_id=requested_org; DELETE FROM intake_submissions WHERE org_id=requested_org;
  DELETE FROM ride_transitions WHERE org_id=requested_org; DELETE FROM ride_accessibility_conditions WHERE org_id=requested_org; DELETE FROM ride_requests WHERE org_id=requested_org;
  DELETE FROM sla_clocks WHERE org_id=requested_org; DELETE FROM assistance_transitions WHERE org_id=requested_org; DELETE FROM assistance_requests WHERE org_id=requested_org;
  DELETE FROM event_reminder_intents WHERE org_id=requested_org; DELETE FROM event_rsvps WHERE org_id=requested_org; DELETE FROM events WHERE org_id=requested_org; DELETE FROM event_proposals WHERE org_id=requested_org;
  DELETE FROM admin_mutations WHERE org_id=requested_org; DELETE FROM announcements WHERE org_id=requested_org; DELETE FROM faqs WHERE org_id=requested_org; DELETE FROM content_pages WHERE org_id=requested_org;
  DELETE FROM notification_attempts WHERE org_id=requested_org; DELETE FROM notification_outbox WHERE org_id=requested_org; DELETE FROM notification_audit_pending WHERE org_id=requested_org;
  DELETE FROM notification_inbox WHERE org_id=requested_org; DELETE FROM print_jobs WHERE org_id=requested_org; DELETE FROM print_requests WHERE org_id=requested_org;
  DELETE FROM notification_preferences WHERE org_id=requested_org;
  DELETE FROM service_embeddings WHERE org_id=requested_org; DELETE FROM service_accessibility WHERE org_id=requested_org; DELETE FROM service_languages WHERE org_id=requested_org;
  DELETE FROM services WHERE org_id=requested_org; DELETE FROM service_imports WHERE org_id=requested_org;
  DELETE FROM policy_decisions WHERE org_id=requested_org;
  DELETE FROM audit_events WHERE org_id=requested_org; DELETE FROM ai_cost_attempts WHERE org_id=requested_org; DELETE FROM ai_events WHERE org_id=requested_org;
  DELETE FROM ai_cost_reservations WHERE org_id=requested_org; DELETE FROM ai_rate_limit_observations WHERE org_id=requested_org;
  DELETE FROM ai_cache WHERE org_id=requested_org; DELETE FROM ai_org_cost_caps WHERE org_id=requested_org; DELETE FROM ai_cost_caps WHERE org_id=requested_org;
  DELETE FROM flag_changes WHERE org_id=requested_org; DELETE FROM feature_flags WHERE org_id=requested_org;
  DELETE FROM demo_accounts WHERE org_id=requested_org; DELETE FROM sessions WHERE org_id=requested_org;
  DELETE FROM verification_tokens WHERE org_id=requested_org; DELETE FROM recovery_contacts WHERE org_id=requested_org; DELETE FROM auth_rate_limits WHERE org_id=requested_org;
  DELETE FROM partners WHERE org_id=requested_org; DELETE FROM service_categories WHERE org_id=requested_org;
  DELETE FROM profiles WHERE org_id=requested_org; DELETE FROM user_roles WHERE org_id=requested_org; DELETE FROM users WHERE org_id=requested_org;

  FOREACH table_name IN ARRAY ARRAY[
    'admin_mutations','ai_cache','ai_cost_attempts','ai_cost_caps','ai_cost_reservations','ai_events','ai_org_cost_caps','ai_rate_limit_observations',
    'announcements','assistance_requests','assistance_transitions','audit_events','auth_rate_limits','blocks','caregiver_invitations','caregiver_links',
    'consent_grants','consent_read_backs','consent_scopes','content_pages','demo_accounts','event_proposals','event_reminder_intents','event_rsvps','events',
    'faqs','feature_flags','flag_changes','forum_posts','forum_replies','forum_topics','intake_mutations','intake_submissions','messaging_conversations',
    'messaging_messages','messaging_report_keys','messaging_reports','moderation_items','notification_attempts','notification_audit_pending','notification_inbox',
    'notification_outbox','notification_preferences','partners','policy_decisions','print_jobs','print_requests','profiles','recovery_contacts','reports',
    'ride_accessibility_conditions','ride_requests','ride_transitions','service_accessibility','service_categories','service_embeddings','service_imports',
    'service_languages','services','sessions','sla_clocks','translation_drafts','translation_events','translation_qualified_reviewers',
    'translation_reviewer_events','translation_sources','user_roles','users','verification_tokens'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER',table_name);
  END LOOP;

  UPDATE orgs SET name='[SYNTHETIC] Maple Harbor Demo',slug='maple-harbor',locale_default='en',timezone='America/New_York' WHERE id=requested_org;
  INSERT INTO users(id,org_id,display_name,email,phone,is_demo,locale,mode) VALUES
    ('34000000-0000-4000-8000-000000000001',requested_org,'[SYNTHETIC] Avery Example','senior.demo@example.invalid',NULL,true,'en','easy'),
    ('34000000-0000-4000-8000-000000000002',requested_org,'[SYNTHETIC] Casey Example','caregiver.demo@example.invalid',NULL,true,'en','standard'),
    ('34000000-0000-4000-8000-000000000003',requested_org,'[SYNTHETIC] Jordan Example','staff.demo@example.invalid',NULL,true,'en','standard'),
    ('34000000-0000-4000-8000-000000000004',requested_org,'[SYNTHETIC] Morgan Example','partner.demo@example.invalid',NULL,true,'en','standard'),
    ('34000000-0000-4000-8000-000000000005',requested_org,'[SYNTHETIC] Riley Example','support.demo@example.invalid',NULL,true,'es','standard'),
    ('34000000-0000-4000-8000-000000000006',requested_org,'[SYNTHETIC] Taylor Example','admin.demo@example.invalid',NULL,true,'en','standard');
  INSERT INTO user_roles(org_id,user_id,role) VALUES
    (requested_org,'34000000-0000-4000-8000-000000000001','senior'),(requested_org,'34000000-0000-4000-8000-000000000002','caregiver'),
    (requested_org,'34000000-0000-4000-8000-000000000003','staff'),(requested_org,'34000000-0000-4000-8000-000000000004','partner'),
    (requested_org,'34000000-0000-4000-8000-000000000005','support'),(requested_org,'34000000-0000-4000-8000-000000000006','admin');
  INSERT INTO profiles(id,org_id,user_id,preferred_name,contact_email,contact_phone) SELECT
    ('34000000-0000-4000-8000-'||right(id::text,12))::uuid,org_id,id,display_name,email,NULL FROM users WHERE org_id=requested_org;
  INSERT INTO notification_preferences(org_id,user_id,preferences) SELECT requested_org,id,'{"outbound":"disabled","email":false,"sms":false,"voice":false}'::jsonb FROM users WHERE org_id=requested_org;
  PERFORM seed_org_flags(requested_org);
  INSERT INTO demo_accounts(id,org_id,user_id,code_digest,expires_at) SELECT uuid_generate_v4(),requested_org,v.user_id,
    encode(digest(convert_to(requested_pepper,'UTF8')||decode('00','hex')||convert_to(v.code,'UTF8'),'sha256'),'hex'),'2099-01-01T00:00:00Z'::timestamptz FROM (VALUES
    ('34000000-0000-4000-8000-000000000001'::uuid,'DEMO-SENIOR'),('34000000-0000-4000-8000-000000000002'::uuid,'DEMO-CAREGIVER'),
    ('34000000-0000-4000-8000-000000000003'::uuid,'DEMO-STAFF'),('34000000-0000-4000-8000-000000000004'::uuid,'DEMO-PARTNER'),
    ('34000000-0000-4000-8000-000000000005'::uuid,'DEMO-SUPPORT'),('34000000-0000-4000-8000-000000000006'::uuid,'DEMO-ADMIN')) v(user_id,code);

  INSERT INTO service_categories(id,org_id,slug,label_en,label_es,created_at,updated_at) VALUES
    ('34000000-0000-4000-8900-000000000001',requested_org,'synthetic-demo-support','[SYNTHETIC] Demo support','[SYNTHETIC] Apoyo de demostración','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z');
  INSERT INTO partners(id,org_id,name,categories,contact,created_at,updated_at) VALUES
    ('34000000-0000-4000-8900-000000000002',requested_org,'[SYNTHETIC] Example Community Partner',ARRAY['synthetic-demo-support'],
      '{"value":"[SYNTHETIC] No outbound contact","outboundDisabled":true}'::jsonb,'2026-09-01T12:00:00Z','2026-09-01T12:00:00Z');
  INSERT INTO services(id,org_id,external_id,category_id,name_en,name_es,description_en,description_es,eligibility_note_en,eligibility_note_es,phone,source_updated_at,publication_state,reviewed_by,reviewed_at,created_at,updated_at) VALUES
    ('34000000-0000-4000-8900-000000000003',requested_org,'synthetic-demo-service-v1','34000000-0000-4000-8900-000000000001',
      '[SYNTHETIC] Example support service','[SYNTHETIC] Servicio de apoyo de ejemplo','Synthetic reviewer fixture only.','Solo una prueba sintética.',
      'No eligibility determination.','No determina elegibilidad.','','2026-09-01T12:00:00Z','published','34000000-0000-4000-8000-000000000003','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z');

  INSERT INTO events(id,org_id,title,starts_at,time_zone,location,capacity,accessibility,published_at,created_by,created_at)
    SELECT ('34000000-0000-4000-8100-'||lpad(day::text,12,'0'))::uuid,requested_org,'[SYNTHETIC] Demo activity '||day,
      '2026-09-14T14:00:00Z'::timestamptz+(day-1)*interval '1 day','America/New_York','[SYNTHETIC] Maple Harbor Community Room',20,ARRAY['step-free'],
      '2026-09-01T12:00:00Z','34000000-0000-4000-8000-000000000003','2026-09-01T12:00:00Z' FROM generate_series(1,7) day;
  -- The maintenance wrapper seeds assistance after this function returns, in
  -- the same transaction. Keeping encryption outside SQL prevents the reset
  -- function from ever receiving the assistance encryption key.
  INSERT INTO ride_requests(id,org_id,resident_id,requested_by_actor_id,purpose,mode,pickup_at,pickup_tz,pickup_location,destination_location,return_needed,idempotency_key,request_hash,created_at)
    VALUES('34000000-0000-4000-8300-000000000001',requested_org,'34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','[SYNTHETIC] Demo grocery trip','partner_van','2026-09-15T14:00:00Z','America/New_York','[SYNTHETIC] Demo residence','[SYNTHETIC] Demo market',true,'demo-ride-v1',repeat('3',64),'2026-09-11T14:05:00Z');
  INSERT INTO ride_transitions(id,org_id,ride_id,actor_id,from_state,to_state,at,reason,idempotency_key,request_hash) VALUES
    ('34000000-0000-4000-8300-000000000002',requested_org,'34000000-0000-4000-8300-000000000001','34000000-0000-4000-8000-000000000001','draft','requested','2026-09-11T14:05:00Z','synthetic_demo_request','demo-ride-transition-v1',repeat('4',64));
  INSERT INTO forum_topics(id,org_id,created_by,title,sort_order,created_at) VALUES('34000000-0000-4000-8400-000000000001',requested_org,'34000000-0000-4000-8000-000000000003','[SYNTHETIC] Demo neighbors',1,'2026-09-11T14:10:00Z');
  INSERT INTO forum_posts(id,org_id,topic_id,author_id,body,flag_state,created_at) VALUES('34000000-0000-4000-8400-000000000002',requested_org,'34000000-0000-4000-8400-000000000001','34000000-0000-4000-8000-000000000001','[SYNTHETIC] Demo post for moderation.','flagged_awaiting_human','2026-09-11T14:11:00Z');
  INSERT INTO reports(id,org_id,reporter_id,target_type,target_id,reason,note,created_at) VALUES('34000000-0000-4000-8400-000000000003',requested_org,'34000000-0000-4000-8000-000000000002','post','34000000-0000-4000-8400-000000000002','synthetic_demo','[SYNTHETIC] Reviewer queue fixture','2026-09-11T14:12:00Z');
  INSERT INTO moderation_items(id,org_id,source,target_type,target_id,report_id,created_at) VALUES('34000000-0000-4000-8400-000000000004',requested_org,'user_report','post','34000000-0000-4000-8400-000000000002','34000000-0000-4000-8400-000000000003','2026-09-11T14:12:00Z');
  INSERT INTO translation_sources(id,org_id,resource_key,source_text,source_hash,source_version,critical,updated_by,updated_at) VALUES
    ('34000000-0000-4000-8500-000000000001',requested_org,'demo.welcome','Welcome to the synthetic demo',encode(digest(convert_to('Welcome to the synthetic demo','UTF8'),'sha256'),'hex'),1,false,'34000000-0000-4000-8000-000000000003','2026-09-11T14:15:00Z');
  INSERT INTO translation_drafts(id,org_id,source_id,source_hash,source_version,translated_text,provenance,machine_generated,status,created_by,created_at) SELECT
    '34000000-0000-4000-8500-000000000002',requested_org,id,source_hash,1,'Bienvenido a la demostración sintética','manual',false,'awaiting_review','34000000-0000-4000-8000-000000000003','2026-09-11T14:16:00Z' FROM translation_sources WHERE org_id=requested_org AND resource_key='demo.welcome';
  INSERT INTO content_pages(id,org_id,slug,version,critical,updated_by,updated_at) VALUES('34000000-0000-4000-8600-000000000001',requested_org,'synthetic-demo-welcome',1,false,'34000000-0000-4000-8000-000000000006','2026-09-11T14:20:00Z');
  INSERT INTO faqs(id,org_id,question,answer,version,updated_by,updated_at) VALUES('34000000-0000-4000-8600-000000000002',requested_org,'Is this real contact information?','No. Every identity and location is synthetic and outbound delivery is disabled.',1,'34000000-0000-4000-8000-000000000006','2026-09-11T14:20:00Z');
  INSERT INTO announcements(id,org_id,title,publish_at,version,updated_by,updated_at) VALUES('34000000-0000-4000-8600-000000000003',requested_org,'[SYNTHETIC] Demo week is ready','2026-09-11T14:20:00Z',1,'34000000-0000-4000-8000-000000000006','2026-09-11T14:20:00Z');
  INSERT INTO audit_events(id,actor,action,target,org_id,at,outcome,reason,fields) VALUES('34000000-0000-4000-8700-000000000001','system:demo_reset','demo.reset','demo_fixture:wp-034.v1',requested_org,statement_timestamp(),'allowed','versioned synthetic fixture restored',ARRAY[]::text[]);

  SELECT jsonb_build_object('users',(SELECT count(*) FROM users WHERE org_id=requested_org),'demo_accounts',(SELECT count(*) FROM demo_accounts WHERE org_id=requested_org),
    'events',(SELECT count(*) FROM events WHERE org_id=requested_org),'assistance_requests',(SELECT count(*) FROM assistance_requests WHERE org_id=requested_org),
    'ride_requests',(SELECT count(*) FROM ride_requests WHERE org_id=requested_org),'moderation_items',(SELECT count(*) FROM moderation_items WHERE org_id=requested_org),
    'translation_drafts',(SELECT count(*) FROM translation_drafts WHERE org_id=requested_org),'content_pages',(SELECT count(*) FROM content_pages WHERE org_id=requested_org),
    'faqs',(SELECT count(*) FROM faqs WHERE org_id=requested_org),'announcements',(SELECT count(*) FROM announcements WHERE org_id=requested_org),
    'service_categories',(SELECT count(*) FROM service_categories WHERE org_id=requested_org),'partners',(SELECT count(*) FROM partners WHERE org_id=requested_org),
    'services',(SELECT count(*) FROM services WHERE org_id=requested_org),'policy_decisions',(SELECT count(*) FROM policy_decisions WHERE org_id=requested_org),
    'notification_outbox',(SELECT count(*) FROM notification_outbox WHERE org_id=requested_org)) INTO counts;
  RETURN jsonb_build_object('fixture_version',expected_version,'counts',counts);
END $$;

REVOKE ALL ON FUNCTION seniorsocial_reset_demo(uuid,uuid,text,text) FROM PUBLIC;
-- Only the migration/maintenance owner may execute, including cold bootstrap.
-- Runtime can set actor GUCs and must never acquire this destructive authority.
REVOKE ALL ON FUNCTION seniorsocial_reset_demo(uuid,uuid,text,text) FROM seniorsocial_app;
