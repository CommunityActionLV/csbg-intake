/* Reports vertical — plain serializable shapes shared by the server rollup,
   the page/client UI, and the export route. No server imports here. */

export interface MiniRow {
  label: string;
  n: number;
}

export interface MiniTableData {
  title: string;     // "C1 · Sex"
  code: string;      // "Sec. C1"
  charCode?: string; // catalog characteristic code ("C1", "C5b-source") — drift lookup
  rows: MiniRow[];
  total: number;     // the characteristic's reportable universe (Σ rows incl. Unknown)
}

/** Data-quality panel entry: completeness gaps + answer-list drift for one characteristic. */
export interface DriftEntry {
  code: string;
  title: string;
  total: number;
  unknown: number; // values reported as Unknown/Not Reported
  drift: Array<{ value: string; count: number }>; // stored values that failed to canonicalize
}

export interface DomainBar {
  domain: string; // domain id ("hn")
  code: string;   // "SRV 5"
  name: string;   // "Health and Nutrition"
  count: number;
}

export interface TopService {
  code: string;
  label: string;
  count: number;
}

export interface FnpiRow {
  code: string;
  label: string;
  served: number;
  target: number;
  actual: number;
}

/** ROMA agency goal + the FNPI indicators that measure it (Org Standard 4.3). */
export interface RomaGoalRow {
  id: number;
  title: string;
  description: string;
  indicators: FnpiRow[];
  served: number;
  target: number;
  actual: number;
}

export interface ReportRollup {
  fy: { label: string; short: string; range: string; pctElapsed: number };
  orgName: string;
  /** True when a filter is active → figures are counted live from in-system
      records only, EXCLUDING the imported pre-system (CAP60/legacy) baselines.
      False = the authoritative CSBG submission view. */
  live: boolean;
  /** Human-readable scope applied (e.g. "Programs: Weatherization · Services: Housing"); "" when unfiltered. */
  scopeNote: string;
  generated: string; // ISO date
  agency: { individualsServed: number; householdsServed: number; newThisFY: number };
  clientCount: number;
  readyPct: number; // % of enrolled records at 100% completeness
  /** Section C top line: unduplicated individuals/households about whom one or
      more characteristics were obtained (live records; kv baselines excluded). */
  sectionCTotals: { individuals: number; households: number };
  dataQuality: DriftEntry[];
  roma: RomaGoalRow[];
  characteristics: MiniTableData[];
  srvByDomain: DomainBar[];
  topServices: TopService[];
  fnpi: FnpiRow[];
}

/** Derived FNPI metrics — single source of truth for the table, CSV, and packet.
    'Achieving outcome' = actual ÷ number served; 'target accuracy' = actual ÷ target. */
export function fnpiStats(f: FnpiRow, pctElapsed: number): { achieving: number; accuracy: number; onPace: boolean } {
  const achieving = f.served > 0 ? Math.round((f.actual / f.served) * 100) : 0;
  const accuracy = f.target > 0 ? Math.round((f.actual / f.target) * 100) : 0;
  return { achieving, accuracy, onPace: accuracy >= pctElapsed - 5 };
}
