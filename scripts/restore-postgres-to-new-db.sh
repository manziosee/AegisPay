#!/usr/bin/env sh
set -eu

archive=${1:?Usage: restore-postgres-to-new-db.sh ARCHIVE.dump}
if [ ! -s "$archive" ]; then
  echo 'Backup archive does not exist or is empty.' >&2
  exit 1
fi
restore_db="aegispay_restore_$(date -u +%Y%m%d%H%M%S)"
docker compose exec -T postgres createdb -U aegispay_admin "$restore_db"
docker compose exec -T postgres pg_restore -U aegispay_admin -d "$restore_db" --exit-on-error < "$archive"
echo "Restored into a separate database: $restore_db"
echo 'This script leaves the active aegispay database unchanged.'
