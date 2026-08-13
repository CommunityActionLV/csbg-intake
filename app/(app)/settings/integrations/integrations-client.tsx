"use client";
/* Settings → Integrations — PA HMIS (ClientTrack API) connection form. Both key
   fields are write-only: they never round-trip to the browser, and leaving one
   blank keeps whatever is stored. */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Chip, Field, Notice, Panel } from "@/components/ui";
import { I } from "@/components/icons";
import { useToast } from "@/components/toast";
import { testHmisConnection } from "../../data/hmis-actions";
import { clearHmisSettings, saveHmisSettings } from "./actions";

export interface HmisSettingsView {
  baseUrl: string;
  hasSubscriptionKey: boolean;   // a key is stored (its value never leaves the server)
  hasApiKey: boolean;
  orgId: string;
  pageSize: number;
  source: "settings" | "environment" | null;
  envConfigured: boolean;        // HMIS_* environment variables would apply if cleared
  keysUnreadable: boolean;       // stored keys can't be decrypted on this server
}

export function IntegrationsClient({ initial }: { initial: HmisSettingsView }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    baseUrl: initial.baseUrl,
    subscriptionKey: "",
    apiKey: "",
    orgId: initial.orgId,
    pageSize: String(initial.pageSize || 200),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSave() {
    startTransition(async () => {
      const res = await saveHmisSettings(form);
      toast(res.message);
      if (res.ok) {
        setForm((f) => ({ ...f, subscriptionKey: "", apiKey: "" }));
        router.refresh();
      }
    });
  }
  function onTest() {
    startTransition(async () => {
      const res = await testHmisConnection();
      toast(res.message);
    });
  }
  function onClear() {
    startTransition(async () => {
      const res = await clearHmisSettings();
      toast(res.message);
      if (res.ok) router.refresh();
    });
  }

  const canSave = form.baseUrl.trim() !== ""
    && (form.subscriptionKey.trim() !== "" || initial.hasSubscriptionKey)
    && (form.apiKey.trim() !== "" || initial.hasApiKey);

  const keyHint = (stored: boolean, issued: string) =>
    stored ? "Stored — leave blank to keep it, or paste a new one to replace it." : issued;

  return (
    <Panel
      title="PA HMIS connection"
      sub="ClientTrack API credentials issued under the PA DCED MOU. Saved settings apply immediately — no server restart. Sync runs from Data & integrations."
      right={
        initial.source ? (
          <Chip tone={initial.source === "settings" ? "sage" : "teal"}>
            {initial.source === "settings" ? "Using saved settings" : "Using environment variables"}
          </Chip>
        ) : (
          <Chip tone="amber">Not configured</Chip>
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
        <div className="fgrid c2">
          <Field label="API base URL" required hint="Production is the only environment Eccovia exposes.">
            <input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.clienttrack.net" />
          </Field>
          <Field label="Org ID" hint="User Keys only — scopes results to one organization.">
            <input value={form.orgId} onChange={set("orgId")} autoComplete="off" />
          </Field>
        </div>
        <div className="fgrid c2">
          <Field label="Subscription key" required={!initial.hasSubscriptionKey}
            hint={keyHint(initial.hasSubscriptionKey, "Sent as Ocp-Apim-Subscription-Key.")}>
            <input type="password" value={form.subscriptionKey} onChange={set("subscriptionKey")}
              placeholder={initial.hasSubscriptionKey ? "•••••••• (unchanged)" : ""} autoComplete="new-password" />
          </Field>
          <Field label="API key" required={!initial.hasApiKey}
            hint={keyHint(initial.hasApiKey, "Sent as Authorization: ApiKey …")}>
            <input type="password" value={form.apiKey} onChange={set("apiKey")}
              placeholder={initial.hasApiKey ? "•••••••• (unchanged)" : ""} autoComplete="new-password" />
          </Field>
        </div>
        <div className="fgrid c2">
          <Field label="Page size" hint="Records per CRQL page (default 200, CTAPI's maximum is 500).">
            <input type="number" min={1} max={500} value={form.pageSize} onChange={set("pageSize")} />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="calv-btn calv-btn--primary calv-btn--sm" disabled={!canSave || pending}
            style={!canSave || pending ? { opacity: 0.45, cursor: "not-allowed" } : undefined} onClick={onSave}>
            <I name="check" size={14} /> Save connection
          </button>
          <button className="calv-btn calv-btn--secondary calv-btn--sm" disabled={pending || !initial.source} onClick={onTest}>
            Test connection
          </button>
          {initial.hasSubscriptionKey || initial.hasApiKey ? (
            <button className="calv-btn calv-btn--quiet calv-btn--sm" disabled={pending} onClick={onClear}>
              Clear saved settings
            </button>
          ) : null}
          <span style={{ fontSize: 12.5, color: "var(--calv-slate-65)" }}>
            Sync itself runs from <Link className="tlink" href="/data">Data &amp; integrations</Link>.
          </span>
        </div>
        {initial.keysUnreadable ? (
          <Notice tone="warn" icon="alert">
            The stored keys can&apos;t be decrypted on this server — the encryption key (data/secret.key,
            or CSBG_SECRET_KEY) has changed or is missing. Paste both keys again to re-save them.
          </Notice>
        ) : null}
        {initial.envConfigured ? (
          <Notice tone="sand">
            HMIS_* environment variables are also set on this server. Saved settings take precedence; Clear saved settings falls back to the environment values.
          </Notice>
        ) : null}
      </div>
    </Panel>
  );
}
