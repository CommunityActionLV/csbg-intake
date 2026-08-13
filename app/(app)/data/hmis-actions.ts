"use server";
/* PA HMIS sync actions — admin-only. Per the CACLV ↔ PA HMIS operating
   understanding, synced records feed internal tracking & reporting:
   dedup-linked, blank-filled, and imported into the client directory. */
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/access";
import { kvGet, kvSet, nextClientId } from "@/lib/data/core";
import { fmt, shortDate, todayIso } from "@/lib/format";
import {
  createClientFromHmis, fetchHmisClients, getHmisConfig, hmisToken, runHmisMatching,
} from "@/lib/hmis";

export interface HmisActionResult { ok: boolean; message: string }

const NOT_CONFIGURED =
  "HMIS isn't configured — set the connection in Settings → Integrations (or via HMIS_* environment variables).";

/** Verify credentials reach the token endpoint. No data is pulled. */
export async function testHmisConnection(): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const { cfg } = await getHmisConfig();
  if (!cfg) return { ok: false, message: NOT_CONFIGURED };
  try {
    await hmisToken(cfg);
  } catch (e) {
    return { ok: false, message: `Could not authenticate with PA HMIS: ${e instanceof Error ? e.message : String(e)}` };
  }
  await audit(user.id, "hmis.test", "integration", "hmis", "Token endpoint reachable, credentials accepted");
  return { ok: true, message: "Connected — PA HMIS accepted the credentials." };
}

/** Set the program HMIS-imported clients enroll into. */
export async function setHmisProgram(programId: string): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const program = (await db.select().from(t.programs).where(eq(t.programs.id, programId)))[0];
  if (!program || program.active !== 1) return { ok: false, message: "Pick an active program." };
  await kvSet("hmisProgramId", programId);
  await audit(user.id, "hmis.program.set", "integration", "hmis", `HMIS imports enroll into ${program.name}`);
  revalidatePath("/data");
  return { ok: true, message: `HMIS imports will enroll into ${program.name}.` };
}

/** Pull the CACLV-project snapshot, refresh hmis_clients wholesale, and run
    the integration pass: link, fill blanks, queue near matches, and import
    unmatched people as client records (internal tracking & reporting). */
