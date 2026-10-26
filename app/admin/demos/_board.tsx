"use client";

import { useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { DemoDetailPanel } from "./_detail-panel";
import type { DemoRow } from "./_card";
import type { AdminActivityRow } from "@/server/services/hq-audit";

/**
 * The kanban board carries `@dnd-kit/core` (~10–13 KB gzip), needed only for
 * the drag-to-move-status interaction. `/admin/demos` is the single largest
 * route in the bundle; lazy-loading the board keeps dnd-kit out of its
 * first-load JS. `ssr: false` is legal here because `_board.tsx` is a client
 * component, and this is an internal HQ route (no SEO cost). The skeleton is
 * sized to the real board layout (a horizontally-scrolling row of `w-72`
 * columns) so first paint does not shift once the chunk hydrates. Props,
 * types and drag behaviour are unchanged — only the import mechanism differs.
 */
const DemosKanban = dynamic(
  () => import("./_kanban").then((m) => m.DemosKanban),
  {
    ssr: false,
    loading: () => <KanbanSkeleton />,
  },
);

function KanbanSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="flex gap-3 overflow-x-auto pb-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex w-72 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="h-5 w-28 animate-pulse rounded-full bg-slate-200" />
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              <div className="h-20 animate-pulse rounded-md bg-white" />
              <div className="h-20 animate-pulse rounded-md bg-white" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Thin client wrapper owning the open/close state for the side panel.
 *
 * Selected demo id lives in the URL (`?demo=<id>`) so server-side data
 * fetching (the activity timeline) keeps working without an extra
 * round-trip to a client-only state container.
 */
export function DemosBoard({
  demos,
  openId,
  openDemo,
  openActivity,
}: {
  demos: DemoRow[];
  openId: string | null;
  openDemo: DemoRow | null;
  openActivity: AdminActivityRow[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const setOpen = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set("demo", id);
      else next.delete("demo");
      router.replace(`/admin/demos?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  // Layout: when a demo is open, reserve a 420px column for the side
  // panel. When nothing's open, collapse to a single full-width column
  // so the kanban gets the entire row — no dead "Open a demo" panel
  // taking up workflow real estate.
  return (
    <div
      className={
        openDemo
          ? "grid grid-cols-1 gap-4 xl:grid-cols-[1fr_420px]"
          : "grid grid-cols-1 gap-4"
      }
    >
      <div className="min-w-0">
        <DemosKanban
          demos={demos}
          openId={openId}
          onOpen={(id) => setOpen(id)}
        />
      </div>
      {openDemo ? (
        <DemoDetailPanel
          demo={openDemo}
          activity={openActivity}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
