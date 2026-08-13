import { desc, eq, inArray } from "drizzle-orm";
import { db, t } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { getStaff, kvGet } from "@/lib/data/core";
import { getPrograms } from "@/lib/access";
import { getFplHistory } from "@/lib/fpl";
import { importTemplate } from "@/lib/import-templates";
import { localDateOf, shortDate } from "@/lib/format";
import { DataClient, type MatchingStats, type ReviewRow } from "./data-client";
import { HmisPanel, type HmisReviewItem, type HmisSyncStats } from "./hmis-panel";
import { hmisConfigured } from "@/lib/hmis";

export default async function DataPage() {
  await requireAdmin();

  const integrations = await db.select().from(t.integrations);
  const kvMatching = await kvGet<MatchingStats>("matching", { auto: 0, staff: 0, awaiting: 0, silent: 0 });

  // Duplicate review queue — `awaiting` is the LIVE pending count, not a stored stat.
  const pendingReviews = await db.select().from(t.matchReviews).where(eq(t.matchReviews.status, "pending"));
  const matching: MatchingStats = { ...kvMatching, awaiting: pendingReviews.length };
  const candidateIds = [...new Set(pendingReviews.flatMap((r) => r.candidateIds))];
  const candidateClients = candidateIds.length > 0
    ? await db.select({
        id: t.clients.id, first: t.clients.first, last: t.clients.last, dob: t.clients.dob,
        phone: t.clients.phone, address: t.clients.address, enrolled: t.clients.enrolled,
      }).from(t.clients).where(inArray(t.clients.id, candidateIds))
    : [];
  const candidateById = new Map(candidateClients.map((c) => [c.id, c]));

  const programs = (await getPrograms()).map((p) => ({ id: p.id, short: p.short, name: p.name }));
  const programShort = new Map(programs.map((p) => [p.id, p.short]));

  const reviews: ReviewRow[] = pendingReviews.map((r) => ({
    id: r.id,
    when: shortDate(localDateOf(r.at)),
    sourceId: r.source,
    source: integrations.find((x) => x.id === r.source)?.name ?? r.source,
    sourceRef: r.sourceRef,
    incoming: {
      first: r.payload.client.first,
      last: r.payload.client.last,
      dob: r.payload.client.dob,
      phone: r.payload.client.phone,
      address: r.payload.client.address,
      program: programShort.get(r.payload.programId) ?? r.payload.programId,
    },
    candidates: r.candidateIds
      .map((id) => candidateById.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c),
  }));
  const fplYears = (await getFplHistory()).map((s) => s.year);
  const services = (await db.select().from(t.services).orderBy(t.services.sort))
    .filter((s) => s.active === 1)
    .map((s) => ({ code: s.code, label: s.label }));

  const staff = new Map((await getStaff()).map((s) => [s.id, s.initials]));
  const importJobs = (await db.select().from(t.importJobs)
    .orderBy(desc(t.importJobs.id))
    .limit(8))
    .map((j) => ({
      id: j.id,
      when: shortDate(localDateOf(j.at)),
      template: importTemplate(j.template)?.name ?? j.template,
      filename: j.filename,
      imported: j.imported,
      updated: j.updated,
      skipped: j.skipped,
      staffInitials: staff.get(j.staffId) ?? j.staffId,
      canUndo: j.template === "clients",
    }));

  // PA HMIS panel — sync state, pending link/dismiss reviews
  const hmisStats = await kvGet<HmisSyncStats>("hmisSync",
    { at: null, pulled: 0, alreadyLinked: 0, autoLinked: 0, enriched: 0, created: 0, queued: 0, noDob: 0, noProgram: 0 });
  const hmisProgramId = await kvGet<string | null>("hmisProgramId", null);
  const hmisPending = await db.select().from(t.hmisReviews).where(eq(t.hmisReviews.status, "pending"));
  const hmisSnapshot = new Map(
    (await db.select().from(t.hmisClients)).map((h) => [h.hmisId, h]));
  const hmisCandidateIds = [...new Set(hmisPending.flatMap((r) => r.candidateIds))];
  const hmisCandidates = hmisCandidateIds.length > 0
    ? await db.select({
        id: t.clients.id, first: t.clients.first, last: t.clients.last,
        dob: t.clients.dob, phone: t.clients.phone,
      }).from(t.clients).where(inArray(t.clients.id, hmisCandidateIds))
    : [];
  const hmisCandidateById = new Map(hmisCandidates.map((c) => [c.id, c]));
  const hmisReviews: HmisReviewItem[] = hmisPending
    .map((r) => {
      const h = hmisSnapshot.get(r.hmisId);
      if (!h) return null; // snapshot row replaced away — stale review, hidden
      return {
        id: r.id,
        when: shortDate(localDateOf(r.at)),
        person: { name: `${h.first} ${h.last}`, dob: h.dob ?? "", phone: h.phone ?? "", email: h.email ?? "" },
        candidates: r.candidateIds
          .map((id) => hmisCandidateById.get(id))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => ({ id: c.id, name: `${c.first} ${c.last}`, dob: c.dob, phone: c.phone ?? "" })),
      };
    })
    .filter((r): r is HmisReviewItem => r !== null);

  return (
    <>
    <DataClient
      integrations={integrations.map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        status: x.status,
        lastSync: x.lastSync,
        records: x.records,
        detail: x.detail,
      }))}
      matching={matching}
      reviews={reviews}
      importJobs={importJobs}
      programs={programs}
      fplYears={fplYears}
      services={services}
    />
    <HmisPanel
      configured={hmisConfigured()}
      stats={hmisStats}
      reviews={hmisReviews}
      programs={programs.map((p) => ({ id: p.id, name: p.name }))}
      programId={hmisProgramId}
    />
    </>
  );
}
