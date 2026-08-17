"use server";
/* Settings → Integrations — the PA HMIS connection, editable in the UI so
   hosted installs (Apache/Ubuntu, Docker) don't need shell access. Admin-only.
   Both CTAPI keys are write-only: they are encrypted before storage, never sent
   back to the browser, and never written to the audit log. */
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/access";
import { kvGet, kvSet } from "@/lib/data/core";
import { encryptSecret } from "@/lib/secrets";
import {
  CTAPI_BASE_URL, CTAPI_MAX_PAGE_SIZE, effectivePageSize, normalizeProcedureName,
  parseProcedureParams, type HmisStoredConfig,
} from "@/lib/hmis";

export interface SettingsResult { ok: boolean; message: string }

export interface HmisSettingsInput {
  baseUrl: string;
  subscriptionKey: string;  // blank = keep the stored key
  apiKey: string;           // blank = keep the stored key
  orgId: string;
  pageSize: string;
  storedProcedure: string;        // blank = sync from the CRQL query instead
  storedProcedureParams: string;  // JSON object; blank = {}
}

/** CTAPI rejects plain HTTP, so http:// is a validation error rather than a
    request that fails later with something less obvious. */
const isHttpsUrl = (v: string): boolean => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

export async function saveHmisSettings(input: HmisSettingsInput): Promise<SettingsResult> {
  const user = await requireAdmin();

  const baseUrl = (input.baseUrl.trim() || CTAPI_BASE_URL).replace(/\/+$/, "");
  if (!isHttpsUrl(baseUrl)) {
    return { ok: false, message: `Enter the API base URL as https:// — normally ${CTAPI_BASE_URL}.` };
  }

  const existing = await kvGet<Partial<HmisStoredConfig>>("hmisConn", {});
  const subscriptionKeyInput = input.subscriptionKey.trim();
  const apiKeyInput = input.apiKey.trim();
  const subscriptionKey = subscriptionKeyInput ? encryptSecret(subscriptionKeyInput) : existing.subscriptionKey ?? "";
  const apiKey = apiKeyInput ? encryptSecret(apiKeyInput) : existing.apiKey ?? "";
  if (!subscriptionKey) return { ok: false, message: "Enter the subscription key (Ocp-Apim-Subscription-Key)." };
  if (!apiKey) return { ok: false, message: "Enter the API key PA HMIS issued." };

  // clamped here as well as in the input: a stored value CTAPI won't honour is
  // worse than a corrected one, and hand-edited configs skip the input entirely
  const pageSize = effectivePageSize(input.pageSize);

  // Normalized once, here, and stored as normalized — the name goes into a URL
  // path segment, so a rejected value must not be sanitized and used anyway.
  const procedure = normalizeProcedureName(input.storedProcedure);
  if (!procedure.ok) return { ok: false, message: procedure.message };
  const params = parseProcedureParams(input.storedProcedureParams);
  if (!params.ok) return { ok: false, message: params.message };

  const stored: HmisStoredConfig = {
    baseUrl,
    subscriptionKey,
    apiKey,
    orgId: input.orgId.trim(),
    pageSize,
    storedProcedure: procedure.value,
    storedProcedureParams: params.value,
  };
  await kvSet("hmisConn", stored);
  // endpoints, scope and source only — neither key, nor any part of one, is
  // ever audited; parameter KEYS only, since a value could carry identifiers
  const paramKeys = Object.keys(params.value);
  await audit(user.id, "hmis.settings.save", "integration", "hmis",
    `Connection saved — ${baseUrl}${stored.orgId ? `, OrgId ${stored.orgId}` : ""}, page size ${pageSize}`
    + `, client source ${procedure.value ? `stored procedure ${procedure.value}` : "CRQL query on cmClient"}`
    + (procedure.value && paramKeys.length ? ` (parameters: ${paramKeys.join(", ")})` : "")
    + ` (subscription key ${subscriptionKeyInput ? "replaced" : "unchanged"}, API key ${apiKeyInput ? "replaced" : "unchanged"})`);
  revalidatePath("/settings/integrations");
  revalidatePath("/data");
  const notes: string[] = [];
  if (pageSize === CTAPI_MAX_PAGE_SIZE && Number(input.pageSize) > CTAPI_MAX_PAGE_SIZE) {
    notes.push(`page size capped at ${CTAPI_MAX_PAGE_SIZE}, CTAPI's limit`);
  }
  notes.push(procedure.value
    ? `clients will sync from ${procedure.value}`
    : "clients will sync from the CRQL query");
  return { ok: true, message: `HMIS connection saved — ${notes.join("; ")}. Use Test connection to verify it.` };
}

export async function clearHmisSettings(): Promise<SettingsResult> {
  const user = await requireAdmin();
  await db.delete(t.kv).where(eq(t.kv.key, "hmisConn"));
  await audit(user.id, "hmis.settings.clear", "integration", "hmis",
    "Connection settings cleared — environment variables (if any) apply again");
  revalidatePath("/settings/integrations");
  revalidatePath("/data");
  return { ok: true, message: "Saved settings cleared — HMIS_* environment variables apply again, if set." };
}
