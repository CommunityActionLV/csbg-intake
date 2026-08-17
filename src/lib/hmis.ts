import { and, eq, inArray } from "drizzle-orm";
import { db, t } from "@/db";
import type { HmisSyncUndo } from "@/db/schema";
import { classifyMatches, matchKey } from "@/lib/matching";
import { canonicalCharacteristic } from "@/lib/csbg-catalog";
import { getActiveFpl } from "@/lib/fpl";
import { decryptSecret } from "@/lib/secrets";

/* ID allocation lives in @/lib/data/core, which imports Next's `server-only`
   and therefore can't be imported from this (unit-testable) module — the
   caller passes the allocator in instead. */
export type ClientIdAllocator = () => Promise<string>;

/* ============================================================
   PA HMIS (Eccovia ClientTrack/CaseWorthy) sync.

   Governed by the signed PA DCED MOU (effective 2026-07-01) and the
   parties' operating understanding (CACLV ↔ PA HMIS): the named data
   elements for CACLV-owned projects are pulled into this private,
   internal-only system for CACLV's internal tracking and reporting —
   deduplicated against the client directory, imported into client
   records, and rolled into deidentified organization-wide aggregates.
   The data is never redisclosed and never used outside the agency.

   Sync behavior per HMIS person:
     already linked        → fill blank fields on the linked record
     exact name+DOB match  → auto-link (audited) + fill blanks
     near match            → hmis_reviews queue (link / create / dismiss)
     no match              → create a client record in the configured
                             HMIS program (needs a DOB; else snapshot-only)
   Local data always wins: enrichment fills ONLY empty fields.

   The transport is Eccovia's ClientTrack API (CTAPI): no OAuth2 and
   no token endpoint — two static headers on every request, and client
   listing through CRQL rather than a REST collection. Verified against
   PA_HMIS production on 2026-08-13; see
   docs/compliance/hmis-api-integration-profile.md.

   Configured in Settings → Integrations (encrypted in the database)
   or, for ops-managed installs, from the environment:
     HMIS_BASE_URL          API root (default https://api.clienttrack.net)
     HMIS_SUBSCRIPTION_KEY  Ocp-Apim-Subscription-Key
     HMIS_API_KEY           Authorization: ApiKey <key>
     HMIS_ORG_ID            optional — User Keys only
     HMIS_PAGE_SIZE         CRQL page size (default 200, max 500)
   Read-only: nothing here writes to HMIS.
   ============================================================ */

export interface HmisConfig {
  baseUrl: string;          // https only — CTAPI rejects plain HTTP
  subscriptionKey: string;
  apiKey: string;
  orgId: string;            // "" → the OrgId header is omitted entirely
  pageSize: number;         // CRQL paging only; the procedure endpoint takes none
  /** Schema-qualified stored procedure to pull clients from. Set → it is the
      client source; empty → the CRQL cmClient query is. The setting IS the
      switch; there is no separate mode. */
  storedProcedure: string;
  /** Parameters posted as the procedure's body. `{}` when it takes none. */
  storedProcedureParams: Record<string, unknown>;
}

/** Prod is the only environment the Eccovia docs expose. The PA_HMIS
    application name from the ClientTrack login URL is not part of the API URL. */
export const CTAPI_BASE_URL = "https://api.clienttrack.net";
/** CTAPI's hard ceiling on pageSize; larger values are not honoured. */
export const CTAPI_MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;

/** Records per CRQL page: 1..500, defaulting when the value isn't a number.
    Enforced here rather than at the input so a hand-edited config can't ask
    CTAPI for a page it will silently refuse to fill. */
export function effectivePageSize(value: unknown): number {
  // absent or blank is "unset", not zero: Number("") is 0, and clamping that to
  // 1 would turn a cleared form field into a one-record-per-page pull
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_PAGE_SIZE;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), CTAPI_MAX_PAGE_SIZE);
}

export function hmisConfig(): HmisConfig | null {
  const subscriptionKey = process.env.HMIS_SUBSCRIPTION_KEY ?? "";
  const apiKey = process.env.HMIS_API_KEY ?? "";
  const baseUrl = (process.env.HMIS_BASE_URL || CTAPI_BASE_URL).replace(/\/+$/, "");
  if (!subscriptionKey || !apiKey || !baseUrl) return null;
  // The environment gets the same normalization the settings form does, but it
  // cannot show an error — an unusable value is dropped with a warning rather
  // than silently becoming a request path.
  const procedure = normalizeProcedureName(process.env.HMIS_STORED_PROCEDURE ?? "");
  if (!procedure.ok) console.warn(`[hmis] HMIS_STORED_PROCEDURE ignored — ${procedure.message}`);
  const params = parseProcedureParams(process.env.HMIS_STORED_PROCEDURE_PARAMS ?? "");
  if (!params.ok) console.warn(`[hmis] HMIS_STORED_PROCEDURE_PARAMS ignored — ${params.message}`);
  return {
    baseUrl,
    subscriptionKey,
    apiKey,
    orgId: process.env.HMIS_ORG_ID ?? "",
    pageSize: effectivePageSize(process.env.HMIS_PAGE_SIZE),
    storedProcedure: procedure.ok ? procedure.value : "",
    storedProcedureParams: params.ok ? params.value : {},
  };
}

/** Connection settings saved from Settings → Integrations (kv "hmisConn").
    Both keys hold ciphertext from @/lib/secrets — the encryption key lives
    outside the database, so a dump of this table yields no usable credential.
    Neither value is ever rendered back to the browser. */
export interface HmisStoredConfig {
  baseUrl: string;
  subscriptionKey: string;  // ciphertext
  apiKey: string;           // ciphertext
  orgId: string;
  pageSize: number;
  /** Normalized at save (see normalizeProcedureName) and stored as sent — CTAPI
      echoes the name back verbatim in its errors, so it uses the exact string.
      Neither this nor the parameters are secrets: stored plainly, displayed. */
  storedProcedure?: string;
  storedProcedureParams?: Record<string, unknown>;
}

async function kvRead<T>(key: string): Promise<T | null> {
  // direct kv access — @/lib/data/core imports Next's `server-only`, which
  // this unit-testable module must not pull in
  const row = (await db.select().from(t.kv).where(eq(t.kv.key, key)))[0];
  return row ? (row.value as T) : null;
}

/** Effective connection config: Settings → Integrations when saved there,
    otherwise the HMIS_* environment variables. */
