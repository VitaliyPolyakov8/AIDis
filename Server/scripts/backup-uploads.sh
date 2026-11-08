#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory:   ./scripts/backup-uploads.sh
#
# Archives the attachments volume while the backend keeps running.
# Output: backups/aidis-uploads-YYYYmmdd-HHMMSS.tar.gz
# Optional: BACKUP_KEEP_DAYS=30 also deletes aidis-uploads-*.tar.gz older than 30 days.
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
umask 077

timestamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/aidis-uploads-$timestamp.tar.gz"
tmp="$target.partial"

echo "Backing up uploads to $target ..."
docker compose exec -T backend tar -czf - -C /app/storage uploads > "$tmp"
if [ ! -s "$tmp" ]; then
  rm -f "$tmp"
  echo "ERROR: archive is empty; is the backend container running? (docker compose ps)" >&2
  exit 1
fi
mv "$tmp" "$target"
echo "Done: $target ($(du -h "$target" | cut -f1))"

if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'aidis-uploads-*.tar.gz' -mtime "+$BACKUP_KEEP_DAYS" -print -delete
fi
