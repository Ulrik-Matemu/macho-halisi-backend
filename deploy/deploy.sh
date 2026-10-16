#!/usr/bin/env bash
# Build and (re)start the API. Run as root from the backend checkout that
# lives in /opt/macho-halisi/backend:   bash deploy/deploy.sh
set -euo pipefail
APP_USER=machohalisi
APP_DIR=/opt/macho-halisi/backend
cd "$APP_DIR"

[ -f /etc/macho-halisi/api.env ] || { echo "Missing /etc/macho-halisi/api.env (copy deploy/api.env.example)"; exit 1; }

# Full install: prisma + typescript are devDependencies needed to build/migrate.
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" npx prisma generate
sudo -u "$APP_USER" npm run build

# Apply committed migrations only (never `migrate dev` in production).
set -a; . /etc/macho-halisi/api.env; set +a
sudo -u "$APP_USER" --preserve-env=DATABASE_URL npx prisma migrate deploy

install -m 644 deploy/macho-halisi-api.service /etc/systemd/system/macho-halisi-api.service
systemctl daemon-reload
systemctl enable macho-halisi-api
systemctl restart macho-halisi-api
sleep 3
systemctl --no-pager --lines=15 status macho-halisi-api || true
curl -fsS http://127.0.0.1:4000/health && echo && echo "API healthy"
