#!/bin/sh
# Deletes this project's development database volume and rebuilds it from
# scratch: init scripts, migrations and fixture seed. Touches only Compose
# project "supplier-disruption". Requires the volume name as confirmation.
set -eu

VOLUME="supplier-disruption_db-data"

if [ "${1:-}" != "--delete-volume=${VOLUME}" ]; then
  echo "This deletes all data in Docker volume ${VOLUME}." >&2
  echo "Confirm with: sh scripts/db-reset.sh --delete-volume=${VOLUME}" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
compose() {
  docker compose -p supplier-disruption -f compose.yaml -f compose.dev.yaml "$@"
}

# Remove the containers, then only the database volume; other volumes this
# project may gain later are kept.
compose down --remove-orphans
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  docker volume rm "$VOLUME"
fi
compose up --detach --wait db
node --env-file-if-exists=.env packages/db/dist/cli/migrate.js
node --env-file-if-exists=.env apps/api/dist/seed.js
