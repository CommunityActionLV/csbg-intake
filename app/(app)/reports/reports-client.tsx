"use client";
/* Reports — CSBG Annual Report rollup preview (Module 3). Pixel port of
   screens-reports.jsx; all data arrives pre-tallied from the server page.
   Filters live in the URL (?period/programs/domains); the bar below pushes a
   new querystring, the server re-runs the rollup, and every export link carries
   the same scope so the download matches what's on screen. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, CodeChip, Kpi, Meter, Notice, PageHead, Panel } from "@/components/ui";
import { Seg } from "@/components/ui-client";
import { useToast } from "@/components/toast";
import { I } from "@/components/icons";
import { fmt } from "@/lib/format";
import { fnpiStats, type MiniTableData, type ReportRollup } from "./types";
import { addRomaGoal, removeRomaGoal } from "./actions";

interface Opt { id: string; label: string }
export interface FilterState {
  preset: string;
  from: string;
  to: string;
  programIds: string[];
  domains: string[];
  query: string;
}

/** Scope controls. Selections are staged locally, then "Apply" pushes a new
    querystring so the server rollup re-runs; "Reset" returns to the federal view. */
function FilterBar({ state, periodOptions, programOptions, domainOptions }: {
  state: FilterState;
  periodOptions: Opt[];
  programOptions: Opt[];
  domainOptions: Opt[];
}) {
  const router = useRouter();
  const [preset, setPreset] = useState(state.preset);
  const [from, setFrom] = useState(state.from);
  const [to, setTo] = useState(state.to);
  const [programIds, setProgramIds] = useState<string[]>(state.programIds);
  const [domains, setDomains] = useState<string[]>(state.domains);

  const apply = () => {
    const qp = new URLSearchParams();
    if (preset !== "current") qp.set("period", preset);
    if (preset === "custom") { if (from) qp.set("from", from); if (to) qp.set("to", to); }
    if (programIds.length) qp.set("programs", programIds.join(","));
    if (domains.length) qp.set("domains", domains.join(","));
    const qs = qp.toString();
    router.push(qs ? `/reports?${qs}` : "/reports");
  };
  const reset = () => {
    setPreset("current"); setFrom(""); setTo(""); setProgramIds([]); setDomains([]);
    router.push("/reports");
  };
  const dirty = state.query !== (() => {
    const qp = new URLSearchParams();
    if (preset !== "current") qp.set("period", preset);
    if (preset === "custom") { if (from) qp.set("from", from); if (to) qp.set("to", to); }
    if (programIds.length) qp.set("programs", programIds.join(","));
    if (domains.length) qp.set("domains", domains.join(","));
    return qp.toString();
  })();

  const multi = (e: React.ChangeEvent<HTMLSelectElement>) => [...e.target.selectedOptions].map((o) => o.value);

  return (
    <Panel title="Filter the rollup" sub="Default is the full agency submission view. Narrowing by period, program, or service switches to a live-records-only analysis (pre-system baselines excluded).">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, alignItems: "start" }}>
        <div className="field">
          <label>Reporting period</label>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {periodOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {preset === "custom" ? (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
              <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          ) : null}
        </div>
        <div className="field">
          <label>Programs {programIds.length ? `(${programIds.length})` : ""}</label>
          <select multiple size={5} value={programIds} onChange={(e) => setProgramIds(multi(e))}>
            {programOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Service domains {domains.length ? `(${domains.length})` : ""}</label>
          <select multiple size={5} value={domains} onChange={(e) => setDomains(multi(e))}>
            {domainOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button className="calv-btn calv-btn--primary calv-btn--sm" onClick={apply} disabled={!dirty}>Apply filters</button>
        <button className="calv-btn calv-btn--quiet calv-btn--sm" onClick={reset}>Reset to full view</button>
        <span className="kbd-hint" style={{ marginLeft: "auto" }}>Ctrl/⌘-click to select multiple</span>
      </div>
    </Panel>
  );
}

function MiniTable({ title, code, rows, total }: MiniTableData) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Panel>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <h3 className="ptitle" style={{ fontSize: 15 }}>{title}</h3>
        <CodeChip code={code} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "grid", gridTemplateColumns: "1fr 60px 32px", gap: 10, alignItems: "center", fontSize: 12.5 }}>
            <span style={{ color: "var(--calv-slate-65)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            <div className="track" style={{ height: 10, background: "var(--calv-sand-15)", borderRadius: 2, overflow: "hidden" }}>
              <i style={{ display: "block", height: "100%", width: (r.n / max * 100) + "%", background: "var(--calv-teal)" }}></i>
            </div>
            <span style={{ fontFamily: "var(--font-h1)", fontSize: 13, textAlign: "right" }}>{r.n}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--calv-slate-15)", paddingTop: 7, marginTop: 3, fontSize: 12 }}>
          <span style={{ color: "var(--calv-slate-65)" }}>TOTAL</span>
          <span style={{ fontFamily: "var(--font-h1)", fontSize: 13 }}>{total}</span>
        </div>
      </div>
    </Panel>
  );
}

