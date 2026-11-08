#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory:   ./scripts/backup-all.sh
# Database dump + uploads archive. Suitable for cron (see docs/en/backups.md).
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/backup-db.sh
./scripts/backup-uploads.sh
