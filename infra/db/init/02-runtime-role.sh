#!/bin/sh
set -eu

if [ -z "${SENIORSOCIAL_RUNTIME_DB_PASSWORD:-}" ]; then
  echo "SENIORSOCIAL_RUNTIME_DB_PASSWORD is required" >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=runtime_password="$SENIORSOCIAL_RUNTIME_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE seniorsocial_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS',
  :'runtime_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'seniorsocial_runtime'
) \gexec
SQL
