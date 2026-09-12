DROP TABLE IF EXISTS notification_audit_pending;
DROP TABLE IF EXISTS notification_attempts;
DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS notification_preferences;
DROP FUNCTION IF EXISTS notification_audit_constrained();
DROP FUNCTION IF EXISTS notification_outbox_constrained();
DROP FUNCTION IF EXISTS notification_attempt_immutable();
DROP FUNCTION IF EXISTS notification_delivery_evidence();
