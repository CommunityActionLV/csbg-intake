# HMIS API Integration Profile

Reference for the PA HMIS (Eccovia ClientTrack/CaseWorthy) → CAP Trellis
integration.

**Status:** MOU **signed by both parties** (PA DCED 6/29/2026 · CACLV
7/27/2026, effective 7/1/2026 until terminated). **API credentials issued.**
Sync engine, snapshot store, matching pass, review queue, and the
organization-wide unduplicated aggregate are **built**. Remaining: pin the
exact endpoint paths/paging/field names against the Eccovia API docs
(<https://apidoc.eccovia.com>) and run the first production sync.

## Permitted use — READ THIS FIRST

The signed MOU restricts use of the shared data **exclusively** to:

1. **Data-set matching for deduplication**, and
2. **Deidentified aggregate organization-wide reports.**

Scope is limited to data entered by and for **CACLV-owned projects**.

The system enforces this: the sync **never writes to the `clients` table** —
no intake prefill, no contact-info reuse, no record creation from HMIS data.
Its only outputs are the admin-only `hmis_clients` snapshot, durable ID links
in `client_external_ids` (system = `hmis`), the `hmis_reviews` queue, and
aggregate counts on /reports. The earlier ambition of eliminating double
entry at intake **exceeds the signed terms** — pursue an MOU amendment before
building anything that copies HMIS elements into client records.

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

## Matching & de-duplication policy (as built)

1. **Linked records:** exact `client_external_ids` (system `hmis`) match —
   every sync after first linkage. Unambiguous, no fuzzy logic.
2. **Exact identity** (normalized name + DOB, single candidate): auto-link,
   audited (`hmis.link` on sync as auto-link detail).
3. **Near matches** (shared engine, `src/lib/matching.ts`): held in
   `hmis_reviews` — resolutions are **link** or **dismiss** only (never
   "create a client"; the MOU does not permit it). Dismissals stick across
   syncs. Every resolution is audited.
4. Email/phone are tiebreaker signals in review, never primary keys.

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