export async function getHmisConfig(): Promise<{ cfg: HmisConfig | null; source: "settings" | "environment" | null }> {
  const stored = await kvRead<Partial<HmisStoredConfig>>("hmisConn");
  if (stored?.subscriptionKey && stored.apiKey && stored.baseUrl) {
    const subscriptionKey = decryptSecret(stored.subscriptionKey);
    const apiKey = decryptSecret(stored.apiKey);
    // Both readable, or fall through to the environment: half-decrypted
    // credentials would send an empty header and read as a rejection.
    if (subscriptionKey && apiKey) {
      return {
        source: "settings",
        cfg: {
          baseUrl: stored.baseUrl.replace(/\/+$/, ""),
          subscriptionKey,
          apiKey,
          orgId: stored.orgId ?? "",
          pageSize: effectivePageSize(stored.pageSize),
          storedProcedure: stored.storedProcedure ?? "",
          storedProcedureParams: stored.storedProcedureParams ?? {},
        },
      };
    }
  }
  const env = hmisConfig();
  return { cfg: env, source: env ? "environment" : null };
}

export async function hmisConfigured(): Promise<boolean> {
  return (await getHmisConfig()).cfg !== null;
}

/** True when settings hold keys that this server's encryption key cannot read
    (a lost or rotated data/secret.key) — the settings page says so instead of
    showing a connection that cannot work. */
export async function hmisKeysUnreadable(): Promise<boolean> {
  const stored = await kvRead<Partial<HmisStoredConfig>>("hmisConn");
  if (!stored?.subscriptionKey || !stored.apiKey) return false;
  return decryptSecret(stored.subscriptionKey) === null || decryptSecret(stored.apiKey) === null;
}

/* ---------- CTAPI transport ---------- */

/** What a 401 actually meant. CTAPI answers 401 for three different problems
    and the body's prose is the only thing that separates them — one of which
    ("not available at this time") is not a credential problem at all, and reads
    as one unless it is called out. */
export type HmisAuthFailure = "subscription" | "apikey" | "procedureNotEnabled" | "unknown";

export function classifyAuthFailure(body: string): HmisAuthFailure {
  const b = (body ?? "").toLowerCase();
  if (b.includes("missing subscription key")) return "subscription";
  if (b.includes("missing or incorrect apikey")) return "apikey";
  if (b.includes("is not available at this time")) return "procedureNotEnabled";
  return "unknown";
}

/** The sentence to put in front of an operator, by cause. `procedure` names the
    procedure so the not-enabled case points at the right thing to chase. */
export function authFailureMessage(kind: HmisAuthFailure, procedure?: string | null): string {
  switch (kind) {
    case "subscription":
      return "Subscription key rejected — check the Subscription Key setting.";
    case "apikey":
      return "API key rejected — check the API Key setting.";
    case "procedureNotEnabled":
      return `Eccovia has not enabled ${procedure ? `${procedure} ` : "this stored procedure "}`
        + "for this subscription. This is NOT a credential problem — contact CaseWorthy support "
        + "to add the procedure to your execution scope.";
    default:
      return "Credentials rejected — check the subscription key and API key, and note that the two are easy to transpose.";
  }
}

/** 401 — never retried: replaying a refused key only burns the rate limit. */
export class HmisAuthError extends Error {
  readonly kind: HmisAuthFailure;
  readonly body: string;
  constructor(body = "") {
    super(`CTAPI answered 401${body ? ` — ${body}` : ""}`);
    this.name = "HmisAuthError";
    this.body = body;
    this.kind = classifyAuthFailure(body);
  }
}

/** Any other non-2xx answer, carrying the status and a truncated body. */
export class HmisHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`CTAPI answered ${status}${body ? ` — ${body}` : ""}`);
    this.name = "HmisHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Transient: CTAPI down or wobbling. Retried with backoff. */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 800;
const BODY_LIMIT = 300;

export interface HmisRequestOptions {
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Backoff base in ms (tests pass 0 to keep the suite quick). */
  retryDelayMs?: number;
}

const truncate = (s: string, n = BODY_LIMIT): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The two static headers CTAPI requires on every request, plus the optional
    organization scope. The literal `ApiKey ` prefix lives here and nowhere
    else — it is not a bearer token and CTAPI rejects `Bearer`. */
function ctapiHeaders(cfg: HmisConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": cfg.subscriptionKey,
    Authorization: `ApiKey ${cfg.apiKey}`,
    Accept: "application/json",
  };
  const orgId = cfg.orgId?.trim() ?? "";
  if (orgId) headers.OrgId = orgId;  // User Keys only; Admin Keys ignore it
  return headers;
}

export interface CtapiRequestInit {
  method?: "GET" | "POST";
  path: string;
  params?: Record<string, string>;
  /** JSON request body. Supplying one adds Content-Type exactly once — the
      headers are a single object literal, so a duplicate is not expressible. */
  body?: unknown;
  /** What this request was for, named in 5xx diagnostics. An invalid procedure
      or object answers 500 with a literally empty body, so status alone cannot
      tell a typo from a server fault — the request has to identify itself. */
  describe?: string;
}

/** One request against CTAPI: HTTPS only, both auth headers, a request timeout,
    and a bounded retry for transient statuses and network faults. 401 and every
    other 4xx fail on the first answer. Keys travel as headers only, so no key
    value can reach a URL, a message, a log line, or a thrown error. */
async function ctapiRequest(
  cfg: HmisConfig,
  init: CtapiRequestInit,
  opts: HmisRequestOptions = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const backoff = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const method = init.method ?? "GET";
  const url = new URL(cfg.baseUrl + init.path);
  if (url.protocol !== "https:") {
    throw new Error("The HMIS API base URL must use https:// — CTAPI rejects plain HTTP.");
  }
  for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
  const headers = ctapiHeaders(cfg);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoff * attempt);
      continue;
    }
    if (res.status === 401) {
      // the body is the only thing separating "wrong key" from "procedure not
      // enabled", so unlike other statuses it is read before throwing
      throw new HmisAuthError(truncate((await res.text().catch(() => "")).trim()));
    }
    if (!res.ok) {
      const text = truncate((await res.text().catch(() => "")).trim());
      if (res.status >= 500 && init.describe) {
        console.warn(`[hmis] ${init.describe} → ${res.status}${text ? ` — ${text}` : " — empty body"}`);
      }
      const err = new HmisHttpError(res.status, text);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(backoff * attempt);
      continue;
    }
    return (await res.json()) as unknown;
  }
  throw lastError ?? new Error("CTAPI request failed.");
}

/** GET wrapper — the shape every CRQL read uses. */
async function ctapiGet(
  cfg: HmisConfig,
  path: string,
  params: Record<string, string>,
  opts: HmisRequestOptions = {},
): Promise<unknown> {
  return ctapiRequest(cfg, { method: "GET", path, params }, opts);
}

/** "Hello CER from from the PA_HMIS ClientTrack environment." → "PA_HMIS".
    Anchored on the words before "ClientTrack environment", which reads both the
    documented greeting and the live one (which repeats "from"). */
export function hmisEnvironmentName(message: string): string | null {
  return message.match(/([\w.-]+)\s+ClientTrack\s+environment/i)?.[1] ?? null;
}

