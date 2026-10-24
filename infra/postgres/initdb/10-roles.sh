#!/usr/bin/env bash
# Runs once, on an empty data directory, as the bootstrap superuser.
# Creates the migrator and the two runtime login roles from mounted secrets.
# Schema-level grants are applied by the migration command, not here.
set -Eeuo pipefail

for name in db_migrator_password db_api_password db_worker_password; do
  if [ ! -s "/run/secrets/${name}" ]; then
    echo "initdb: secret ${name} is missing or empty" >&2
    exit 1
  fi
done

# Passwords are read by psql itself (backtick \set) so they never appear in argv.
psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\set migrator_password `tr -d '\n' < /run/secrets/db_migrator_password`
\set api_password `tr -d '\n' < /run/secrets/db_api_password`
\set worker_password `tr -d '\n' < /run/secrets/db_worker_password`

CREATE ROLE sd_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE sd_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'api_password';
CREATE ROLE sd_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'worker_password';

-- Only these roles may connect, and only the migrator may create schemas.
-- TEMPORARY is withheld so runtime roles cannot create temporary tables either.
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO sd_migrator, sd_api, sd_worker;
GRANT CREATE ON DATABASE :"DBNAME" TO sd_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The maintenance databases are not for application roles.
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;
SQL
