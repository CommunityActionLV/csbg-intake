import { requireUser, isAdmin } from "@/lib/auth";
import { db, t } from "@/db";
import { getOrg } from "@/lib/data/core";
import { FNPIS, DOMAINS } from "@/lib/csbg-catalog";
import { buildRollup } from "./rollup";
import { resolveFilters, periodOptions, type RawParams } from "./filters";
import { ReportsClient } from "./reports-client";

/* Reports & CSBG rollup. The DEFAULT view is agency-wide and unfiltered — the
   authoritative Annual Report submission (current FY, all programs, all enrolled
   clients, pre-system baselines included). URL search params (period / programs /
   domains) narrow it into a labeled "live records only" analysis view. */

export default async function ReportsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const user = await requireUser();
  const org = await getOrg();
  const sp = await searchParams;
  const filters = resolveFilters(sp, org.fyStart);
  const data = await buildRollup(filters);

  const programs = (await db.select().from(t.programs))
    .filter((p) => p.active === 1)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, label: p.short || p.name }));

  return (
    <ReportsClient
      data={data}
      canManageGoals={isAdmin(user)}
      fnpiOptions={FNPIS.map((f) => ({ code: f.code, label: f.label }))}
      filterState={{
        preset: filters.preset,
        from: typeof sp.from === "string" ? sp.from : "",
        to: typeof sp.to === "string" ? sp.to : "",
        programIds: filters.programIds,
        domains: filters.domains,
        query: filters.query,
      }}
      periodOptions={periodOptions(org.fyStart)}
      programOptions={programs}
      domainOptions={DOMAINS.map((d) => ({ id: d.id, label: `${d.name} (${d.code})` }))}
    />
  );
}
