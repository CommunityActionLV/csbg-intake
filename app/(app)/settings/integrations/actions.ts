"use server";
/* Settings → Integrations — the PA HMIS connection, editable in the UI so
   hosted installs (Apache/Ubuntu, Docker) don't need shell access. Admin-only.
   The client secret is write-only: it is never sent back to the browser and
   never written to the audit log. */
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/access";
import { kvGet, kvSet } from "@/lib/data/core";
import type { HmisStoredConfig } from "@/lib/hmis";

export interface SettingsResult { ok: boolean; message: string }

export interface HmisSettingsInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;   // blank = keep the stored secret
  baseUrl: string;
  clientsPath: string;
  scope: string;
  pageSize: string;
}

const isHttpUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

export async function saveHmisSettings(input: HmisSettingsInput): Promise<SettingsResult> {
  const user = await requireAdmin();

  const tokenUrl = input.tokenUrl.trim();
  const clientId = input.clientId.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!isHttpUrl(tokenUrl)) return { ok: false, message: "Enter the OAuth2 token URL (https://…)." };
  if (!isHttpUrl(baseUrl)) return { ok: false, message: "Enter the API base URL (https://…)." };
  if (!clientId) return { ok: false, message: "Enter the client ID PA HMIS issued." };

  const existing = await kvGet<Partial<HmisStoredConfig>>("hmisConn", {});
  const clientSecret = input.clientSecret.trim() || existing.clientSecret || "";
  if (!clientSecret) return { ok: false, message: "Enter the client secret PA HMIS issued." };

  const pageSizeRaw = Number(input.pageSize);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 && pageSizeRaw <= 1000
    ? Math.round(pageSizeRaw) : 200;

  const clientsPath = input.clientsPath.trim() || "/api/clients";
  if (!clientsPath.startsWith("/")) return { ok: false, message: "The clients path must start with / (e.g. /api/clients)." };

  const stored: HmisStoredConfig = {
    tokenUrl, clientId, clientSecret, baseUrl, clientsPath,
    scope: input.scope.trim(), pageSize,
  };
  await kvSet("hmisConn", stored);
  // never the secret — endpoints and client id only
  await audit(user.id, "hmis.settings.save", "integration", "hmis",
    `Connection saved — ${baseUrl}${clientsPath} (client id ${clientId}${input.clientSecret.trim() ? ", secret replaced" : ", secret unchanged"})`);
  revalidatePath("/settings/integrations");
  revalidatePath("/data");
  return { ok: true, message: "HMIS connection saved — use Test connection to verify it." };
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