export function ReportsClient({ data, canManageGoals, fnpiOptions, filterState, periodOptions, programOptions, domainOptions }: {
  data: ReportRollup;
  canManageGoals: boolean;
  fnpiOptions: Array<{ code: string; label: string }>;
  filterState: FilterState;
  periodOptions: Opt[];
  programOptions: Opt[];
  domainOptions: Opt[];
}) {
  const toast = useToast();
  const [tab, setTab] = useState("Characteristics");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDesc, setGoalDesc] = useState("");
  const [goalCodes, setGoalCodes] = useState<string[]>([]);

  async function onAddGoal() {
    const res = await addRomaGoal(goalTitle, goalDesc, goalCodes);
    toast(res.message);
    if (res.ok) { setGoalTitle(""); setGoalDesc(""); setGoalCodes([]); }
  }
  async function onRemoveGoal(id: number) {
    const res = await removeRomaGoal(id);
    toast(res.message);
  }
  const { fy, agency, clientCount: n, readyPct } = data;
  const maxSrv = Math.max(1, ...data.srvByDomain.map((d) => d.count));

  // real file downloads from the export route — the active filter querystring
  // is appended so every export matches the scope shown on screen.
  const download = (path: string, msg: string) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = filterState.query ? `${path}${sep}${filterState.query}` : path;
    const a = document.createElement("a");
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(msg);
  };

  return (
    <div>
      <PageHead
        title="The report writes"
        titleAccent="itself."
        lede={`Live ${fy.short} rollup in CSBG Annual Report 3.0 format (OMB 0970-0492) — exactly what gets submitted to DCED each fall.`}
        right={
          <div style={{ display: "flex", gap: 8 }}>
            <button className="calv-btn calv-btn--quiet calv-btn--sm"
              onClick={() => download("/reports/export", "CSV export generated.")}>Export CSV</button>
            <button className="calv-btn calv-btn--quiet calv-btn--sm"
              onClick={() => download("/reports/export?xlsx=1", "Module 3 workbook exported — Sections A, B & C plus the validation sheet.")}>
              Module 3 workbook (Excel)
            </button>
            <button className="calv-btn calv-btn--primary calv-btn--sm"
              onClick={() => download("/reports/export?packet=1", "Annual Report PDF drafted — Module 3 Sections A, B & C.")}>
              <I name="doc" size={13} /> Draft Annual Report (PDF)
            </button>
          </div>
        }
      />

      {data.live ? (
        <Notice tone="warn" icon="alert">
          <strong>Live records only.</strong> This filtered view counts purely from in-system records
          and <strong>excludes the imported pre-system baseline</strong>, so the totals are lower than the
          official submission figures. Scope: {data.fy.label}
          {data.scopeNote ? ` · ${data.scopeNote}` : ""}. Reset to the full view for the numbers you file.
        </Notice>
      ) : null}

      <FilterBar state={filterState} periodOptions={periodOptions} programOptions={programOptions} domainOptions={domainOptions} />

      <div className="kpis">
        <Kpi kick="Individuals served (unduplicated)" value={fmt(agency.individualsServed)} foot="Module 3 Sec. C, line A" />
        <Kpi kick="Households served (unduplicated)" value={fmt(agency.householdsServed)} foot="Module 3 Sec. C, line B" accent="var(--calv-teal)" />
        <Kpi kick={data.live ? "New enrollments in period" : "New enrollments this FY"} value={fmt(agency.newThisFY)} accent="var(--calv-sage)" />
        <Kpi kick="Records report-ready" value={readyPct + "%"} foot={(100 - readyPct) + "% have Unknown / Not Reported fields"} tone="bad" accent="var(--calv-amber)" />
      </div>

      <div className="toolbar">
        <Seg options={["Characteristics", "Services", "Outcomes (FNPI)", "ROMA goals"]} value={tab} onChange={setTab} />
        <span className="kbd-hint" style={{ marginLeft: "auto" }}>
          {tab === "Characteristics" ? "Sec. C — tallied live from the " + n + " records in this system" :
            tab === "Services" ? "Sec. A — unduplicated counts by service code" :
              tab === "Outcomes (FNPI)" ? "Sec. B — Individual & Family National Performance Indicators" :
                "Org Standard 4.3 — agency goals traced to the indicators that measure them"}
        </span>
      </div>

      {tab === "Characteristics" ? (
        <>
          <Panel
            title="Section C top line — records with one or more characteristics obtained"
            sub={`Live records only (pre-system baseline shown in the KPI row): ${fmt(data.sectionCTotals.individuals)} individuals · ${fmt(data.sectionCTotals.households)} households. Every table below totals back to its reportable universe, Unknown / Not Reported included — the same sum rule the federal submission validates.`}
          >
            {(() => {
              const issues = data.dataQuality.filter((q) => q.unknown > 0 || q.drift.length > 0);
              if (issues.length === 0) {
                return <p style={{ fontSize: 12.5, color: "var(--calv-slate-65)", margin: 0 }}>
                  No validation gaps — every characteristic canonicalizes cleanly with nothing Unknown.
                </p>;
              }
              return (
                <table className="data" style={{ fontSize: 12.5 }}>
                  <thead><tr><th>Characteristic</th><th>Unknown / Not Reported</th><th>Answer-list drift (stored values that don&apos;t match the federal form)</th></tr></thead>
                  <tbody>
                    {issues.map((q) => (
                      <tr key={q.title}>
                        <td>{q.title}</td>
                        <td>{q.unknown > 0 ? `${fmt(q.unknown)} of ${fmt(q.total)}` : "—"}</td>
                        <td>{q.drift.length > 0
                          ? q.drift.map((d) => `“${d.value}” ×${d.count}`).join(" · ")
                          : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
          </Panel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 13, marginTop: 13 }}>
            {data.characteristics.map((m) => (
              <MiniTable key={m.title} title={m.title} code={m.code} rows={m.rows} total={m.total} />
            ))}
          </div>
        </>
      ) : null}

      {tab === "Services" ? (
        <Panel title="Module 3, Section A — services by domain" sub={`Unduplicated individuals served, ${fy.short} to date. Click a domain in the full product to drill to service-code level.`}>
          <div className="bars-h" style={{ maxWidth: 760 }}>
            {data.srvByDomain.map((d) => (
              <div className="bar-h" key={d.domain} style={{ gridTemplateColumns: "220px 1fr 70px" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>{d.name} <CodeChip code={d.code} /></span>
                <div className="track" style={{ height: 18 }}><i style={{ width: (d.count / maxSrv * 100) + "%" }}></i></div>
                <span className="v">{fmt(d.count)}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--calv-slate-65)", marginTop: 16 }}>
            Top single services: {data.topServices.map((s) => `${s.code} ${s.label} (${fmt(s.count)})`).join(" · ")}.
          </p>
        </Panel>
      ) : null}

      {tab === "Outcomes (FNPI)" ? (
        <Panel title="Module 3, Section B — Individual & Family NPIs" sub={`Actuals vs ${fy.short} targets. 'Achieving outcome' = actual ÷ number served; 'target accuracy' = actual ÷ target.`}>
          <table className="data">
            <thead><tr><th>Indicator</th><th className="num">Served</th><th className="num">Target</th><th className="num">Actual</th><th className="num">% achieving</th><th style={{ width: 170 }}>Target accuracy</th><th>Pace</th></tr></thead>
            <tbody>
              {data.fnpi.map((f) => {
                const { achieving, accuracy, onPace } = fnpiStats(f, fy.pctElapsed);
                return (
                  <tr key={f.code}>
                    <td><div style={{ display: "flex", gap: 8, alignItems: "center" }}><CodeChip code={f.code} /><span style={{ maxWidth: 330, display: "inline-block" }}>{f.label}</span></div></td>
                    <td className="num">{fmt(f.served)}</td>
                    <td className="num" style={{ color: "var(--calv-slate-65)" }}>{fmt(f.target)}</td>
                    <td className="num">{fmt(f.actual)}</td>
                    <td className="num">{achieving}%</td>
                    <td><Meter pct={Math.min(accuracy, 100)} tone={onPace ? "" : "warn"} /></td>
                    <td>{onPace ? <Chip tone="sage">On pace</Chip> : <Chip tone="amber">Behind</Chip>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: "var(--calv-slate-65)", marginTop: 14 }}>
            {fy.pctElapsed}% of the FY has elapsed — indicators under {fy.pctElapsed - 5}% of target are flagged so program managers can act before September 30, not after.
          </p>
        </Panel>
      ) : null}

      {tab === "ROMA goals" ? (
        <Panel title="ROMA — agency goals and the indicators that measure them"
          sub="Board-ready evidence for Organizational Standard 4.3: each goal traces to FNPI indicators, whose live counts roll up here.">
          {canManageGoals ? (
            <div style={{ margin: "4px 0 18px", padding: "14px 16px", background: "var(--calv-sand-15)", border: "1px solid var(--calv-sand-35)", borderRadius: 4 }}>
              <div className="calv-label" style={{ marginBottom: 10 }}>Add a goal</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12 }}>
                <div className="field"><label>Goal title</label>
                  <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="e.g. Households achieve stable housing" /></div>
                <div className="field"><label>Description (optional)</label>
                  <input value={goalDesc} onChange={(e) => setGoalDesc(e.target.value)} placeholder="From the community action plan" /></div>
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label>Linked FNPI indicators (choose one or more)</label>
                <select multiple size={6} value={goalCodes}
                  onChange={(e) => setGoalCodes([...e.target.selectedOptions].map((o) => o.value))}>
                  {fnpiOptions.map((f) => <option key={f.code} value={f.code}>{f.code} — {f.label}</option>)}
                </select>
              </div>
              <button className="calv-btn calv-btn--primary calv-btn--sm" style={{ marginTop: 10 }} onClick={onAddGoal}>
                <I name="plus" size={13} /> Add goal
              </button>
            </div>
          ) : null}
          {data.roma.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              No goals yet — link your community action plan goals to FNPI indicators
              {canManageGoals ? " with the form above" : " (a Program Manager or Data Admin adds them)"}.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {data.roma.map((g) => {
                const pct = g.target > 0 ? Math.min(100, Math.round((g.actual / g.target) * 100)) : 0;
                return (
                  <div key={g.id} style={{ border: "1px solid var(--calv-slate-15)", borderRadius: 4, padding: "14px 16px" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <strong style={{ fontWeight: 600, fontSize: 14 }}>{g.title}</strong>
                      <span style={{ fontSize: 12, color: "var(--calv-slate-65)" }}>
                        {g.indicators.map((i) => i.code).join(" · ")}
                      </span>
                      {canManageGoals ? (
                        <button className="calv-btn calv-btn--quiet calv-btn--sm" style={{ marginLeft: "auto" }} onClick={() => onRemoveGoal(g.id)}>Remove</button>
                      ) : null}
                    </div>
                    {g.description ? <p style={{ fontSize: 12.5, color: "var(--calv-slate-65)", margin: "6px 0 0" }}>{g.description}</p> : null}
                    <div style={{ display: "flex", gap: 18, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5 }}>Served <strong style={{ fontWeight: 700 }}>{fmt(g.served)}</strong></span>
                      <span style={{ fontSize: 12.5 }}>Target <strong style={{ fontWeight: 700 }}>{fmt(g.target)}</strong></span>
                      <span style={{ fontSize: 12.5 }}>Achieved <strong style={{ fontWeight: 700 }}>{fmt(g.actual)}</strong></span>
                      <div className="track" style={{ height: 14, flex: 1, minWidth: 160 }}><i style={{ width: pct + "%" }}></i></div>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{g.target > 0 ? pct + "% of target" : "no target set"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
