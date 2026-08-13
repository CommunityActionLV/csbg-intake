import { and, eq } from "drizzle-orm";
import { db, t } from "@/db";
import { classifyMatches, matchKey } from "@/lib/matching";

/* ============================================================
   PA HMIS (Eccovia ClientTrack/CaseWorthy) sync — MOU-scoped.

   The signed PA DCED MOU (effective 2026-07-01) permits pulling the
   named data elements for CACLV-owned projects and restricts USE to:
     (a) data-set matching for deduplication, and
     (b) deidentified aggregate organization-wide reports.
   Accordingly this module NEVER writes to the clients table. Its only
   outputs are the hmis_clients snapshot (admin-only), durable ID links
   in client_external_ids (system = 'hmis'), the hmis_reviews queue,
   and aggregate counts. No intake prefill, no outreach use.

   Credentials/endpoints come from the environment (.env.local on the
   local tier — the data folder and machine are password-protected per
   the MOU's security condition; never commit them):
     HMIS_TOKEN_URL      OAuth2 token endpoint (client-credentials)
     HMIS_CLIENT_ID      issued credential
     HMIS_CLIENT_SECRET  issued credential
     HMIS_BASE_URL       API root for our instance
     HMIS_CLIENTS_PATH   client-list path (default /api/clients)
     HMIS_SCOPE          optional OAuth2 scope
     HMIS_PAGE_SIZE      page size (default 200)
   The exact endpoint/paging/field names are the one part of this
   integration that varies per Eccovia instance — normalizeHmisClient()
   accepts the common spellings and everything else is env-tunable.
   ============================================================ */

export interface HmisConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  clientsPath: string;
  scope: string;
  pageSize: number;
}

export function hmisConfig(): HmisConfig | null {
  const tokenUrl = process.env.HMIS_TOKEN_URL ?? "";
  const clientId = process.env.HMIS_CLIENT_ID ?? "";
  const clientSecret = process.env.HMIS_CLIENT_SECRET ?? "";
  const baseUrl = (process.env.HMIS_BASE_URL ?? "").replace(/\/+$/, "");
  if (!tokenUrl || !clientId || !clientSecret || !baseUrl) return null;
  return {
    tokenUrl,
    clientId,
    clientSecret,
    baseUrl,
    clientsPath: process.env.HMIS_CLIENTS_PATH ?? "/api/clients",
    scope: process.env.HMIS_SCOPE ?? "",
    pageSize: Math.max(1, Number(process.env.HMIS_PAGE_SIZE) || 200),
  };
}

export const hmisConfigured = (): boolean => hmisConfig() !== null;

/** OAuth2 client-credentials token. */
export async function hmisToken(cfg: HmisConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (cfg.scope) body.set("scope", cfg.scope);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token endpoint returned no access_token");
  return json.access_token;
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

/** Pull every client page from the API. Handles the two common Eccovia
    response shapes: a bare array, or { data: [...] } / { value: [...] }. */
export async function fetchHmisClients(cfg: HmisConfig, token: string): Promise<HmisClientRow[]> {
  const out: HmisClientRow[] = [];
  const MAX_PAGES = 200; // safety backstop (MAX_PAGES × pageSize records)
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(cfg.baseUrl + cfg.clientsPath);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(cfg.pageSize));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${cfg.clientsPath} answered ${res.status} on page ${page}`);
    const json = (await res.json()) as unknown;
    const items: Raw[] = Array.isArray(json) ? (json as Raw[])
      : Array.isArray((json as Raw).data) ? ((json as Raw).data as Raw[])
      : Array.isArray((json as Raw).value) ? ((json as Raw).value as Raw[])
      : [];
    for (const raw of items) {
      const row = normalizeHmisClient(raw);
      if (row) out.push(row);
    }
    if (items.length < cfg.pageSize) break; // short page = last page
  }
  return out;
}

/* ---------- matching pass (dedup — the MOU's first permitted use) ---------- */

export interface HmisMatchStats {
  alreadyLinked: number;
  autoLinked: number;
  queued: number;
  unlinked: number;
}

/** Match unlinked snapshot rows against the client directory.
    Exact name+DOB → auto-link (audited by the caller); near matches →
    hmis_reviews for a human; everything else stays unlinked. */
export async function runHmisMatching(rows: HmisClientRow[], linkedBy: string): Promise<HmisMatchStats> {
  const now = new Date().toISOString();
  const linked = new Set(
    (await db.select().from(t.clientExternalIds).where(eq(t.clientExternalIds.system, "hmis")))
      .map((r) => r.externalId));
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

  const stats: HmisMatchStats = { alreadyLinked: 0, autoLinked: 0, queued: 0, unlinked: 0 };
  for (const row of rows) {
    if (linked.has(row.hmisId)) { stats.alreadyLinked++; continue; }
    // exact identity (name + DOB) — unambiguous, auto-link
    if (row.dob) {
      const exact = byKey.get(matchKey({ first: row.first, last: row.last, dob: row.dob })) ?? [];
      if (exact.length === 1) {
        await db.insert(t.clientExternalIds)
          .values({ system: "hmis", externalId: row.hmisId, clientId: exact[0], linkedAt: now, linkedBy })
          .onConflictDoNothing();
        linked.add(row.hmisId);
        stats.autoLinked++;
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
    }
    stats.unlinked++;
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
