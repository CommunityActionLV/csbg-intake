import { and, eq } from "drizzle-orm";
import { db, t } from "@/db";
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
  pageSize: number;
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
  return {
    baseUrl,
    subscriptionKey,
    apiKey,
    orgId: process.env.HMIS_ORG_ID ?? "",
    pageSize: effectivePageSize(process.env.HMIS_PAGE_SIZE),
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

/** 401 — the credentials themselves were refused. Never retried: replaying a
    rejected key only burns the rate limit. */
export class HmisAuthError extends Error {
  constructor(message = "CTAPI rejected the credentials (401).") {
    super(message);
    this.name = "HmisAuthError";
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

/** One GET against CTAPI: HTTPS only, both auth headers, a request timeout, and
    a bounded retry for transient statuses and network faults. 401 and every
    other 4xx fail on the first answer. Keys travel as headers only, so no key
    value can reach a URL, a message, or a thrown error. */
async function ctapiGet(
  cfg: HmisConfig,
  path: string,
  params: Record<string, string>,
  opts: HmisRequestOptions = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const backoff = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const url = new URL(cfg.baseUrl + path);
  if (url.protocol !== "https:") {
    throw new Error("The HMIS API base URL must use https:// — CTAPI rejects plain HTTP.");
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: ctapiHeaders(cfg),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoff * attempt);
      continue;
    }
    if (res.status === 401) throw new HmisAuthError();
    if (!res.ok) {
      const body = truncate((await res.text().catch(() => "")).trim());
      const err = new HmisHttpError(res.status, body);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(backoff * attempt);
      continue;
    }
    return (await res.json()) as unknown;
  }
  throw lastError ?? new Error("CTAPI request failed.");
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
      return {
        ok: false,
        environment: null,
        message: "Credentials rejected — check the subscription key and API key, and note that the two are easy to transpose.",
      };
    }
    if (e instanceof HmisHttpError) {
      return { ok: false, environment: null, message: `PA HMIS answered ${e.status}${e.body ? ` — ${e.body}` : ""}` };
    }
    return { ok: false, environment: null, message: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- normalization ---------- */

type Raw = Record<string, unknown>;

const pick = (raw: Raw, keys: string[]): string => {
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
export function normalizeHmisClient(raw: Raw): HmisClientRow | null {
  const hmisId = pick(raw, ["ClientID", "clientId", "client_id", "ClientId", "id", "ID"]);
  const first = pick(raw, ["FirstName", "firstName", "first_name", "first"]);
  const last = pick(raw, ["LastName", "lastName", "last_name", "last"]);
  if (!hmisId || !first || !last) return null;
  const dobRaw = pick(raw, ["DOB", "dob", "DateOfBirth", "dateOfBirth", "date_of_birth", "Birthdate", "birthdate"]);
  // gender and sex are separate MOU elements — keep both when distinct
  const gender = pick(raw, ["Gender", "gender", "GenderDesc"]);
  const sexRaw = pick(raw, ["Sex", "sex"]);
  const race = pick(raw, ["Race", "race", "RaceDesc"]);
  const ethnicity = pick(raw, ["Ethnicity", "ethnicity"]);
  return {
    hmisId,
    first,
    last,
    dob: dobRaw ? hmisDate(dobRaw) : null,
    email: pick(raw, ["Email", "email", "EmailAddress"]) || null,
    phone: pick(raw, ["Phone", "phone", "Telephone", "telephone", "PhoneNumber", "HomePhone"]) || null,
    sex: [gender, sexRaw && sexRaw !== gender ? sexRaw : ""].filter(Boolean).join(" / ") || null,
    race: [race, ethnicity].filter(Boolean).join(" · ") || null,
    veteran: pick(raw, ["VeteranStatus", "veteranStatus", "veteran_status", "Veteran", "veteran"]) || null,
    insurance: pick(raw, ["HealthInsuranceType", "healthInsurance", "InsuranceType", "insurance"]) || null,
    incomeSrc: pick(raw, ["SourceOfIncome", "IncomeSource", "incomeSource", "income_source"]) || null,
    nonCash: pick(raw, ["NonCashBenefits", "nonCashBenefits", "non_cash_benefits", "NonCash"]) || null,
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

/** Rows out of one CRQL response.

    The envelope is `{recordCount, cacheExpirationDate, data:{Table1:[…]}}` when
    there are matches and a bare `{}` when there are none, so every level is
    checked before use — `json.data.Table1.length` throws on any no-match query.
    `recordCount` is deliberately ignored: live responses disagreed with the
    actual row count, so it cannot drive paging. */
export function crqlRows(json: unknown): Raw[] {
  const data = (json as Raw | null | undefined)?.data as Raw | undefined;
  const table = data?.Table1;
  return Array.isArray(table) ? (table as Raw[]) : [];
}

export interface HmisPull {
  rows: HmisClientRow[];
  /** Pages requested (not pages with data). */
  pages: number;
  /** One full page then an empty one — indistinguishable from a result set that
      `TOP` bounded before paging applied, so the caller reports the ambiguity
      rather than claiming a complete snapshot. See the integration profile. */
  singlePageCapped: boolean;
}

/** Pull the client list through CRQL, page by page. Rows the API can't identify
    are dropped, and ClientID 0 — a system/template row, not a person — is
    skipped. Ends on the first short page. */
export async function fetchHmisClients(cfg: HmisConfig, opts: HmisRequestOptions = {}): Promise<HmisPull> {
  const pageSize = effectivePageSize(cfg.pageSize);
  const q = crqlClientQuery(pageSize);
  if (encodeURIComponent(q).length > CRQL_MAX_QUERY_CHARS) {
    throw new Error("The CRQL client query is over CTAPI's 2048-character limit — shorten CRQL_CLIENT_FIELDS.");
  }
  const out: HmisClientRow[] = [];
  const MAX_PAGES = 200; // safety backstop (MAX_PAGES × pageSize records)
  let pages = 0;
  let firstPageRows = 0;
  let lastPageRows = 0;
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
      const row = normalizeHmisClient(item);
      if (!row || row.hmisId === "0") continue;
      out.push(row);
    }
    if (raw.length < pageSize) break; // short page = last page
  }
  return {
    rows: out,
    pages,
    singlePageCapped: pages === 2 && firstPageRows === pageSize && lastPageRows === 0,
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
    always wins; nothing non-empty is ever overwritten. Returns true when
    anything changed. */
export async function enrichLinkedClient(clientId: string, row: HmisClientRow): Promise<boolean> {
  const client = (await db.select().from(t.clients).where(eq(t.clients.id, clientId)))[0];
  if (!client) return false;
  const set: Record<string, unknown> = {};
  if (!client.phone && row.phone) set.phone = row.phone;
  if (!client.sex && row.sex) set.sex = canonOr("C1", row.sex);
  if (!client.race && row.race) set.race = canonOr("C6", row.race);
  if (!client.military && row.veteran) set.military = canonOr("C7", row.veteran);
  if (!client.insurance && row.insurance) set.insurance = canonOr("C5b-source", row.insurance);
  if (!client.incomeSrc && row.incomeSrc) set.incomeSrc = canonOr("D13", row.incomeSrc);
  if (row.email && !client.custom?.email) set.custom = { ...client.custom, email: row.email };
  if (Object.keys(set).length === 0) return false;
  await db.update(t.clients).set(set).where(eq(t.clients.id, clientId));
  return true;
}

/** Import one HMIS person as a new client record (internal tracking &
    reporting). Requires a DOB (clients.dob is NOT NULL). Links the HMIS ID. */
export async function createClientFromHmis(
  row: HmisClientRow, programId: string, userId: string, allocateId: ClientIdAllocator,
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
  });
  await db.insert(t.clientPrograms).values({ clientId, programId });
  await db.insert(t.clientExternalIds)
    .values({ system: "hmis", externalId: row.hmisId, clientId, linkedAt: now, linkedBy: userId })
    .onConflictDoNothing();
  return clientId;
}

/** The full integration pass over a fresh snapshot: link, enrich, queue,
    and import. `programId` is the enrollment program for created records
    (null = skip creation and count what it would have imported). */
export async function runHmisMatching(
  rows: HmisClientRow[], linkedBy: string, programId: string | null, allocateId: ClientIdAllocator,
): Promise<HmisMatchStats> {
  const now = new Date().toISOString();
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
      if (await enrichLinkedClient(existing, row)) stats.enriched++;
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
        if (await enrichLinkedClient(exact[0], row)) stats.enriched++;
        continue;
      }
    }
    // near matches → human review (once per HMIS id; dismissals stay dismissed)
    if (!reviewed.has(row.hmisId)) {
      const { possible } = classifyMatches(
        { first: row.first, last: row.last, dob: row.dob ?? "", phone: row.phone }, candidates);
      if (possible.length > 0) {
        await db.insert(t.hmisReviews).values({
          at: now, hmisId: row.hmisId, candidateIds: possible.map((m) => m.client.id), status: "pending",
        });
        reviewed.add(row.hmisId);
        stats.queued++;
        continue;
      }
      // no match anywhere → import as a new client record
      if (!row.dob) { stats.noDob++; continue; }
      if (!programId) { stats.noProgram++; continue; }
      const created = await createClientFromHmis(row, programId, linkedBy, allocateId);
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
  return stats;
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
