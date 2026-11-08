#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory:
#   ./scripts/restore-db.sh backups/aidis-db-YYYYmmdd-HHMMSS.dump
#
# DESTRUCTIVE: replaces the CURRENT AIDis database contents with the dump.
# Safety steps performed automatically:
#   1. asks you to type RESTORE to confirm;
#   2. makes a fresh backup of the current database first;
#   3. stops ONLY the AIDis backend container while restoring (PostgreSQL keeps running);
#   4. restores inside a single transaction (all or nothing);
#   5. starts the backend again.
set -euo pipefail

cd "$(dirname "$0")/.."
dump="${1:-}"
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "Usage: $0 <path-to-aidis-db-*.dump>" >&2
  exit 1
fi

echo "This will REPLACE the current AIDis database with: $dump"
read -r -p "Type RESTORE to continue: " answer
if [ "$answer" != "RESTORE" ]; then
  echo "Aborted. Nothing was changed."
  exit 1
fi

echo "Step 1/4: safety backup of the current database"
./scripts/backup-db.sh

echo "Step 2/4: stopping the AIDis backend (other containers keep running)"
docker compose stop backend

restore_ok=0
echo "Step 3/4: restoring"
if docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < "$dump"; then
  restore_ok=1
fi

echo "Step 4/4: starting the AIDis backend"
docker compose start backend

if [ "$restore_ok" -ne 1 ]; then
  echo "ERROR: restore failed. The transaction was rolled back, the previous data is unchanged." >&2
  exit 1
fi
echo "Restore complete. Check: docker compose logs --tail=50 backend"
