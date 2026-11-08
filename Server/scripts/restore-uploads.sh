#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory:
#   ./scripts/restore-uploads.sh backups/aidis-uploads-YYYYmmdd-HHMMSS.tar.gz
#
# Extracts an uploads archive into the attachments volume. Files with the same name
# are overwritten; files that are not in the archive are left in place.
# A safety backup of the current uploads is taken first.
set -euo pipefail

cd "$(dirname "$0")/.."
archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: $0 <path-to-aidis-uploads-*.tar.gz>" >&2
  exit 1
fi

echo "This will restore attachments from: $archive"
read -r -p "Type RESTORE to continue: " answer
if [ "$answer" != "RESTORE" ]; then
  echo "Aborted. Nothing was changed."
  exit 1
fi

./scripts/backup-uploads.sh
docker compose exec -T backend tar -xzf - -C /app/storage < "$archive"
echo "Uploads restored."
