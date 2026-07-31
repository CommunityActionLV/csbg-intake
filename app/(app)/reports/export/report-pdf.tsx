import React from "react";
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { fmt } from "@/lib/format";
import { fnpiStats, type MiniTableData, type ReportRollup } from "../types";

/* ============================================================
   Draft CSBG Annual Report 3.0 — branded PDF packet.

   Built with @react-pdf/renderer (pure JS, no headless browser) so it renders
   the same in dev, `next start`, and the standalone container. Fonts are the
   PDF-standard Helvetica family — no external font files to trace or ship —
   and branding comes from the agency accent color + uploaded logo. Consumes the
   same ReportRollup as the CSV/XLSX exporters, so all four stay in lock-step.
   ============================================================ */

export interface PdfMeta {
  accent: string;              // agency brand color, e.g. "#D14124"
  logoData?: string | null;    // data: URL when the agency uploaded a logo
  catalogVersion: string;      // e.g. "AR-3.0.1"
}

const INK = "#26211C";
const MUTE = "#6B6257";
const LINE = "#D9D3C9";
const HEADFILL = "#F2EFEA";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 54, paddingHorizontal: 40, fontFamily: "Helvetica", fontSize: 9, color: INK, lineHeight: 1.35 },

  band: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "14 16", borderRadius: 4, marginBottom: 14 },
  bandTitle: { fontFamily: "Helvetica-Bold", fontSize: 16, color: "#FFFFFF", lineHeight: 1.1 },
  bandSub: { fontSize: 8.5, color: "#FFFFFF", opacity: 0.9, marginTop: 4 },
  logo: { height: 34, maxWidth: 150, objectFit: "contain" },

  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 10 },
  metaItem: { fontSize: 8, color: MUTE, marginRight: 12 },
  metaStrong: { fontFamily: "Helvetica-Bold", color: INK },

  caveat: { borderWidth: 1, borderColor: "#E4B94D", backgroundColor: "#FBF3DD", borderRadius: 4, padding: "8 10", marginBottom: 12 },
  caveatText: { fontSize: 8.5, color: "#6A4E12" },

  h2: { fontFamily: "Helvetica-Bold", fontSize: 12, marginTop: 6, marginBottom: 6, paddingBottom: 3, borderBottomWidth: 1.5 },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 9.5, marginBottom: 3 },
  note: { fontSize: 8, color: MUTE, marginBottom: 6 },

  // table primitives
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 3, marginBottom: 10 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE },
  trLast: { flexDirection: "row" },
  th: { fontFamily: "Helvetica-Bold", fontSize: 8, backgroundColor: HEADFILL, padding: "4 6" },
  td: { fontSize: 8.5, padding: "4 6" },
  tdNum: { fontSize: 8.5, padding: "4 6", textAlign: "right", fontFamily: "Helvetica-Bold" },

  // characteristics grid
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  card: { width: "48.5%", borderWidth: 1, borderColor: LINE, borderRadius: 3, marginBottom: 10 },
  cardHead: { fontFamily: "Helvetica-Bold", fontSize: 8.5, padding: "4 6", backgroundColor: HEADFILL },
  crow: { flexDirection: "row", justifyContent: "space-between", padding: "2.5 6", borderTopWidth: 0.5, borderTopColor: LINE },
  ctotal: { flexDirection: "row", justifyContent: "space-between", padding: "3 6", borderTopWidth: 1, borderTopColor: LINE, backgroundColor: "#FAF8F5" },

  footer: { position: "absolute", bottom: 24, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: LINE, paddingTop: 6 },
  footText: { fontSize: 7, color: MUTE },
});

/** A bordered table from a header spec + rows. `cols` gives flex weights and
    alignment; `rows` are arrays of cell strings/numbers. */
