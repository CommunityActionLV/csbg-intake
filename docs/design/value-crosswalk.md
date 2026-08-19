# Design: configurable value crosswalk

**Status:** draft for review. Nothing implemented.

## Problem

External systems speak their own vocabulary, CAP Trellis speaks the CSBG AR 3.0
instrument, and the two drift apart on their own schedules.

Live today: the PA HMIS procedure returns `race` as
`"Black, African American, or African"` — HUD's 2024 wording. The instrument's
option is `"Black or African American"`. `canonicalCharacteristic()` finds no
match, the caller stores the raw label (correct — nothing is coerced), and the
value then counts as Unknown/Not Reported in the C6 tally on the federal report.
The same applies to `insurance`, income sources, and anything else a vendor
rewords. HUD changed race wording in 2024; CaseWorthy can change a label any
day; CSBG revises the instrument periodically. **No release cadence can keep up
with that, and no hard-coded table should try.**

The spreadsheet importers have the identical problem with legacy exports, and
solve it separately today.

## Requirements

1. An agency can fix a mismatch **without editing TypeScript or redeploying**.
   This is the open-source litmus test: a CAA running WellSky or CAP60 must be
   able to onboard their vocabulary from the UI.
2. Mappings are **per source** — each integration and each import template — so
   two vendors can use the same word differently.
3. Nothing is ever silently recategorized. An unmapped value is stored as-is and
   surfaced, never coerced to a default.
4. Mapping decisions are **auditable**: who mapped which label to which federal
   category, and when. A monitor can ask.
5. Mappings are **portable** — exportable as data so one agency's work is
   reusable by the next.

## Model

One table, `value_mappings`:

| column | notes |
|---|---|
| `id` | identity |
| `source` | `hmis`, `import:clients`, `import:services`, … — the ingestion source |
| `code` | characteristic code: `C1`, `C6`, `C7`, `C5b-source`, `D13`, … |
| `source_value` | the vendor's string, stored verbatim |
| `lookup_key` | `source_value` normalized (case, whitespace, punctuation) — the match key |
| `csbg_value` | the instrument option, or null |
| `status` | `mapped` · `pending` · `keep_as_is` |
| `seen_count`, `first_seen`, `last_seen` | populated by ingestion |
| `updated_by`, `updated_at` | audit trail |

`keep_as_is` is a first-class decision, not an absence: it records that someone
looked at the label and decided it has no instrument equivalent, so it stops
appearing in the work queue.

Unique on (`source`, `code`, `lookup_key`).

## Resolution order

```
mapCharacteristic(source, code, rawValue):
  1. canonicalCharacteristic(code, rawValue)   → instrument match wins, always
  2. value_mappings lookup (source, code, key) → status mapped   → csbg_value
                                               → status keep_as_is → rawValue
  3. no row  → record a `pending` row (count++), return rawValue
```

Step 3 is what makes this usable: **the system writes the work queue, the admin
never types a vendor string.** The first sync after a vendor reword produces a
pending row with a count and an example; an admin picks the instrument option
from a dropdown.

## Where it applies

One function, called wherever external values enter:

- `src/lib/hmis.ts` — `canonOr()` in `enrichLinkedClient` / `createClientFromHmis`
- `app/(app)/data/actions.ts` — the client-migration and service-history importers
- any future connector, by construction

Everything downstream (reports, eligibility, exports) keeps reading canonical
values and needs no change.

## UI

**Settings → Value mappings.** Pending first, grouped by source then
characteristic, each row showing the vendor label, how many times it has been
seen, an example record, and a dropdown of that characteristic's instrument
options plus "keep as-is". A count badge appears on Data & integrations while
anything is pending, so a vendor reword is noticed rather than discovered at
report time.

Every create/edit/delete writes an `audit_log` row — these are federal reporting
decisions, and a commit message is not an audit trail.

## Portability

Export/import per source as JSON. That turns mappings into shareable artifacts —
a `profiles/` directory of community-contributed crosswalks ("Eccovia
ClientTrack", "WellSky ServicePoint", "CAP60 export") that adopters import
instead of rediscovering. Ship PA_HMIS as an *example*, explicitly not a default.

## Deliberate non-goals

Mappings are **lookups, not logic**: `(source, code, value) → value`. No regular
expressions, no conditionals, no computed transforms, no scripting. A source
needing computation gets an adapter in code. This constraint is what keeps the
feature operable by an agency admin instead of becoming a small ETL product only
its authors can run.

## Phasing

| Phase | Scope | Value on its own |
|---|---|---|
| 1 | Table + `mapCharacteristic()` + auto-collection of pending values, applied in the HMIS sync. No UI — pending values appear in the sync result, as they do now. | The queue starts filling with real data immediately |
| 2 | Settings → Value mappings UI + audit rows | Agency can fix mismatches without a deploy |
| 3 | Wire into the spreadsheet importers | One vocabulary layer for every ingestion path |
| 4 | Export/import JSON; ship the PA_HMIS profile as an example | Other CAAs inherit the work |
| 5 | Retroactive re-apply: walk stored records, preview counts, apply, audit | Fixes records imported before a mapping existed |

Phase 1 is small and unblocks everything else. Phase 5 is deliberately last and
deliberately manual — silently rewriting stored client characteristics because
someone saved a dropdown is not acceptable on a compliance system, so it needs a
preview and an explicit action.

## Open decisions

1. **Retroactivity.** Recommended: on-demand re-apply with a preview (phase 5),
   never automatic on save. Confirm.
2. **UI location.** Settings → Value mappings, or a tab inside Data &
   integrations next to the sources themselves?
3. **Cross-source reuse.** Per-source only (recommended — two vendors can mean
   different things by the same word), with a "copy from another source" action
   to avoid re-doing identical work?
4. **Scope of `source`.** One row per integration (`hmis`) versus per connector
   instance, once an agency runs two HMIS connections.
5. **Combined fields.** `race` currently stores `race · ethnicity` joined into
   one string. A crosswalk on the combined string is fragile; this probably wants
   the two mapped separately before joining. Needs a decision when phase 1 lands.

## First entries this will produce

From the live procedure output, the initial pending queue should contain at
least `C6 "Black, African American, or African"`, plus whatever the sync you are
running now reports under "labels outside the CSBG instrument".
