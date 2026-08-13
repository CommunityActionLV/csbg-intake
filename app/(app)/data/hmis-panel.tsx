"use client";
/* PA HMIS sync panel — status, sync controls, and the link/dismiss match
   queue. MOU-scoped: matching + deidentified aggregates only, so the panel
   never offers "create a client" and shows no more identity than a reviewer
   needs to compare records. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, Empty, Panel } from "@/components/ui";
import { I } from "@/components/icons";
import { useToast } from "@/components/toast";
import { fmt } from "@/lib/format";
import { resolveHmisReview, runHmisSync, testHmisConnection } from "./hmis-actions";

export interface HmisSyncStats {
  at: string | null;        // ISO datetime of last sync (null = never)
  pulled: number;
  alreadyLinked: number;
  autoLinked: number;
  queued: number;
  unlinked: number;
}

export interface HmisReviewItem {
  id: number;
  when: string;
  person: { name: string; dob: string; phone: string; email: string };
  candidates: Array<{ id: string; name: string; dob: string; phone: string }>;
}

export function HmisPanel({ configured, stats, reviews }: {
  configured: boolean;
  stats: HmisSyncStats;
  reviews: HmisReviewItem[];
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyReview, setBusyReview] = useState<number | null>(null);

  function onTest() {
    startTransition(async () => {
      const res = await testHmisConnection();
      toast(res.message);
    });
  }
  function onSync() {
    startTransition(async () => {
      const res = await runHmisSync();
      toast(res.message);
      if (res.ok) router.refresh();
    });
  }
  function onResolve(id: number, action: { type: "link"; clientId: string } | { type: "dismiss" }) {
    setBusyReview(id);
    startTransition(async () => {
      const res = await resolveHmisReview(id, action);
      setBusyReview(null);
      toast(res.message);
      if (res.ok) router.refresh();
    });
  }

  return (
    <Panel
      title="PA HMIS sync"
      sub="Per the signed PA DCED MOU: HMIS data is used ONLY to deduplicate across systems and build deidentified organization-wide totals — it never fills client records."
      right={
        <div style={{ display: "flex", gap: 8 }}>
          <button className="calv-btn calv-btn--quiet calv-btn--sm" disabled={pending} onClick={onTest}>Test connection</button>
          <button className="calv-btn calv-btn--secondary calv-btn--sm" disabled={pending || !configured}
            style={!configured ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            title={configured ? undefined : "Add the HMIS_* settings to .env.local first"}
            onClick={onSync}>
            <I name="rotate" size={13} /> Run sync
          </button>
        </div>
      }
      style={{ marginBottom: 13 }}
    >
      {!configured ? (
        <Empty padding={18}>
          Not configured yet — add HMIS_TOKEN_URL, HMIS_CLIENT_ID, HMIS_CLIENT_SECRET, and HMIS_BASE_URL to .env.local (never commit them), restart the server, then Test connection.
        </Empty>
      ) : (
        <div style={{ display: "flex", gap: 22, fontSize: 12.5, color: "var(--calv-slate-65)", flexWrap: "wrap", marginBottom: reviews.length ? 14 : 0 }}>
          {stats.at ? (
            <>
              <span><strong style={{ fontWeight: 600, color: "var(--calv-slate)" }}>{fmt(stats.pulled)}</strong> HMIS records last sync</span>
              <span><strong style={{ fontWeight: 600, color: "var(--calv-slate)" }}>{fmt(stats.alreadyLinked + stats.autoLinked)}</strong> linked to Trellis records</span>
              <span><strong style={{ fontWeight: 600, color: "var(--calv-slate)" }}>{fmt(stats.unlinked)}</strong> HMIS-only</span>
              <span><strong style={{ fontWeight: 600, color: "var(--calv-slate)" }}>{fmt(reviews.length)}</strong> awaiting review</span>
            </>
          ) : (
            <span>Configured — run the first sync to pull the CACLV-project snapshot.</span>
          )}
        </div>
      )}

      {reviews.map((r) => (
        <div key={r.id} style={{ border: "1px solid var(--calv-slate-15)", borderRadius: 4, padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 8, flexWrap: "wrap" }}>
            <Chip tone="amber">HMIS match · {r.when}</Chip>
            <span style={{ fontWeight: 600 }}>{r.person.name}</span>
            <span style={{ fontSize: 12.5, color: "var(--calv-slate-65)" }}>
              b. {r.person.dob || "—"}{r.person.phone ? " · " + r.person.phone : ""}{r.person.email ? " · " + r.person.email : ""}
            </span>
          </div>
          <table className="data compact">
            <thead><tr><th>Possible match</th><th>DOB</th><th>Phone</th><th></th></tr></thead>
            <tbody>
              {r.candidates.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}<div style={{ fontFamily: "var(--font-body)", fontWeight: 300, fontSize: 11, textTransform: "none", color: "var(--calv-slate-65)" }}>{c.id}</div></td>
                  <td>{c.dob}</td>
                  <td>{c.phone || "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="calv-btn calv-btn--secondary calv-btn--sm" disabled={pending && busyReview === r.id}
                      onClick={() => onResolve(r.id, { type: "link", clientId: c.id })}>
                      Same person — link
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, textAlign: "right" }}>
            <button className="calv-btn calv-btn--quiet calv-btn--sm" disabled={pending && busyReview === r.id}
              onClick={() => onResolve(r.id, { type: "dismiss" })}>
              Not the same person
            </button>
          </div>
        </div>
      ))}
    </Panel>
  );
}
