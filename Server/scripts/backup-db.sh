#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory:   ./scripts/backup-db.sh
#
# Creates a consistent PostgreSQL dump (pg_dump custom format) while everything keeps
# running. Nothing is stopped. Output: backups/aidis-db-YYYYmmdd-HHMMSS.dump
#
# Optional: BACKUP_KEEP_DAYS=30 ./scripts/backup-db.sh  also deletes AIDis DB dumps in
# backups/ older than 30 days (only files named aidis-db-*.dump).
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
umask 077

timestamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/aidis-db-$timestamp.dump"
tmp="$target.partial"

echo "Backing up database to $target ..."
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$tmp"

if [ ! -s "$tmp" ]; then
  rm -f "$tmp"
  echo "ERROR: backup file is empty; is the postgres container running? (docker compose ps)" >&2
  exit 1
fi
mv "$tmp" "$target"
echo "Done: $target ($(du -h "$target" | cut -f1))"

if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then
  echo "Removing AIDis DB dumps older than $BACKUP_KEEP_DAYS days from $BACKUP_DIR"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'aidis-db-*.dump' -mtime "+$BACKUP_KEEP_DAYS" -print -delete
fi
