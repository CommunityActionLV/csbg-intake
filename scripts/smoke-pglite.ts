/* Smoke test: run the production bootstrap DDL + seed against an in-process
   PGlite (real Postgres compiled to WASM), then sample the queries the app
   leans on. Verifies the Postgres port without needing a server: `npm run smoke` */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { BOOTSTRAP } from "../src/db/ddl";
import { runSeed } from "../src/db/seed";
import { runInit } from "../src/db/init";
import { characteristicByCode } from "../src/lib/csbg-catalog";
import { LATEST_OFFICIAL_FPL_YEAR } from "../src/lib/fpl-data";

const t = schema;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const pglite = new PGlite();
  await pglite.exec(BOOTSTRAP);
  await pglite.exec(BOOTSTRAP); // idempotency: second boot over an existing schema must not throw
  const db = drizzle(pglite, { schema }) as unknown as NodePgDatabase<typeof schema>;

  await runSeed(db);

  const org = (await db.select().from(t.organization).where(eq(t.organization.id, 1)))[0];
  check("organization seeded", org?.name === "Community Action Lehigh Valley");

  const users = await db.select().from(t.users);
  check("six demo users", users.length === 6, `got ${users.length}`);

  const clients = await db.select().from(t.clients);
  check("clients seeded", clients.length > 0, `got ${clients.length}`);
  check("client jsonb flags is an array", Array.isArray(clients[0]?.flags));
  check("client jsonb custom is an object", typeof clients[0]?.custom === "object" && !Array.isArray(clients[0]?.custom));

  const apps = await db.select().from(t.applications);
  check("applications seeded", apps.length > 0, `got ${apps.length}`);

  // past denials feed the /denials review page — terminal stage with a full determination record
  const denied = apps.filter((a) => a.stage === "denied");
  check("denied applications seeded with determination records",
    denied.length >= 2 && denied.every((a) => !!a.decisionNote && !!a.decidedBy && !!a.decidedAt),
    `got ${denied.length}`);

  // eligibility document-verification rows, incl. the seeded A-1174 SSN bypass
  const bypass = (await db.select().from(t.applicationDocs)
    .where(and(eq(t.applicationDocs.applicationId, "A-1174"), eq(t.applicationDocs.docKey, "ssn"))))[0];
  check("A-1174 ssn bypass row", bypass?.status === "verified" && !!bypass?.bypassBy && !bypass?.fileName);

  // identity column: insert without id, returning
  const inserted = await db.insert(t.serviceLog).values({
    date: "2026-06-11", clientId: clients[0].id, code: "SDA 1a", programId: "cad-a", staffId: "dr", note: "smoke",
  }).returning({ id: t.serviceLog.id });
  check("identity id assigned on insert", Number.isInteger(inserted[0]?.id) && inserted[0].id > 0, `id ${inserted[0]?.id}`);

  // service-log attachment columns (file_name / file_path)
  const withFile = await db.insert(t.serviceLog).values({
    date: "2026-06-11", clientId: clients[0].id, code: "SRV 4e", programId: "cad-a", staffId: "dr",
    note: "smoke attachment", fileName: "receipt.pdf", filePath: "service-log/C-1/svc-1.pdf",
  }).returning({ id: t.serviceLog.id, fileName: t.serviceLog.fileName });
  check("service_log attachment columns roundtrip", withFile[0]?.fileName === "receipt.pdf");

  // per-program service availability (program_services)
  await db.insert(t.programServices).values([
    { programId: "cad-a", code: "SDA 1a" },
    { programId: "cad-a", code: "SRV 4e" },
  ]);
  const psRows = await db.select().from(t.programServices).where(eq(t.programServices.programId, "cad-a"));
  check("program_services roundtrip", psRows.length === 2, `got ${psRows.length}`);
  await db.delete(t.programServices).where(eq(t.programServices.programId, "cad-a"));

  // transaction commit + rollback semantics (the approve flow uses a transaction)
  await db.transaction(async (tx) => {
    await tx.insert(t.kv).values({ key: "smoke", value: { ok: true } });
  });
  const kvRow = (await db.select().from(t.kv).where(eq(t.kv.key, "smoke")))[0];
  check("transaction committed, jsonb kv roundtrip", (kvRow?.value as { ok?: boolean })?.ok === true);
  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      await tx.update(t.kv).set({ value: { ok: false } }).where(eq(t.kv.key, "smoke"));
      throw new Error("force rollback");
    });
  } catch {
    rolledBack = true;
  }
  const after = (await db.select().from(t.kv).where(eq(t.kv.key, "smoke")))[0];
  check("transaction rolled back on error", rolledBack && (after?.value as { ok?: boolean })?.ok === true);

  // update + delete builders
  await db.update(t.applicationDocs).set({ status: "submitted" })
    .where(and(eq(t.applicationDocs.applicationId, "A-1174"), eq(t.applicationDocs.docKey, "ssn")));
  const flipped = (await db.select().from(t.applicationDocs)
    .where(and(eq(t.applicationDocs.applicationId, "A-1174"), eq(t.applicationDocs.docKey, "ssn"))))[0];
  check("update builder works", flipped?.status === "submitted");
  await db.delete(t.kv).where(eq(t.kv.key, "smoke"));
  check("delete builder works", (await db.select().from(t.kv).where(eq(t.kv.key, "smoke"))).length === 0);

  // integration groundwork: external-ID linkage + duplicate review queue round-trips
  await db.insert(t.clientExternalIds).values({
    system: "hmis", externalId: "HM-90001", clientId: clients[0].id,
    linkedAt: "2026-07-14T00:00:00Z", linkedBy: "smoke",
  });
  const linked = (await db.select().from(t.clientExternalIds)
    .where(and(eq(t.clientExternalIds.system, "hmis"), eq(t.clientExternalIds.externalId, "HM-90001"))))[0];
  check("client_external_ids round-trip", linked?.clientId === clients[0].id);

  const [review] = await db.insert(t.matchReviews).values({
    at: "2026-07-14T00:00:00Z", source: "sheets", sourceRef: "smoke.csv row 2",
    payload: {
      kind: "client",
      client: { first: "Ana", last: "Reyes", dob: "1990-01-01", phone: null, address: null,
        sex: null, race: null, housing: null, hhType: null, hhSize: 1,
        income: 12000, enrolled: "2026-07-14", fplYear: 2026 },
      programId: "csbg",
    },
    candidateIds: [clients[0].id],
  }).returning({ id: t.matchReviews.id });
  const pendingReviews = await db.select().from(t.matchReviews).where(eq(t.matchReviews.status, "pending"));
  check("match_reviews pending round-trip", pendingReviews.some((r) => r.id === review.id));
  check("match_reviews jsonb payload typed", pendingReviews[0]?.payload.client.first === "Ana"
    && Array.isArray(pendingReviews[0]?.candidateIds));

  // HMIS syncs are logged as import jobs so they appear in Recent imports with
  // an Undo button; hmis_undo carries what the sync did to records that already
  // existed, which is the half undo can't derive from import_job_id.
  const [syncJob] = await db.insert(t.importJobs).values({
    at: new Date().toISOString(), template: "hmis", filename: "dbo.Example_API",
    imported: 2, updated: 1, skipped: 0, staffId: users[0].id, detail: "smoke",
    hmisUndo: {
      links: [{ system: "hmis", externalId: "H1" }],
      reviewIds: [7],
      enriched: [{ clientId: clients[0].id, before: { phone: null, custom: {} } }],
    },
  }).returning({ id: t.importJobs.id });
  const storedJob = (await db.select().from(t.importJobs).where(eq(t.importJobs.id, syncJob.id)))[0];
  check("import_jobs accepts an hmis sync entry", storedJob?.template === "hmis",
    `${storedJob?.template} · ${storedJob?.filename}`);
  check("import_jobs.hmis_undo jsonb round-trip",
    storedJob?.hmisUndo?.links[0]?.externalId === "H1"
    && storedJob?.hmisUndo?.reviewIds[0] === 7
    && storedJob?.hmisUndo?.enriched[0]?.before.phone === null);

  const [sheetJob] = await db.insert(t.importJobs).values({
    at: new Date().toISOString(), template: "clients", filename: "legacy.csv",
    imported: 1, updated: 0, skipped: 0, staffId: users[0].id, detail: "smoke",
  }).returning({ id: t.importJobs.id });
  const storedSheet = (await db.select().from(t.importJobs).where(eq(t.importJobs.id, sheetJob.id)))[0];
  check("import_jobs.hmis_undo is null for a spreadsheet import", storedSheet?.hmisUndo === null);

  await pglite.close();

  // ---------- Production init path (CSBG_DEMO_SEED=0 → /setup wizard) ----------
  const pglite2 = new PGlite();
  await pglite2.exec(BOOTSTRAP);
  const db2 = drizzle(pglite2, { schema }) as unknown as NodePgDatabase<typeof schema>;
  await runInit(db2);

  const org2 = (await db2.select().from(t.organization).where(eq(t.organization.id, 1)))[0];
  check("init: placeholder organization", org2?.name === "New Community Action Agency" && org2.logoMode === "wordmark");
  check("init: no users (setup wizard owns first admin)", (await db2.select().from(t.users)).length === 0);

  const scheds = await db2.select().from(t.fplSchedules);
  const active2 = scheds.find((s) => s.status === "active");
  check("init: latest official FPL year active", active2?.year === LATEST_OFFICIAL_FPL_YEAR,
    `active ${active2?.year}`);
  check("init: multiple guideline years on record", scheds.length >= 3, `got ${scheds.length}`);

  const raceValues = (await db2.select().from(t.listValues)).filter((v) => v.listKey === "race").map((v) => v.value);
  const c6 = characteristicByCode("C6")!.options;
  check("init: race list uses instrument-canonical strings", c6.every((o) => raceValues.includes(o)),
    raceValues.join(" | ").slice(0, 80));

  check("init: services taxonomy loaded", (await db2.select().from(t.services)).length > 70);
  check("init: intake fields incl. C4", (await db2.select().from(t.intakeFields)).some((f) => f.code === "C4"));
  check("init: no demo clients", (await db2.select().from(t.clients)).length === 0);

  await pglite2.close();

  console.log(failures === 0 ? "\nSmoke test passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
