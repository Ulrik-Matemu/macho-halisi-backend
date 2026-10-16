#!/usr/bin/env bash
# Nightly database backup, 14-day retention. Installed by cron (see MIGRATION.md):
#   15 2 * * * postgres /opt/macho-halisi/backend/deploy/backup-db.sh
set -euo pipefail
DIR=/var/backups/macho-halisi
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump -Fc macho_halisi > "$DIR/macho_halisi-$STAMP.dump"
find "$DIR" -name 'macho_halisi-*.dump' -mtime +14 -delete
# Off-server copy matters more than this local one — see MIGRATION.md.
