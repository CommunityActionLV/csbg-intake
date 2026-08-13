import { requireAdmin } from "@/lib/auth";
import { kvGet } from "@/lib/data/core";
import { getHmisConfig, hmisConfig, type HmisStoredConfig } from "@/lib/hmis";
import { IntegrationsClient, type HmisSettingsView } from "./integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage() {
  await requireAdmin();

  const stored = await kvGet<Partial<HmisStoredConfig>>("hmisConn", {});
  const { source } = await getHmisConfig();

  const view: HmisSettingsView = {
    tokenUrl: stored.tokenUrl ?? "",
    clientId: stored.clientId ?? "",
    hasSecret: Boolean(stored.clientSecret),
    baseUrl: stored.baseUrl ?? "",
    clientsPath: stored.clientsPath ?? "/api/clients",
    scope: stored.scope ?? "",
    pageSize: stored.pageSize ?? 200,
    source,
    envConfigured: hmisConfig() !== null,
  };

  return <IntegrationsClient initial={view} />;
}
