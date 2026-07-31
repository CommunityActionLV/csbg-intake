import ExcelJS from "exceljs";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/access";
import { getOrg } from "@/lib/data/core";
import { CATALOG_VERSION } from "@/lib/csbg-catalog";
import { buildRollup } from "../rollup";
import { resolveFilters } from "../filters";
import { renderReportPdf } from "./report-pdf";
import { fnpiStats, type ReportRollup } from "../types";

/* ============================================================
   GET /reports/export          → CSV rollup (Module 3 A/B/C)
   GET /reports/export?packet=1 → Draft Annual Report packet (branded PDF)
   GET /reports/export?xlsx=1   → Module 3 workbook (Excel), shaped like the
                                  OCS SmartForm sections for transcription
                                  into the state submission
   All three honor the same ?period/programs/domains filter params as the
   Reports page, and stream real files generated from live data.
   ============================================================ */

export const dynamic = "force-dynamic";

// ---------- CSV helpers ----------
const esc = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const row = (...cells: Array<string | number>): string => cells.map(esc).join(",");

function buildCsv(d: ReportRollup): string {
  const L: string[] = [];
  L.push(row(`CSBG Annual Report 3.0 (OMB 0970-0492) — ${d.fy.short} rollup`));
  L.push(row("Agency", d.orgName));
  L.push(row("Fiscal year", `${d.fy.label} (${d.fy.range})`));
  L.push(row("Generated", d.generated));
  L.push(row("Records report-ready", d.readyPct + "%"));
  L.push("");

  L.push(row("MODULE 3 SEC. C — SUMMARY"));
  L.push(row("Line", "Measure", "Value"));
  L.push(row("A", "Individuals served (unduplicated)", d.agency.individualsServed));
  L.push(row("B", "Households served (unduplicated)", d.agency.householdsServed));
  L.push(row("", "New enrollments this FY", d.agency.newThisFY));
  L.push(row("", "Individuals with 1+ characteristics obtained (live records)", d.sectionCTotals.individuals));
  L.push(row("", "Households with 1+ characteristics obtained (live records)", d.sectionCTotals.households));
  L.push("");

  const dq = d.dataQuality.filter((q) => q.unknown > 0 || q.drift.length > 0);
  if (dq.length > 0) {
    L.push(row("SEC. C VALIDATION — UNKNOWNS AND ANSWER-LIST DRIFT"));
    L.push(row("Characteristic", "Unknown / Not Reported", "Unmatched stored values"));
    for (const q of dq) {
      L.push(row(q.title, q.unknown > 0 ? `${q.unknown} of ${q.total}` : "",
        q.drift.map((x) => `${x.value} x${x.count}`).join(" · ")));
    }
    L.push("");
  }

  L.push(row("MODULE 3 SEC. C — ALL CHARACTERISTICS REPORT"));
  for (const m of d.characteristics) {
    L.push(row(m.code, m.title));
    L.push(row("Answer", "Count"));
    for (const r of m.rows) L.push(row(r.label, r.n));
    L.push(row("TOTAL", m.total));
    L.push("");
  }

  L.push(row("MODULE 3 SEC. A — SERVICES BY DOMAIN"));
  L.push(row("Code", "Domain", "Individuals served"));
  for (const s of d.srvByDomain) L.push(row(s.code, s.name, s.count));
  L.push("");
  L.push(row("TOP SINGLE SERVICES"));
  L.push(row("Code", "Service", "Count"));
  for (const s of d.topServices) L.push(row(s.code, s.label, s.count));
  L.push("");

  L.push(row("MODULE 3 SEC. B — INDIVIDUAL & FAMILY NPIs"));
  L.push(row("Code", "Indicator", "Served", "Target", "Actual", "% achieving", "Target accuracy", "Pace"));
  for (const f of d.fnpi) {
    const s = fnpiStats(f, d.fy.pctElapsed);
    L.push(row(f.code, f.label, f.served, f.target, f.actual, s.achieving + "%", s.accuracy + "%", s.onPace ? "On pace" : "Behind"));
  }
  L.push("");
  L.push(row(`${d.fy.pctElapsed}% of the FY has elapsed — indicators under ${d.fy.pctElapsed - 5}% of target are flagged.`));
  // UTF-8 BOM so Excel renders em dashes / accents correctly
  return "\uFEFF" + L.join("\r\n") + "\r\n";
}

// ---------- Module 3 workbook (SmartForm-shaped Excel) ----------
/* The OCS submission pipeline (OLDC) rejects control characters and chokes on
   markup-significant text in SmartForm cells — scrub every string we emit. */
const cleanCell = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();

