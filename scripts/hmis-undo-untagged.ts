/* One-off: undo an HMIS sync that ran BEFORE syncs were logged as import jobs.

   Syncs are now recorded in import_jobs with a reversal record, so Recent
   imports → Undo handles them. Anything synced before that carries no job id and
   nothing recorded what it touched, so this script reconstructs the reversal
   from what is still identifiable in the data:

     clients created by a sync   flagged "HMIS import …" with no import_job_id,
                                 and NOT the result of resolving a review by hand
     links to existing clients   client_external_ids rows for clients that
                                 predate the sync — removed so a re-run links and
                                 blank-fills them again
     queued near matches         pending hmis_reviews — removed so a re-run
                                 re-queues them

   NOT reversible, and reported rather than glossed over: blank fields the sync
   filled in on records that already existed. Nothing recorded their previous
   values, so this script cannot restore them.

   Usage, from the project root, with DATABASE_URL pointing at the live database:

     npx tsx scripts/hmis-undo-untagged.ts             # dry run — prints the plan
     npx tsx scripts/hmis-undo-untagged.ts --apply     # pg_dump, then delete
     …                                       --names   # full names, not initials

   Dry run is the default and touches nothing. --apply writes a pg_dump to
   data/backups/ first and refuses to continue if the dump fails.
*/
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db, t, databaseUrl, databaseInfo } from "../src/db";
import { clearHmisSyncSummary } from "../src/lib/hmis";

const execFileAsync = promisify(execFile);

const APPLY = process.argv.includes("--apply");
const SHOW_NAMES = process.argv.includes("--names");
const HMIS_FLAG = "HMIS import";          // set by createClientFromHmis
const HMIS_SYSTEM = "hmis";

/** Initials by default: this prints to a terminal and possibly a scrollback
    buffer, and the client roster is not what anyone needs to verify a count. */
const who = (first: string, last: string): string =>
  SHOW_NAMES ? `${first} ${last}` : `${first.slice(0, 1)}.${last.slice(0, 1)}.`;

