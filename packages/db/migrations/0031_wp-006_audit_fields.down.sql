ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_fields_bounded,
  DROP COLUMN IF EXISTS fields;
