REVOKE UPDATE (state) ON messaging_reports FROM seniorsocial_app;
DROP INDEX IF EXISTS messaging_reports_human_queue;
DROP TRIGGER IF EXISTS safe_messaging_moderation_reason ON messaging_moderation_decisions;
DROP FUNCTION IF EXISTS enforce_safe_messaging_moderation_reason();
DROP TABLE IF EXISTS messaging_moderation_decisions;
DROP TRIGGER IF EXISTS messaging_report_human_decision ON messaging_reports;
DROP FUNCTION IF EXISTS enforce_messaging_report_human_decision();
DROP POLICY IF EXISTS human_reviewer_decide ON messaging_reports;
DROP POLICY IF EXISTS human_reviewer_select ON messaging_reports;
