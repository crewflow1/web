"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DemosKanban } from "./_kanban";
import { DemoDetailPanel } from "./_detail-panel";
import type { DemoRow } from "./_card";
import type { AdminActivityRow } from "@/server/services/hq-audit";

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
