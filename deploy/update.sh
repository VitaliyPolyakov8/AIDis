#!/usr/bin/env bash
# Updates an AIDis installed with deploy/setup.sh to the newest version of this repository.
#
#   sudo bash /opt/aidis/deploy/update.sh             backup -> git pull -> build -> migrate -> restart
#   sudo bash /opt/aidis/deploy/update.sh --no-backup  skip the backup (not recommended)
#   sudo bash /opt/aidis/deploy/update.sh --rebuild    build and restart even when nothing new was pulled
#
# The running AIDis is replaced only after the new version is built and its database migrations
# succeeded. When a migration fails nothing is restarted and the script prints how to go back.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$REPO/deploy/lib/common.sh"

DIR="$REPO/Server"
BACKUP=1
REBUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-backup) BACKUP=0; shift ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "Run as root: sudo bash $0"
[ -f "$DIR/install.env" ] && [ -f "$DIR/.env" ] || die "No installation found in $DIR (install with deploy/setup.sh first)."
DOMAIN="$(env_get "$DIR/install.env" DOMAIN)"
WEB_DIR="$(env_get "$DIR/install.env" WEB_DIR)"
[ -n "$DOMAIN" ] && [ -n "$WEB_DIR" ] || die "$DIR/install.env is incomplete; run deploy/setup.sh again (it keeps your data and secrets)."
cd "$DIR"

if [ "$BACKUP" = 1 ]; then
  info "Backup of the database and uploads (Server/backups)"
  ./scripts/backup-all.sh || die "The backup failed, nothing was changed. Is AIDis running (docker compose ps)? Or run with --no-backup."
fi

OLD="$(git -C "$REPO" rev-parse HEAD)"
info "Getting the new version (git pull)"
git -C "$REPO" pull --ff-only || die "git pull failed (files changed by hand in $REPO?). Nothing was changed; see: git -C $REPO status"
NEW="$(git -C "$REPO" rev-parse HEAD)"
if [ "$OLD" = "$NEW" ] && [ "$REBUILD" = 0 ]; then
  info "Already the newest version ($(git -C "$REPO" log -1 --format=%h)). Nothing to do (--rebuild forces a rebuild)."
  exit 0
fi
info "Updating $(git -C "$REPO" log -1 --format=%h "$OLD") -> $(git -C "$REPO" log -1 --format=%h "$NEW")"

rollback_help() {
  echo
  echo "AIDis was NOT restarted: the old version keeps running. To go back to it completely:"
  echo "  git -C $REPO checkout $OLD"
  echo "  cd $DIR && docker compose build"
  echo "If the database was changed, restore the backup made a moment ago (newest file in $DIR/backups):"
  echo "  cd $DIR && ./scripts/restore-db.sh backups/<aidis-db-file>.dump"
}

build_web "$REPO" "$WEB_DIR.new"
info "Building the server"
docker compose pull --ignore-buildable || note "could not pull every image now; docker compose up pulls what is missing"
docker compose build

info "Database migrations"
if ! docker compose run --rm backend npx --no-install prisma migrate deploy; then
  rm -rf "$WEB_DIR.new"
  rollback_help
  die "A database migration failed (see above)."
fi

info "Restarting with the new version"
# The folder itself stays (Caddy has it mounted); only its content is replaced.
mkdir -p "$WEB_DIR"
find "$WEB_DIR" -mindepth 1 -delete
cp -a "$WEB_DIR.new/." "$WEB_DIR/"
rm -rf "$WEB_DIR.new"
docker compose up -d --remove-orphans
if wait_healthy "$DOMAIN" 300; then
  info "Done: https://$DOMAIN runs the new version. Desktop apps update themselves from GitHub Releases."
else
  echo "WARNING: https://$DOMAIN does not answer after the restart. Look at: cd $DIR && docker compose logs --tail 100 backend"
  rollback_help
  exit 1
fi
