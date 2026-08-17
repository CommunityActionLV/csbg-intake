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
  storedProcedure: string;       // set = the client source; blank = CRQL query
  storedProcedureParams: string; // pretty-printed JSON object
  source: "settings" | "environment" | null;
  envConfigured: boolean;        // HMIS_* environment variables would apply if cleared
  keysUnreadable: boolean;       // stored keys can't be decrypted on this server
}

export function IntegrationsClient({ initial }: { initial: HmisSettingsView }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [form, setForm] = useState({
    baseUrl: initial.baseUrl,
    subscriptionKey: "",
    apiKey: "",
    orgId: initial.orgId,
    pageSize: String(initial.pageSize || 200),
    storedProcedure: initial.storedProcedure,
    storedProcedureParams: initial.storedProcedureParams || "{}",
  });
  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSave() {
    startTransition(async () => {
      const res = await saveHmisSettings(form);
      toast(res.message);
      if (res.ok) {
        setForm((f) => ({ ...f, subscriptionKey: "", apiKey: "" }));
        setResult(null);
        router.refresh();
      }
    });
  }
  function onTest() {
    startTransition(async () => {
      const res = await testHmisConnection();
      // shown in the panel rather than a toast: the procedure step reports the
      // column names it found, which is the point of running it
      setResult({ ok: res.ok, lines: res.lines });
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
          <Field label="Page size" hint="Records per CRQL page (default 200, CTAPI's maximum is 500). Applies to CRQL queries only — the stored-procedure endpoint takes no paging parameters.">
            <input type="number" min={1} max={500} value={form.pageSize} onChange={set("pageSize")} />
          </Field>
        </div>
        <div className="fgrid c2">
          <Field label="Stored procedure"
            hint="The schema prefix is optional — C_Report_Example and dbo.C_Report_Example both work, and the name is saved exactly as typed. Leave blank to sync with a CRQL query instead.">
            <input value={form.storedProcedure} onChange={set("storedProcedure")}
              placeholder="C_Report_Example_API" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Stored procedure parameters"
            hint="JSON object of the procedure's parameters. Leave as {} if it takes none.">
            <textarea value={form.storedProcedureParams} onChange={set("storedProcedureParams")}
              rows={3} spellCheck={false} style={{ fontFamily: "var(--calv-mono, monospace)", fontSize: 12.5 }} />
          </Field>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--calv-slate-65)" }}>
          <strong>Client source:</strong>{" "}
          {initial.storedProcedure
            ? <>stored procedure <code>{initial.storedProcedure}</code></>
            : <>CRQL query on <code>cmClient</code></>}
          {form.storedProcedure.trim() !== initial.storedProcedure
            ? <> — changes when you save.</>
            : null}
        </div>
        <Notice tone="warn" icon="alert">
          Whatever is named here is <strong>executed</strong> against PA HMIS production when you
          sync or test. Eccovia&apos;s stored-procedure endpoint runs write procedures too
          (their own examples include <code>Merge_Client</code> and <code>Delete_Client</code>),
          and nothing in the API distinguishes them — only name a read-only report procedure.
        </Notice>
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
        {result ? (
          <Notice tone={result.ok ? "good" : "warn"} icon={result.ok ? "check" : "alert"}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {result.lines.map((line, i) => (
                <div key={i} style={{ overflowWrap: "anywhere" }}>{line}</div>
              ))}
            </div>
          </Notice>
        ) : null}
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