function Table({ cols, header, rows, accent }: {
  cols: Array<{ w: number; num?: boolean }>;
  header: string[];
  rows: Array<Array<string | number>>;
  accent: string;
}) {
  return (
    <View style={s.table}>
      <View style={s.tr} wrap={false}>
        {header.map((h, i) => (
          <Text key={i} style={[s.th, { flex: cols[i].w, textAlign: cols[i].num ? "right" : "left" }]}>{h}</Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} style={ri === rows.length - 1 ? s.trLast : s.tr} wrap={false}>
          {r.map((c, ci) => (
            <Text key={ci} style={[cols[ci].num ? s.tdNum : s.td, { flex: cols[ci].w, color: ci === 0 ? INK : undefined }]}>
              {typeof c === "number" ? fmt(c) : c}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function MiniCard({ m }: { m: MiniTableData }) {
  return (
    <View style={s.card} wrap={false}>
      <Text style={s.cardHead}>{m.title}</Text>
      {m.rows.map((r, i) => (
        <View key={i} style={s.crow}>
          <Text style={{ flex: 1, fontSize: 8, color: MUTE, paddingRight: 4 }}>{r.label}</Text>
          <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold" }}>{fmt(r.n)}</Text>
        </View>
      ))}
      <View style={s.ctotal}>
        <Text style={{ fontSize: 8, color: MUTE }}>TOTAL</Text>
        <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold" }}>{fmt(m.total)}</Text>
      </View>
    </View>
  );
}

function ReportDoc({ d, meta }: { d: ReportRollup; meta: PdfMeta }) {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(meta.accent) ? meta.accent : "#D14124";
  const dq = d.dataQuality.filter((q) => q.unknown > 0 || q.drift.length > 0);
  const hasLogo = typeof meta.logoData === "string" && meta.logoData.startsWith("data:");

  return (
    <Document title={`CSBG Annual Report 3.0 Draft — ${d.orgName} — ${d.fy.short}`} author="CAP Trellis">
      <Page size="LETTER" style={s.page} wrap>
        {/* Branded header band */}
        <View style={[s.band, { backgroundColor: accent }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.bandTitle}>CSBG Annual Report 3.0 — Draft</Text>
            <Text style={s.bandSub}>{d.orgName} · Module 3, Sections A, B &amp; C</Text>
          </View>
          {hasLogo ? <Image src={meta.logoData as string} style={s.logo} /> : null}
        </View>

        {/* Meta line */}
        <View style={s.metaRow}>
          <Text style={s.metaItem}>OMB <Text style={s.metaStrong}>0970-0492</Text></Text>
          <Text style={s.metaItem}>Period <Text style={s.metaStrong}>{d.fy.label}</Text> ({d.fy.range})</Text>
          <Text style={s.metaItem}>Generated <Text style={s.metaStrong}>{d.generated}</Text></Text>
          <Text style={s.metaItem}>Catalog <Text style={s.metaStrong}>{meta.catalogVersion}</Text></Text>
          <Text style={s.metaItem}>Records report-ready <Text style={s.metaStrong}>{d.readyPct}%</Text></Text>
        </View>

        {d.live ? (
          <View style={s.caveat}>
            <Text style={s.caveatText}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Live records only — not the official submission figure. </Text>
              This is a filtered analysis counted purely from in-system records; the imported pre-system baseline is excluded, so totals are lower than the figures you file.
              {d.scopeNote ? ` Scope: ${d.scopeNote}.` : ""}
            </Text>
          </View>
        ) : null}

        {/* Section C summary */}
        <Text style={[s.h2, { borderBottomColor: accent }]}>Module 3, Section C — Summary</Text>
        <Table
          accent={accent}
          cols={[{ w: 0.6 }, { w: 4 }, { w: 1.2, num: true }]}
          header={["Line", "Measure", "Value"]}
          rows={[
            ["A", "Individuals served (unduplicated)", d.agency.individualsServed],
            ["B", "Households served (unduplicated)", d.agency.householdsServed],
            ["", "New enrollments in period", d.agency.newThisFY],
            ["", "Individuals with 1+ characteristics obtained (live records)", d.sectionCTotals.individuals],
            ["", "Households with 1+ characteristics obtained (live records)", d.sectionCTotals.households],
          ]}
        />

        {dq.length > 0 ? (
          <>
            <Text style={s.h3}>Section C validation — unknowns and answer-list drift</Text>
            <Table
              accent={accent}
              cols={[{ w: 2.4 }, { w: 1.6 }, { w: 2.6 }]}
              header={["Characteristic", "Unknown / Not Reported", "Unmatched stored values"]}
              rows={dq.map((q) => [
                q.title,
                q.unknown > 0 ? `${fmt(q.unknown)} of ${fmt(q.total)}` : "—",
                q.drift.map((x) => `"${x.value}" x${x.count}`).join(" · ") || "—",
              ])}
            />
          </>
        ) : null}

        {/* Section A */}
        <Text style={[s.h2, { borderBottomColor: accent }]}>Module 3, Section A — Services by domain</Text>
        <Text style={s.note}>Unduplicated individuals served, {d.fy.label}.</Text>
        <Table
          accent={accent}
          cols={[{ w: 0.9 }, { w: 4 }, { w: 1.3, num: true }]}
          header={["Code", "Domain", "Individuals served"]}
          rows={d.srvByDomain.map((x) => [x.code, x.name, x.count])}
        />
        {d.topServices.length > 0 ? (
          <Text style={s.note}>Top single services: {d.topServices.map((x) => `${x.code} ${x.label} (${fmt(x.count)})`).join(" · ")}.</Text>
        ) : null}

        {/* Section B */}
        <Text style={[s.h2, { borderBottomColor: accent }]}>Module 3, Section B — Individual &amp; Family NPIs</Text>
        <Text style={s.note}>Actuals vs {d.fy.short} targets. Achieving = actual / served; accuracy = actual / target.</Text>
        <Table
          accent={accent}
          cols={[{ w: 0.9 }, { w: 3.2 }, { w: 0.8, num: true }, { w: 0.8, num: true }, { w: 0.8, num: true }, { w: 1, num: true }, { w: 1, num: true }, { w: 1 }]}
          header={["Code", "Indicator", "Served", "Target", "Actual", "% ach.", "Accuracy", "Pace"]}
          rows={d.fnpi.map((f) => {
            const st = fnpiStats(f, d.fy.pctElapsed);
            return [f.code, f.label, f.served, f.target, f.actual, `${st.achieving}%`, `${st.accuracy}%`, st.onPace ? "On pace" : "Behind"];
          })}
        />
        <Text style={s.note}>{d.fy.pctElapsed}% of the period has elapsed — indicators under {d.fy.pctElapsed - 5}% of target are flagged as behind.</Text>

        {/* Section C — all characteristics */}
        <Text style={[s.h2, { borderBottomColor: accent }]}>Module 3, Section C — All Characteristics Report</Text>
        <Text style={s.note}>Tallied live from {fmt(d.clientCount)} enrolled records. Blank answers report as "Unknown / Not Reported."</Text>
        <View style={s.grid}>
          {d.characteristics.map((m) => <MiniCard key={m.title} m={m} />)}
        </View>

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footText}>Draft — generated by CAP Trellis from live records. Review before submission to your state.</Text>
          <Text style={s.footText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export function renderReportPdf(d: ReportRollup, meta: PdfMeta): Promise<Buffer> {
  return renderToBuffer(<ReportDoc d={d} meta={meta} />);
}
