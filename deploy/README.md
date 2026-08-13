# Deploying CAP Trellis

Three supported paths, by agency capacity. All of them serve the same app; pick
the one that matches who will run it. (Design rationale: `docs/ROADMAP.md` §7.)

## 1. Docker Compose (recommended self-host)

One VPS or agency VM, one command:

```bash
cp .env.example .env    # set CSBG_DOMAIN and DB_PASSWORD
docker compose up -d
```

What you get:

- **app** — the Next.js server (standalone build, non-root user)
- **db** — PostgreSQL 16 with a named volume
- **caddy** — reverse proxy with **automatic HTTPS** (Let's Encrypt) for
  `CSBG_DOMAIN`; `localhost` serves plain HTTP for trials
- **backup** — nightly `pg_dump` into `deploy/docker/backups/`, keeping the
  most recent 30

Updating: `git pull && docker compose build && docker compose up -d`.
Restoring: `pg_restore -h localhost -U csbg -d csbg_intake --clean <dump>`
(run inside the db container: `docker compose exec db …`).

DNS: point an A record for `CSBG_DOMAIN` at the server before first start so
certificate issuance succeeds. Only ports 80/443 need to be reachable.

## 2. Embedded database (local / offline)

No PostgreSQL at all — the app runs its own embedded engine (PGlite) in-process:

```bash
DATABASE_URL=pglite://./data/pglite npm run build && npm start
```

Suited to a single office machine or an offline trial. The `data/` directory
holds both the database and uploaded documents — back that folder up. Not for
multi-process deployments (one Node server only).

## 3. systemd + reverse proxy (IT-managed)

**Apache on Ubuntu** is the documented generic path: `deploy/apache/` has the
vhost, the systemd unit, and a step-by-step README (embedded database or
PostgreSQL — your choice). A messier worked example — the original Community
Action Lehigh Valley staging setup with its provisioning script — lives in
`deploy/examples/calv-staging/`. Either way the only contract the app needs
is `DATABASE_URL` and a proxy passing HTTP to port 3100. Put TLS in front of
it; `CSBG_ALLOW_HTTP=1` exists for isolated LAN setups only.
