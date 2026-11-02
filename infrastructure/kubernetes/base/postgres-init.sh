#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_user="$APP_DB_USER" \
  --set=app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
GRANT USAGE, CREATE ON SCHEMA public TO :"app_user";
SQL
