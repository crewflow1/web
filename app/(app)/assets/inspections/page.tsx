import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { isInspectionOverdue } from "@/lib/assets/inspection-schedule";
import {
  currentSafetyBlocks,
  hasUnbypassedBlock,
  type BlockableInspection,
  type OverrideRow,
} from "@/lib/assets/inspection-override";

export const metadata = { title: "Inspections · CrewFlow" };

/**
 * /assets/inspections — the operator's org-wide answers (M4 UX):
 * what needs inspecting today, what's overdue, which assets are blocked and
 * why (with the honest override state). Bounded reads on the partial indexes;
 * the block computation is the same unit-tested mirror the asset detail uses.
 */

type DueRow = {
  id: string;
  asset_id: string;
  title: string;
  due_at: string | null;
  template_version: number | null;
  assets: { id: string; name: string } | null;
};

type FailRow = BlockableInspection & {
  asset_id: string;
  assets: { id: string; name: string } | null;
};

/**
 * Chainable `.eq()`/`.not()` so the ACTIVE-org pin can sit alongside the
 * existing filters. RLS (`current_org_ids()`) admits EVERY org the viewer
 * belongs to, so an unpinned read blends both companies' inspection backlog
 * — including the safety-critical picture. Same class as #456/#463/#464.
 */
type InspQuery<T> = {
  eq: (k: string, v: unknown) => InspQuery<T>;
  not: (k: string, op: string, v: unknown) => InspQuery<T>;
  order: (
    c: string,
    o: { ascending: boolean },
  ) => { limit: (n: number) => Promise<{ data: T[] | null }> };
};

export default async function InspectionsOverviewPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  // Open due work (draft + due_at), oldest first — served by the partial index.
  const { data: dueRaw } = await (
    supabase.from("asset_inspections" as never) as unknown as {
      select: (c: string) => InspQuery<DueRow>;
    }
  )
    .select("id, asset_id, title, due_at, template_version, assets(id, name)")
    .eq("org_id", ctx.org.id)
    .eq("status", "draft")
    .not("due_at", "is", null)
    .order("due_at", { ascending: true })
    .limit(100);
  const dueAll = dueRaw ?? [];
  const overdue = dueAll.filter((d) => isInspectionOverdue(d.due_at, today));
  const dueUpcoming = dueAll.filter((d) => !isInspectionOverdue(d.due_at, today));

  // Safety picture: issued safety-critical records + live overrides, grouped
  // per asset, run through the unit-tested mirror of the DB clearing predicate.
  const { data: safetyRaw } = await (
    supabase.from("asset_inspections" as never) as unknown as {
      select: (c: string) => InspQuery<FailRow>;
    }
  )
    .select(
      "id, asset_id, title, status, outcome, safety_critical, inspected_at, created_at, reinspection_of, assets(id, name)",
    )
    .eq("org_id", ctx.org.id)
    .eq("safety_critical", true)
    .eq("status", "issued")
    .order("created_at", { ascending: false })
    .limit(400);
  const { data: overridesRaw } = await (
    supabase.from("asset_inspection_overrides" as never) as unknown as {
      select: (c: string) => InspQuery<OverrideRow & { asset_id: string }>;
    }
  )
    .select("id, asset_id, inspection_id, reason, expires_at, created_at, created_by, revoked_at")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const byAsset = new Map<string, { name: string; rows: FailRow[] }>();
  for (const row of safetyRaw ?? []) {
    const cur = byAsset.get(row.asset_id) ?? { name: row.assets?.name ?? "Asset", rows: [] };
    cur.rows.push(row);
    byAsset.set(row.asset_id, cur);
  }
  const blockedAssets = [...byAsset.entries()]
    .map(([assetId, { name, rows }]) => ({
      assetId,
      name,
      blocks: currentSafetyBlocks(
        rows,
        (overridesRaw ?? []).filter((o) => o.asset_id === assetId),
        nowIso,
      ),
    }))
    .filter((a) => a.blocks.length > 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Assets
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Inspections</h1>
        <p className="mt-1 text-sm text-slate-600">
          What needs inspecting, what&apos;s overdue, and which assets are blocked — across
          the whole fleet.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Overdue" value={overdue.length} tone={overdue.length > 0 ? "red" : "slate"} />
        <Stat label="Due / open" value={dueUpcoming.length} tone="blue" />
        <Stat label="Blocked assets" value={blockedAssets.length} tone={blockedAssets.length > 0 ? "red" : "slate"} />
      </div>

      {blockedAssets.length > 0 ? (
        <section className="rounded-xl border border-red-300 bg-red-50 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-red-900">Blocked assets</h2>
          <ul className="mt-2 divide-y divide-red-100 text-sm">
            {blockedAssets.map((a) => (
              <li key={a.assetId} className="flex flex-wrap items-center gap-2 py-2.5">
                <Link href={`/assets/${a.assetId}`} className="font-medium text-slate-900 hover:underline">
                  {a.name}
                </Link>
                {a.blocks.map((b) => (
                  <span key={b.inspection.id} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-red-700">
                    {b.inspection.title} — failed {(b.inspection.inspected_at ?? b.inspection.created_at).slice(0, 10)}
                  </span>
                ))}
                {hasUnbypassedBlock(a.blocks) ? (
                  <span className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">Blocked from issue</span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Operational override recorded</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DueList title="Overdue" rows={overdue} tone="red" empty="Nothing overdue." />
      <DueList title="Due" rows={dueUpcoming} tone="blue" empty="No open due inspections. Schedules generate them automatically each morning." />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "red" | "blue" | "slate" }) {
  const tones = {
    red: "border-red-200 bg-red-50 text-red-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    slate: "border-slate-200 bg-white text-slate-900",
  } as const;
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${tones[tone]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function DueList({
  title,
  rows,
  tone,
  empty,
}: {
  title: string;
  rows: DueRow[];
  tone: "red" | "blue";
  empty: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <Link
                href={`/assets/${r.asset_id}/inspections/${r.id}`}
                className="font-medium text-slate-900 hover:underline"
              >
                {r.title}
              </Link>
              <span className="text-xs text-slate-500">{r.assets?.name ?? "Asset"}</span>
              {r.template_version ? (
                <span className="text-[11px] text-slate-500">template v{r.template_version}</span>
              ) : null}
              <span
                className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  tone === "red" ? "bg-red-100 text-red-700" : "bg-blue-50 text-blue-700"
                }`}
              >
                {tone === "red" ? "Was due" : "Due"} {r.due_at?.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
