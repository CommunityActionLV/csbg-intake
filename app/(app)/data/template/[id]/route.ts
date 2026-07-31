import { asc, eq } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { importTemplate } from "@/lib/import-templates";
import { buildTemplateWorkbook } from "@/lib/template-workbook";
import { getFplHistory } from "@/lib/fpl";

/* ============================================================
   GET /data/template/[id] — downloadable import template (.xlsx):
   an Import sheet (headers + skip-guaranteed example row) and an
   "Accepted values" key sheet listing every accepted value for
   fields with predetermined options — including the agency's
   LIVE program, staff, and FPL-schedule lists at download time.
   Admin-only, like the import wizard itself.
   ============================================================ */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  await requireAdmin();

  const { id } = await params;
  const tpl = importTemplate(id);
  if (!tpl) return new Response("Unknown import template.", { status: 404 });

  const programs = (await db.select().from(t.programs).where(eq(t.programs.active, 1)).orderBy(asc(t.programs.sort)))
    .map((p) => ({ id: p.id, name: p.name }));
  const staff = (await db.select().from(t.users).where(eq(t.users.active, 1)).orderBy(asc(t.users.name)))
    .map((u) => ({ name: u.name, username: u.username, initials: u.initials }));
  const fplYears = (await getFplHistory()).map((s) => s.year).sort((a, b) => b - a);

  const wb = await buildTemplateWorkbook(tpl, { programs, staff, fplYears });
  const buf = await wb.xlsx.writeBuffer();

  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="cap-trellis-import-${tpl.id}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
