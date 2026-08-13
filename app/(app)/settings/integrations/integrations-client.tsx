"use client";
/* Settings → Integrations — PA HMIS connection form. The secret field is
   write-only: it never round-trips to the browser; leaving it blank keeps
   whatever is stored. */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Chip, Field, Notice, Panel } from "@/components/ui";
import { I } from "@/components/icons";
import { useToast } from "@/components/toast";
import { testHmisConnection } from "../../data/hmis-actions";
import { clearHmisSettings, saveHmisSettings } from "./actions";

export interface HmisSettingsView {
  tokenUrl: string;
  clientId: string;
  hasSecret: boolean;      // a secret is stored (its value never leaves the server)
  baseUrl: string;
  clientsPath: string;
  scope: string;
  pageSize: number;
  source: "settings" | "environment" | null;
  envConfigured: boolean;  // HMIS_* environment variables would apply if cleared
}

export function IntegrationsClient({ initial }: { initial: HmisSettingsView }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    tokenUrl: initial.tokenUrl,
    clientId: initial.clientId,
    clientSecret: "",
    baseUrl: initial.baseUrl,
    clientsPath: initial.clientsPath,
    scope: initial.scope,
    pageSize: String(initial.pageSize || 200),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSave() {
    startTransition(async () => {
      const res = await saveHmisSettings(form);
      toast(res.message);
      if (res.ok) {
        setForm((f) => ({ ...f, clientSecret: "" }));
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

  const canSave = form.tokenUrl.trim() !== "" && form.clientId.trim() !== "" && form.baseUrl.trim() !== ""
    && (form.clientSecret.trim() !== "" || initial.hasSecret);

  return (
    <Panel
      title="PA HMIS connection"
      sub="Credentials issued under the PA DCED MOU. Saved settings apply immediately — no server restart. Sync runs from Data & integrations."
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
          <Field label="OAuth2 token URL" required hint="From the Eccovia API documentation for your instance.">
            <input value={form.tokenUrl} onChange={set("tokenUrl")} placeholder="https://…/oauth/token" />
          </Field>
          <Field label="API base URL" required hint="Root the client-list path is appended to.">
            <input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://…" />
          </Field>
        </div>
        <div className="fgrid c2">
          <Field label="Client ID" required>
            <input value={form.clientId} onChange={set("clientId")} autoComplete="off" />
          </Field>
          <Field label="Client secret" required={!initial.hasSecret}
            hint={initial.hasSecret ? "A secret is stored — leave blank to keep it, or paste a new one to replace it." : "Issued with the client ID."}>
            <input type="password" value={form.clientSecret} onChange={set("clientSecret")}
              placeholder={initial.hasSecret ? "•••••••• (unchanged)" : ""} autoComplete="new-password" />
          </Field>
        </div>
        <div className="fgrid c3">
          <Field label="Clients path" hint="Defaults to /api/clients — match your instance's stored procedure/endpoint.">
            <input value={form.clientsPath} onChange={set("clientsPath")} placeholder="/api/clients" />
          </Field>
          <Field label="OAuth2 scope" hint="Only if the API docs require one.">
            <input value={form.scope} onChange={set("scope")} />
          </Field>
          <Field label="Page size" hint="Records per request (default 200).">
            <input type="number" min={1} max={1000} value={form.pageSize} onChange={set("pageSize")} />
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
          {initial.hasSecret || initial.tokenUrl ? (
            <button className="calv-btn calv-btn--quiet calv-btn--sm" disabled={pending} onClick={onClear}>
              Clear saved settings
            </button>
          ) : null}
          <span style={{ fontSize: 12.5, color: "var(--calv-slate-65)" }}>
            Sync itself runs from <Link className="tlink" href="/data">Data &amp; integrations</Link>.
          </span>
        </div>
        {initial.envConfigured ? (
          <Notice tone="sand">
            HMIS_* environment variables are also set on this server. Saved settings take precedence; Clear saved settings falls back to the environment values.
          </Notice>
        ) : null}
      </div>
    </Panel>
  );
}
