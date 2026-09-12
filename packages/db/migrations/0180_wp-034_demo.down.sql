DROP FUNCTION IF EXISTS seniorsocial_reset_demo(uuid,uuid,text,text);
SELECT set_config('app.current_org_id','11111111-1111-4111-8111-111111111111',true);
ALTER TABLE audit_events DISABLE TRIGGER USER;
DELETE FROM audit_events WHERE action='demo.reset';
ALTER TABLE audit_events ENABLE TRIGGER USER;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'auth.signed_in','auth.signed_out','auth.code_requested','auth.demo_code_used','consent.granted','consent.revoked','consent.read_back_confirmed',
  'caregiver.invited','caregiver.accepted','caregiver.acted','caregiver.denied','ride.created','ride.transitioned','ride.send_failed',
  'assistance.opened','assistance.owned','assistance.transitioned','assistance.sla_breached','moderation.flagged','moderation.decided',
  'content.updated','service.updated','partner.updated','translation.approved','translation.invalidated','notification.preferences_changed',
  'notification.queued','notification.attempted','notification.suppressed','user.role_changed','user.held_for_review','flag.changed',
  'export.created','export.downloaded','ai.recommended','ai.refused','ai.killed'
));