export interface HmisAuthTestResult {
  ok: boolean;
  /** Environment CTAPI says we reached ("PA_HMIS"), when it says so. */
  environment: string | null;
  message: string;
}

/** GET /auth/test — the only handshake CTAPI has. Reports the environment on
    success so staff can see whether they reached Prod or a sandbox. */
export async function hmisAuthTest(cfg: HmisConfig, opts: HmisRequestOptions = {}): Promise<HmisAuthTestResult> {
  try {
    const json = await ctapiGet(cfg, "/auth/test", {}, opts);
    const greeting = typeof (json as Raw)?.message === "string" ? String((json as Raw).message) : "";
    const environment = hmisEnvironmentName(greeting);
    return {
      ok: true,
      environment,
      message: environment
        ? `Connected — PA HMIS accepted the credentials on the ${environment} ClientTrack environment.`
        : `Connected — PA HMIS accepted the credentials. ${truncate(greeting || "CTAPI returned no environment name.", 160)}`,
    };
  } catch (e) {
    if (e instanceof HmisAuthError) {
      return { ok: false, environment: null, message: authFailureMessage(e.kind) };
    }
    if (e instanceof HmisHttpError) {
      return { ok: false, environment: null, message: `PA HMIS answered ${e.status}${e.body ? ` — ${e.body}` : ""}` };
    }
    return { ok: false, environment: null, message: e instanceof Error ? e.message : String(e) };
  }
}

export interface HmisProcedureTestResult {
  ok: boolean;
  /** False when no procedure is set — reported plainly, never skipped silently. */
  configured: boolean;
  procedure: string | null;
  rowCount: number;
  /** Column names the procedure returned. This is how the real output shape
      gets discovered, so it goes to the operator, not just to a log. */
  columns: string[];
  /** Distinct `relationship` values with counts — the evidence for whether a
      row is a client or a household. */
  relationships: Array<{ value: string; count: number }>;
  message: string;
}

export interface HmisConnectionTestResult {
  auth: HmisAuthTestResult;
  procedure: HmisProcedureTestResult;
}

/** Execute the configured procedure and report what came back.

    NOTE this really does run the procedure against production — that is what
    testing it means, and why the settings panel warns that whatever is named
    must be a read-only report procedure. */
