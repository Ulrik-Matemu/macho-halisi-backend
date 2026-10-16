#!/usr/bin/env bash
# One-time bootstrap for the Macho Halisi API on a fresh Ubuntu 22.04/24.04
# server (works inside an unprivileged Proxmox LXC — no Docker needed).
# Installs Node 22, PostgreSQL 17 and Caddy, creates the database and a
# locked-down service user. Run as root:  bash setup-server.sh
# Safe to re-run: every step checks before it changes anything.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo -i)"; exit 1; }

APP_USER=machohalisi
APP_DIR=/opt/macho-halisi/backend
ENV_DIR=/etc/macho-halisi
DB_NAME=macho_halisi
DB_USER=macho

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release ufw git openssl debian-keyring debian-archive-keyring apt-transport-https

# ── Node 22 ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# ── PostgreSQL 17 (PGDG) ────────────────────────────────────────────
if ! command -v psql >/dev/null || ! psql --version | grep -q ' 17\.'; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-17
fi
systemctl enable --now postgresql

# ── Caddy (automatic HTTPS) ─────────────────────────────────────────
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ── Service user + directories ──────────────────────────────────────
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/macho-halisi --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
install -d -m 750 -o postgres -g postgres /var/backups/macho-halisi

# ── Database + role (password stored root-only, never printed) ──────
if [ ! -f /root/.macho-db-password ]; then
  openssl rand -hex 24 > /root/.macho-db-password
  chmod 600 /root/.macho-db-password
fi
DB_PASS="$(cat /root/.macho-db-password)"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
# Postgres listens on localhost only (the default) — never expose 5432.

# ── Firewall: SSH + web only ────────────────────────────────────────
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo
echo "Bootstrap complete."
echo "  DB password is in /root/.macho-db-password (use it in ${ENV_DIR}/api.env)"
echo "  Next: copy the backend to ${APP_DIR}, create ${ENV_DIR}/api.env, then run deploy.sh"
