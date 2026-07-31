import "server-only";
import { db, t } from "@/db";
import { getOrg, getEnabledIntakeFields, kvGet } from "@/lib/data/core";
import { fplStatusFor } from "@/lib/fpl";
import { completenessPct } from "@/lib/completeness";
import { ageFromDob, todayIso } from "@/lib/format";
import {
  FPL_BANDS, domainById, fnpiByCode, characteristicByCode, canonicalCharacteristic,
} from "@/lib/csbg-catalog";
import type { Client } from "@/db/schema";
import type { MiniRow, MiniTableData, DriftEntry, ReportRollup } from "./types";
import { resolveFilters, type ReportFilters } from "./filters";

/* ============================================================
   Live CSBG Annual Report 3.0 rollup (Module 3 Sections A/B/C).
   Used by the Reports page and the /reports/export download route.

   DEFAULT (no filters) is the authoritative submission view: the
   current fiscal year, every program, ALL enrolled clients, with
   the imported pre-system (CAP60/legacy) baselines layered in.

   When a filter is applied (`filters.live`), the rollup narrows to
   the chosen period / programs / service domains and counts PURELY
   from in-system records — the pre-system baselines are dropped and
   the top-line KPIs are recomputed live, because those imports carry
   no date/program/service dimension to slice on. Two different
   questions, kept honestly separate.

   Section C tallies use the INSTRUMENT'S canonical answer
   strings (canonicalCharacteristic) — display-list edits can't
   skew federal output; values that fail to canonicalize land in
   Unknown/Not Reported and are surfaced as data-quality drift.
   ============================================================ */

const UNKNOWN = "Unknown / Not Reported";

/** Tally values into fixed categories. Null / unmatched answers roll into an
    "Unknown / Not Reported" row (that's exactly how they land on the federal form). */
function tally(values: Array<string | null | undefined>, cats: string[], filterZero = true): MiniRow[] {
  const m = new Map<string, number>(cats.map((c) => [c, 0]));
  let unknown = 0;
  for (const v of values) {
    if (v && m.has(v)) m.set(v, (m.get(v) ?? 0) + 1);
    else unknown++;
  }
  const rows = cats.map((c) => ({ label: c, n: m.get(c) ?? 0 })).filter((r) => !filterZero || r.n > 0);
  if (unknown > 0 || !filterZero) rows.push({ label: UNKNOWN, n: unknown });
  return rows;
}

function ageBandOf(dob: string): string {
  // C2 bands, exactly as printed on the instrument
  const a = ageFromDob(dob);
  return a <= 4 ? "0-4" : a <= 17 ? "5-17" : a <= 24 ? "18-24" : a <= 34 ? "25-34"
    : a <= 44 ? "35-44" : a <= 64 ? "45-64" : a <= 84 ? "65-84" : "85 and older";
}

function hhSizeBandOf(size: number): string {
  // D10 options
  return size <= 1 ? "Single Person" : size === 2 ? "Two" : size === 3 ? "Three"
    : size === 4 ? "Four" : size === 5 ? "Five" : "Six or more";
}

/** Canonicalize one characteristic across clients, collecting drift (stored
    values that don't map to any instrument option). */
function canonColumn(
  code: string,
  clients: Client[],
  read: (c: Client) => string | null | undefined,
  drift: Map<string, Map<string, number>>,
): Array<string | null> {
  return clients.map((c) => {
    const raw = read(c);
    if (raw == null || String(raw).trim() === "") return null;
    const canon = canonicalCharacteristic(code, String(raw));
    if (canon == null) {
      const m = drift.get(code) ?? new Map<string, number>();
      m.set(String(raw), (m.get(String(raw)) ?? 0) + 1);
      drift.set(code, m);
    }
    return canon;
  });
}

const optionsOf = (code: string): string[] => characteristicByCode(code)?.options ?? [];

/** Trim a service label to its headline form ("Utility payment assistance (including …)" → "utility payment assistance"). */
function shortServiceLabel(label: string): string {
  const base = label.replace(/\s*\(.*\)\s*$/, "").trim();
  return base.charAt(0).toLowerCase() + base.slice(1);
}

