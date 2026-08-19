# CAP Trellis

**Open-source client intake, eligibility, case & service management, and federal
reporting for Community Action Agencies.**

CAP Trellis is built around the data requirements of the **CSBG Annual Report 3.0**
(OMB No. 0970-0492) — Module 3 Section A services, Section B National Performance
Indicators, and the Section C All Characteristics Report — with a versioned
**Federal Poverty Guidelines** eligibility engine. It began at Community Action
Lehigh Valley (CALV) and is configurable for any CAA.

A trellis is a structure that supports growth. So is this.

- **License:** Apache-2.0 (see `LICENSE` / `NOTICE`)
- **Status:** pre-1.0, version 0.5.0 — roadmap Phases 1–5 are built. See
  `CHANGELOG.md` for what has landed and `docs/ROADMAP.md` for what's next.

## Stack

- **Next.js 15** (App Router) · React 19 · TypeScript (strict) · **Node 22**
  (what CI and the Docker images run; the Windows installer accepts Node 20+)
- **PostgreSQL** via node-postgres + Drizzle ORM — the schema bootstraps and seeds
  itself on first run (`src/db/ddl.ts`); an **embedded database mode** (PGlite) runs
  with zero database setup for local/offline installs
- Plain-CSS design system (`src/styles/tokens.css`, `src/styles/app.css`) — no Tailwind
- Session auth (scrypt + httpOnly cookie), optional **TOTP two-step verification**
  with signed-in device management, server-enforced role & program-based access
  control, login rate limiting, pervasive audit log
- **Bilingual** — English and Spanish, with per-user language and interface-scale
  preferences

## Quick start

```bash
npm install
npm run dev        # http://localhost:3100
```

With no `DATABASE_URL` set, the app expects PostgreSQL at
`postgres://csbg:csbg@localhost:5432/csbg_intake`. To run with **zero database
setup** (embedded PGlite, data stored under `data/`):

```bash
DATABASE_URL=pglite://./data/pglite npm run dev
```

The database schema bootstraps automatically. By default an empty database seeds
itself with realistic fictional demo data (evaluation mode). Set
`CSBG_DEMO_SEED=0` for a production install — the database initializes with only
the canonical CSBG taxonomy and official FPL schedules, and the first visit runs
the **/setup wizard** (agency profile, guideline table, eligibility policy, first
administrator). The Docker compose file ships with `CSBG_DEMO_SEED=0`.

**Demo accounts** (password `demo1234`):

| Username | Role | Access |
|---|---|---|
| `dana`, `marcus`, `luz` | Case Worker | assigned programs |
| `robin` | Front Desk | 2 programs |
| `joan` | Program Manager | all programs + admin |
| `terrence` | Data Admin | all programs + admin |

**Client portal demo:** open `/p/demo-rosa`, or use *Client portal preview* in the
sidebar. Documents uploaded there appear in the eligibility queue in real time.

```bash
npm run seed       # reset the database to fresh demo data
npm run typecheck  # strict TypeScript check
npm test           # vitest unit suite
npm run smoke      # DDL + seed against in-memory PGlite
npm run build      # production build
npm run mfa:reset  # clear a locked-out user's two-step verification
```

See `.env.example` for the environment variables, and `CONVENTIONS.md` before
sending a patch.

## Deploying

Three supported paths, by agency capacity — all detailed in `deploy/README.md`:

1. **Docker Compose** (recommended self-host) — app + PostgreSQL + Caddy with
   automatic HTTPS and nightly `pg_dump` backups:

   ```bash
   cp .env.example .env   # set CSBG_DOMAIN + secrets
   docker compose up -d
   ```

2. **Embedded database** (local / offline) — no PostgreSQL at all. A
   dependency-free **Windows office-PC installer** (`deploy/windows/`) builds the
   app, registers start-at-sign-in, and ships a console management menu.

3. **systemd + reverse proxy** (IT-managed) — `deploy/apache/` has an Apache
   vhost, a hardened systemd unit, and a step-by-step Ubuntu README. A worked
   example lives in `deploy/examples/calv-staging/`.

## What's inside

- **Dashboard** — caseload, follow-ups/outcome check-ins, eligibility-queue snapshot,
  data-quality gaps
- **Eligibility queue** — pre-enrollment pipeline: per-program document checklists
  (mark submitted → verify, or signed bypass), income vs the configurable FPL ceiling,
  approve-and-enroll (locked until all documents verify and income qualifies, with a
  duplicate guard at approval) or deny-with-required-note; every determination is
  audit-logged, and denials get their own review page
- **Intake wizard** — 6 steps with live duplicate detection, automatic FPL calculation,
  and a report-readiness meter across the All-Characteristics fields
- **Clients** — scoped directory + 360° profile with every CSBG characteristic, service
  history, capture-now gap filling, and follow-up scheduling
- **Service log** — 3-field quick entry mapped to the full official SRV/SDA taxonomy
- **Reports** — live Annual Report rollup: Module 3 Section A services, Section B FNPI
  targets-vs-actuals, Section C All Characteristics. Period/program/service filters,
  CSV, Excel, and branded PDF export. The unfiltered default remains the authoritative
  submission view; any filter switches to a clearly labeled "live records only"
  analysis that excludes imported pre-system baselines
- **Data & integrations** — spreadsheet importer with downloadable .xlsx templates for
  every option (clients, service history, pantries, pantry agencies, seminars,
  volunteers), each carrying an *Accepted values* key sheet; legacy-ID linkage,
  per-row poverty-guideline year, and undoable imports; a **duplicate review queue**
  backed by the shared client-matching engine; and PA HMIS sync (see below)
- **Program tools** — attendance, weatherization pipeline, pantry network, seminars,
  construction projects, volunteers, loan servicing
- **Client portal** — tokenized, no-login mobile page: status steps, document upload,
  appointment, caseworker contact
- **Security** — two-step verification enrollment and signed-in device management
- **Settings** — white-label organization, programs-by-type, users + program
  assignments, versioned FPL guidelines with point-in-time pinning, intake-question
  builder, answer lists, per-program service catalogs, integrations, database health
  + backup


## Compliance notes

- **FPL pinning:** every client/application stores the guideline year it was assessed
  under. Publishing a new year never recalculates a prior determination.
- **Access control:** program assignment gates client records, applications, services,
  tools, and search — enforced in queries, not just navigation.
- **Audit log:** sign-ins, eligibility decisions, FPL publishes, settings changes,
  HMIS syncs, and portal uploads write to `audit_log`.
- **Taxonomy:** `src/lib/csbg-catalog.ts`, extracted from the CSBG Annual Report 3.0
  instrument. Federal-instrument verification status is tracked in
  `docs/compliance/ar-3.0.md`.

## Documentation

- `CHANGELOG.md` — release notes. Compliance-relevant changes are marked
  **[compliance]**; read those before upgrading during a reporting season
- `docs/ROADMAP.md` — market review, federal data-requirements spec, phased plan
- `docs/ARCHITECTURE.md` — how the app is put together
- `docs/compliance/ar-3.0.md` — federal-instrument verification status
- `docs/compliance/hmis-api-integration-profile.md` — PA HMIS integration profile
- `deploy/README.md` — deployment tiers, TLS notes, backup and restore
- `CONVENTIONS.md` — implementation conventions for contributors
- `CONTRIBUTING.md` / `SECURITY.md`

## Contributing

CI (`.github/workflows/ci.yml`) runs typecheck, the unit suite, a DDL+seed smoke
test against PGlite, and a production build on every pull request. `main` is a
protected branch — land changes through a pull request that passes CI.

All seeded people, addresses, and records are fictional.
