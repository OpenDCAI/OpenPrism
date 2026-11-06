#!/bin/sh
# Creates (or re-credentials) the app's Postgres role and database on the hosted server. Idempotent.
# Root connection comes from the standard PG* variables; the app's from APP_DB_USER / APP_DB_NAME / APP_DB_PASSWORD.
set -eu
: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${APP_DB_USER:?}" "${APP_DB_NAME:?}" "${APP_DB_PASSWORD:?}"
export PGPORT="${PGPORT:-5432}"

psql -v ON_ERROR_STOP=1 -X -q -d postgres \
  -v app_user="$APP_DB_USER" -v app_db="$APP_DB_NAME" -v app_pw="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
-- Always set the password: the bootstrap only runs while the credentials Secret does not exist yet.
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_user', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec
-- Nobody but the owner (and superusers) may connect to the app's database.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_db') \gexec
SQL

# psql only expands :'var' in SQL read from stdin, not in -c.
owner=$(psql -X -At -d postgres -v app_db="$APP_DB_NAME" <<'SQL'
SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'app_db';
SQL
)
if [ "$owner" != "$APP_DB_USER" ]; then
  echo "database $APP_DB_NAME already exists and is owned by '$owner', not '$APP_DB_USER'; refusing to take it over" >&2
  exit 1
fi
echo "postgres: role $APP_DB_USER and database $APP_DB_NAME ready"
