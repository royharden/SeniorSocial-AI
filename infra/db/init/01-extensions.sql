-- Runs once, on an empty data volume, before anything connects.
-- Schema itself is WP-003's (packages/db/migrations); this file only creates the
-- extensions a migration cannot create for itself without superuser rights.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
