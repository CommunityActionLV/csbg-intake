# CAP Trellis behind Apache (Ubuntu VM tier)

The Next.js server runs as a systemd service on `127.0.0.1:3100`; Apache
terminates TLS and reverse-proxies to it. Suits an agency VM that already
hosts other Apache sites (PHP/Laravel etc.) — no Docker required.

## Install

1. **Node.js 20+** (Ubuntu 24.04's default `nodejs` is too old):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **App user + code** at `/opt/captrellis`:

   ```bash
   sudo useradd -r -m -d /opt/captrellis -s /usr/sbin/nologin captrellis
   sudo -u captrellis git clone https://github.com/dchevalier18/csbg-intake.git /opt/captrellis
   cd /opt/captrellis
   sudo -u captrellis npm ci
   ```

3. **`.env.local`** (owned by `captrellis`, mode 600):

   ```bash
   # embedded database (simplest) …
   DATABASE_URL=pglite:///opt/captrellis/data/pglite
   # … or PostgreSQL if the VM runs it (recommended for multi-user load):
   # DATABASE_URL=postgres://captrellis:…@localhost:5432/captrellis
   CSBG_DEMO_SEED=0
   PORT=3100
   HOSTNAME=127.0.0.1
   # ONLY if staff reach the app over plain http:// on a trusted LAN
   # (do NOT set this when Apache serves HTTPS):
   # CSBG_ALLOW_HTTP=1
   ```

   The PA HMIS connection is configured in the app itself
   (Settings → Integrations) — no env vars or restarts needed for it.

4. **Build and start**:

   ```bash
   sudo -u captrellis bash -c 'cd /opt/captrellis && DATABASE_URL=pglite://memory CSBG_DEMO_SEED=0 npm run build'
   sudo cp deploy/apache/captrellis.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now captrellis
   ```

   (The build overrides `DATABASE_URL` with an in-memory engine so parallel
   build workers never touch the real data directory — same trick the other
   tiers use. `next start` reads `.env.local` normally.)

5. **Apache** — see `captrellis.conf`:

   ```bash
   sudo a2enmod proxy proxy_http headers ssl rewrite
   sudo cp deploy/apache/captrellis.conf /etc/apache2/sites-available/
   sudo nano /etc/apache2/sites-available/captrellis.conf   # ServerName + certs
   sudo a2ensite captrellis && sudo systemctl reload apache2
   ```

   First visit serves the /setup wizard (agency profile + first admin).

## Update

```bash
cd /opt/captrellis
sudo -u captrellis git pull
sudo -u captrellis npm ci
sudo -u captrellis bash -c 'DATABASE_URL=pglite://memory CSBG_DEMO_SEED=0 npm run build'
sudo systemctl restart captrellis
```

Schema migrations apply automatically on the next boot (append-only DDL).

## Backups

- Embedded database: stop the service, copy `/opt/captrellis/data/`, start it
  (or use Settings → Database → JSON export while running).
- PostgreSQL: ordinary `pg_dump`, plus `/opt/captrellis/data/uploads/`.

## Notes

- HTTPS at Apache means **no** `CSBG_ALLOW_HTTP` — the session cookie stays
  `Secure`. Setting it while serving HTTPS weakens cookies for no benefit;
  omitting it while serving plain HTTP breaks sign-in. Pick one.
- The client portal (`/p/<token>`) works on this tier since the VM is
  network-reachable — expose it only if the vhost is internet-facing and
  TLS-terminated.
- Outbound HTTPS to the PA HMIS API must be allowed from this VM (the sync
  runs server-side).
