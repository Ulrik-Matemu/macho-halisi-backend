# Migrating the API + database to the client's server

Target: Ubuntu container `TestWeb-NodJS` on Proxmox (6 CPU, 11.7 GiB RAM, 1 TB disk), LAN IP `192.168.1.150`.
Stack: native install, no Docker — Node 22, PostgreSQL 17, Caddy, systemd (the container is *unprivileged*, where Docker needs extra Proxmox settings for no benefit here).

> Never paste server passwords into chat or commit them. Use SSH keys; do secrets by hand on the server.

## 0. Things to settle first

| Question | Why it matters |
|---|---|
| **How will the internet reach 192.168.1.150?** `192.168.1.x` is a private address. Either (a) the client's router forwards ports 80/443 to it and there is a public/static IP, or (b) use a **Cloudflare Tunnel** (no port forwarding, works behind CGNAT, needs the domain's DNS on Cloudflare — free). | Without one of these the website on Vercel cannot call the API. |
| **Domain + DNS access** (suggested API hostname `api.<domain>`). | HTTPS certificate, `CORS_ORIGIN`, website `EXPRESS_API_URL`. |
| **Where does the current database live?** (Render Postgres / Neon / other) | Source of the `pg_dump`. |
| **Is the Proxmox host backed up / on a UPS?** | A single container is the only copy otherwise; see §6. |
| **MFA key** — reuse the old one, or make a new one (see §5). | Decides whether admins must re-enrol their authenticator. |

## 1. Access (do this yourself, I never need the password)

```bash
ssh-copy-id <user>@<server-ip>          # from your machine, once
ssh <user>@<server-ip>
sudo -i
```
If you run commands through Claude Code, prefix with `!` so output lands in the session: `! ssh <user>@<ip> 'uname -a; lsb_release -d; free -h; df -h /; which node docker psql'`.
(The server is on a LAN address, so your machine must be on that network or a VPN.)

## 2. Bootstrap the server (once)

```bash
# from your machine, in macho-halisi-backend/
scp -r deploy <user>@<server-ip>:/tmp/macho-deploy
# on the server, as root
bash /tmp/macho-deploy/setup-server.sh
```
This installs Node 22, Postgres 17 and Caddy, creates the `machohalisi` service user, the `macho_halisi` database and role (password saved root-only in `/root/.macho-db-password`), and enables the firewall (22/80/443 only). Postgres stays on localhost.

## 3. Install the app

```bash
# on your machine: ship the code without node_modules/.env
rsync -a --exclude node_modules --exclude dist --exclude .env --exclude .git \
  ./ <user>@<server-ip>:/tmp/macho-backend/
# on the server, as root
rsync -a /tmp/macho-backend/ /opt/macho-halisi/backend/ && chown -R machohalisi:machohalisi /opt/macho-halisi
cp /opt/macho-halisi/backend/deploy/api.env.example /etc/macho-halisi/api.env
chown root:machohalisi /etc/macho-halisi/api.env && chmod 640 /etc/macho-halisi/api.env
nano /etc/macho-halisi/api.env     # fill in every <...>; generate secrets with: openssl rand -hex 32
```
**Generate fresh `JWT_*`, `ANALYTICS_INGEST_SECRET`, `MONITOR_SECRET`.** (Rotating the JWT secrets simply logs everyone out once.)

## 4. Move the data

1. **Freeze** dashboard edits (tell the client; enquiries submitted during the window go to the old DB).
2. **Dump the old DB** (from your machine; connection string from the old host's dashboard):
   ```bash
   pg_dump -Fc --no-owner --no-acl "<OLD_DATABASE_URL>" -f macho-old.dump
   ```
3. **Copy and restore on the server** (this *is* the schema + data, including Prisma's `_prisma_migrations` history, so `migrate deploy` afterwards is a no-op or applies only newer migrations):
   ```bash
   scp macho-old.dump <user>@<server-ip>:/tmp/
   sudo -u postgres pg_restore --no-owner --role=macho -d macho_halisi /tmp/macho-old.dump
   ```
   If the source is empty/new, skip this and let `deploy.sh` create the schema, then run `npm run seed:admin` and `npm run seed:client-packages`.
4. **Verify row counts** match the old DB:
   ```bash
   sudo -u postgres psql macho_halisi -c "select 'users',count(*) from users union all select 'itineraries',count(*) from itineraries union all select 'enquiries',count(*) from enquiries;"
   ```
5. **Images need no copying** — they live on Cloudinary and the DB holds the URLs. Make sure the client owns that Cloudinary account (or move the credentials to one they own).

## 5. MFA key

`MFA_ENCRYPTION_KEY` encrypts each user's TOTP seed. If you set a **new** key, the restored seeds can't be decrypted. After restoring, reset MFA for everyone so each user re-enrols on next login:

```bash
sudo -u postgres psql macho_halisi -c 'UPDATE users SET "mfaEnabled" = false, "mfaSecret" = NULL;'
```
(`mfaEnabled=false` makes the login flow offer enrolment again.) Do this *before* opening the API to users. If you'd rather avoid re-enrolment, copy the old key instead.

## 6. Start it, then HTTPS

```bash
bash /opt/macho-halisi/backend/deploy/deploy.sh      # build, migrate deploy, start service, health check
cp /opt/macho-halisi/backend/deploy/Caddyfile.example /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile                            # set the real api hostname
systemctl reload caddy
curl https://api.<domain>/health
```
Logs: `journalctl -u macho-halisi-api -f`.
Updating later: rsync new code, then `bash deploy/deploy.sh`.

**Backups** (the old host's backups no longer exist after cut-over):
```bash
echo '15 2 * * * postgres /opt/macho-halisi/backend/deploy/backup-db.sh' > /etc/cron.d/macho-halisi-backup
```
Also copy `/var/backups/macho-halisi` off the server (second machine, Backblaze/S3 via `rclone`) and **do one test restore** into a scratch DB before relying on it.

## 7. Cut over the website

1. In Vercel → Project → Environment Variables: set `EXPRESS_API_URL=https://api.<domain>` and keep `ANALYTICS_INGEST_SECRET` equal to the new backend's value; set `NEXT_PUBLIC_SITE_URL` to the real site URL. Redeploy.
2. Backend `CORS_ORIGIN` must list that site origin.
3. GitHub Actions uptime workflow secrets: `API_URL`, `SITE_URL`, `MONITOR_SECRET` → new values.
4. Smoke test: homepage shows 5 itineraries, `/itineraries/<slug>` loads, submit a test enquiry, log in to `/dashboard`.
5. Keep the old backend running read-only for 1–2 weeks as rollback, then retire it.

## 8. Rollback
Point `EXPRESS_API_URL` back at the old backend and redeploy the site. Data entered on the new server in the meantime would need a `pg_dump` back — another reason to keep the freeze window short.