export async function runHmisSync(): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const { cfg } = await getHmisConfig();
  if (!cfg) return { ok: false, message: NOT_CONFIGURED };

  let rows;
  try {
    const token = await hmisToken(cfg);
    rows = await fetchHmisClients(cfg, token);
  } catch (e) {
    return { ok: false, message: `Sync failed while pulling from PA HMIS: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (rows.length === 0) {
    return { ok: false, message: "PA HMIS answered but returned no client records — check HMIS_CLIENTS_PATH against the API docs." };
  }

  // full-snapshot semantics: replace the table with this pull
  const now = new Date().toISOString();
  await db.delete(t.hmisClients);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(t.hmisClients).values(rows.slice(i, i + CHUNK).map((r) => ({ ...r, fetchedAt: now })));
  }

  const programId = await kvGet<string | null>("hmisProgramId", null);
  const stats = await runHmisMatching(rows, user.id, programId, nextClientId);
  await kvSet("hmisSync", { at: now, pulled: rows.length, ...stats });
  await db.update(t.integrations)
    .set({ status: "connected", lastSync: shortDate(todayIso()), records: `${fmt(rows.length)} HMIS records` })
    .where(eq(t.integrations.id, "hmis"));
  await audit(user.id, "hmis.sync", "integration", "hmis",
    `${fmt(rows.length)} pulled — ${stats.alreadyLinked} already linked, ${stats.autoLinked} auto-linked, ${stats.enriched} blank-filled, ${stats.created} imported as clients, ${stats.queued} queued for review${stats.noDob ? `, ${stats.noDob} without DOB` : ""}${stats.noProgram ? `, ${stats.noProgram} skipped (no enrollment program set)` : ""}`);
  revalidatePath("/data");
  revalidatePath("/reports");
  revalidatePath("/clients");
  const parts = [
    `${fmt(stats.created)} imported as new clients`,
    `${fmt(stats.autoLinked)} auto-linked`,
    `${fmt(stats.enriched)} records blank-filled`,
    `${fmt(stats.queued)} need review`,
  ];
  if (stats.noProgram > 0) parts.push(`${fmt(stats.noProgram)} skipped — set the enrollment program`);
  if (stats.noDob > 0) parts.push(`${fmt(stats.noDob)} kept snapshot-only (no DOB)`);
  return { ok: true, message: `Synced ${fmt(rows.length)} HMIS records — ${parts.join(", ")}.` };
}

/** Resolve a held HMIS near-match: link to a candidate, import as a new
    client record, or dismiss (not the same person, keep snapshot-only). */
export async function resolveHmisReview(
  reviewId: number,
  action: { type: "link"; clientId: string } | { type: "create" } | { type: "dismiss" },
): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const review = (await db.select().from(t.hmisReviews).where(eq(t.hmisReviews.id, reviewId)))[0];
  if (!review) return { ok: false, message: "Review not found." };
  if (review.status !== "pending") return { ok: false, message: "This match was already resolved." };

  const now = new Date().toISOString();
  if (action.type === "link") {
    if (!review.candidateIds.includes(action.clientId)) {
      return { ok: false, message: "Pick one of the candidate records." };
    }
    await db.insert(t.clientExternalIds)
      .values({ system: "hmis", externalId: review.hmisId, clientId: action.clientId, linkedAt: now, linkedBy: user.id })
      .onConflictDoNothing();
    await db.update(t.hmisReviews)
      .set({ status: "resolved", resolution: "linked", resolvedClientId: action.clientId, resolvedBy: user.id, resolvedAt: now })
      .where(eq(t.hmisReviews.id, reviewId));
    await audit(user.id, "hmis.link", "client", action.clientId, `Linked to HMIS record on review (queue #${reviewId})`);
    revalidatePath("/data");
    revalidatePath("/reports");
    return { ok: true, message: `Linked — this HMIS record now counts as the same person as ${action.clientId}.` };
  }

  if (action.type === "create") {
    const row = (await db.select().from(t.hmisClients).where(eq(t.hmisClients.hmisId, review.hmisId)))[0];
    if (!row) return { ok: false, message: "This HMIS record is no longer in the snapshot — run a sync first." };
    if (!row.dob) return { ok: false, message: "This HMIS record has no date of birth — it can't become a client record yet." };
    const programId = await kvGet<string | null>("hmisProgramId", null);
    if (!programId) return { ok: false, message: "Set the HMIS enrollment program first (above)." };
    const clientId = await createClientFromHmis({ ...row, services: row.services, household: row.household }, programId, user.id, nextClientId);
    if (!clientId) return { ok: false, message: "Could not create the record." };
    await db.update(t.hmisReviews)
      .set({ status: "resolved", resolution: "created", resolvedClientId: clientId, resolvedBy: user.id, resolvedAt: now })
      .where(eq(t.hmisReviews.id, reviewId));
    await audit(user.id, "hmis.create", "client", clientId, `Imported from HMIS on review (queue #${reviewId})`);
    revalidatePath("/data");
    revalidatePath("/reports");
    revalidatePath("/clients");
    return { ok: true, message: `Imported as new client record ${clientId}.` };
  }

  await db.update(t.hmisReviews)
    .set({ status: "resolved", resolution: "dismissed", resolvedBy: user.id, resolvedAt: now })
    .where(eq(t.hmisReviews.id, reviewId));
  await audit(user.id, "hmis.dismiss", "hmis_review", String(reviewId), "Marked as not the same person");
  revalidatePath("/data");
  revalidatePath("/reports");
  return { ok: true, message: "Dismissed — kept snapshot-only; these count as two different people." };
}
