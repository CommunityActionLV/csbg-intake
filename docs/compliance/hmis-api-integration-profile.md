# HMIS API Integration Profile

Reference for the PA HMIS (Eccovia ClientTrack/CaseWorthy) → CAP Trellis
integration.

**Status:** MOU **signed by both parties** (PA DCED 6/29/2026 · CACLV
7/27/2026, effective 7/1/2026 until terminated). **API credentials issued and
confirmed working against PA_HMIS production** (`GET /auth/test` → 200,
`SELECT TOP 5 … FROM cmClient` → 200 in 502 ms, both on 2026-08-13). Sync
engine, snapshot store, matching pass, review queue, and the organization-wide
unduplicated aggregate are **built**, now against the real transport (CTAPI —
see below). Remaining: confirm the unverified `cmClient` column names and the
`TOP`/`pageNo` interaction (list at the end), then run the first production
sync.

The transport is **CTAPI**, Eccovia's ClientTrack API
(<https://apidoc.eccovia.com>). It is **not** OAuth2: there is no token
endpoint, no bearer token, and no client-list endpoint. An earlier build of the
connection panel assumed all three; it was replaced.

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

## Authentication (CTAPI)

Two static headers on **every** request — no token exchange:

```
Ocp-Apim-Subscription-Key: <subscription key>
Authorization: ApiKey <api key>          # literal "ApiKey ", never "Bearer"
OrgId: <org id>                          # optional; User Keys only
```

`OrgId` scopes results to one organization including its sharing agreements;
Admin Keys ignore it. Base URL is `https://api.clienttrack.net` — Prod is the
only environment the docs expose, and the `PA_HMIS` application name from the
ClientTrack login URL does **not** appear in the API URL. HTTPS only.

`GET /auth/test` is the handshake: 200 with
`{"message":"Hello CER from from the PA_HMIS ClientTrack environment."}`.
The panel surfaces the environment name from that message so staff can see
which environment they reached.

Status codes handled distinctly: **401** credentials rejected (never retried —
replaying a refused key only burns the rate limit), **404** unknown object or
path, **500/502/503/504** retried with backoff to a bounded attempt count.

## Client listing via CRQL

There is no client-list endpoint. `POST /clients` *creates* a client;
`GET /clients` does not list them. Listing goes through CRQL:

```
GET /crql?q=SELECT TOP 200 ClientID, FirstName, … FROM cmClient
        &pageNo=1&pageSize=200&shouldCache=true
```

Hard-won specifics, all verified live on 2026-08-13 — several contradict the
published docs, and the code follows what was tested:

- **`SELECT TOP n` is mandatory in practice**, though undocumented. `TOP 5` +
  `pageSize=5` answered in 502 ms, while `SELECT … FROM cmClient Order By
  ClientID` and `SELECT ClientID FROM cmClient WHERE ClientID between 1 and
  2000` both ran past 30 s and were aborted. `pageSize` alone does not bound
  the work. `crqlClientQuery()` emits `TOP` from the same effective page size
  as the `pageSize` parameter so the two cannot drift.
- **No `ORDER BY`** — the one live query that carried one timed out.
  `shouldCache=true` snapshots the result set server-side and is what keeps a
  multi-page pull coherent.
- **An empty result is a bare `{}`**, not `{"data":{"Table1":[]}}`, so
  `json.data.Table1.length` throws on any no-match query. `crqlRows()` checks
  every level.
- **`recordCount` is not trustworthy** — a `TOP 5`/`pageSize=5` read returned
  5 rows alongside `recordCount: 10`. Paging counts rows in `Table1` instead.
- **`__crql_rid` is a per-response sequence number**, not a record ID. Never
  read, never persisted.
- **`ClientID: 0`** is a system/template row and is skipped.
- `pageNo` is 1-based; `pageSize` defaults to 25 and is capped at **500**.
  `OFFSET` is rejected by the parser because paging owns that concern.
- CRQL allows **at most one join**, no subqueries, no wildcards in the field
  list, no calculated expressions, and caps the query at 2048 chars once
  URL-encoded. Anything needing multiple joins or aggregation has to be built
  in ClientTrack's Query Designer, exported as a stored procedure, and called
  through `POST /crql/storedprocedures/{name}` — not forced through CRQL.
- Single-record read: `GET /cto/cmClient/{id}` returns the full row including
  the HUD fields (`HUDRace`, `HUDEthnicity`, `VeteranStatus`,
  `DisablingCondition`, `PriorLivingSituation`, `SSNQuality`, `NameQuality`,
  `BirthDateQuality`). Not used by the sync — see the open questions.

`CRQL_CLIENT_FIELDS` in `src/lib/hmis.ts` is the single place the column list
lives. `ClientID`, `FirstName`, `LastName` and `ActiveStatus` are verified; the
demographic columns are the expected spellings and are **unverified** — a wrong
name makes CRQL answer 400 naming the column, and the 400 body is surfaced
verbatim.

## Configuration

Primary: **Settings → Integrations** (admin-only) — base URL, subscription key,
API key, Org ID, page size. Saved to the database and applied immediately, no
restart; suits hosted tiers (Apache/Ubuntu, Docker) where staff have no shell
access. Both keys are write-only in the UI (never sent back to the browser,
never audited) and **encrypted at rest** with AES-256-GCM (`src/lib/secrets.ts`).

The encryption key lives **outside** the database — `CSBG_SECRET_KEY`, or
`data/secret.key` generated on first use with mode 0600 — so a database dump or
backup tarball carries no usable credential. If that key is lost or rotated, the
stored keys become unreadable: the settings page says so and staff paste them
again. Page size is clamped to 1..500 server-side as well as in the input.

Fallback: `HMIS_*` environment variables — used when nothing is saved in
Settings; useful for ops-managed installs. Saved settings take precedence;
"Clear saved settings" falls back to the environment.

```
HMIS_BASE_URL=          # optional, default https://api.clienttrack.net
HMIS_SUBSCRIPTION_KEY=  # Ocp-Apim-Subscription-Key
HMIS_API_KEY=           # Authorization: ApiKey <key>
HMIS_ORG_ID=            # optional, User Keys only
HMIS_PAGE_SIZE=         # optional, default 200, max 500
```

Credentials rest inside the app database (encrypted) or the server's
`.env.local`, on access-restricted machines — satisfying the MOU's
secure-storage condition. Data & Integrations → PA HMIS sync has **Test
connection** (`/auth/test` only, no client data) and **Run sync** (full snapshot
pull + integration pass). Admin-only.

## Sync design (as built)

- **One-way, inbound only. Read-only against CTAPI** — nothing in this codebase
  writes to HMIS.
- Full-snapshot semantics: each run replaces `hmis_clients` wholesale, then
  re-runs the matching pass. Links and review resolutions persist across runs.
- Field-name-tolerant normalization (`normalizeHmisClient`) accepts
  PascalCase / camelCase / snake_case spellings; rows without an ID or name
  are dropped, as is `ClientID` 0.
- Paging ends on the first short page, with a 200-page backstop. A pull that
  filled exactly one page and then hit an empty one is **reported as ambiguous**
  rather than as a complete snapshot — see open question 1.
- Request timeout of 20 s, at most 3 attempts, backoff between them.
- All syncs, links, and dismissals write `audit_log` rows. Neither key appears
  in an audit row, an error message, or a log line at any level.

## Open questions for PA HMIS / Eccovia

1. **Does `TOP n` bound the result set before `pageNo` applies?** Every live
   read so far was a single page, so this is untested. If `TOP` binds first,
   page 2 comes back empty and a statewide pull silently stops at one page.
   Cheapest check (read-only, one call): `SELECT TOP 5 ClientID FROM cmClient`
   with `pageSize=5&pageNo=2` — rows back means paging works inside `TOP`; empty
   means multi-page pulls need a keyset walk (`WHERE ClientID > <last>`)
   instead. Until it is answered, `runHmisSync` flags a one-page pull.
2. **Row determinism without `ORDER BY`** — confirm `shouldCache=true` is the
   intended mechanism for keeping a multi-page pull from repeating or skipping
   rows, given that `Order By ClientID` timed out.
3. **Which issued value is which.** We hold an "access key alias" and an "access
   security key" — apparently the Access-record pair behind
   `Authorization: ApiKey`. Confirm whether a separate
   `Ocp-Apim-Subscription-Key` was issued; if not, that is a procurement gap,
   not a code gap.
4. **The unverified `cmClient` column names** in `CRQL_CLIENT_FIELDS` — DOB
   above all, since without it every unmatched person stays snapshot-only
   instead of being imported.
5. **Which CRQL entity holds enrollments/services and family members.** They are
   not `cmClient` columns, so under CRQL the `services` and `household` lists
   arrive empty: imported clients get `hhSize` 1 and today's date as the
   enrollment date instead of the first service date. Likely a Query Designer
   stored procedure.
6. **Whether our key type needs `OrgId`** — a User Key may make it effectively
   required rather than optional.
7. **Rate limits for the initial backfill**, and whether the list should filter
   on `ActiveStatus` rather than merely select it.

## Disposition of electronic files (MOU condition)

The snapshot lives inside the app database only. To end the arrangement: stop
the sync (Settings → Integrations → **Clear saved settings**, and remove any
`HMIS_*` env settings) and clear the snapshot
(`DELETE FROM hmis_clients; DELETE FROM hmis_reviews;`) — coordinate final
disposition with PA DCED as the MOU requires. Linkage rows in
`client_external_ids` contain only opaque IDs.

## Related

- HMIS-aligned CSV **export** (manual, one-way out, admin-only):
  `app/(app)/clients/export-hmis/route.ts` — an alignment aid, unrelated to
  this inbound sync.
- AR 3.0 scope notes: `docs/compliance/ar-3.0.md`.
