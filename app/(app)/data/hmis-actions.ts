"use server";
/* PA HMIS sync actions — admin-only, MOU-scoped (dedup matching +
   deidentified aggregates; never writes to the clients table). */
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/access";
import { kvSet } from "@/lib/data/core";
import { fmt, shortDate, todayIso } from "@/lib/format";
import {
  fetchHmisClients, hmisConfig, hmisToken, runHmisMatching,
} from "@/lib/hmis";

export interface HmisActionResult { ok: boolean; message: string }

const NOT_CONFIGURED =
  "HMIS isn't configured — add HMIS_TOKEN_URL, HMIS_CLIENT_ID, HMIS_CLIENT_SECRET, and HMIS_BASE_URL to .env.local and restart the server.";

/** Verify credentials reach the token endpoint. No data is pulled. */
export async function testHmisConnection(): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const cfg = hmisConfig();
  if (!cfg) return { ok: false, message: NOT_CONFIGURED };
  try {
    await hmisToken(cfg);
  } catch (e) {
    return { ok: false, message: `Could not authenticate with PA HMIS: ${e instanceof Error ? e.message : String(e)}` };
  }
  await audit(user.id, "hmis.test", "integration", "hmis", "Token endpoint reachable, credentials accepted");
  return { ok: true, message: "Connected — PA HMIS accepted the credentials." };
}

/** Pull the CACLV-project snapshot, refresh hmis_clients wholesale, and run
    the dedup matching pass. Snapshot data is admin-only and is used solely
    for matching + deidentified aggregates, per the signed MOU. */
export async function runHmisSync(): Promise<HmisActionResult> {
  const user = await requireAdmin();
  const cfg = hmisConfig();
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

  const stats = await runHmisMatching(rows, user.id);
  await kvSet("hmisSync", { at: now, pulled: rows.length, ...stats });
  await db.update(t.integrations)
    .set({ status: "connected", lastSync: shortDate(todayIso()), records: `${fmt(rows.length)} HMIS records` })
    .where(eq(t.integrations.id, "hmis"));
  await audit(user.id, "hmis.sync", "integration", "hmis",
    `${fmt(rows.length)} pulled — ${stats.alreadyLinked} already linked, ${stats.autoLinked} auto-linked (exact name+DOB), ${stats.queued} queued for review, ${stats.unlinked} HMIS-only`);
  revalidatePath("/data");
  revalidatePath("/reports");
  return {
    ok: true,
    message: `Synced ${fmt(rows.length)} HMIS records — ${stats.autoLinked} auto-linked, ${stats.queued} need review, ${fmt(stats.unlinked)} HMIS-only.`,
  };
}

/** Resolve a held HMIS near-match: link to a candidate, or dismiss (not the
    same person). Never creates a client record — the MOU does not allow it. */
export async function resolveHmisReview(
  reviewId: number,
  action: { type: "link"; clientId: string } | { type: "dismiss" },
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

  await db.update(t.hmisReviews)
    .set({ status: "resolved", resolution: "dismissed", resolvedBy: user.id, resolvedAt: now })
    .where(eq(t.hmisReviews.id, reviewId));
  await audit(user.id, "hmis.dismiss", "hmis_review", String(reviewId), "Marked as not the same person");
  revalidatePath("/data");
  revalidatePath("/reports");
  return { ok: true, message: "Dismissed — these count as two different people in the unduplicated totals." };
}
