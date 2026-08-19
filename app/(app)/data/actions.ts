"use server";
/* Data & integrations — spreadsheet import. Parse runs server-side (CSV via the
   built-in RFC 4180 parser, XLSX via ExcelJS); commit re-validates every row
   against the live tables. Admin-only. */
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { readSheet } from "@/lib/spreadsheet";
import { db, t } from "@/db";
import type { HeldClientPayload, ImportAdditions } from "@/db/schema";
import { classifyMatches, matchKey } from "@/lib/matching";
import { requireAdmin } from "@/lib/auth";
import { audit, getPrograms } from "@/lib/access";
import { programType } from "@/lib/program-types";
import { kvGet, kvSet, nextClientId } from "@/lib/data/core";
import { importTemplate } from "@/lib/import-templates";
import { getActiveFpl, getFplHistory, scheduleYearOn } from "@/lib/fpl";
import { canonicalCharacteristic } from "@/lib/csbg-catalog";
import { revertHmisSync } from "@/lib/hmis";
import { annualizeEntry, INCOME_PERIODS, type IncomePeriod } from "@/lib/income";
import { fmt, shortDate, todayIso } from "@/lib/format";

const MAX_FILE_BYTES = 4 * 1024 * 1024; // keep in step with serverActions.bodySizeLimit
const MAX_ROWS = 2000;

export interface ParseResult {
  ok: boolean;
  message?: string;
  headers?: string[];
  rows?: string[][];
}

/** Read an uploaded CSV/XLSX (base64) into a header row + string grid. No writes. */
export async function parseImportFile(filename: string, base64: string): Promise<ParseResult> {
  await requireAdmin();

  const buf = Buffer.from(String(base64 ?? ""), "base64");
  if (buf.length === 0) return { ok: false, message: "That file looks empty — pick a CSV or XLSX export." };
  if (buf.length > MAX_FILE_BYTES) return { ok: false, message: "Files up to 4 MB are supported — split larger exports." };

  const sheet = await readSheet(buf);
  if (!sheet) return { ok: false, message: `“${filename}” doesn't look like a CSV or XLSX file.` };

  const { headers, rows } = sheet;
  if (headers.length === 0 || rows.length === 0) {
    return { ok: false, message: "The sheet needs a header row plus at least one data row." };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, message: `That's ${fmt(rows.length)} rows — imports cap at ${fmt(MAX_ROWS)} per file. Split the export.` };
  }
  return { ok: true, headers, rows };
}

export interface ImportSummary {
  ok: boolean;
  message: string;
  imported: number;
  updated: number;
  skipped: number;
  /** rows held in the duplicate review queue — resolved on the Data page */
  queued: number;
  errors: string[];
  /** rows that landed with something worth reporting — e.g. an existing client
      enrolled in an additional program. Not failures; shown apart from errors. */
  notes: string[];
}

const fail = (message: string): ImportSummary =>
  ({ ok: false, message, imported: 0, updated: 0, skipped: 0, queued: 0, errors: [], notes: [] });