async function buildXlsx(d: ReportRollup): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CAP Trellis";
  const bold = { bold: true } as const;

  const cover = wb.addWorksheet("Cover");
  cover.columns = [{ width: 34 }, { width: 60 }];
  cover.addRows([
    ["CSBG Annual Report 3.0 — Module 3", ""],
    ["OMB No.", "0970-0492"],
    ["Catalog version", CATALOG_VERSION],
    ["Agency", cleanCell(d.orgName)],
    ["Reporting period", `${d.fy.label} (${d.fy.range})`],
    ["Generated", d.generated],
    ["", ""],
    ["How to use this workbook", "Values are shaped to the Module 3 sections for transcription into your state's SmartForm/portal. Every characteristic block totals back to its reportable universe, Unknown/Not Reported included."],
  ]);
  cover.getColumn(1).font = bold;

  const secA = wb.addWorksheet("Section A — Services");
  secA.columns = [{ width: 10 }, { width: 56 }, { width: 18 }];
  secA.addRow(["Code", "Domain", "Individuals served"]).font = bold;
  for (const s of d.srvByDomain) secA.addRow([s.code, cleanCell(s.name), s.count]);
  secA.addRow([]);
  secA.addRow(["Code", "Top single services", "Count"]).font = bold;
  for (const s of d.topServices) secA.addRow([s.code, cleanCell(s.label), s.count]);

  const secB = wb.addWorksheet("Section B — FNPIs");
  secB.columns = [{ width: 12 }, { width: 64 }, { width: 10 }, { width: 10 }, { width: 10 }];
  secB.addRow(["Code", "Indicator", "Served", "Target", "Actual"]).font = bold;
  for (const f of d.fnpi) secB.addRow([f.code, cleanCell(f.label), f.served, f.target, f.actual]);

  const secC = wb.addWorksheet("Section C — All Characteristics");
  secC.columns = [{ width: 58 }, { width: 14 }];
  secC.addRow(["Individuals about whom one or more characteristics were obtained (live records)", d.sectionCTotals.individuals]).font = bold;
  secC.addRow(["Households about whom one or more characteristics were obtained (live records)", d.sectionCTotals.households]).font = bold;
  for (const m of d.characteristics) {
    secC.addRow([]);
    const h = secC.addRow([cleanCell(`${m.title} (${m.code})`), ""]);
    h.font = bold;
    for (const r of m.rows) secC.addRow([cleanCell(r.label), r.n]);
    const t = secC.addRow(["TOTAL", m.total]);
    t.font = bold;
  }

  const dq = d.dataQuality.filter((q) => q.unknown > 0 || q.drift.length > 0);
  const val = wb.addWorksheet("Validation");
  val.columns = [{ width: 36 }, { width: 22 }, { width: 60 }];
  val.addRow(["Characteristic", "Unknown / Not Reported", "Stored values that don't match the instrument"]).font = bold;
  if (dq.length === 0) {
    val.addRow(["No validation gaps", "", ""]);
  } else {
    for (const q of dq) {
      val.addRow([
        cleanCell(q.title),
        q.unknown > 0 ? `${q.unknown} of ${q.total}` : "",
        cleanCell(q.drift.map((x) => `${x.value} ×${x.count}`).join(" · ")),
      ]);
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function GET(req: Request): Promise<Response> {
  const user = await requireUser();
  const url = new URL(req.url);
  const params = url.searchParams;
  const packet = params.get("packet") === "1";
  const xlsx = params.get("xlsx") === "1";

  const org = await getOrg();
  const filters = resolveFilters(Object.fromEntries(params), org.fyStart);
  const d = await buildRollup(filters);
  const slug = d.fy.short.toLowerCase().replace(/[^a-z0-9]+/g, "-") + (d.live ? "-filtered" : "");
  const scope = d.live ? ` (filtered — live records only${d.scopeNote ? `; ${d.scopeNote}` : ""})` : "";

  if (packet) {
    const body = await renderReportPdf(d, { accent: org.accent, logoData: org.logoData, catalogVersion: CATALOG_VERSION });
    await audit(user.id, "report.pdf", "report", d.fy.short,
      `Annual Report PDF drafted — Module 3 Sections A, B & C${scope}`);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="csbg-annual-report-${slug}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (xlsx) {
    const body = await buildXlsx(d);
    await audit(user.id, "report.xlsx", "report", d.fy.short,
      `Module 3 workbook exported (SmartForm-shaped Excel, Sections A, B & C + validation)${scope}`);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="csbg-module4-${slug}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const body = buildCsv(d);
  await audit(user.id, "report.export", "report", d.fy.short,
    `CSV rollup exported (Module 3 Sections A, B & C)${scope}`);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="csbg-annual-report-${slug}-rollup.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
