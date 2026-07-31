# Changelog

All notable changes to CAP Trellis. Compliance-relevant changes (anything that
tracks a federal instrument or guideline revision) are marked **[compliance]**
— agencies should read those lines before upgrading in a reporting season.

## Unreleased — 0.5.0 (roadmap Phases 1–5)

### Reports: period/program/service filters + branded PDF
- The Reports rollup can now be **filtered** by reporting period (current FY,
  a prior FY, calendar year-to-date, or a custom date range), by **program**,
  and by **service domain**. Filters live in the URL, so every export link
  carries the same scope as the screen. The unfiltered default is unchanged and
  remains the authoritative submission view (current FY, all programs, all
  enrolled clients, pre-system baselines included).
- **[compliance]** Applying any filter switches to a clearly labeled **"live
  records only"** analysis: figures are counted purely from in-system records
  and the imported pre-system (CAP60/legacy) baselines are **excluded**, because
  those aggregates carry no date/program/service dimension to slice on. Top-line
  KPIs are recomputed live under a filter. A banner on the page and a caveat on
  the PDF spell this out so filtered numbers are never mistaken for the figures
  you file.
- The **Draft Annual Report** export now produces a professional, branded
  **PDF** (agency accent color + logo) instead of a Markdown file — Module 3
  Sections A, B & C with page numbering and a draft/confidentiality footer.
  Rendered with `@react-pdf/renderer` (no headless browser), so it behaves the
  same in dev, `next start`, and the container. CSV and the Module 3 Excel
  workbook are unchanged and also honor the active filters.

### Service-history import (new template)
- New "Service history" spreadsheet template backfills the service log from a
  legacy system — one row per service delivered. Clients resolve by **legacy
  ID** (the client_external_ids linkage written at migration), a Trellis ID,
  or an exact unambiguous name (+DOB); the service must be an AR 3.0 code or
  exact label; the program comes from a column, a fixed value, or the
  client's only enrollment — ambiguity always skips with a reason, never a
  guess. Re-imports are idempotent: a row matching an existing log entry
  (same client, service, date, and note) skips. Fixed one-value-for-the-file
  inputs work here too (service, program, legacy system).

### Client migration: record-complete imports
- The client-migration template now covers the full client record, not just
  the report characteristics: **County** of residence, **Caseworker**
  assignment (resolves by staff name, username, or initials; blank assigns to
  the importer), and a **Legacy client ID + Legacy system** pair. The legacy
  pair writes a durable `client_external_ids` cross-reference — and makes
  re-imports idempotent: a row whose (system, ID) is already linked skips with
  a clear reason instead of re-importing under a new name-match. County,
  caseworker, and legacy system all support the set-one-value-for-every-row
  shortcut; ClientTrack's own `ClientID` header auto-maps onto the legacy pair.
- Rows held for duplicate review carry the new fields through resolution:
  "create new client" honors the sheet's caseworker, and both resolutions
  link the legacy ID.

### Duplicate matching becomes real (integration groundwork)
- **One shared matching engine** (`src/lib/matching.ts`): exact identity =
  normalized name + date of birth; "possible" = same last name plus a matching
  DOB or similar first name, with phone as a tiebreaker signal. The intake
  duplicate warning, the client-migration import, and the approval guard all
  use it — and future API syncs (HMIS) will too.
- **Duplicate review queue**: client-migration import rows that closely match
  an existing client are **held for human review** instead of importing as
  probable duplicates. The Data page gets a real "Duplicate review" panel —
  use the existing record (enrolls it in the row's program and logs its
  service), create a new client, or dismiss the row. Every resolution is
  audited; the "awaiting review" stat is now the live queue count.
- **Approval duplicate guard**: approving a fresh intake that exactly matches
  an existing client's name + DOB now prompts the reviewer — add the program
  to the existing record (one service history, no duplicate) or confirm a
  separate person. Previously the intake-time warning was advisory only and
  approval created the duplicate silently.
- **External-ID linkage table** (`client_external_ids`): durable
  (system, external id) → client mapping, ready for the HMIS Client ID and
  any other source system, so post-first-link syncs match exactly by ID.
- The "How matching works" panel no longer claims SSN matching (the system
  stores no SSN in any form; the HMIS MOU excludes it) and the demo HMIS
  integration card no longer fakes a de-dup backlog.

### Import wizard: downloadable blank templates
- Every import option (Client migration, Pantry member agencies, Pantry
  aggregates, Seminar sign-ins, Volunteer hours) offers a blank CSV download
  from the wizard's template picker: the exact header row (auto-maps on
  upload) plus one example row showing every field's format. The example row
  is engineered to be skipped with a visible reason if staff forget to delete
  it — its match field can never match real data.

### Program tools become manageable (post-Phase 5)
Every program-type tool can now create and manage its own records instead of
only displaying seeded data:

- **Pantry network**: add and edit member agencies in the tool; new
  "Pantry member agencies" spreadsheet import template builds or refreshes
  the roster from Primarius 2.0's agency export (or any CSV/XLSX) — matched
  by agency ID or name, so re-imports update instead of duplicate. The
  reporting cycle is no longer pinned to a demo month: it's always the
  calendar month that just closed, and network KPIs compute live from the
  tables on real installs.
- **Volunteers**: add volunteers (name, role, program, low-income flag,
  optional client link) and edit them in the tool; the existing "Volunteer
  hours" import is now linked from the roster.
- **Loan servicing**: loans carry structured terms (APR in basis points,
  term in months, disbursement date) behind the display strings; each loan
  has a detail page with a **full amortization schedule** (level-payment,
  cent-accurate, last installment absorbs rounding) and a **payment ledger**
  — every payment recorded splits interest-first at one month of the note
  rate on the open balance, with date, split, running balance, staff, and
  note. New-loan form takes numeric rate/term so the schedule generates.