const num = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null; // blank cell is "no value", not zero — skip the row with a reason
  const n = Number(t.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2026-05" | "2026-05-12" | "5/2026" | "5/12/2026" | "May 2026" → "2026-05" (or null). */
function parseMonth(s: string): string | null {
  const v = s.trim().toLowerCase();
  let m = v.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return monthOf(m[1], m[2]);
  m = v.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
  if (m) return monthOf(m[2], m[1]);
  m = v.match(/^([a-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m) {
    const idx = MONTH_NAMES.findIndex((n) => m![1].startsWith(n));
    if (idx !== -1) return monthOf(m[2], String(idx + 1));
  }
  return null;
}

function monthOf(year: string, month: string): string | null {
  const mo = Number(month);
  if (mo < 1 || mo > 12) return null;
  return `${year}-${String(mo).padStart(2, "0")}`;
}

/** "2026-06-08" | "6/8/2026" | "6/8/26" → ISO date (or null). */
function parseDateIso(s: string): string | null {
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, mo, day, yr] = m;
  const year = yr.length === 2 ? `20${yr}` : yr;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

const isYes = (s: string): boolean => ["yes", "y", "true", "1", "x"].includes(s.trim().toLowerCase());
const isNo = (s: string): boolean => ["no", "n", "false", "0", "none"].includes(s.trim().toLowerCase());

/* "Monthly" | "per month" | "biweekly" | "yearly" … → income period id (or null). */
const PERIOD_ALIASES: Record<string, IncomePeriod> = {
  annual: "annual", annually: "annual", yearly: "annual", year: "annual", yr: "annual",
  monthly: "monthly", month: "monthly", mo: "monthly", "per month": "monthly",
  weekly: "weekly", week: "weekly", wk: "weekly", "per week": "weekly",
  biweekly: "biweekly", "bi-weekly": "biweekly", "every two weeks": "biweekly", fortnightly: "biweekly",
  "twice-monthly": "twice-monthly", "twice monthly": "twice-monthly", "twice a month": "twice-monthly",
  semimonthly: "twice-monthly", "semi-monthly": "twice-monthly",
};
const parsePeriod = (s: string): IncomePeriod | null =>
  PERIOD_ALIASES[s.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;

/** Commit a parsed spreadsheet. Per-row validation — good rows land, bad rows skip with a reason. */
export async function commitImport(
  templateId: string,
  filename: string,
  mapping: Record<string, number>,
  rows: string[][],
  constants: Record<string, string> = {},
): Promise<ImportSummary> {
  const user = await requireAdmin();

  const tpl = importTemplate(templateId);
  if (!tpl) return fail("Pick an import template first.");
  if (!Array.isArray(rows) || rows.length === 0) return fail("Nothing to import — the file had no data rows.");
  if (rows.length > MAX_ROWS) return fail(`Imports cap at ${fmt(MAX_ROWS)} rows per file.`);
  const constOf = (key: string): string => String(constants?.[key] ?? "").trim();
  for (const f of tpl.fields) {
    const mapped = Number.isInteger(mapping[f.key]) && mapping[f.key] >= 0;
    if (f.required && !mapped && !constOf(f.key)) {
      return fail(`Map a column to “${f.label}” — or set a fixed value for it — before importing.`);
    }
  }

  // A field's value comes from its mapped column; a blank cell (or an unmapped
  // field) falls back to the fixed value set for the whole file, if any.
  const cell = (row: string[], key: string): string => {
    const idx = mapping[key];
    if (Number.isInteger(idx) && idx >= 0) {
      const v = String(row[idx] ?? "").trim();
      if (v !== "") return v;
    }
    return constOf(key);
  };

  let imported = 0;
  let updated = 0;
  const errors: string[] = [];
  const notes: string[] = [];
  const createdClientIds: string[] = []; // tagged with the import job id below → enables undo
  // What this import added to clients that already existed — those records carry
  // no import_job_id, so undo reverses them from here (see ImportAdditions).
  const additions: ImportAdditions = { enrollments: [], serviceLogIds: [] };
  // Near-matches held for human review ("conflicts queue — nothing merges silently").
  const held: Array<{ rowNo: number; payload: HeldClientPayload; candidateIds: string[] }> = [];
  const skip = (rowNo: number, why: string) => errors.push(`Row ${rowNo}: ${why}`);
  const note = (rowNo: number, what: string) => notes.push(`Row ${rowNo}: ${what}`);

  if (tpl.id === "clients") {
    // ---- client migration (legacy-system cutover) ----
    const programs = await getPrograms();
    const programByRef = new Map<string, string>();
    for (const p of programs) {
      programByRef.set(p.id.toLowerCase(), p.id);
      programByRef.set(p.short.toLowerCase(), p.id);
      programByRef.set(p.name.toLowerCase(), p.id);
    }
    const candidates = await db.select({
      id: t.clients.id, first: t.clients.first, last: t.clients.last,
      dob: t.clients.dob, phone: t.clients.phone,
    }).from(t.clients);
    // Exact identity (normalized name + DOB) → the client already on file. A
    // repeat of the same person is NOT a duplicate to drop: a legacy export
    // lists someone once per program, so the row's job becomes additive —
    // enroll them in the program they're missing and log the service that came
    // with it. Grows as rows create clients, so a second row for the same
    // person in one file enrolls them rather than creating a twin.
    const byKey = new Map(candidates.map((c) => [matchKey(c), c.id]));
    // Current enrollments, so a program is only added when genuinely missing.
    const enrolledByClient = new Map<string, string[]>();
    for (const cp of await db.select().from(t.clientPrograms)) {
      enrolledByClient.set(cp.clientId, [...(enrolledByClient.get(cp.clientId) ?? []), cp.programId]);
    }
    // Service-log idempotency: re-importing the same sheet must not stack a
    // second copy of an entry already on record. Keyed WITHOUT the note, unlike
    // the service-history template — the note here is generated rather than
    // taken from the sheet, so one person + service + date is one fact however
    // the row reached us (new client or additional enrollment).
    const logSeen = new Set(
      (await db.select({
        clientId: t.serviceLog.clientId, code: t.serviceLog.code, date: t.serviceLog.date,
      }).from(t.serviceLog)).map((r) => `${r.clientId}|${r.code}|${r.date}`));
    const org = (await db.select().from(t.organization).where(eq(t.organization.id, 1)))[0];
    const active = await getActiveFpl(); // default when a row names no guideline year
    const schedules = await getFplHistory();
    const scheduleYears = new Set(schedules.map((s) => s.year));
    // AR 3.0 taxonomy — a service reference resolves by code or exact label
    const serviceByRef = new Map<string, string>();
    for (const s of await db.select().from(t.services)) {
      serviceByRef.set(s.code.toLowerCase(), s.code);
      serviceByRef.set(s.label.toLowerCase(), s.code);
    }
    // caseworker column resolves by staff name, username, or initials
    const staffByRef = new Map<string, string>();
    for (const u of await db.select().from(t.users).where(eq(t.users.active, 1))) {
      staffByRef.set(u.name.toLowerCase(), u.id);
      staffByRef.set(u.username.toLowerCase(), u.id);
      staffByRef.set(u.initials.toLowerCase(), u.id);
      staffByRef.set(u.id.toLowerCase(), u.id);
    }
    // legacy-ID linkage: a (system, id) pair already on file means the row was
    // imported before — idempotent re-imports skip it by ID, not by name. The
    // value is the client that owns the pair (null once a row held for review
    // claims it), so a pair already pointing at THIS person can fall through to
    // the additive path instead of being read as somebody else's record.
    const extPairs = new Map<string, string | null>(
      (await db.select().from(t.clientExternalIds))
        .map((r) => [`${r.system}|${r.externalId.toLowerCase()}`, r.clientId]));
    const now = new Date().toISOString();
    const today = todayIso();
    // characteristics canonicalize where possible; unmappable values import
    // as-is and surface on the Reports data-quality panel for cleanup
    const canonOr = (code: string, v: string): string | null =>
      v === "" ? null : canonicalCharacteristic(code, v) ?? v;

    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2;
      const first = cell(row, "first");
      const last = cell(row, "last");
      if (!first || !last) { skip(rowNo, "missing first or last name"); continue; }
      const dob = parseDateIso(cell(row, "dob"));
      if (!dob) { skip(rowNo, `date of birth “${cell(row, "dob")}” — use a format like 2001-05-14`); continue; }
      const key = matchKey({ first, last, dob });
      // Already on file? Validate the rest of the row first, then take the
      // additive path below — the program and service still have to land.
      const existingId = byKey.get(key);
      const programRef = cell(row, "program");
      const programId = programByRef.get(programRef.toLowerCase());
      if (!programId) { skip(rowNo, programRef ? `no program matches “${programRef}”` : "missing program"); continue; }
      const income = num(cell(row, "income"));
      // Income period: a non-annual figure is annualized for the FPL math and
      // the ORIGINAL amount is preserved on the income worksheet.
      const periodRaw = cell(row, "incomePeriod");
      let period: IncomePeriod = "annual";
      if (periodRaw) {
        const canon = parsePeriod(periodRaw);
        if (!canon) { skip(rowNo, `income period “${periodRaw}” — use Annual, Monthly, Weekly, Biweekly, or Twice-monthly`); continue; }
        period = canon;
      }
      const rawIncome = income !== null && income > 0 ? income : 0;
      const annualIncome = period === "annual" ? Math.round(rawIncome) : Math.round(annualizeEntry(rawIncome, period));
      const periodLabel = INCOME_PERIODS.find((pp) => pp.id === period)?.label ?? period;
      const worksheet = period !== "annual" && rawIncome > 0
        ? {
            entries: [{ source: `Imported (${periodLabel.toLowerCase()})`, amount: Math.round(rawIncome * 100) / 100, period }],
            lookbackDays: org?.incomeLookbackDays ?? 90,
            annualized: annualIncome,
          }
        : undefined;
      const hhSizeRaw = num(cell(row, "hhSize"));
      const hhSize = hhSizeRaw !== null ? Math.min(12, Math.max(1, Math.round(hhSizeRaw))) : 1;
      const enrolledRaw = cell(row, "enrolled");
      const enrolled = enrolledRaw ? parseDateIso(enrolledRaw) : today;
      if (!enrolled) { skip(rowNo, `enrollment date “${enrolledRaw}” — use a format like 2025-10-12`); continue; }
      // Poverty-guideline year: a bare year must match a configured schedule;
      // a date (or month) resolves to the schedule IN FORCE that day — so a
      // mapped assessment/certification date column pins each row correctly.
      // Blank (and no fixed value) pins to the active schedule.
      const fplYearRaw = cell(row, "fplYear");
      let fplYear = active.year;
      if (fplYearRaw) {
        if (/^\d{4}$/.test(fplYearRaw)) {
          const y = Number(fplYearRaw);
          if (!scheduleYears.has(y)) {
            skip(rowNo, `poverty-guideline year “${fplYearRaw}” isn't a configured FPL schedule`);
            continue;
          }
          fplYear = y;
        } else {
          const month = parseMonth(fplYearRaw);
          const iso = parseDateIso(fplYearRaw) ?? (month ? `${month}-01` : null);
          if (!iso) {
            skip(rowNo, `poverty-guideline year “${fplYearRaw}” — use a year (2024) or a date like 2024-06-08`);
            continue;
          }
          const inferred = scheduleYearOn(schedules, iso);
          if (inferred === null) {
            skip(rowNo, `${iso} predates the oldest configured FPL schedule — add the older schedule in Settings → FPL`);
            continue;
          }
          fplYear = inferred;
        }
      }
      // Service attribution: an optional per-row (or fixed) service logs one
      // service_log entry on the new client. Validate before anything lands.
      const serviceRef = cell(row, "service");
      const serviceCode = serviceRef ? serviceByRef.get(serviceRef.toLowerCase()) : undefined;
      if (serviceRef && !serviceCode) { skip(rowNo, `no service matches “${serviceRef}” — use an AR 3.0 code or exact label`); continue; }
      const serviceDateRaw = cell(row, "serviceDate");
      const serviceDate = serviceDateRaw ? parseDateIso(serviceDateRaw) : enrolled;
      if (!serviceDate) { skip(rowNo, `service date “${serviceDateRaw}” — use a format like 2026-01-15`); continue; }
      // Caseworker assignment: resolves by name/username/initials; blank = importer
      const caseworkerRaw = cell(row, "caseworker");
      let caseworkerId = user.id;
      if (caseworkerRaw) {
        const match = staffByRef.get(caseworkerRaw.toLowerCase());
        if (!match) { skip(rowNo, `no staff member matches “${caseworkerRaw}” — use their name, username, or initials`); continue; }
        caseworkerId = match;
      }
      // Legacy-ID linkage: keeps the source system's record ID as a durable
      // cross-reference and makes re-imports of the same export idempotent
      const legacyIdRaw = cell(row, "legacyId");
      const legacySystem = (cell(row, "legacySystem") || "legacy").trim().toLowerCase();
      const legacyPair = legacyIdRaw ? `${legacySystem}|${legacyIdRaw.toLowerCase()}` : null;
      if (legacyPair && extPairs.has(legacyPair)) {
        // Linked to the very person this row names → the multi-program case;
        // fall through so the extra enrollment lands. Linked to anyone else (or
        // to a row already held for review) stays a skip — that's a conflict.
        const owner = extPairs.get(legacyPair);
        if (!owner || owner !== existingId) {
          skip(rowNo, `legacy ID “${legacyIdRaw}” (${legacySystem}) is already linked to ${owner ?? "another imported row"}`);
          continue;
        }
      }
      const externalId = legacyIdRaw ? { system: legacySystem, id: legacyIdRaw } : undefined;
      // Remaining All Characteristics Report fields (C3/C5/C7/C8/D13 + the C4
      // custom field) — the same canonicalize-or-keep treatment the C1/C6/D9/D11
      // columns get, so imported records can be report-complete on day one.
      const edu = canonOr("C3", cell(row, "edu"));
      const work = canonOr("C8", cell(row, "work"));
      const military = canonOr("C7", cell(row, "military"));
      const incomeSrc = canonOr("D13", cell(row, "incomeSrc"));
      // C5b stores the insurance SOURCE, with "None" meaning uninsured
      const insuranceRaw = cell(row, "insurance");
      const insurance = insuranceRaw === "" ? null
        : isNo(insuranceRaw) || insuranceRaw.trim().toLowerCase() === "uninsured" ? "None"
        : canonOr("C5b-source", insuranceRaw);
      const disabilityRaw = cell(row, "disability");
      let disability: number | null = null;
      if (disabilityRaw) {
        if (isYes(disabilityRaw)) disability = 1;
        else if (isNo(disabilityRaw)) disability = 0;
        else { skip(rowNo, `disability “${disabilityRaw}” — use Yes or No (blank = unknown)`); continue; }
      }
      const dyRaw = cell(row, "disconnectedYouth");
      const custom: Record<string, string> = {};
      if (dyRaw) {
        if (isYes(dyRaw)) custom.disconnectedYouth = "Yes";
        else if (isNo(dyRaw)) custom.disconnectedYouth = "No";
        else { skip(rowNo, `disconnected youth “${dyRaw}” — use Yes or No (blank = unknown)`); continue; }
      }

      // ---- Already on file: add the program, never rewrite the person ----
      // A client enrolled in more than one program appears once per program in a
      // legacy export. Identity is settled (exact name + DOB), so this row adds
      // the missing enrollment and its service and leaves every stored
      // characteristic alone — a sheet must not silently overwrite case notes,
      // income, or a pinned guideline year on an established record.
      if (existingId) {
        const already = enrolledByClient.get(existingId) ?? [];
        const addedProgram = !already.includes(programId);
        if (addedProgram) {
          await db.insert(t.clientPrograms).values({ clientId: existingId, programId });
          enrolledByClient.set(existingId, [...already, programId]);
          additions.enrollments.push({ clientId: existingId, programId });
        }
        let addedService = false;
        if (serviceCode) {
          const dupKey = `${existingId}|${serviceCode}|${serviceDate}`;
          if (!logSeen.has(dupKey)) {
            const [logged] = await db.insert(t.serviceLog).values({
              date: serviceDate,
              clientId: existingId,
              code: serviceCode,
              programId,
              staffId: user.id,
              note: "Imported service — existing client record",
            }).returning({ id: t.serviceLog.id });
            logSeen.add(dupKey);
            if (logged) additions.serviceLogIds.push(logged.id);
            addedService = true;
          }
        }
        if (externalId) {
          await db.insert(t.clientExternalIds)
            .values({ system: externalId.system, externalId: externalId.id, clientId: existingId, linkedAt: now, linkedBy: user.id })
            .onConflictDoNothing();
          extPairs.set(legacyPair!, existingId);
        }
        // Nothing new to add is the genuine re-import case — say so plainly
        // rather than reporting an update that changed nothing.
        if (addedProgram || addedService) {
          const what = addedProgram && addedService ? `enrolled in ${programId} and a service logged`
            : addedProgram ? `enrolled in ${programId}`
            : "a service logged";
          note(rowNo, `${first} ${last} (${dob}) is already on file as ${existingId} — ${what}`);
          updated++;
        } else {
          skip(rowNo, `${first} ${last} (${dob}) is already on file as ${existingId} and enrolled in ${programId} — nothing to add`);
        }
        continue;
      }

      // Not an exact record, but close to one (same last name + DOB, or a
      // near-miss first name)? Hold the row for human review instead of
      // creating a possible duplicate — resolved on the Data page.
      const { possible } = classifyMatches({ first, last, dob, phone: cell(row, "phone") || null }, candidates);
      if (possible.length > 0) {
        held.push({
          rowNo,
          payload: {
            kind: "client",
            client: {
              first, last, dob,
              phone: cell(row, "phone") || null,
              address: cell(row, "address") || null,
              county: cell(row, "county") || null,
              sex: canonOr("C1", cell(row, "sex")),
              race: canonOr("C6", cell(row, "race")),
              housing: canonOr("D11", cell(row, "housing")),
              hhType: canonOr("D9", cell(row, "hhType")),
              hhSize,
              edu, work, insurance, military, disability, incomeSrc,
              caseworkerId,
              custom,
              income: annualIncome,
              incomeWorksheet: worksheet,
              enrolled,
              fplYear,
            },
            programId,
            serviceCode: serviceCode || undefined,
            serviceDate: serviceCode ? serviceDate : undefined,
            externalId,
          },
          candidateIds: possible.map((m) => m.client.id),
        });
        if (legacyPair) extPairs.set(legacyPair, null);
        continue;
      }

      const clientId = await nextClientId();
      await db.insert(t.clients).values({
        id: clientId,
        first,
        last,
        dob,
        phone: cell(row, "phone") || null,
        address: cell(row, "address") || null,
        county: cell(row, "county") || null,
        sex: canonOr("C1", cell(row, "sex")),
        race: canonOr("C6", cell(row, "race")),
        housing: canonOr("D11", cell(row, "housing")),
        hhType: canonOr("D9", cell(row, "hhType")),
        hhSize,
        edu, work, insurance, military, disability, incomeSrc,
        income: annualIncome,
        incomeWorksheet: worksheet,
        caseworkerId,
        enrolled,
        fplYear,
        nextFollowUp: null,
        flags: ["Migrated record — verify characteristics"],
        custom,
        status: "active",
        createdAt: now,
      });
      await db.insert(t.clientPrograms).values({ clientId, programId });
      if (serviceCode) {
        await db.insert(t.serviceLog).values({
          date: serviceDate,
          clientId,
          code: serviceCode,
          programId,
          staffId: user.id,
          note: "Imported with client record",
        });
        logSeen.add(`${clientId}|${serviceCode}|${serviceDate}`);
      }
      if (externalId) {
        await db.insert(t.clientExternalIds)
          .values({ system: externalId.system, externalId: externalId.id, clientId, linkedAt: now, linkedBy: user.id })
          .onConflictDoNothing();
        extPairs.set(legacyPair!, clientId);
      }
      // A later row naming this same person now resolves to the record just
      // created — it adds a second program instead of a duplicate client.
      byKey.set(key, clientId);
      enrolledByClient.set(clientId, [programId]);
      createdClientIds.push(clientId);
      imported++;
    }
  } else if (tpl.id === "services") {
    // ---- service-history backfill (legacy-system export) ----
    // Clients resolve by legacy ID (client_external_ids linkage from the
    // migration), a Trellis ID, or an exact unambiguous name (+DOB).
    const bySystemId = new Map<string, string>();
    const byIdAlone = new Map<string, string | null>(); // null = ambiguous across systems
    for (const r of await db.select().from(t.clientExternalIds)) {
      const idLower = r.externalId.toLowerCase();
      bySystemId.set(`${r.system}|${idLower}`, r.clientId);
      byIdAlone.set(idLower, byIdAlone.has(idLower) && byIdAlone.get(idLower) !== r.clientId ? null : r.clientId);
    }
    const allClients = await db.select({
      id: t.clients.id, first: t.clients.first, last: t.clients.last, dob: t.clients.dob,
    }).from(t.clients);
    const byTrellisId = new Map(allClients.map((c) => [c.id.toLowerCase(), c.id]));
    const byName = new Map<string, Array<{ id: string; dob: string }>>();
    for (const c of allClients) {
      const k = `${c.first} ${c.last}`.trim().toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), { id: c.id, dob: c.dob }]);
    }
    const programs = await getPrograms();
    const programByRef = new Map<string, string>();
    for (const p of programs) {
      programByRef.set(p.id.toLowerCase(), p.id);
      programByRef.set(p.short.toLowerCase(), p.id);
      programByRef.set(p.name.toLowerCase(), p.id);
    }
    const enrolledPrograms = new Map<string, string[]>();
    for (const cp of await db.select().from(t.clientPrograms)) {
      enrolledPrograms.set(cp.clientId, [...(enrolledPrograms.get(cp.clientId) ?? []), cp.programId]);
    }
    const serviceByRef = new Map<string, string>();
    for (const svc of await db.select().from(t.services)) {
      serviceByRef.set(svc.code.toLowerCase(), svc.code);
      serviceByRef.set(svc.label.toLowerCase(), svc.code);
    }
    // idempotency: an entry identical in (client, code, date, note) is the
    // same historical fact — re-importing the export must not double-log it
    const logSeen = new Set(
      (await db.select({
        clientId: t.serviceLog.clientId, code: t.serviceLog.code,
        date: t.serviceLog.date, note: t.serviceLog.note,
      }).from(t.serviceLog)).map((r) => `${r.clientId}|${r.code}|${r.date}|${r.note}`));

    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2;
      const serviceRef = cell(row, "service");
      const code = serviceRef ? serviceByRef.get(serviceRef.toLowerCase()) : undefined;
      if (!code) { skip(rowNo, serviceRef ? `no service matches “${serviceRef}” — use an AR 3.0 code or exact label` : "missing service"); continue; }
      const date = parseDateIso(cell(row, "date"));
      if (!date) { skip(rowNo, `service date “${cell(row, "date")}” — use a format like 2026-01-15`); continue; }

      // resolve the client
      const ref = cell(row, "legacyId");
      let clientId: string | undefined;
      if (ref) {
        const refLower = ref.toLowerCase();
        clientId = byTrellisId.get(refLower);
        if (!clientId) {
          const system = cell(row, "legacySystem").trim().toLowerCase();
          if (system) {
            clientId = bySystemId.get(`${system}|${refLower}`);
          } else {
            const only = byIdAlone.get(refLower);
            if (only === null) { skip(rowNo, `legacy ID “${ref}” is linked in more than one system — set the Legacy system`); continue; }
            clientId = only ?? undefined;
          }
        }
        if (!clientId) { skip(rowNo, `no client is linked to legacy ID “${ref}” — run the client migration first`); continue; }
      } else {
        const nm = cell(row, "name");
        if (!nm) { skip(rowNo, "missing client reference — map a legacy ID or name column"); continue; }
        const dobRaw = cell(row, "dob");
        const dobIso = dobRaw ? parseDateIso(dobRaw) : null;
        if (dobRaw && !dobIso) { skip(rowNo, `date of birth “${dobRaw}” — use a format like 2001-05-14`); continue; }
        const candidates = byName.get(nm.trim().toLowerCase()) ?? [];
        const matched = dobIso ? candidates.filter((c) => c.dob === dobIso) : candidates;
        if (matched.length === 0) { skip(rowNo, `no client matches “${nm}”${dobIso ? ` born ${dobIso}` : ""}`); continue; }
        if (matched.length > 1) { skip(rowNo, `“${nm}” matches ${matched.length} clients — map a DOB or legacy-ID column`); continue; }
        clientId = matched[0].id;
      }

      // resolve the program: explicit column/fixed value, else the client's
      // only enrollment — ambiguity is a skip, never a guess
      const progRef = cell(row, "program");
      let programId: string | undefined;
      if (progRef) {
        programId = programByRef.get(progRef.toLowerCase());
        if (!programId) { skip(rowNo, `no program matches “${progRef}”`); continue; }
      } else {
        const enrolled = enrolledPrograms.get(clientId) ?? [];
        if (enrolled.length === 1) programId = enrolled[0];
        else { skip(rowNo, `${clientId} is enrolled in ${enrolled.length} programs — map a program column or set one for the file`); continue; }
      }

      const note = cell(row, "note");
      const dupKey = `${clientId}|${code}|${date}|${note}`;
      if (logSeen.has(dupKey)) { skip(rowNo, `already in the service log (same client, service, date, and note)`); continue; }
      await db.insert(t.serviceLog).values({ date, clientId, code, programId, staffId: user.id, note });
      logSeen.add(dupKey);
      imported++;
    }
    revalidatePath("/services");
  } else if (tpl.id === "pantry-agencies") {
    // ---- member-agency roster (Primarius 2.0 agency export or any list) ----
    const programs = await getPrograms();
    const owning = programs.find((p) => (programType(p.type).caps as string[]).includes("pantry"));
    if (!owning) return fail("Add a Food Bank / Pantry program first — the roster needs a program to belong to.");
    const agencies = await db.select().from(t.pantryAgencies);
    const byId = new Map(agencies.map((a) => [a.id.toLowerCase(), a]));
    const byName = new Map(agencies.map((a) => [a.name.trim().toLowerCase(), a]));
    let nextNo = agencies.reduce((m, a) => {
      const n = Number(a.id.replace("P-", ""));
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);

    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2;
      const name = cell(row, "name");
      if (!name) { skip(rowNo, "missing agency name"); continue; }
      const ref = cell(row, "id");
      const existing = (ref && byId.get(ref.toLowerCase())) || byName.get(name.toLowerCase());
      const fields = {
        name,
        town: cell(row, "town"),
        county: cell(row, "county"),
        contact: cell(row, "contact"),
        phone: cell(row, "phone"),
      };
      if (existing) {
        // refresh: non-empty cells win, blank cells keep what's on file
        await db.update(t.pantryAgencies).set({
          name: fields.name,
          town: fields.town || existing.town,
          county: fields.county || existing.county,
          contact: fields.contact || existing.contact,
          phone: fields.phone || existing.phone,
        }).where(eq(t.pantryAgencies.id, existing.id));
        byName.delete(existing.name.trim().toLowerCase());
        const refreshed = { ...existing, ...fields };
        byName.set(name.toLowerCase(), refreshed);
        byId.set(existing.id.toLowerCase(), refreshed);
        updated++;
      } else {
        const id = "P-" + String(++nextNo).padStart(3, "0");
        const created = { id, programId: owning.id, ...fields, compliance: "current" };
        await db.insert(t.pantryAgencies).values(created);
        byId.set(id.toLowerCase(), created);
        byName.set(name.toLowerCase(), created);
        imported++;
      }
    }
  } else if (tpl.id === "pantry") {
    const agencies = await db.select().from(t.pantryAgencies);
    const byRef = new Map<string, (typeof agencies)[number]>();
    for (const a of agencies) {
      byRef.set(a.id.toLowerCase(), a);
      byRef.set(a.name.toLowerCase(), a);
    }
    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2; // 1-based + header row
      const ref = cell(row, "agency");
      const agency = byRef.get(ref.toLowerCase());
      if (!agency) { skip(rowNo, ref ? `no member agency matches “${ref}”` : "missing agency"); continue; }
      const month = parseMonth(cell(row, "month"));
      if (!month) { skip(rowNo, `month “${cell(row, "month")}” — use a format like 2026-05`); continue; }
      const hh = num(cell(row, "households"));
      const lbs = num(cell(row, "lbs"));
      // mirror the manual enterReport contract: a received report has real positive figures
      if (hh === null || lbs === null) { skip(rowNo, "households and pounds must be numbers"); continue; }
      if (hh <= 0 || lbs <= 0) { skip(rowNo, "households and pounds must both be above zero"); continue; }
      const existing = (await db.select().from(t.pantryReports)
        .where(and(eq(t.pantryReports.agencyId, agency.id), eq(t.pantryReports.month, month))))[0];
      if (existing) {
        await db.update(t.pantryReports)
          .set({ status: "received", households: Math.round(hh), lbs: Math.round(lbs) })
          .where(eq(t.pantryReports.id, existing.id));
        updated++;
      } else {
        await db.insert(t.pantryReports)
          .values({ agencyId: agency.id, month, status: "received", households: Math.round(hh), lbs: Math.round(lbs) });
        imported++;
      }
    }
  } else if (tpl.id === "seminars") {
    const seminars = await db.select().from(t.seminars);
    const seminarById = new Map(seminars.map((s) => [s.id, s]));
    const byRef = new Map<string, (typeof seminars)[number]>();
    for (const s of seminars) {
      byRef.set(s.id.toLowerCase(), s);
      byRef.set(s.title.toLowerCase(), s);
    }
    const attendees = await db.select().from(t.seminarAttendees);
    const seen = new Set(attendees.map((a) => `${a.seminarId}|${a.name.toLowerCase()}`));
    // exact-unique name match against active clients — ambiguous names stay unlinked
    const clientsByName = new Map<string, string[]>();
    for (const c of await db.select().from(t.clients)) {
      if (c.status !== "active") continue;
      const key = `${c.first} ${c.last}`.toLowerCase();
      clientsByName.set(key, [...(clientsByName.get(key) ?? []), c.id]);
    }
    const touched = new Set<string>();
    let autoMatched = 0;

    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2;
      const ref = cell(row, "seminar");
      const sem = byRef.get(ref.toLowerCase());
      if (!sem) { skip(rowNo, ref ? `no seminar matches “${ref}”` : "missing seminar"); continue; }
      const name = cell(row, "name");
      if (!name) { skip(rowNo, "missing attendee name"); continue; }
      const key = `${sem.id}|${name.toLowerCase()}`;
      if (seen.has(key)) { skip(rowNo, `${name} is already on the ${sem.id} list`); continue; }
      const matches = clientsByName.get(name.toLowerCase()) ?? [];
      const clientId = matches.length === 1 ? matches[0] : null;
      await db.insert(t.seminarAttendees).values({
        seminarId: sem.id,
        name,
        clientId,
        applicationId: null,
        intakeStatus: clientId ? "enrolled" : "not-started",
      });
      seen.add(key);
      touched.add(sem.id);
      if (clientId) autoMatched++;
      imported++;
    }

    // `registered` is the headcount, independent of attendee rows — a sign-in sheet of
    // already-registered people must not inflate it. Reconcile to the larger of the
    // existing count and the actual roster size instead of bumping per imported row.
    for (const semId of touched) {
      const roster = (await db.select().from(t.seminarAttendees).where(eq(t.seminarAttendees.seminarId, semId))).length;
      const current = seminarById.get(semId)?.registered ?? 0;
      if (roster > current) {
        await db.update(t.seminars).set({ registered: roster }).where(eq(t.seminars.id, semId));
      }
    }
    if (autoMatched > 0) {
      const m = await kvGet<{ auto: number; staff: number; awaiting: number; silent: number }>(
        "matching", { auto: 0, staff: 0, awaiting: 0, silent: 0 });
      await kvSet("matching", { ...m, auto: m.auto + autoMatched });
    }
  } else if (tpl.id === "volunteers") {
    // volunteers — hours accumulate on existing rows; new volunteers need a program
    const vols = await db.select().from(t.volunteers);
    const byName = new Map(vols.map((v) => [v.name.toLowerCase(), v]));
    const programs = await getPrograms();
    const programByRef = new Map<string, string>();
    for (const p of programs) {
      programByRef.set(p.id.toLowerCase(), p.id);
      programByRef.set(p.short.toLowerCase(), p.id);
      programByRef.set(p.name.toLowerCase(), p.id);
    }
    let nextVolNo = vols.reduce((m, v) => {
      const n = Number(v.id.replace("V-", ""));
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    const stats = await kvGet<{ totalHoursFY: number; lowIncomeHoursFY: number; activeVolunteers: number }>(
      "volStats", { totalHoursFY: 0, lowIncomeHoursFY: 0, activeVolunteers: 0 });

    for (const [i, row] of rows.entries()) {
      const rowNo = i + 2;
      const name = cell(row, "name");
      if (!name) { skip(rowNo, "missing volunteer name"); continue; }
      const hours = num(cell(row, "hours"));
      if (hours === null || hours <= 0) { skip(rowNo, "hours must be a number above zero"); continue; }
      const h = Math.round(hours);
      const rawDate = cell(row, "date");
      const dateIso = rawDate ? parseDateIso(rawDate) : null;
      if (rawDate && !dateIso) { skip(rowNo, `shift date “${rawDate}” — use a format like 2026-06-08`); continue; }

      const existing = byName.get(name.toLowerCase());
      if (existing) {
        existing.hoursFY += h;
        if (dateIso && (!existing.lastShift || dateIso > existing.lastShift)) existing.lastShift = dateIso;
        await db.update(t.volunteers)
          .set({ hoursFY: existing.hoursFY, lastShift: existing.lastShift })
          .where(eq(t.volunteers.id, existing.id));
        stats.totalHoursFY += h;
        if (existing.lowIncome === 1) stats.lowIncomeHoursFY += h;
        updated++;
      } else {
        const programRef = cell(row, "program");
        const programId = programByRef.get(programRef.toLowerCase());
        if (!programId) {
          skip(rowNo, programRef
            ? `no program matches “${programRef}” for new volunteer ${name}`
            : `new volunteer ${name} needs a program column`);
          continue;
        }
        const lowIncome = isYes(cell(row, "lowIncome")) ? 1 : 0;
        const id = `V-${++nextVolNo}`;
        const vol = { id, name, clientId: null, lowIncome, role: cell(row, "role"), hoursFY: h, lastShift: dateIso };
        await db.insert(t.volunteers).values(vol);
        await db.insert(t.volunteerPrograms).values({ volunteerId: id, programId });
        byName.set(name.toLowerCase(), vol);
        stats.activeVolunteers += 1;
        stats.totalHoursFY += h;
        if (lowIncome === 1) stats.lowIncomeHoursFY += h;
        imported++;
      }
    }
    await kvSet("volStats", stats);
  } else {
    return fail(`No importer handles the “${tpl.name}” template yet.`);
  }

  const skipped = errors.length;
  const queued = held.length;
  const [job] = await db.insert(t.importJobs).values({
    at: new Date().toISOString(),
    template: tpl.id,
    filename,
    imported,
    updated,
    skipped,
    staffId: user.id,
    detail: errors.slice(0, 12).join(" · "),
    // only recorded when the import touched pre-existing clients
    additions: additions.enrollments.length || additions.serviceLogIds.length ? additions : null,
  }).returning({ id: t.importJobs.id });
  // Tag the rows this client-migration import created so it can be undone later.
  if (createdClientIds.length > 0) {
    await db.update(t.clients).set({ importJobId: job.id }).where(inArray(t.clients.id, createdClientIds));
  }
  // Near-matches land in the duplicate review queue, tied back to this file/row.
  const now = new Date().toISOString();
  for (const h of held) {
    await db.insert(t.matchReviews).values({
      at: now,
      source: "sheets",
      sourceRef: `${filename} row ${h.rowNo}`,
      payload: h.payload,
      candidateIds: h.candidateIds,
    });
  }
  if (imported + updated > 0) {
    await db.update(t.integrations).set({ lastSync: shortDate(todayIso()) }).where(eq(t.integrations.id, "sheets"));
  }
  await audit(user.id, "data.import", "integration", "sheets",
    `${tpl.name} · ${filename} · ${imported} imported, ${updated} updated, ${skipped} skipped` +
    (queued ? `, ${queued} held for duplicate review` : ""));
  revalidatePath("/", "layout");

  const queuedNote = queued
    ? ` ${fmt(queued)} row${queued === 1 ? " is" : "s are"} held for duplicate review below — nothing merges silently.`
    : "";
  const enrolledNote = additions.enrollments.length
    ? ` ${fmt(additions.enrollments.length)} existing client${additions.enrollments.length === 1 ? " was" : "s were"} enrolled in an additional program.`
    : "";
  const message = imported + updated > 0
    ? `Import complete — ${fmt(imported)} added and ${fmt(updated)} updated in ${tpl.target}${skipped ? `; ${fmt(skipped)} row${skipped === 1 ? "" : "s"} skipped` : ""}.${enrolledNote}${queuedNote}`
    : queued > 0
      ? `No rows imported directly.${queuedNote}`
      : `Nothing imported — all ${fmt(skipped)} row${skipped === 1 ? "" : "s"} were skipped. Check the row notes below.`;
  return { ok: true, message, imported, updated, skipped, queued, errors, notes };
}

/* ---------- Duplicate review queue ---------- */

export type ReviewAction =
  | { type: "link"; clientId: string }   // use the existing record
  | { type: "create" }                   // genuinely a different person
  | { type: "dismiss" };                 // drop the incoming row entirely

/** Resolve a held match-review row. Every resolution is audited; link/create
    update the staff-resolved matching counter shown on the Data page. */
export async function resolveMatchReview(id: number, action: ReviewAction): Promise<{ ok: boolean; message: string }> {
  const user = await requireAdmin();

  const review = (await db.select().from(t.matchReviews).where(eq(t.matchReviews.id, id)))[0];
  if (!review || review.status !== "pending") {
    return { ok: false, message: "That review is gone or already resolved — refresh the page." };
  }
  const p = review.payload;
  const person = `${p.client.first} ${p.client.last}`;
  const now = new Date().toISOString();

  let resolution: string;
  let resolvedClientId: string | null = null;
  let message: string;

  if (action.type === "link") {
    // server-side re-check: only a listed candidate can be linked
    if (!review.candidateIds.includes(action.clientId)) {
      return { ok: false, message: "That client isn't a candidate for this review." };
    }
    const existing = (await db.select().from(t.clients).where(eq(t.clients.id, action.clientId)))[0];
    if (!existing) return { ok: false, message: `Client ${action.clientId} no longer exists.` };
    const enrolled = (await db.select().from(t.clientPrograms)
      .where(eq(t.clientPrograms.clientId, existing.id)))
      .some((m) => m.programId === p.programId);
    if (!enrolled) {
      await db.insert(t.clientPrograms).values({ clientId: existing.id, programId: p.programId });
    }
    if (p.serviceCode && p.serviceDate) {
      await db.insert(t.serviceLog).values({
        date: p.serviceDate,
        clientId: existing.id,
        code: p.serviceCode,
        programId: p.programId,
        staffId: user.id,
        note: "Imported row matched to existing record on review",
      });
    }
    if (p.externalId) {
      await db.insert(t.clientExternalIds)
        .values({ system: p.externalId.system, externalId: p.externalId.id, clientId: existing.id, linkedAt: now, linkedBy: user.id })
        .onConflictDoNothing();
    }
    resolution = "linked";
    resolvedClientId = existing.id;
    message = `${person} matched to existing record ${existing.id} — no duplicate created.`;
  } else if (action.type === "create") {
    // the queue may be stale — never create a second exact record
    const candidates = await db.select({
      id: t.clients.id, first: t.clients.first, last: t.clients.last, dob: t.clients.dob,
    }).from(t.clients);
    const key = matchKey(p.client);
    if (candidates.some((c) => matchKey(c) === key)) {
      return { ok: false, message: `${person} (${p.client.dob}) now has an exact client record — use “Use existing record” instead.` };
    }
    const clientId = await nextClientId();
    await db.insert(t.clients).values({
      id: clientId,
      ...p.client,
      caseworkerId: p.client.caseworkerId ?? user.id,
      nextFollowUp: null,
      flags: ["Migrated record — verify characteristics"],
      custom: p.client.custom ?? {},
      status: "active",
      createdAt: now,
    });
    await db.insert(t.clientPrograms).values({ clientId, programId: p.programId });
    if (p.serviceCode && p.serviceDate) {
      await db.insert(t.serviceLog).values({
        date: p.serviceDate, clientId, code: p.serviceCode, programId: p.programId,
        staffId: user.id, note: "Imported with client record (cleared duplicate review)",
      });
    }
    if (p.externalId) {
      await db.insert(t.clientExternalIds)
        .values({ system: p.externalId.system, externalId: p.externalId.id, clientId, linkedAt: now, linkedBy: user.id })
        .onConflictDoNothing();
    }
    resolution = "created";
    resolvedClientId = clientId;
    message = `${person} confirmed as a new client — record ${clientId} created.`;
  } else {
    resolution = "dismissed";
    message = `The incoming row for ${person} was dismissed — nothing was created.`;
  }

  await db.update(t.matchReviews).set({
    status: "resolved",
    resolution,
    resolvedClientId,
    resolvedBy: user.id,
    resolvedAt: now,
  }).where(eq(t.matchReviews.id, id));

  const m = await kvGet<{ auto: number; staff: number; awaiting: number; silent: number }>(
    "matching", { auto: 0, staff: 0, awaiting: 0, silent: 0 });
  await kvSet("matching", { ...m, staff: m.staff + 1 });

  await audit(user.id, "data.match-review", "match-review", String(id),
    `${review.sourceRef || review.source} · ${person} → ${resolution}${resolvedClientId ? ` (${resolvedClientId})` : ""}`);
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export interface UndoResult { ok: boolean; message: string; removed: number; }

/** Reverse a client-migration import: delete the clients it created (tagged with
    its job id) plus their client-owned rows, and unlink any soft references.
    Only client-migration imports are reversible — the other importers upsert
    into shared aggregates, which can't be cleanly un-applied. */
export async function undoImport(jobId: number): Promise<UndoResult> {
  const user = await requireAdmin();

  const job = (await db.select().from(t.importJobs).where(eq(t.importJobs.id, jobId)))[0];
  if (!job) return { ok: false, message: "That import couldn't be found — it may already have been undone.", removed: 0 };
  if (job.template !== "clients" && job.template !== "hmis") {
    return { ok: false, message: "Undo is only available for client-migration imports and HMIS syncs.", removed: 0 };
  }

  // An HMIS sync also touches records that already existed — links, queued
  // reviews, blank-filled fields. Deleting those clients would be wrong, so the
  // sync recorded what it did and undo reverses exactly that.
  const reverted = job.template === "hmis" ? await revertHmisSync(job.hmisUndo) : null;
  // Additions to clients that already existed: those records must SURVIVE the
  // undo (they predate the import), so only the enrollment and the service rows
  // this job created for them come back out.
  const additions = job.additions;
  const reverseAdditions = async () => {
    for (const e of additions?.enrollments ?? []) {
      await db.delete(t.clientPrograms)
        .where(and(eq(t.clientPrograms.clientId, e.clientId), eq(t.clientPrograms.programId, e.programId)));
    }
    if (additions?.serviceLogIds?.length) {
      await db.delete(t.serviceLog).where(inArray(t.serviceLog.id, additions.serviceLogIds));
    }
  };
  const addedBack = additions?.enrollments.length ?? 0;
  const addedNote = addedBack
    ? ` ${fmt(addedBack)} added program enrollment${addedBack === 1 ? "" : "s"} on existing clients ${addedBack === 1 ? "was" : "were"} also removed.`
    : "";

  const targets = await db.select({ id: t.clients.id }).from(t.clients).where(eq(t.clients.importJobId, jobId));
  const ids = targets.map((c) => c.id);
  if (ids.length === 0) {
    // An import can legitimately create nobody and still have work to reverse —
    // e.g. a sheet that only added second-program enrollments to existing clients.
    await reverseAdditions();
    await db.delete(t.importJobs).where(eq(t.importJobs.id, jobId));
    const undone = reverted ? ` ${reverted}` : "";
    if (addedBack || reverted) {
      await audit(user.id, job.template === "hmis" ? "hmis.sync.undo" : "data.import.undo",
        "integration", job.template === "hmis" ? "hmis" : "sheets",
        `${job.filename} · no client records created`
        + (addedBack ? ` · ${addedBack} added enrollment${addedBack === 1 ? "" : "s"} reversed` : "")
        + (reverted ? ` · ${reverted}` : ""));
      revalidatePath("/", "layout");
    }
    return {
      ok: true,
      removed: 0,
      message: `No client records were created by that ${job.template === "hmis" ? "sync" : "import"} — the log entry was cleared.${undone}${addedNote}`,
    };
  }
  await reverseAdditions();

  // Client-owned rows (NOT NULL client_id) — remove outright.
  await db.delete(t.clientPrograms).where(inArray(t.clientPrograms.clientId, ids));
  await db.delete(t.serviceLog).where(inArray(t.serviceLog.clientId, ids));
  await db.delete(t.outcomeLog).where(inArray(t.outcomeLog.clientId, ids));
  // External-system links belong to the client, not to the other system: leaving
  // them behind orphans a row pointing at a deleted client, and for HMIS it also
  // makes the next sync treat that person as already linked.
  await db.delete(t.clientExternalIds).where(inArray(t.clientExternalIds.clientId, ids));
  // Independent records that merely reference a client — unlink, don't destroy.
  await db.update(t.applications).set({ clientId: null }).where(inArray(t.applications.clientId, ids));
  await db.update(t.loans).set({ clientId: null }).where(inArray(t.loans.clientId, ids));
  await db.update(t.seminarAttendees).set({ clientId: null }).where(inArray(t.seminarAttendees.clientId, ids));
  await db.update(t.students).set({ clientId: null }).where(inArray(t.students.clientId, ids));
  await db.update(t.volunteers).set({ clientId: null }).where(inArray(t.volunteers.clientId, ids));
  await db.update(t.wxJobs).set({ clientId: null }).where(inArray(t.wxJobs.clientId, ids));
  // Finally the clients, and the import log entry.
  await db.delete(t.clients).where(inArray(t.clients.id, ids));
  await db.delete(t.importJobs).where(eq(t.importJobs.id, jobId));

  await audit(user.id, job.template === "hmis" ? "hmis.sync.undo" : "data.import.undo",
    "integration", job.template === "hmis" ? "hmis" : "sheets",
    `${job.filename} · ${ids.length} imported client${ids.length === 1 ? "" : "s"} removed`
    + (addedBack ? `, ${addedBack} added enrollment${addedBack === 1 ? "" : "s"} reversed` : "")
    + (reverted ? ` · ${reverted}` : ""));
  revalidatePath("/", "layout");

  return {
    ok: true,
    removed: ids.length,
    message: `${job.template === "hmis" ? "Sync" : "Import"} undone — removed ${fmt(ids.length)} imported client`
      + `${ids.length === 1 ? "" : "s"} and their enrollments.${reverted ? ` ${reverted}` : ""}${addedNote}`,
  };
}

