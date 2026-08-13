import { requireAdmin } from "@/lib/auth";
import { kvGet } from "@/lib/data/core";
import {
  CTAPI_BASE_URL, getHmisConfig, hmisConfig, hmisKeysUnreadable, type HmisStoredConfig,
} from "@/lib/hmis";
import { IntegrationsClient, type HmisSettingsView } from "./integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage() {
  await requireAdmin();

  const stored = await kvGet<Partial<HmisStoredConfig>>("hmisConn", {});
  const { source } = await getHmisConfig();

  // Only ever booleans for the keys — the ciphertext stays server-side too.
  const view: HmisSettingsView = {
    baseUrl: stored.baseUrl ?? CTAPI_BASE_URL,
    hasSubscriptionKey: Boolean(stored.subscriptionKey),
    hasApiKey: Boolean(stored.apiKey),
    orgId: stored.orgId ?? "",
    pageSize: stored.pageSize ?? 200,
    source,
    envConfigured: hmisConfig() !== null,
    keysUnreadable: await hmisKeysUnreadable(),
  };

  return <IntegrationsClient initial={view} />;
}
