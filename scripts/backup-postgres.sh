#!/usr/bin/env sh
set -eu

backup_dir=${1:-backups}
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
filename="$backup_dir/aegispay_$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$filename"
if [ ! -s "$filename" ]; then
  rm -f "$filename"
  echo 'Database backup was empty.' >&2
  exit 1
fi
chmod 600 "$filename"
echo "Created PostgreSQL archive: $filename"