export async function buildRollup(filters?: ReportFilters): Promise<ReportRollup> {
  const org = await getOrg();
  const f = filters ?? resolveFilters({}, org.fyStart);
  const fy = f.period;
  const live = f.live;
  // Section C tallies over ALL active clients for the federal view; a chosen
  // period (not "current") additionally narrows to clients enrolled within it.
  const periodScoped = f.preset !== "current";
  const fields = await getEnabledIntakeFields();

  let clients = (await db.select().from(t.clients)).filter((c) => c.status === "active");
  if (f.programIds.length) {
    const scope = new Set(f.programIds);
    const inScope = new Set(
      (await db.select().from(t.clientPrograms)).filter((m) => scope.has(m.programId)).map((m) => m.clientId),
    );
    clients = clients.filter((c) => inScope.has(c.id));
  }
  if (periodScoped) clients = clients.filter((c) => c.enrolled >= fy.start && c.enrolled <= fy.end);
  const n = clients.length;
  // New enrollments within the reporting window (live-computable either way).
  const newInPeriod = clients.filter((c) => c.enrolled >= fy.start && c.enrolled <= fy.end).length;

  // Records report-ready — % of enrolled records with every report field captured (computed live).
  const readyPct = n === 0 ? 100
    : Math.round((clients.filter((c) => completenessPct(c, fields) === 100).length / n) * 100);

  // ---------- Section C — All Characteristics Report (tallied live) ----------
  // D12 — % FPL band computed with each client's PINNED guideline year (point-in-time integrity).
  const fplBands = await Promise.all(
    clients.map((c) => fplStatusFor(c.income, c.hhSize, c.fplYear, org.csbgCeiling).then((s) => s.band)),
  );

  // Top-line unduplicated denominators: people/households about whom one or
  // more characteristics were obtained. A client record is one individual AND
  // one household in this model.
  const CHAR_FIELDS = (c: Client) => [
    c.sex, c.race, c.edu, c.work, c.insurance, c.military,
    c.disability != null ? String(c.disability) : null,
    c.hhType, c.housing, c.incomeSrc,
  ];
  const withAnyCharacteristic = clients.filter(
    (c) => !!c.dob || CHAR_FIELDS(c).some((v) => v != null && String(v).trim() !== ""),
  ).length;
  const sectionCTotals = { individuals: withAnyCharacteristic, households: withAnyCharacteristic };

  // Reportable-universe slices
  const age = (c: Client) => ageFromDob(c.dob);
  const edu524 = clients.filter((c) => age(c) >= 5 && age(c) <= 24);
  const edu25 = clients.filter((c) => age(c) >= 25);
  const youth1424 = clients.filter((c) => age(c) >= 14 && age(c) <= 24);
  const adults18 = clients.filter((c) => age(c) >= 18);
  const insured = clients.filter((c) => c.insurance != null && c.insurance !== "" && c.insurance !== "None");

  const drift = new Map<string, Map<string, number>>();
  const characteristics: MiniTableData[] = [
    { title: "C1 · Gender identity", code: "Sec. C1", charCode: "C1", total: n,
      rows: tally(canonColumn("C1", clients, (c) => c.sex, drift), optionsOf("C1"), false) },
    { title: "C2 · Age", code: "Sec. C2", charCode: "C2", total: n,
      rows: tally(clients.map((c) => ageBandOf(c.dob)), optionsOf("C2"), false) },
    { title: "C3 · Education (ages 5-24)", code: "Sec. C3", charCode: "C3", total: edu524.length,
      rows: tally(canonColumn("C3", edu524, (c) => c.edu, drift), optionsOf("C3"), false) },
    { title: "C3 · Education (ages 25+)", code: "Sec. C3", charCode: "C3", total: edu25.length,
      rows: tally(canonColumn("C3", edu25, (c) => c.edu, drift), optionsOf("C3"), false) },
    { title: "C4 · Disconnected youth (14-24)", code: "Sec. C4", charCode: "C4", total: youth1424.length,
      rows: tally(youth1424.map((c) => {
        const v = c.custom?.["disconnectedYouth"];
        return v === "Yes" || v === "No" ? v : null;
      }), optionsOf("C4"), false) },
    { title: "C5a · Disability", code: "Sec. C5a", charCode: "C5a", total: n,
      rows: tally(clients.map((c) => (c.disability === 1 ? "Yes" : c.disability === 0 ? "No" : null)),
        optionsOf("C5a"), false) },
    { title: "C5b · Health insurance", code: "Sec. C5b", charCode: "C5b", total: n,
      rows: tally(clients.map((c) =>
        c.insurance == null || c.insurance === "" ? null : c.insurance === "None" ? "No" : "Yes"),
        optionsOf("C5b"), false) },
    { title: "C5b · Insurance source (insured)", code: "Sec. C5b.1-7", charCode: "C5b-source", total: insured.length,
      rows: tally(canonColumn("C5b-source", insured, (c) => c.insurance, drift), optionsOf("C5b-source"), false) },
    { title: "C6 · Race & ethnicity", code: "Sec. C6", charCode: "C6", total: n,
      rows: tally(canonColumn("C6", clients, (c) => c.race, drift), optionsOf("C6"), false) },
    { title: "C7 · Military status", code: "Sec. C7", charCode: "C7", total: n,
      rows: tally(canonColumn("C7", clients, (c) => c.military, drift), optionsOf("C7"), false) },
    { title: "C8 · Work status (18+)", code: "Sec. C8", charCode: "C8", total: adults18.length,
      rows: tally(canonColumn("C8", adults18, (c) => c.work, drift), optionsOf("C8"), false) },
    { title: "D9 · Household type", code: "Sec. D9", charCode: "D9", total: n,
      rows: tally(canonColumn("D9", clients, (c) => c.hhType, drift), optionsOf("D9"), false) },
    { title: "D10 · Household size", code: "Sec. D10", charCode: "D10", total: n,
      rows: tally(clients.map((c) => hhSizeBandOf(c.hhSize)), optionsOf("D10"), false) },
    { title: "D11 · Housing", code: "Sec. D11", charCode: "D11", total: n,
      rows: tally(canonColumn("D11", clients, (c) => c.housing, drift), optionsOf("D11"), false) },
    { title: "D12 · Income level (% FPL)", code: "Sec. D12", charCode: "D12", total: n,
      rows: tally(fplBands, [...FPL_BANDS], false) },
    { title: "D13 · Income sources", code: "Sec. D13", charCode: "D13", total: n,
      rows: tally(canonColumn("D13", clients, (c) => c.incomeSrc, drift), optionsOf("D13"), false) },
  ];

  // Data-quality panel: per-characteristic Unknown counts (completeness gaps)
  // + stored values that failed to canonicalize (answer-list drift). Every
  // tally is Σ(categories)+Unknown = its reportable universe by construction,
  // so drift and unknowns are the two ways numbers go missing.
  const dataQuality: DriftEntry[] = characteristics.map((m) => ({
    code: m.code,
    title: m.title,
    total: m.total,
    unknown: m.rows.find((r) => r.label === UNKNOWN)?.n ?? 0,
    drift: [...(drift.get(m.charCode ?? "") ?? new Map<string, number>())]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  }));

  // ---------- Section A — services by domain ----------
  // The kv aggregates are the imported pre-system baseline (CAP60/legacy history);
  // everything recorded in THIS system's service log is layered on top live, so
  // "Service logged — mapped to <code> for the rollup" is actually true. Under a
  // filter the baseline is dropped (it carries no date/program/service dimension).
  const allServices = await db.select().from(t.services);
  const domainOf = new Map(allServices.map((s) => [s.code, s.domain]));
  const progScope = new Set(f.programIds);
  const domainScope = new Set(f.domains);
  const codeScope = new Set(f.serviceCodes);
  const fyLog = (await db.select().from(t.serviceLog)).filter((s) =>
    s.date >= fy.start && s.date <= fy.end &&
    (progScope.size === 0 || progScope.has(s.programId)) &&
    (codeScope.size === 0 || codeScope.has(s.code)) &&
    (domainScope.size === 0 || domainScope.has(domainOf.get(s.code) ?? "")));
  const liveByDomain = new Map<string, number>();
  const liveByCode = new Map<string, number>();
  const servedIds = new Set<string>();
  for (const s of fyLog) {
    const dom = domainOf.get(s.code);
    if (dom) liveByDomain.set(dom, (liveByDomain.get(dom) ?? 0) + 1);
    liveByCode.set(s.code, (liveByCode.get(s.code) ?? 0) + 1);
    servedIds.add(s.clientId);
  }

  const baseline = new Map(live ? [] : (await kvGet<Array<{ domain: string; count: number }>>("srvByDomain", []))
    .map((d) => [d.domain, d.count] as const));
  const srvByDomain = [...new Set([...baseline.keys(), ...liveByDomain.keys()])]
    .flatMap((id) => {
      const dom = domainById(id);
      const count = (baseline.get(id) ?? 0) + (liveByDomain.get(id) ?? 0);
      return dom && count > 0 ? [{ domain: id, code: dom.code, name: dom.name, count }] : [];
    })
    .sort((a, b) => b.count - a.count);

  const serviceLabels = new Map(allServices.map((s) => [s.code, s.label]));
  const topBaseline = new Map(live ? [] : (await kvGet<Array<{ code: string; count: number }>>("topServices", []))
    .map((s) => [s.code, s.count] as const));
  const topServices = [...new Set([...topBaseline.keys(), ...liveByCode.keys()])]
    .map((code) => ({
      code,
      label: shortServiceLabel(serviceLabels.get(code) ?? code),
      count: (topBaseline.get(code) ?? 0) + (liveByCode.get(code) ?? 0),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // Top-line KPIs: the pre-system baseline for the federal view; recomputed
  // live from the filtered service log when scoped (1 client record = 1 individual
  // = 1 household in this model, so served individuals and households coincide).
  const agency = live
    ? { individualsServed: servedIds.size, householdsServed: servedIds.size, newThisFY: newInPeriod }
    : await kvGet<{ individualsServed: number; householdsServed: number; newThisFY: number }>(
        "agency", { individualsServed: 0, householdsServed: 0, newThisFY: 0 });

  // ---------- Section B — Individual & Family NPIs ----------
  // Counts come live from the client-level outcome log (unduplicated individuals
  // per indicator this FY); fnpi_progress contributes only the FY targets.
  // served = clients with any recorded outcome; actual = clients who achieved it.
  const fyOutcomes = (await db.select().from(t.outcomeLog)).filter((o) =>
    o.date >= fy.start && o.date <= fy.end && (progScope.size === 0 || progScope.has(o.programId)));
  const servedBy = new Map<string, Set<string>>();
  const achievedBy = new Map<string, Set<string>>();
  for (const o of fyOutcomes) {
    if (!servedBy.has(o.code)) servedBy.set(o.code, new Set());
    servedBy.get(o.code)!.add(o.clientId);
    if (o.status === "achieved") {
      if (!achievedBy.has(o.code)) achievedBy.set(o.code, new Set());
      achievedBy.get(o.code)!.add(o.clientId);
    }
  }
  // fnpi_progress carries the FY targets, plus any served/actual a pre-system database
  // recorded as aggregates (the seed sets these to 0, so a fresh install is purely live).
  // Layer live outcome-log counts on top of that baseline — the same pre-system-baseline
  // pattern Section A uses for srvByDomain/topServices.
  const targets = new Map((await db.select().from(t.fnpiProgress)).map((p) => [p.code, p]));
  const fnpi = [...new Set([...targets.keys(), ...servedBy.keys()])]
    .map((code) => {
      const base = targets.get(code);
      return {
        code,
        label: fnpiByCode(code)?.label ?? base?.label ?? code,
        served: (live ? 0 : base?.served ?? 0) + (servedBy.get(code)?.size ?? 0),
        target: base?.target ?? 0,
        actual: (live ? 0 : base?.actual ?? 0) + (achievedBy.get(code)?.size ?? 0),
      };
    })
    .filter((f) => f.served > 0 || f.target > 0)
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  // ---------- ROMA goals (Org Standard 4.3) — goal → linked FNPI progress ----------
  const fnpiByCodeMap = new Map(fnpi.map((f) => [f.code, f]));
  const roma = (await db.select().from(t.romaGoals))
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((g) => {
      const linked = g.fnpiCodes.map((code) => fnpiByCodeMap.get(code) ?? {
        code, label: fnpiByCode(code)?.label ?? code, served: 0, target: 0, actual: 0,
      });
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        indicators: linked,
        served: linked.reduce((s, f) => s + f.served, 0),
        target: linked.reduce((s, f) => s + f.target, 0),
        actual: linked.reduce((s, f) => s + f.actual, 0),
      };
    });

  // Scope summary for the live-mode caveat shown on the page, exports, and PDF.
  const programNames = f.programIds.length
    ? (await db.select().from(t.programs))
        .filter((p) => f.programIds.includes(p.id))
        .map((p) => p.short || p.name)
    : [];
  const domainNames = f.domains.map((id) => domainById(id)?.name).filter((x): x is string => !!x);
  const scopeNote = [
    programNames.length ? `Programs: ${programNames.join(", ")}` : "",
    domainNames.length ? `Services: ${domainNames.join(", ")}` : "",
  ].filter(Boolean).join(" · ");

  return {
    fy: { label: fy.label, short: fy.short, range: fy.range, pctElapsed: fy.pctElapsed },
    orgName: org.name,
    live,
    scopeNote,
    generated: todayIso(),
    agency,
    clientCount: n,
    readyPct,
    sectionCTotals,
    dataQuality,
    roma,
    characteristics,
    srvByDomain,
    topServices,
    fnpi,
  };
}
