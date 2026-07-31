/* Reports filters — plain, DB-free parsing shared by the Reports page, the
   export route, and the client filter bar. Turns URL search params into a
   resolved period + program/domain/service scope.

   Design note: the DEFAULT (no params) is the authoritative CSBG submission
   view — current fiscal year, every program, pre-system baselines included.
   The moment any scope is applied we flip to `live = true`, which tells the
   rollup to drop the imported pre-system baselines and count purely from
   in-system records. That keeps the federal numbers correct and the filtered
   numbers honest — they are two different questions. */

import { currentFY, fiscalYearEndingIn, customPeriod, type FiscalYear } from "@/lib/format";

export interface ReportFilters {
  /** Resolved reporting window (FiscalYear shape — real FY or synthesized range). */
  period: FiscalYear;
  /** Period preset id, normalized. 'current' | 'prior' | 'fy<YYYY>' | 'ytd' | 'custom'. */
  preset: string;
  /** Program ids to scope to; empty = all programs. */
  programIds: string[];
  /** Service-domain ids to scope Section A to; empty = all domains. */
  domains: string[];
  /** Specific service codes to scope Section A to; empty = all (data-layer; not surfaced in v1 UI). */
  serviceCodes: string[];
  /** True once any scope is applied → rollup excludes pre-system baselines. */
  live: boolean;
  /** Canonical querystring (no leading '?') for export links and router.push. */
  query: string;
}

export type RawParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
const csv = (v: string | string[] | undefined): string[] => {
  const s = one(v);
  return s ? [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))] : [];
};
const isIso = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isoOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The fiscal calendar year the current FY ends in (e.g. 2026 for FY26). */
export function currentFyYear(fyStart: string, now = new Date()): number {
  return Number(currentFY(now, fyStart).label.replace(/\D/g, ""));
}

/** Period options for the filter dropdown (newest first). */
export function periodOptions(fyStart: string, now = new Date()): Array<{ id: string; label: string }> {
  const y = currentFyYear(fyStart, now);
  return [
    { id: "current", label: `Current — ${fiscalYearEndingIn(y, fyStart, now).label}` },
    { id: "prior", label: `Prior — ${fiscalYearEndingIn(y - 1, fyStart, now).label}` },
    { id: `fy${y - 2}`, label: fiscalYearEndingIn(y - 2, fyStart, now).label },
    { id: "ytd", label: `Calendar year to date (${now.getFullYear()})` },
    { id: "custom", label: "Custom date range…" },
  ];
}

/** Parse search params into a resolved filter set. Pure (no DB); pass the
    agency's FY start month and, in tests, a fixed `now`. */
export function resolveFilters(params: RawParams, fyStart: string, now = new Date()): ReportFilters {
  const y = currentFyYear(fyStart, now);
  const cur = currentFY(now, fyStart);
  const from = one(params.from);
  const to = one(params.to);
  let preset = one(params.period) || "current";

  let period = cur;
  if (preset === "prior") period = fiscalYearEndingIn(y - 1, fyStart, now);
  else if (/^fy\d{4}$/.test(preset)) period = fiscalYearEndingIn(Number(preset.slice(2)), fyStart, now);
  else if (preset === "ytd") period = customPeriod(`${now.getFullYear()}-01-01`, isoOf(now), now);
  else if (preset === "custom" && isIso(from) && isIso(to) && from <= to) period = customPeriod(from, to, now);
  else preset = "current"; // unknown preset or invalid custom range → fall back to the federal view

  const programIds = csv(params.programs);
  const domains = csv(params.domains);
  const serviceCodes = csv(params.services);
  const live = preset !== "current" || programIds.length > 0 || domains.length > 0 || serviceCodes.length > 0;

  const qp = new URLSearchParams();
  if (preset !== "current") qp.set("period", preset);
  if (preset === "custom") { qp.set("from", from); qp.set("to", to); }
  if (programIds.length) qp.set("programs", programIds.join(","));
  if (domains.length) qp.set("domains", domains.join(","));
  if (serviceCodes.length) qp.set("services", serviceCodes.join(","));

  return { period, preset, programIds, domains, serviceCodes, live, query: qp.toString() };
}
