ALTER TABLE audit_events
  ADD COLUMN fields text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT audit_events_fields_bounded CHECK (
    cardinality(fields) <= 64
    AND array_position(fields, NULL) IS NULL
    AND (
      cardinality(fields) = 0
      OR array_to_string(fields, ',') ~ '^[a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63})*$'
    )
  );
