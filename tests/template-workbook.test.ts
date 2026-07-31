import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readSheet } from "../src/lib/spreadsheet";
import { IMPORT_TEMPLATES, autoMapColumns } from "../src/lib/import-templates";
import { buildTemplateWorkbook, type LiveOptionLists } from "../src/lib/template-workbook";
import { characteristicByCode } from "../src/lib/csbg-catalog";

const LIVE: LiveOptionLists = {
  programs: [{ id: "wx", name: "Weatherization" }, { id: "gnx", name: "Generation Next" }],
  staff: [{ name: "Dana Rivera", username: "dana", initials: "DR" }],
  fplYears: [2026, 2025, 2024],
};

async function buffers(tplId: string): Promise<{ buf: Buffer; wb: ExcelJS.Workbook }> {
  const tpl = IMPORT_TEMPLATES.find((t) => t.id === tplId)!;
  const wb = await buildTemplateWorkbook(tpl, LIVE);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { buf, wb };
}

describe("downloadable template workbooks", () => {
  it("every option annotation resolves to at least one accepted value", () => {
    for (const tpl of IMPORT_TEMPLATES) {
      for (const f of tpl.fields) {
        if (!f.options) continue;
        if (["yes-no", "period", "services", "programs", "staff", "fpl-years"].includes(f.options)) continue;
        const c = characteristicByCode(f.options);
        expect(c, `${tpl.id}.${f.key}: characteristic ${f.options} must exist`).toBeTruthy();
        expect(c!.options.length).toBeGreaterThan(0);
      }
    }
  });

  for (const tpl of IMPORT_TEMPLATES) {
    it(`${tpl.name}: Import sheet round-trips the upload parser with a full auto-map`, async () => {
      const { buf } = await buffers(tpl.id);
      // readSheet reads the FIRST worksheet only — the key sheet must not interfere
      const sheet = await readSheet(buf);
      expect(sheet).not.toBeNull();
      expect(sheet!.rows).toHaveLength(1); // the example row
      const mapping = autoMapColumns(tpl, sheet!.headers);
      for (const f of tpl.fields) {
        expect(mapping[f.key], `field ${f.key} should auto-map`).toBeGreaterThanOrEqual(0);
        expect(sheet!.headers[mapping[f.key]]).toBe(f.label);
      }
    });
  }

  it("clients workbook carries a key sheet with instrument answers and live lists", async () => {
    const { wb } = await buffers("clients");
    const key = wb.getWorksheet("Accepted values");
    expect(key).toBeTruthy();
    const text: string[] = [];
    key!.eachRow((row) => text.push(String(row.getCell(1).value ?? "")));
    const all = text.join("\n");
    // instrument answers for option-backed characteristics
    expect(all).toContain("Transgender, non-binary, or another gender");            // C1
    expect(all).toContain("Multiracial or Multiethnic (two or more of the above)"); // C6
    expect(all).toContain("Single Parent Female");                                  // D9
    // live lists resolved at download time
    expect(all).toContain("Weatherization");         // programs
    expect(all).toContain("Dana Rivera");            // staff
    expect(all).toContain("2026");                   // FPL years
    // the services taxonomy key
    expect(all).toContain("SDA 1a — Eligibility determinations");
  });

  it("templates without option-backed fields still get the general-notes key sheet", async () => {
    const { wb } = await buffers("seminars");
    const key = wb.getWorksheet("Accepted values");
    expect(key).toBeTruthy();
  });
});
