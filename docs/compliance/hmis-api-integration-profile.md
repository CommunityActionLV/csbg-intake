# HMIS API Integration Profile

Reference for the PA HMIS (Eccovia ClientTrack/CaseWorthy) → CAP Trellis
integration.

**Status:** MOU **signed by both parties** (PA DCED 6/29/2026 · CACLV
7/27/2026, effective 7/1/2026 until terminated). **API credentials issued.**
Sync engine, snapshot store, matching pass, review queue, and the
organization-wide unduplicated aggregate are **built**. Remaining: pin the
exact endpoint paths/paging/field names against the Eccovia API docs
(<https://apidoc.eccovia.com>) and run the first production sync.

## Permitted use — the operating understanding

Scope is limited to data entered by and for **CACLV-owned projects**. Per the
operating understanding between CACLV and PA HMIS (confirmed by the Homeless
Program Manager with the HMIS engineer who built the API's stored procedure):
the shared elements are pulled into CAP Trellis — a **private, internal-only
system** — for CACLV's internal tracking and reporting. That includes
importing contact information and demographics into client records. The
MOU's "deduplication" language refers to the HMIS-side stored procedure,
which returns **pre-deduplicated result sets**; on our side the matching
engine additionally deduplicates against the existing client directory so
nobody is double-counted.

Standing obligations either way: the data is never redisclosed, never used
outside the agency, stored securely with access limited to staff working on
this (admin-gated), and electronic-file disposition is coordinated with
PA DCED (procedure below). *Housekeeping note:* the MOU's written
"exclusively … deidentified aggregate reports" sentence is narrower than
this operating understanding — worth asking DCED to align the text at the
next revision so a monitoring review reads the same way both parties do.

## Data elements (per signed MOU) → where they land

| MOU element | Destination (all in the `hmis_clients` snapshot) |
|---|---|
| First name / Last name | `first` / `last` |
| Date of birth | `dob` |
| Email / Telephone | `email` / `phone` — **matching tiebreakers only** |
| **Client ID** | `hmis_id` (PK) + `client_external_ids` when linked |
| Services | `services` (jsonb name/date list) |
| Gender and Sex | `sex` (kept distinct when both provided) |
| Race / Ethnicity | `race` (combined text) |
| Veteran status | `veteran` |
| Health insurance type | `insurance` |
| Source of income | `income_src` |
| Non-cash benefits | `non_cash` |
| Family members (first/last/DOB) | `household` (jsonb list) |

**No SSN in any form.** The MOU excludes it; the system stores none.

## Sync behavior (as built)

Per HMIS person, each sync:

1. **Already linked** (`client_external_ids`, system `hmis`): fill **blank**
   fields on the linked record — phone, sex, race, veteran/military,
   insurance, income source, email (stored in `custom.email`). **Local data
   always wins**; nothing non-empty is ever overwritten.
2. **Exact identity** (normalized name + DOB, single candidate): auto-link
   (audited) + the same blank-fill.
3. **Near matches** (shared engine, `src/lib/matching.ts`; email/phone are
   tiebreakers, never keys): held in `hmis_reviews` — resolutions are
   **link**, **import as new client**, or **dismiss** (keep snapshot-only).
   Dismissals stick across syncs. Every resolution is audited.
4. **No match:** imported as a new client record — enrolled into the
   configured HMIS program (Data page setting), flagged
   "HMIS import — verify income & eligibility data" (HMIS supplies no income
   figure, so imports land at $0 income and must be verified before any
   eligibility determination), `hhSize` derived from the family-members
   list, FPL year pinned to the active schedule. Requires a DOB
   (`clients.dob` is NOT NULL) — DOB-less records stay snapshot-only.

## Aggregates (as built)

/reports shows "Organization-wide unduplicated · with PA HMIS" once a
snapshot exists: Trellis total, HMIS total (CACLV projects), matched overlap
(counted once), HMIS-only, and the unduplicated org-wide total. Counts only —
no identifying fields leave `src/lib/hmis.ts#hmisAggregate`.

## Configuration (environment, never committed)

```
HMIS_TOKEN_URL=      # OAuth2 token endpoint (client-credentials grant)
HMIS_CLIENT_ID=
HMIS_CLIENT_SECRET=
HMIS_BASE_URL=       # API root for our instance
HMIS_CLIENTS_PATH=   # optional, default /api/clients
HMIS_SCOPE=          # optional
HMIS_PAGE_SIZE=      # optional, default 200
```

On the local Windows tier these live in `.env.local`; the machine and data
folder are access-restricted, satisfying the MOU's secure-storage condition.
Data & Integrations → PA HMIS sync has **Test connection** (token round-trip
only) and **Run sync** (full snapshot pull + matching pass). Admin-only.

## Sync design (as built)

- **One-way, inbound only.** Full-snapshot semantics: each run replaces
  `hmis_clients` wholesale, then re-runs the matching pass. Links and review
  resolutions persist across runs.
- Field-name-tolerant normalization (`normalizeHmisClient`) accepts
  PascalCase / camelCase / snake_case spellings; rows without an ID or name
  are dropped.
- Response-shape tolerant paging (bare array, `{data:[...]}`, `{value:[...]}`;
  short page = last page; 200-page backstop).
- All syncs, links, and dismissals write `audit_log` rows.

## To finalize against the Eccovia docs

1. Exact client-list endpoint path + auth specifics for our instance
   (set via `HMIS_BASE_URL`/`HMIS_CLIENTS_PATH`/`HMIS_TOKEN_URL`).
2. Real pagination parameter names (currently `page`/`pageSize`).
3. Delta/modified-since support (currently full snapshot each run).
4. How Services and family members are represented in responses.
5. Rate limits for the initial backfill.

## Disposition of electronic files (MOU condition)

The snapshot lives inside the app database only. To end the arrangement:
stop the sync (remove the `HMIS_*` env settings) and clear the snapshot
(`DELETE FROM hmis_clients; DELETE FROM hmis_reviews;`) — coordinate final
disposition with PA DCED as the MOU requires. Linkage rows in
`client_external_ids` contain only opaque IDs.

## Related

- HMIS-aligned CSV **export** (manual, one-way out, admin-only):
  `app/(app)/clients/export-hmis/route.ts` — an alignment aid, unrelated to
  this inbound sync.
- AR 3.0 scope notes: `docs/compliance/ar-3.0.md`.