- **Attendance**: multiple classes per agency with a class picker; create
  classes (site, schedule, service code), enroll students (with optional
  household-record link), and open today's session on demand — the tap-to-
  cycle Today column and post-day service logging are unchanged.
- **Weatherization**: open jobs (household link or name, address, funding,
  measures) and add contractors (trade, crews, credential expirations) in
  the tool; contractors with an **expired** credential are blocked from new
  job assignments. New **Vouchers** tab records contractor expense charges
  (optionally tied to a job) with a submitted → approved → paid pipeline —
  approval/payment is admin-only and every step is audited.
- Housing construction projects intentionally untouched — build-out on hold
  pending review of the existing production system's implementation.

### Windows local install (deferred item — §7 local tier, first cut)
- deploy/windows: dependency-free PowerShell installer (Node check, build,
  embedded database, /setup wizard, start-at-sign-in task) + a console
  server manager with the §7.2 contract — status, start/stop/restart,
  change port, office-LAN toggle with managed firewall rule, open app,
  recent logs. Data (embedded DB + uploads + log) lives in one backupable
  folder. Standalone build output is now Docker-only so `next start` works
  on this tier.

### Spanish (staff app) — foundation + first screens (deferred item)
- Per-user UI language (English / Español) with a toggle in the user menu;
  LangProvider lifts the portal's colocated EN/ES dictionary pattern app-wide
- Translated: sidebar, top bar (search, user menu), and the full intake
  wizard (all six steps, worksheet, FPL panel, duplicate warnings, review)
- Note: characteristic question labels come from Settings → Forms (data, not
  code) — agencies can bilingualize those directly; translations pending a
  native-speaker review pass

### Security: two-step verification + device management (deferred item)
- TOTP MFA (RFC 6238, no new dependencies): per-account enrollment with
  manual-entry key + otpauth link, 8 single-use recovery codes (hashed at
  rest, shown once), two-step sign-in with short-lived pending sessions and
  token rotation, rate-limited verification, operator lockout reset
  (`npm run mfa:reset -- <username>`, audited, revokes all sessions)
- /security page for every staff account: manage two-step verification and
  see/revoke signed-in devices (created, browser/OS, expiry) + sign out
  everywhere else; raw session tokens never reach the client (fingerprints)

### Instrument verification (post-Phase 5)
- **[compliance]** Verified the catalog against the OMB-approved Annual Report
  3.0 instrument PDF (`CATALOG_VERSION` → `AR-3.0.1`):
  - Module numbering corrected: Individual & Family Level is **Module 3**
    (Community is Module 4) — labels updated app-wide
  - C1 is "Gender Identity" with a third option (Transgender, non-binary, or
    another gender)
  - C8 option is "Migrant or Seasonal Farm Worker" (old short value aliased)
  - D9 adds "Single Parent Non-Binary, Transgender, or Another Gender"
  - Sections A (SRV/SDA) and B (FNPI) code lists diffed against the PDF:
    exact match, no changes needed
  - Full record in docs/compliance/ar-3.0.md

### Phase 1 — Foundations
- Apache-2.0 license, NOTICE, contributor/security docs, architecture doc
- Vitest suite + GitHub Actions CI (typecheck, tests, PGlite smoke, build)
- Docker packaging: multi-stage image, compose with PostgreSQL + Caddy
  automatic HTTPS + nightly backup sidecar
- Embedded database mode (`DATABASE_URL=pglite://<dir>`) — zero-setup
  local/offline installs
- Security: magic-byte upload validation, login rate limiting, security
  headers + CSP + HSTS, 256-bit portal tokens
- Replaced CDN-only SheetJS with exceljs + built-in CSV parser; cleared all
  npm audit findings (incl. drizzle-orm SQL-identifier advisory)

### Phase 2 — Compliance core
- **[compliance]** Section C (All Characteristics) rollup completed: all 13
  characteristic blocks with correct reportable universes (age-banded C3,
  adults-only C8, insured-only C5b sources), top-line unduplicated
  individuals/households denominators
- **[compliance]** Report output canonicalized to the AR 3.0 instrument's
  exact answer strings (`CATALOG_VERSION = AR-3.0`); data-quality panel
  surfaces Unknown counts and answer-list drift year-round
- **[compliance]** Official HHS FPL tables 2023–2026 for 48-contiguous/
  Alaska/Hawaii (91 FR 1797; 90 FR 5917); jurisdiction setting; publish
  prefill; 2026 active in fresh installs
- Income worksheet (structured entries, state-configurable lookback) and
  frozen eligibility determinations on approve/deny
- Module labeling pass (superseded by the instrument verification above)

### Phase 3 — Genericization
- First-run setup wizard (`/setup`) + production init (`CSBG_DEMO_SEED=0`):
  clean installs with canonical taxonomy, no demo records
- Permission tiers: document bypass and cross-user verification undo require
  Program Manager / Data Admin
- Full-data JSON export (driver-agnostic backup path)

### Phase 4 — Differentiators
- Module 4 Excel workbook export (SmartForm-shaped, control-character-scrubbed,
  with a validation sheet)
- ROMA goals linked to FNPI indicators (Org Standard 4.3 board view)
- Client portal EN/ES (from the prototype) with the contact line now an
  organization setting
- Accessibility: dialog semantics + focus trap, keyboard radiogroups, live-
  region toasts, skip link

### Phase 5 — Ecosystem
- Client migration import template (CAP60/empowOR/spreadsheet-shaped, with
  duplicate detection and characteristic canonicalization)
- HMIS-aligned client CSV export (HUD-shaped columns/coding) for CoC
  coordination
- Issue templates (bug / feature / compliance), this changelog