export async function hmisProcedureTest(
  cfg: HmisConfig,
  opts: HmisRequestOptions = {},
): Promise<HmisProcedureTestResult> {
  const procedure = cfg.storedProcedure;
  const base = {
    configured: Boolean(procedure),
    procedure: procedure || null,
    rowCount: 0,
    columns: [] as string[],
    relationships: [] as Array<{ value: string; count: number }>,
  };
  if (!procedure) {
    return { ...base, ok: true, message: "No stored procedure set; sync will use the CRQL query." };
  }
  const params = cfg.storedProcedureParams ?? {};
  try {
    const json = await ctapiRequest(cfg, {
      method: "POST",
      path: procedurePath(procedure),
      body: params,
      describe: `stored procedure ${procedure} (parameters: ${Object.keys(params).join(", ") || "none"})`,
    }, opts);
    const result = procedureResult(json);
    const columns = columnNames(result.rows);
    const relationships = valueCounts(result.rows, "relationship").filter((r) => r.value !== "(blank)");
    const extra = result.extraTables.length > 0
      ? ` Additional result sets returned: ${result.extraTables.join(", ")}.`
      : "";
    const outputs = result.output.length > 0 ? ` ${result.output.length} output parameter(s) returned.` : "";
    if (result.rows.length > 0) {
      // the relationship spread is the open one-row-per-client vs
      // one-row-per-household question — reported, not resolved here
      const shape = relationships.length > 0
        ? ` Relationship values: ${relationships.map((r) => `${r.value} ×${r.count}`).join(", ")}.`
        : "";
      return {
        ...base,
        ok: true,
        rowCount: result.rows.length,
        columns,
        relationships,
        message: `${procedure} returned ${result.rows.length} row(s). Columns: ${columns.join(", ")}.${shape}${extra}${outputs}`,
      };
    }
    if (result.message) {
      return {
        ...base,
        ok: true,
        message: `${procedure} ran and returned a message rather than rows: ${truncate(result.message, 200)}${extra}`,
      };
    }
    return { ...base, ok: true, message: `${procedure} ran and returned an empty result (no rows).${extra}` };
  } catch (e) {
    if (e instanceof HmisAuthError) {
      return { ...base, ok: false, message: authFailureMessage(e.kind, procedure) };
    }
    if (e instanceof HmisHttpError) {
      return {
        ...base,
        ok: false,
        message: `${procedure} answered ${e.status}${e.body ? ` — ${e.body}` : " with an empty body"}`
          + (e.status >= 500 ? " — an invalid procedure name and a server fault look identical here." : ""),
      };
    }
    return { ...base, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Test connection as two independent steps, so "the credentials are fine but
    the procedure isn't enabled" never reads as one blanket failure. */
export async function hmisConnectionTest(
  cfg: HmisConfig,
  opts: HmisRequestOptions = {},
): Promise<HmisConnectionTestResult> {
  const auth = await hmisAuthTest(cfg, opts);
  return { auth, procedure: await hmisProcedureTest(cfg, opts) };
}

/* ---------- stored-procedure name and parameters ---------- */

/** schema is OPTIONAL — both `Name` and `dbo.Name` are accepted by the API and
    return identical payloads (verified live). */
const PROCEDURE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export type ProcedureNameResult = { ok: true; value: string } | { ok: false; message: string };

/** Validate a stored-procedure name, and store exactly what was typed.

    Trim only. The schema prefix is optional and is neither required nor added:
    `dbo.` is NOT prepended to a bare name, and a supplied prefix is not
    stripped. CTAPI echoes the name back verbatim in its errors, so sending
    anything other than what the user entered makes those errors confusing to
    read. An all-whitespace value is *empty* rather than invalid.

    The value lands in a URL path segment, so this is a security boundary rather
    than formatting: anything carrying `/`, `\`, `?`, `#`, `%`, `..`, whitespace
    or more than one `.` is REJECTED, never sanitized and used anyway. */
export function normalizeProcedureName(raw: string): ProcedureNameResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, value: "" };
  if (!PROCEDURE_NAME.test(trimmed)) {
    return {
      ok: false,
      message: `“${trimmed}” isn't a valid stored-procedure name — letters, digits and underscores,`
        + " with an optional schema prefix, for example C_Report_Example or dbo.C_Report_Example.",
    };
  }
  return { ok: true, value: trimmed };
}

export type ProcedureParamsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** Parse the parameters field: blank is `{}`, anything else must be JSON that
    deserializes to an object — not an array, not a scalar. Checked at save so a
    syntax error surfaces while someone is looking at the form, not at sync. */
export function parseProcedureParams(raw: string): ProcedureParamsResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      message: `Stored-procedure parameters must be valid JSON — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: `Stored-procedure parameters must be a JSON object, like {} or {"Year": 2026}.` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Request path for a stored procedure. The name is validated at save time, so
    the encoding here is belt and braces rather than the guard itself. */
export function procedurePath(qualifiedName: string): string {
  return `/crql/storedprocedures/${encodeURIComponent(qualifiedName)}`;
}

/* ---------- normalization ---------- */

type Raw = Record<string, unknown>;

const pick = (raw: Raw, keys: readonly string[]): string => {
  for (const k of keys) {
    const v = raw[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

/** "2001-05-14", "2001-05-14T00:00:00", "5/14/2001" → ISO date (or null). */
export function hmisDate(s: string): string | null {
  const v = s.trim();
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}

export interface HmisClientRow {
  hmisId: string;
  first: string;
  last: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  sex: string | null;
  race: string | null;
  veteran: string | null;
  insurance: string | null;
  incomeSrc: string | null;
  nonCash: string | null;
  services: Array<{ name: string; date: string }>;
  household: Array<{ first: string; last: string; dob: string | null }>;
}

/** Field-name-tolerant normalization of one HMIS API client object.
    Returns null when the row has no usable ID or name. */
/** The column spellings each CAP Trellis field is read from, in priority order.
    Declared once so HMIS_MAPPED_COLUMNS below cannot drift out of step with what
    the mapping actually consumes — the stored-procedure path reports every
    column it did NOT understand, and that report is only as honest as this list. */
const FIELD_KEYS = {
  // `clientID` is the live procedure's spelling — the CRQL-era list had
  // ClientID/clientId/ClientId and missed it, which drops every procedure row
  // for want of an ID even once the envelope is unwrapped correctly
  hmisId: ["ClientID", "clientID", "clientId", "client_id", "ClientId", "id", "ID"],
  first: ["FirstName", "firstName", "first_name", "first"],
  last: ["LastName", "lastName", "last_name", "last"],
  dob: ["DOB", "dob", "DateOfBirth", "dateOfBirth", "date_of_birth", "Birthdate", "birthdate"],
  gender: ["Gender", "gender", "GenderDesc"],
  sex: ["Sex", "sex", "sexGender"],
  race: ["Race", "race", "RaceDesc"],
  ethnicity: ["Ethnicity", "ethnicity"],
  email: ["Email", "email", "EmailAddress"],
  phone: ["Phone", "phone", "Telephone", "telephone", "PhoneNumber", "HomePhone"],
  veteran: ["VeteranStatus", "veteranStatus", "veteran_status", "Veteran", "veteran"],
  insurance: ["HealthInsuranceType", "healthInsurance", "InsuranceType", "insurance"],
  // the procedure's spaced keys are read by exact string — the payload mixes
  // clientID, firstName, sexGender and space-separated names in one object, so
  // there is no convention to derive and nothing is auto-camelCased
  incomeSrc: ["SourceOfIncome", "IncomeSource", "incomeSource", "income_source", "source of Cash Income"],
  nonCash: ["NonCashBenefits", "nonCashBenefits", "non_cash_benefits", "NonCash", "source of NonCash Income"],
  services: ["Services", "services"],
  household: ["FamilyMembers", "familyMembers", "household"],
} as const;

/** Columns the procedure returns that CAP Trellis has nowhere to put yet. Named
    here so they don't show up as "unmapped" noise every sync, and reported
    separately as known-but-unstored — the honest state is "arrived, not kept",
    not "unrecognized".

    `enrolled Family Members` is deliberately NOT parsed: its entries are
    `Last, First | MM/DD/YYYY` joined by commas, so the comma is both the
    intra-record and inter-record separator and the split is genuinely
    ambiguous. Household composition comes from per-client rows instead.

    `income` is deliberately not imported: it would feed FPL and eligibility
    determinations, which stays a human step behind the existing
    "verify income & eligibility" flag. */
export const HMIS_KNOWN_UNSTORED_COLUMNS: readonly string[] = [
  "enrollDate", "exitDate", "programName", "relationship", "age", "age at Enrollment",
  "income", "enrolled Family Members", "enrolled Member Count",
];

/** Every column name the mapping consumes. */
export const HMIS_MAPPED_COLUMNS: ReadonlySet<string> = new Set(Object.values(FIELD_KEYS).flat());

/** Columns we know about and deliberately don't store, so they never show up as
    "unmapped" noise: __crql_rid is a per-response sequence number (not an ID,
    never persisted), and ActiveStatus is selected by the CRQL query for its own
    sake. */
export const HMIS_IGNORED_COLUMNS: ReadonlySet<string> = new Set([
  "__crql_rid", "ActiveStatus", ...HMIS_KNOWN_UNSTORED_COLUMNS,
]);

/** Column names present across rows that the mapping doesn't consume. Sorted for
    a stable report; names only, never values. */
export function unmappedColumns(rows: Raw[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!HMIS_MAPPED_COLUMNS.has(key) && !HMIS_IGNORED_COLUMNS.has(key)) seen.add(key);
    }
  }
  return [...seen].sort();
}

/** Known-but-unstored columns actually present in this response — reported so
    "we received it and kept nothing" is visible rather than implied. */
export function knownUnstoredColumns(rows: Raw[]): string[] {
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (HMIS_KNOWN_UNSTORED_COLUMNS.includes(key)) present.add(key);
    }
  }
  return [...present].sort();
}

/** Distinct values of one column with counts, most common first. Used for
    `relationship`: a sample row carries "Self" alongside an enrolled member
    count of 6, so whether the procedure returns one row per client or one row
    per household is unsettled — this reports the evidence instead of guessing. */
export function valueCounts(rows: Raw[], key: string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row[key];
    const value = raw == null || String(raw).trim() === "" ? "(blank)" : String(raw).trim();
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    // code-unit tiebreak, not localeCompare: the report has to read the same on
    // every machine that runs a sync
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Characteristic values the CSBG instrument doesn't recognize.

    The procedure returns human-readable labels, not HUD codes, and the labels
    drift: HUD's 2024 wording "Black, African American, or African" is not the
    instrument's "Black or African American". Those values are stored AS-IS —
    canonicalCharacteristic returns null and every caller keeps the raw string,
    so nothing is ever coerced to a default — and reported here, loudly, because
    a silent vendor wording change would otherwise become quiet data corruption. */
export function characteristicDrift(rows: HmisClientRow[]): Array<{ code: string; value: string; count: number }> {
  const fields: Array<{ code: string; of: (r: HmisClientRow) => string | null }> = [
    { code: "C1", of: (r) => r.sex },
    { code: "C6", of: (r) => r.race },
    { code: "C7", of: (r) => r.veteran },
    { code: "C5b-source", of: (r) => r.insurance },
    { code: "D13", of: (r) => r.incomeSrc },
  ];
  const counts = new Map<string, { code: string; value: string; count: number }>();
  for (const row of rows) {
    for (const field of fields) {
      const value = field.of(row);
      if (!value || canonicalCharacteristic(field.code, value)) continue;
      const key = JSON.stringify([field.code, value]);
      const entry = counts.get(key) ?? { code: field.code, value, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Every column name present across rows — what Test connection reports so the
    real output shape can be read off a live run. */
export function columnNames(rows: Raw[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen].sort();
}

export function normalizeHmisClient(raw: Raw): HmisClientRow | null {
  const hmisId = pick(raw, FIELD_KEYS.hmisId);
  const first = pick(raw, FIELD_KEYS.first);
  const last = pick(raw, FIELD_KEYS.last);
  if (!hmisId || !first || !last) return null;
  const dobRaw = pick(raw, FIELD_KEYS.dob);
  // gender and sex are separate MOU elements — keep both when distinct
  const gender = pick(raw, FIELD_KEYS.gender);
  const sexRaw = pick(raw, FIELD_KEYS.sex);
  const race = pick(raw, FIELD_KEYS.race);
  const ethnicity = pick(raw, FIELD_KEYS.ethnicity);
  return {
    hmisId,
    first,
    last,
    dob: dobRaw ? hmisDate(dobRaw) : null,
    email: pick(raw, FIELD_KEYS.email) || null,
    phone: pick(raw, FIELD_KEYS.phone) || null,
    sex: [gender, sexRaw && sexRaw !== gender ? sexRaw : ""].filter(Boolean).join(" / ") || null,
    race: [race, ethnicity].filter(Boolean).join(" · ") || null,
    veteran: pick(raw, FIELD_KEYS.veteran) || null,
    insurance: pick(raw, FIELD_KEYS.insurance) || null,
    incomeSrc: pick(raw, FIELD_KEYS.incomeSrc) || null,
    nonCash: pick(raw, FIELD_KEYS.nonCash) || null,
    services: Array.isArray(raw.Services ?? raw.services)
      ? ((raw.Services ?? raw.services) as Raw[]).map((s) => ({
          name: pick(s, ["Service", "service", "Name", "name", "ServiceName", "Description"]),
          date: hmisDate(pick(s, ["Date", "date", "BeginDate", "ServiceDate", "begin_date"])) ?? "",
        })).filter((s) => s.name)
      : [],
    household: Array.isArray(raw.FamilyMembers ?? raw.familyMembers ?? raw.household)
      ? ((raw.FamilyMembers ?? raw.familyMembers ?? raw.household) as Raw[]).map((m) => ({
          first: pick(m, ["FirstName", "firstName", "first"]),
          last: pick(m, ["LastName", "lastName", "last"]),
          dob: hmisDate(pick(m, ["DOB", "dob", "DateOfBirth", "Birthdate"])),
        })).filter((m) => m.first || m.last)
      : [],
  };
}

/* ---------- CRQL client listing ---------- */

/** Columns read from cmClient. ClientID / FirstName / LastName / ActiveStatus
    are verified against PA_HMIS production; the rest carry the spellings the
    MOU elements are expected to use and are UNVERIFIED — a wrong name makes
    CRQL answer 400 naming the column, and this list is the single place to fix
    it. CRQL forbids wildcards, so every column is named explicitly. */
export const CRQL_CLIENT_FIELDS = [
  "ClientID", "FirstName", "LastName", "ActiveStatus",
  "DOB", "Email", "Phone", "Gender", "Race", "Ethnicity",
  "VeteranStatus", "HealthInsuranceType", "SourceOfIncome", "NonCashBenefits",
];

/** CTAPI caps the query portion of the URL at 2048 chars once encoded. */
const CRQL_MAX_QUERY_CHARS = 2048;

/** The paged client query.

    `SELECT TOP n` is mandatory in practice, though undocumented: without it a
    statewide select runs past 30 s and is aborted, and pageSize alone does not
    bound the work. TOP is emitted from the same effective page size as the
    pageSize parameter so the two cannot drift apart.

    No ORDER BY — the one live query carrying one timed out. `shouldCache=true`
    is what holds a multi-page pull together instead. */
export function crqlClientQuery(pageSize: number): string {
  return `SELECT TOP ${pageSize} ${CRQL_CLIENT_FIELDS.join(", ")} FROM cmClient`;
}

/* The two endpoints genuinely return different envelopes, so each gets its own
   unwrapper. One shared helper guessing between them is how a silent zero-row
   sync happens: /crql answers {data:{Table1:[…]}}, while
   /crql/storedprocedures answers {output:[…], result:{table1:[…]}} — different
   container, different capitalization. Both are live-verified. */

/** Rows of a CRQL query response — `data.Table1`, the only result set a CRQL
    SELECT returns. A bare `{}` (the live empty-result shape) reads as no rows
    rather than throwing. `recordCount` is deliberately unused: live responses
    disagreed with the actual row count. */
export function crqlRows(json: unknown): Raw[] {
  const data = (json as Raw | null | undefined)?.data as Raw | undefined;
  const table = data?.Table1;
  return Array.isArray(table) ? (table as Raw[]) : [];
}

export interface ProcedureResult {
  /** Rows from `result.table1`. */
  rows: Raw[];
  /** Other result sets in `result` — named, never silently dropped. */
  extraTables: string[];
  /** Top-level `output` array: the procedure's output parameters. Empty for
      ours, surfaced when it isn't so the values aren't lost. */
  output: unknown[];
  /** A message-only body, which is what a procedure returning no result set
      answers with (Eccovia's own Merge_Client example does this). */
  message: string | null;
}

/** Parse a stored-procedure response: `{output: [], result: {table1: [ … ]}}`.

    Verified live (200, ~10.8 KB). Note `result` not `data`, and lowercase
    `table1` — the CRQL spellings find nothing here, which is exactly the silent
    zero-row failure this shape caused. There is no `recordCount`, no
    `cacheExpirationDate` and no `__crql_rid` in this envelope. A bare `{}` and a
    message-only body both read as zero rows without throwing. */
export function procedureResult(json: unknown): ProcedureResult {
  const root = (json ?? {}) as Raw;
  const result = root.result;
  const tables: Array<{ name: string; rows: Raw[] }> = [];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    for (const [name, value] of Object.entries(result as Raw)) {
      if (Array.isArray(value)) tables.push({ name, rows: value as Raw[] });
    }
  }
  // table1 as sent; the case-insensitive fallback costs nothing and survives a
  // vendor capitalization change without another silent zero
  const primary = tables.find((table) => table.name === "table1")
    ?? tables.find((table) => table.name.toLowerCase() === "table1");
  return {
    rows: primary?.rows ?? [],
    extraTables: tables.filter((table) => table !== primary).map((table) => table.name),
    output: Array.isArray(root.output) ? (root.output as unknown[]) : [],
    message: typeof root.message === "string" ? root.message : null,
  };
}

/** Where the client rows came from. The stored-procedure setting is the switch:
    set → "procedure", blank → "crql". */
export type HmisClientSource = "procedure" | "crql";

export interface HmisPull {
  rows: HmisClientRow[];
  source: HmisClientSource;
  /** The procedure that produced these rows, when one did. */
  procedure: string | null;
  /** Pages requested (not pages with data). Always 1 on the procedure path —
      /crql/storedprocedures documents no paging parameters. */
  pages: number;
  /** One full page then an empty one — indistinguishable from a result set that
      `TOP` bounded before paging applied, so the caller reports the ambiguity
      rather than claiming a complete snapshot. See the integration profile. */
  singlePageCapped: boolean;
  /** Rows the API returned, before mapping. */
  rawRowCount: number;
  /** Rows dropped for want of a recognizable client ID and name. */
  droppedRows: number;
  unmappedColumns: string[];
  /** Columns that arrived but have nowhere to be stored yet. */
  knownUnstoredColumns: string[];
  /** Distinct `relationship` values with counts — evidence for whether the
      procedure returns one row per client or one row per household. */
  relationships: Array<{ value: string; count: number }>;
  /** Characteristic labels the CSBG instrument doesn't recognize; stored as-is. */
  labelDrift: Array<{ code: string; value: string; count: number }>;
  extraTables: string[];
  /** Anything an operator needs to read: a message-only body, extra result sets,
      or a mapping that understood none of what came back. */
  note: string | null;
}

/** Pull the client list from whichever source is configured. The stored
    procedure takes priority the moment it is set; otherwise this is the CRQL
    query, unchanged. */
export async function fetchHmisClients(cfg: HmisConfig, opts: HmisRequestOptions = {}): Promise<HmisPull> {
  return cfg.storedProcedure
    ? fetchHmisClientsFromProcedure(cfg, opts)
    : fetchHmisClientsFromCrql(cfg, opts);
}

/** Pull the client list through CRQL, page by page. Rows the API can't identify
    are dropped, and ClientID 0 — a system/template row, not a person — is
    skipped. Ends on the first short page. */
export async function fetchHmisClientsFromCrql(cfg: HmisConfig, opts: HmisRequestOptions = {}): Promise<HmisPull> {
  const pageSize = effectivePageSize(cfg.pageSize);
  const q = crqlClientQuery(pageSize);
  if (encodeURIComponent(q).length > CRQL_MAX_QUERY_CHARS) {
    throw new Error("The CRQL client query is over CTAPI's 2048-character limit — shorten CRQL_CLIENT_FIELDS.");
  }
  const out: HmisClientRow[] = [];
  const seenRaw: Raw[] = [];
  const MAX_PAGES = 200; // safety backstop (MAX_PAGES × pageSize records)
  let pages = 0;
  let firstPageRows = 0;
  let lastPageRows = 0;
  let dropped = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await ctapiGet(cfg, "/crql", {
      q,
      pageNo: String(page),        // 1-based; OFFSET is rejected by the parser
      pageSize: String(pageSize),
      shouldCache: "true",         // server-side snapshot so pages can't shear
    }, opts);
    const raw = crqlRows(json);
    pages = page;
    lastPageRows = raw.length;
    if (page === 1) firstPageRows = raw.length;
    for (const item of raw) {
      seenRaw.push(item);
      const row = normalizeHmisClient(item);
      if (!row) { dropped++; continue; }
      if (row.hmisId === "0") continue;   // system/template row, not a person
      out.push(row);
    }
    if (raw.length < pageSize) break; // short page = last page
  }
  const drift = characteristicDrift(out);
  const driftNote = drift.length > 0
    ? `labels outside the CSBG instrument, stored as-is: `
      + drift.map((d) => `${d.code} “${d.value}” ×${d.count}`).join("; ")
    : null;
  if (driftNote) console.warn(`[hmis] CRQL: ${driftNote}`);
  return {
    rows: out,
    source: "crql",
    procedure: null,
    pages,
    singlePageCapped: pages === 2 && firstPageRows === pageSize && lastPageRows === 0,
    rawRowCount: seenRaw.length,
    droppedRows: dropped,
    unmappedColumns: unmappedColumns(seenRaw),
    knownUnstoredColumns: knownUnstoredColumns(seenRaw),
    relationships: valueCounts(seenRaw, "relationship").filter((r) => r.value !== "(blank)"),
    labelDrift: drift,
    extraTables: [],
    note: driftNote,
  };
}

/** Pull the client list by executing the configured stored procedure.

    One POST, no paging parameters — pageNo/pageSize are documented for /crql
    and not for /crql/storedprocedures — and every returned row is processed, so
    nothing is silently truncated. Nothing about the output shape is assumed:
    this procedure has never returned a row to us, so whatever the mapping does
    not understand is REPORTED (column names only, never values) instead of
    guessed at, and a response that yields no usable client says why. */
export async function fetchHmisClientsFromProcedure(
  cfg: HmisConfig,
  opts: HmisRequestOptions = {},
): Promise<HmisPull> {
  const procedure = cfg.storedProcedure;
  const params = cfg.storedProcedureParams ?? {};
  const json = await ctapiRequest(cfg, {
    method: "POST",
    path: procedurePath(procedure),
    body: params,
    // parameter KEYS only — a parameter value could carry client identifiers
    describe: `stored procedure ${procedure} (parameters: ${Object.keys(params).join(", ") || "none"})`,
  }, opts);

  const result = procedureResult(json);
  const out: HmisClientRow[] = [];
  let dropped = 0;
  for (const item of result.rows) {
    const row = normalizeHmisClient(item);
    if (!row) { dropped++; continue; }
    if (row.hmisId === "0") continue;
    out.push(row);
  }

  const unmapped = unmappedColumns(result.rows);
  const unstored = knownUnstoredColumns(result.rows);
  const relationships = valueCounts(result.rows, "relationship").filter((r) => r.value !== "(blank)");
  const drift = characteristicDrift(out);
  const notes: string[] = [];
  if (result.message) notes.push(`CTAPI message: ${truncate(result.message, 160)}`);
  if (result.extraTables.length > 0) {
    notes.push(`additional result sets not read: ${result.extraTables.join(", ")}`);
  }
  if (result.output.length > 0) {
    notes.push(`${result.output.length} output parameter(s) returned and not stored`);
  }
  if (result.rows.length > 0 && out.length === 0) {
    // the loud case: rows came back but none carried an ID and name we know, so
    // the mapping — not the data — is what's wrong
    notes.push(`none of the ${result.rows.length} returned rows had a recognizable client ID and name;`
      + ` columns returned: ${columnNames(result.rows).join(", ")}`);
  } else if (dropped > 0) {
    notes.push(`${dropped} row(s) skipped — no recognizable client ID and name`);
  }
  if (unmapped.length > 0) notes.push(`columns not mapped to any field: ${unmapped.join(", ")}`);
  if (unstored.length > 0) notes.push(`columns returned but not stored: ${unstored.join(", ")}`);
  if (relationships.length > 0) {
    notes.push(`relationship values: ${relationships.map((r) => `${r.value} ×${r.count}`).join(", ")}`);
  }
  if (drift.length > 0) {
    // loud on purpose: a vendor wording change must not become quiet corruption
    notes.push(`labels outside the CSBG instrument, stored as-is: `
      + drift.map((d) => `${d.code} “${d.value}” ×${d.count}`).join("; "));
  }
  for (const line of notes) console.warn(`[hmis] ${procedure}: ${line}`);

  return {
    rows: out,
    source: "procedure",
    procedure,
    pages: 1,
    singlePageCapped: false,
    rawRowCount: result.rows.length,
    droppedRows: dropped,
    unmappedColumns: unmapped,
    knownUnstoredColumns: unstored,
    relationships,
    labelDrift: drift,
    extraTables: result.extraTables,
    note: notes.length > 0 ? notes.join("; ") : null,
  };
}

/* ---------- integration pass: dedup, enrich, import ---------- */

export interface HmisMatchStats {
  alreadyLinked: number;
  autoLinked: number;
  enriched: number;     // linked records that had blank fields filled
  created: number;      // new client records imported from HMIS
  queued: number;       // near matches held for review
  noDob: number;        // unmatched but missing a DOB — snapshot-only
  noProgram: number;    // unmatched but no enrollment program configured
}

const canonOr = (code: string, v: string | null): string | null =>
  v === null || v === "" ? null : canonicalCharacteristic(code, v) ?? v;

/** Fill BLANK fields on a linked client from its HMIS record — local data
    always wins; nothing non-empty is ever overwritten.

    Returns the values that were there BEFORE, keyed by field, or null when
    nothing changed. That record is what lets undo put an enriched client back
    the way it was: the sync only ever writes into blanks, but "blank" is not
    always null (`custom` is an object), so the prior value is kept rather than
    assumed. */
export async function enrichLinkedClient(
  clientId: string, row: HmisClientRow,
): Promise<Record<string, unknown> | null> {
  const client = (await db.select().from(t.clients).where(eq(t.clients.id, clientId)))[0];
  if (!client) return null;
  const set: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const fill = (field: string, value: unknown, prior: unknown) => {
    set[field] = value;
    before[field] = prior ?? null;
  };
  if (!client.phone && row.phone) fill("phone", row.phone, client.phone);
  if (!client.sex && row.sex) fill("sex", canonOr("C1", row.sex), client.sex);
  if (!client.race && row.race) fill("race", canonOr("C6", row.race), client.race);
  if (!client.military && row.veteran) fill("military", canonOr("C7", row.veteran), client.military);
  if (!client.insurance && row.insurance) fill("insurance", canonOr("C5b-source", row.insurance), client.insurance);
  if (!client.incomeSrc && row.incomeSrc) fill("incomeSrc", canonOr("D13", row.incomeSrc), client.incomeSrc);
  if (row.email && !client.custom?.email) fill("custom", { ...client.custom, email: row.email }, client.custom ?? {});
  if (Object.keys(set).length === 0) return null;
  await db.update(t.clients).set(set).where(eq(t.clients.id, clientId));
  return before;
}

/** Import one HMIS person as a new client record (internal tracking &
    reporting). Requires a DOB (clients.dob is NOT NULL). Links the HMIS ID.
    `jobId` tags the record to its sync so Recent imports can undo it; null when
    the record comes from resolving a review by hand rather than from a sync. */
export async function createClientFromHmis(
  row: HmisClientRow, programId: string, userId: string, allocateId: ClientIdAllocator,
  jobId: number | null = null,
): Promise<string | null> {
  if (!row.dob) return null;
  const now = new Date().toISOString();
  const active = await getActiveFpl();
  const serviceDates = row.services.map((s) => s.date).filter(Boolean).sort();
  const clientId = await allocateId();
  await db.insert(t.clients).values({
    id: clientId,
    first: row.first,
    last: row.last,
    dob: row.dob,
    phone: row.phone,
    sex: canonOr("C1", row.sex),
    race: canonOr("C6", row.race),
    military: canonOr("C7", row.veteran),
    insurance: canonOr("C5b-source", row.insurance),
    incomeSrc: canonOr("D13", row.incomeSrc),
    hhSize: Math.min(12, Math.max(1, row.household.length + 1)),
    income: 0,
    caseworkerId: userId,
    enrolled: serviceDates[0] ?? now.slice(0, 10),
    fplYear: active.year,
    nextFollowUp: null,
    flags: ["HMIS import — verify income & eligibility data"],
    custom: row.email ? { email: row.email } : {},
    status: "active",
    createdAt: now,
    importJobId: jobId,
  });
  await db.insert(t.clientPrograms).values({ clientId, programId });
  await db.insert(t.clientExternalIds)
    .values({ system: "hmis", externalId: row.hmisId, clientId, linkedAt: now, linkedBy: userId })
    .onConflictDoNothing();
  return clientId;
}

/** The full integration pass over a fresh snapshot: link, enrich, queue,
    and import. `programId` is the enrollment program for created records
    (null = skip creation and count what it would have imported).

    `jobId` ties everything this pass writes to a Recent-imports entry: created
    clients carry it, and everything done to records that already existed is
    collected in the returned `undo` record, since deleting those clients is
    never the right reversal. */
export async function runHmisMatching(
  rows: HmisClientRow[], linkedBy: string, programId: string | null, allocateId: ClientIdAllocator,
  jobId: number | null = null,
): Promise<{ stats: HmisMatchStats; undo: HmisSyncUndo }> {
  const now = new Date().toISOString();
  const undo: HmisSyncUndo = { links: [], reviewIds: [], enriched: [] };
  const linkedTo = new Map(
    (await db.select().from(t.clientExternalIds).where(eq(t.clientExternalIds.system, "hmis")))
      .map((r) => [r.externalId, r.clientId]));
  const reviewed = new Set(
    (await db.select({ hmisId: t.hmisReviews.hmisId }).from(t.hmisReviews)).map((r) => r.hmisId));
  const candidates = await db.select({
    id: t.clients.id, first: t.clients.first, last: t.clients.last,
    dob: t.clients.dob, phone: t.clients.phone,
  }).from(t.clients);
  const byKey = new Map<string, string[]>();
  for (const c of candidates) {
    const k = matchKey(c);
    byKey.set(k, [...(byKey.get(k) ?? []), c.id]);
  }

  const stats: HmisMatchStats = {
    alreadyLinked: 0, autoLinked: 0, enriched: 0, created: 0, queued: 0, noDob: 0, noProgram: 0,
  };
  for (const row of rows) {
    const existing = linkedTo.get(row.hmisId);
    if (existing) {
      stats.alreadyLinked++;
      const before = await enrichLinkedClient(existing, row);
      if (before) {
        stats.enriched++;
        undo.enriched.push({ clientId: existing, before });
      }
      continue;
    }
    // exact identity (name + DOB) — unambiguous, auto-link + enrich
    if (row.dob) {
      const exact = byKey.get(matchKey({ first: row.first, last: row.last, dob: row.dob })) ?? [];
      if (exact.length === 1) {
        await db.insert(t.clientExternalIds)
          .values({ system: "hmis", externalId: row.hmisId, clientId: exact[0], linkedAt: now, linkedBy })
          .onConflictDoNothing();
        linkedTo.set(row.hmisId, exact[0]);
        stats.autoLinked++;
        // the link landed on a client that predates this sync — undo has to
        // remove it, or a re-run reports "already linked" and re-enriches nothing
        undo.links.push({ system: "hmis", externalId: row.hmisId });
        const before = await enrichLinkedClient(exact[0], row);
        if (before) {
          stats.enriched++;
          undo.enriched.push({ clientId: exact[0], before });
        }
        continue;
      }
    }
    // near matches → human review (once per HMIS id; dismissals stay dismissed)
    if (!reviewed.has(row.hmisId)) {
      const { possible } = classifyMatches(
        { first: row.first, last: row.last, dob: row.dob ?? "", phone: row.phone }, candidates);
      if (possible.length > 0) {
        const [queued] = await db.insert(t.hmisReviews).values({
          at: now, hmisId: row.hmisId, candidateIds: possible.map((m) => m.client.id), status: "pending",
        }).returning({ id: t.hmisReviews.id });
        reviewed.add(row.hmisId);
        stats.queued++;
        // undo clears the queue entry too: a review row makes the next sync skip
        // this person as already-seen, which would make a re-run non-repeatable
        if (queued) undo.reviewIds.push(queued.id);
        continue;
      }
      // no match anywhere → import as a new client record
      if (!row.dob) { stats.noDob++; continue; }
      if (!programId) { stats.noProgram++; continue; }
      const created = await createClientFromHmis(row, programId, linkedBy, allocateId, jobId);
      if (created) {
        linkedTo.set(row.hmisId, created);
        byKey.set(matchKey({ first: row.first, last: row.last, dob: row.dob }),
          [...(byKey.get(matchKey({ first: row.first, last: row.last, dob: row.dob })) ?? []), created]);
        stats.created++;
      }
      continue;
    }
    // previously dismissed — stays snapshot-only by explicit human decision
  }
  return { stats, undo };
}

/** Reverse what a sync did to records that ALREADY existed: drop the links it
    wrote, clear the reviews it queued, and put back the fields it blank-filled.
    Clients the sync created are not touched here — they carry the job id and the
    Recent-imports undo deletes them outright.

    Returns a human summary, or null when the sync changed no existing record.

    The hmis_clients snapshot is deliberately left alone: it mirrors the source
    and the next sync replaces it wholesale, so restoring it would be busywork. */
export async function revertHmisSync(undo: HmisSyncUndo | null | undefined): Promise<string | null> {
  // Always, even when the sync changed no existing record: the summary is what
  // Data & integrations shows, and leaving it behind makes the page report an
  // import that no longer exists.
  await clearHmisSyncSummary();
  if (!undo) return "sync summary and snapshot cleared.";
  for (const link of undo.links) {
    await db.delete(t.clientExternalIds).where(and(
      eq(t.clientExternalIds.system, link.system),
      eq(t.clientExternalIds.externalId, link.externalId)));
  }
  if (undo.reviewIds.length > 0) {
    await db.delete(t.hmisReviews).where(inArray(t.hmisReviews.id, undo.reviewIds));
  }
  for (const { clientId, before } of undo.enriched) {
    await db.update(t.clients).set(before).where(eq(t.clients.id, clientId));
  }
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (undo.links.length) parts.push(`${plural(undo.links.length, "link")} removed`);
  if (undo.reviewIds.length) parts.push(`${plural(undo.reviewIds.length, "queued review")} cleared`);
  if (undo.enriched.length) parts.push(`${plural(undo.enriched.length, "blank-filled record")} restored`);
  parts.push("sync summary and snapshot cleared");
  return `${parts.join(", ")}.`;
}

/** Clear what the UI reports ABOUT the last sync: the counters on Data &
    integrations, the connector row's status line, and the snapshot itself.

    The snapshot goes too. It describes the pull that is being undone, the next
    sync replaces it wholesale anyway, and leaving it makes /reports count 14
    HMIS people who are no longer linked to anything — inflating the
    organization-wide unduplicated total. */
export async function clearHmisSyncSummary(): Promise<void> {
  await db.delete(t.kv).where(eq(t.kv.key, "hmisSync"));   // absent → the zero default
  await db.delete(t.hmisClients);
  await db.update(t.integrations)
    .set({ status: "ready", lastSync: "—", records: "" })
    .where(eq(t.integrations.id, "hmis"));
}

/* ---------- aggregates (the MOU's second permitted use) ---------- */

export interface HmisAggregate {
  hmisTotal: number;        // people in the HMIS snapshot (CACLV-owned projects)
  linked: number;           // overlap: HMIS people matched to a Trellis record
  hmisOnly: number;         // HMIS people not in Trellis
  trellisTotal: number;     // Trellis client directory
  unduplicated: number;     // organization-wide unique people
}

/** Deidentified organization-wide unduplicated count — pure arithmetic on
    counts, no identifying fields leave this function. */
export async function hmisAggregate(): Promise<HmisAggregate> {
  const hmisTotal = (await db.select({ hmisId: t.hmisClients.hmisId }).from(t.hmisClients)).length;
  const linkedRows = (await db.select().from(t.clientExternalIds).where(eq(t.clientExternalIds.system, "hmis")));
  const snapshotIds = new Set((await db.select({ hmisId: t.hmisClients.hmisId }).from(t.hmisClients)).map((r) => r.hmisId));
  const linked = linkedRows.filter((r) => snapshotIds.has(r.externalId)).length;
  const trellisTotal = (await db.select({ id: t.clients.id }).from(t.clients)).length;
  const hmisOnly = hmisTotal - linked;
  return { hmisTotal, linked, hmisOnly, trellisTotal, unduplicated: trellisTotal + hmisOnly };
}

/* referenced by the sync action for completeness of the where clause */
export const hmisReviewPending = () =>
  db.select().from(t.hmisReviews).where(and(eq(t.hmisReviews.status, "pending")));
