import ExcelJS from "exceljs";
import { characteristicByCode, SERVICES } from "@/lib/csbg-catalog";
import { INCOME_PERIODS } from "@/lib/income";
import type { ImportField, ImportTemplate } from "@/lib/import-templates";

/* ============================================================
   Downloadable import template as an .xlsx workbook:
     Sheet 1 "Import"          — header row + the skip-guaranteed
                                 example row (what gets uploaded;
                                 the parser reads only this sheet)
     Sheet 2 "Accepted values" — a key of every accepted value for
                                 each field with predetermined
                                 options, including the agency's
                                 LIVE lists (programs, staff, FPL
                                 schedule years) at download time.
   Server-side only (ExcelJS stays out of the client bundle).
   ============================================================ */

/** Live per-agency lists resolved by the caller (route handler). */
export interface LiveOptionLists {
  programs: Array<{ id: string; name: string }>;
  staff: Array<{ name: string; username: string; initials: string }>;
  fplYears: number[];
}

interface KeySection {
  title: string;
  note: string;
  values: string[];
}

/** Accepted values for one option-backed field (null = free text). */
function keySectionFor(field: ImportField, live: LiveOptionLists): KeySection | null {
  const opt = field.options;
  if (!opt) return null;
  const base = { title: field.label, note: "" };
  switch (opt) {
    case "yes-no":
      return { ...base, note: "Blank = unknown.", values: ["Yes", "No"] };
    case "period":
      return { ...base, note: "Blank = annual. Close variants accepted (e.g. “per month”, “bi-weekly”).",
        values: INCOME_PERIODS.map((p) => p.label) };
    case "services":
      return { ...base, note: "Use the code or the exact label.",
        values: SERVICES.map((s) => `${s.code} — ${s.label}`) };
    case "programs":
      return { ...base,
        note: live.programs.length ? "Your programs as configured today (name or id works)." : "As configured in Settings → Programs (name or id).",
        values: live.programs.map((p) => `${p.name}  (id: ${p.id})`) };
    case "staff":
      return { ...base,
        note: live.staff.length ? "Your active staff (name, username, or initials works). Blank assigns to the importer." : "Any active staff member's name, username, or initials.",
        values: live.staff.map((s) => `${s.name}  (${s.username} / ${s.initials})`) };
    case "fpl-years":
      return { ...base,
        note: "Configured FPL schedules — or map a DATE column and each row pins to the schedule in force that day. Blank uses the active schedule.",
        values: live.fplYears.map(String) };
    default: {
      // AR 3.0 characteristic — instrument-canonical answers
      const c = characteristicByCode(opt);
      if (!c) return null;
      return { ...base,
        note: "Instrument answers — close variants map automatically; anything else imports as-is and surfaces on the data-quality panel. Blank = Unknown/Not Reported.",
        values: c.options };
    }
  }
}

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE8DF" } };

export async function buildTemplateWorkbook(tpl: ImportTemplate, live: LiveOptionLists): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CAP Trellis";

  // ---- Sheet 1: the import grid (headers + skip-guaranteed example row) ----
  const ws = wb.addWorksheet("Import", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(tpl.fields.map((f) => f.label));
  ws.addRow(tpl.fields.map((f) => f.example));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = HEADER_FILL;
  ws.getRow(2).font = { italic: true, color: { argb: "FF6B6B6B" } };
  tpl.fields.forEach((f, i) => {
    ws.getColumn(i + 1).width = Math.min(42, Math.max(f.label.length, f.example.length, 12) + 2);
  });

  // ---- Sheet 2: the accepted-values key ----
  const key = wb.addWorksheet("Accepted values");
  key.getColumn(1).width = 96;
  const add = (text: string, style?: Partial<ExcelJS.Font>) => {
    const row = key.addRow([text]);
    if (style) row.getCell(1).font = style;
    return row;
  };
  add(`${tpl.name} — accepted values`, { bold: true, size: 13 });
  add("Fill in the Import sheet (replace the example row — it is engineered to be skipped if left in) and upload the file.");
  add("Dates: 2026-01-15 or 1/15/2026. Fields not listed below are free text.");
  add("");
  for (const f of tpl.fields) {
    const section = keySectionFor(f, live);
    if (!section) continue;
    add(section.title + (f.required ? "  (required)" : ""), { bold: true });
    if (section.note) add(section.note, { italic: true, color: { argb: "FF6B6B6B" } });
    if (section.values.length === 0) add("(none configured yet)", { color: { argb: "FF6B6B6B" } });
    for (const v of section.values) add("  " + v);
    add("");
  }
  return wb;
}
