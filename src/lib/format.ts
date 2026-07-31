/* Shared formatting helpers — safe in both server and client components. */

export const fmt = (n: number): string => Number(n).toLocaleString("en-US");

export const money = (n: number): string => "$" + fmt(Math.round(n));

/** "Jun 9" — short date from an ISO date string (noon-anchored to dodge TZ shifts). */
export const shortDate = (iso: string): string =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "June 9, 2026" */
export const longDate = (iso: string): string =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** Today's date as "YYYY-MM-DD" (local). */
export function todayIso(): string {
  return localDateOf(new Date().toISOString());
}

/** Local "YYYY-MM-DD" calendar date for a stored ISO datetime instant. Use before
    shortDate/longDate so an evening timestamp doesn't display as the next UTC day. */
export function localDateOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM" of the month before the given ISO date — the reporting cycle
    that just closed (aggregate reports cover completed months). */
export function prevMonthYm(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** "2026-06" → "June" (or "June 2026" with year). */
export function monthName(ym: string, withYear = false): string {
  const [y, m] = ym.split("-").map(Number);
  const name = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long" });
  return withYear ? `${name} ${y}` : name;
}

export function ageFromDob(dob: string, onDate?: string): number {
  const ref = onDate ? new Date(onDate + "T12:00:00") : new Date();
  const b = new Date(dob + "T12:00:00");
  let age = ref.getFullYear() - b.getFullYear();
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age--;
  return age;
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/* ---------- Fiscal year (start month set in agency settings) ---------- */
export interface FiscalYear {
  label: string;      // "FY 2026"
  short: string;      // "FY26"
  range: string;      // "Oct 1, 2025 – Sep 30, 2026"
  shortRange: string; // "Oct 1 – Sep 30" (yearless, for the topbar chip)
  start: string;      // ISO
  end: string;        // ISO
  pctElapsed: number;
}

/** Start-month options offered on Settings → Organization. */
export const FY_START_MONTHS: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 };

/** Fiscal year containing `now` for an agency whose FY starts in `fyStart`.
    Named for the calendar year it ENDS in (federal convention: Oct 2025 –
    Sep 2026 = FY 2026); a January start coincides with the calendar year. */
export function currentFY(now = new Date(), fyStart = "October"): FiscalYear {
  const sm = FY_START_MONTHS[fyStart] ?? 9;
  const fy = sm === 0 || now.getMonth() < sm ? now.getFullYear() : now.getFullYear() + 1;
  return fiscalYearEndingIn(fy, fyStart, now);
}

/** Shared formatter: turn a [start, end] window into the FiscalYear shape.
    `now` drives pctElapsed (clamped 0–100), so a window entirely in the past
    reads 100% and one entirely in the future reads 0%. */
function fyFromWindow(label: string, short: string, start: Date, end: Date, now: Date): FiscalYear {
  const pctElapsed = Math.min(100, Math.max(0,
    Math.round(((now.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100)));
  const d = (x: Date) => x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const md = (x: Date) => x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return {
    label,
    short,
    range: `${d(start)} – ${d(end)}`,
    shortRange: `${md(start)} – ${md(end)}`,
    start: iso(start),
    end: iso(end),
    pctElapsed,
  };
}

/** The fiscal year that ENDS in calendar year `endingYear` for an agency whose
    FY starts in month `fyStart` — the building block behind currentFY() and the
    Reports "prior year" period presets. */
export function fiscalYearEndingIn(endingYear: number, fyStart = "October", now = new Date()): FiscalYear {
  const sm = FY_START_MONTHS[fyStart] ?? 9;
  const startYear = sm === 0 ? endingYear : endingYear - 1;
  const start = new Date(startYear, sm, 1);
  const end = new Date(startYear + 1, sm, 0); // last day of the month before the next FY starts
  return fyFromWindow(`FY ${endingYear}`, `FY${String(endingYear).slice(2)}`, start, end, now);
}

/** An arbitrary reporting window from two ISO dates ("YYYY-MM-DD"), for the
    Reports custom-range / calendar-YTD filters. Shares the FiscalYear shape so
    the rollup, UI, and exports treat it like any other period. */
export function customPeriod(startIso: string, endIso: string, now = new Date()): FiscalYear {
  const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, (m ?? 1) - 1, d ?? 1); };
  const start = parse(startIso);
  const end = parse(endIso);
  const d = (x: Date) => x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return fyFromWindow(`${d(start)} – ${d(end)}`, "Custom", start, end, now);
}