async function backup(): Promise<string> {
  const dir = path.join(process.cwd(), "data", "backups");
  const d = new Date();
  const stamp = [
    d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"),
  ].join("") + "-" + [
    String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
  const dest = path.join(dir, `csbg-pre-hmis-undo-${stamp}.sql`);
  fs.mkdirSync(dir, { recursive: true });
  // same invocation as Settings → Database & storage → Back up now
  await execFileAsync("pg_dump", ["--no-owner", "--format=plain", `--file=${dest}`, databaseUrl], { timeout: 120_000 });
  return dest;
}

async function main(): Promise<void> {
  const info = databaseInfo();
  console.log(`Database: ${info.database} at ${info.host}:${info.port} (user ${info.user})`);
  console.log(APPLY ? "Mode: APPLY — records will be deleted\n" : "Mode: dry run — nothing will be changed\n");

  const clients = await db.select().from(t.clients);
  const links = await db.select().from(t.clientExternalIds).where(eq(t.clientExternalIds.system, HMIS_SYSTEM));
  const reviews = await db.select().from(t.hmisReviews);

  const linkByClient = new Map(links.map((l) => [l.clientId, l.externalId]));
  // A client created by resolving a review is a human decision, not part of the
  // sync — the review row points at it, which is how they stay distinguishable.
  const fromReview = new Set(reviews.filter((r) => r.resolvedClientId).map((r) => r.resolvedClientId as string));

  const flagged = clients.filter((c) =>
    (c.flags ?? []).some((f) => f.startsWith(HMIS_FLAG)) && c.importJobId === null);
  const created = flagged.filter((c) => !fromReview.has(c.id));
  const keptFromReview = flagged.filter((c) => fromReview.has(c.id));
  const createdIds = created.map((c) => c.id);

  // Links made by hand when someone resolved a review — "link to this candidate"
  // or "import as new client". They must survive: the resolved review makes the
  // next sync skip that HMIS id entirely, so a removed link is never re-created
  // and the record would be orphaned from HMIS for good.
  const handLinked = new Set(reviews.filter((r) => r.status === "resolved").map((r) => r.hmisId));
  // What's left: links this sync made to clients that already existed.
  const preExistingLinks = links.filter((l) =>
    !createdIds.includes(l.clientId) && !handLinked.has(l.externalId) && !fromReview.has(l.clientId));
  const pendingReviews = reviews.filter((r) => r.status === "pending");

  console.log(`Clients created by an untagged HMIS sync: ${created.length}`);
  for (const c of created) {
    console.log(`  ${c.id}  ${who(c.first, c.last)}  enrolled ${c.enrolled}  hmis ${linkByClient.get(c.id) ?? "—"}`);
  }
  if (keptFromReview.length > 0) {
    console.log(`\nKEPT — created by resolving a review by hand, not by the sync: ${keptFromReview.length}`);
    for (const c of keptFromReview) console.log(`  ${c.id}  ${who(c.first, c.last)}`);
  }
  console.log(`\nHMIS links on pre-existing clients, to be removed so a re-sync re-links them: ${preExistingLinks.length}`);
  for (const l of preExistingLinks) {
    const c = clients.find((x) => x.id === l.clientId);
    console.log(`  ${l.clientId}  ${c ? who(c.first, c.last) : "(missing client)"}  hmis ${l.externalId}`);
  }
  if (handLinked.size > 0) {
    console.log(`\nKEPT — links made by hand when a review was resolved: ${handLinked.size}`);
    console.log("  (a resolved review makes the next sync skip that HMIS id, so a removed link never comes back)");
  }
  console.log(`\nPending near-match reviews, to be cleared so a re-sync re-queues them: ${pendingReviews.length}`);
  console.log(`Resolved reviews, kept (they record human decisions): ${reviews.length - pendingReviews.length}`);

  if (preExistingLinks.length > 0) {
    console.log(`\nNOT REVERSIBLE: the sync may have filled blank fields on those ${preExistingLinks.length} pre-existing`);
    console.log("client record(s) — phone, sex, race, military, insurance, income source, email. Nothing");
    console.log("recorded what was blank beforehand, so those values stay. Review them by hand if it matters.");
  }
  const snapshot = await db.select({ hmisId: t.hmisClients.hmisId }).from(t.hmisClients);
  const summary = await db.select().from(t.kv).where(eq(t.kv.key, "hmisSync"));
  console.log(`\nSync summary to be cleared: ${summary.length > 0 ? "the counters shown on Data & integrations" : "none stored"}`);
  console.log(`Snapshot rows to be cleared: ${snapshot.length} (hmis_clients — the next sync repopulates it)`);
  console.log("  Left behind, these make the page report an import that no longer exists, and make");
  console.log("  /reports count HMIS people who are no longer linked to anything.");

  if (created.length === 0 && preExistingLinks.length === 0 && pendingReviews.length === 0
      && snapshot.length === 0 && summary.length === 0) {
    console.log("\nNothing to undo.");
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing changed. Re-run with --apply to delete the above.");
    process.exit(0);
  }

  let dump: string;
  try {
    dump = await backup();
    console.log(`\nBackup written: ${dump} (${(fs.statSync(dump).size / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error(`\nABORTED — backup failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error("Nothing was deleted. pg_dump must be able to reach the database.");
    process.exit(1);
  }

  await db.transaction(async (tx) => {
    if (createdIds.length > 0) {
      // client-owned rows first (NOT NULL client_id), mirroring undoImport
      await tx.delete(t.clientPrograms).where(inArray(t.clientPrograms.clientId, createdIds));
      await tx.delete(t.serviceLog).where(inArray(t.serviceLog.clientId, createdIds));
      await tx.delete(t.outcomeLog).where(inArray(t.outcomeLog.clientId, createdIds));
      await tx.delete(t.clientExternalIds).where(inArray(t.clientExternalIds.clientId, createdIds));
      // independent records that merely reference a client — unlink, don't destroy
      await tx.update(t.applications).set({ clientId: null }).where(inArray(t.applications.clientId, createdIds));
      await tx.update(t.loans).set({ clientId: null }).where(inArray(t.loans.clientId, createdIds));
      await tx.update(t.seminarAttendees).set({ clientId: null }).where(inArray(t.seminarAttendees.clientId, createdIds));
      await tx.update(t.students).set({ clientId: null }).where(inArray(t.students.clientId, createdIds));
      await tx.update(t.volunteers).set({ clientId: null }).where(inArray(t.volunteers.clientId, createdIds));
      await tx.update(t.wxJobs).set({ clientId: null }).where(inArray(t.wxJobs.clientId, createdIds));
      await tx.delete(t.clients).where(inArray(t.clients.id, createdIds));
    }
    for (const l of preExistingLinks) {
      await tx.delete(t.clientExternalIds).where(and(
        eq(t.clientExternalIds.system, l.system),
        eq(t.clientExternalIds.externalId, l.externalId)));
    }
    if (pendingReviews.length > 0) {
      await tx.delete(t.hmisReviews).where(inArray(t.hmisReviews.id, pendingReviews.map((r) => r.id)));
    }
    await tx.insert(t.auditLog).values({
      at: new Date().toISOString(),
      userId: null,                       // run from a shell, not a signed-in session
      action: "hmis.sync.undo.script",
      entity: "integration",
      entityId: "hmis",
      detail: `scripts/hmis-undo-untagged.ts — ${createdIds.length} imported client(s) removed,`
        + ` ${preExistingLinks.length} link(s) removed, ${pendingReviews.length} pending review(s) cleared,`
        + ` sync summary + ${snapshot.length} snapshot row(s) cleared; backup ${path.basename(dump)}`,
    });
  });

  // after the transaction: same reset the Undo button performs, so the page stops
  // reporting a sync that has been undone
  await clearHmisSyncSummary();

  console.log(`\nDone. Removed ${createdIds.length} client(s), ${preExistingLinks.length} link(s),`
    + ` ${pendingReviews.length} pending review(s), and cleared the sync summary`
    + ` + ${snapshot.length} snapshot row(s). Logged to the audit trail.`);
  console.log("Run the sync again from Data & integrations — it will be logged with an Undo button.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
