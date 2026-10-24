#!/bin/sh
# Generates local development secrets under .secrets/ (gitignored).
# Existing files are never overwritten, and no secret value is printed.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dir="$root/.secrets"
umask 077
mkdir -p "$dir/host" "$dir/container"
# The 0644 files below rely on owner-only directories, including ones that an
# earlier run or a person created with looser modes.
chmod 700 "$dir" "$dir/host" "$dir/container"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# write NAME VALUE: creates .secrets/NAME only if it does not exist yet.
# Compose bind-mounts each secret file into a container, where a different
# user (postgres, or the app's UID 10001) must read it.
write() {
  path="$dir/$1"
  if [ -e "$path" ]; then
    echo "kept     .secrets/$1"
    return 0
  fi
  tmp="$path.tmp.$$"
  printf '%s\n' "$2" >"$tmp"
  # Readable inside containers; the .secrets directories stay owner-only.
  chmod 0644 "$tmp"
  # ln fails if the target appeared meanwhile, so a concurrent run cannot clobber it.
  if ln "$tmp" "$path" 2>/dev/null; then
    echo "created  .secrets/$1"
  else
    echo "kept     .secrets/$1"
  fi
  rm -f "$tmp"
}

read_secret() {
  tr -d '\n' <"$dir/$1"
}

for name in postgres_password db_migrator_password db_api_password db_worker_password \
  better_auth_secret worker_service_token fixture_buyer_password fixture_manager_password; do
  write "$name" "$(random_hex)"
done

# Host-side connection URLs for the loopback port published by compose.dev.yaml.
host_url() {
  echo "postgres://$1:$(read_secret "$2")@127.0.0.1:55102/supplier_disruption"
}
write host/database_url_migrator "$(host_url sd_migrator db_migrator_password)"
write host/database_url_api "$(host_url sd_api db_api_password)"
write host/database_url_worker "$(host_url sd_worker db_worker_password)"

# Connection URLs for the app image, which reaches the database by its Compose
# service name. Only the one-off init service mounts the migrator URL.
container_url() {
  echo "postgres://$1:$(read_secret "$2")@db:5432/supplier_disruption"
}
write container/database_url_migrator "$(container_url sd_migrator db_migrator_password)"
write container/database_url_api "$(container_url sd_api db_api_password)"
write container/database_url_worker "$(container_url sd_worker db_worker_password)"
