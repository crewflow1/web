"use client";

import {
  useState,
  useTransition,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  DEMO_LIFECYCLE_STATUSES,
  DEMO_STATUS_LABELS,
  type DemoLifecycleStatus,
  toLifecycleStatus,
} from "@/lib/hq/demo-lifecycle";
import { Alert, accent, type Accent } from "@/components/ui";
import { moveDemoToStatusJson } from "./actions";
import { DemoCard, type DemoRow } from "./_card";

/**
 * Dark-token accent per lifecycle status — presentation only. Keeps the
 * same status→meaning mapping the original light pills used, just moved
 * onto the unified dark accent set.
 */
const STATUS_ACCENT: Record<DemoLifecycleStatus, Accent> = {
  pending_demo: "indigo",
  contacted: "sky",
  demo_booked: "violet",
  demo_done: "violet",
  won: "emerald",
  lost: "rose",
  payment_sent: "amber",
  payment_received: "emerald",
  active_onboarding: "cyan",
  active: "emerald",
};

/**
 * Demos CRM kanban.
 *
 * 10 columns, one per lifecycle status. Horizontally scrollable so we
 * never crush the cards on narrower screens. Drag-and-drop powered by
 * @dnd-kit/core (no sortable — re-ordering within a column doesn't
 * matter; only column transitions do).
 *
 * Drag UX:
 *   - Pointer sensor with an 8px activation distance so a click on a
 *     card doesn't immediately start a drag.
 *   - Optimistic update: the card moves into the new column the moment
 *     the drag ends. The server action runs in a useTransition; if it
 *     fails, we roll the card back and surface the error.
 *
 * Each card carries an "open details" button that lifts state up to
 * the parent — that's where the side panel with timeline + actions
 * lives, so we don't duplicate the actions inside the card.
 */

type KanbanProps = {
  demos: DemoRow[];
  onOpen: (id: string) => void;
  openId: string | null;
};

export function DemosKanban({ demos, onOpen, openId }: KanbanProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Local state for optimistic moves. Source-of-truth still arrives
  // from the server on the next refresh.
  const [overrides, setOverrides] = useState<Record<string, DemoLifecycleStatus>>(
    {},
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const effectiveStatus = (d: DemoRow): DemoLifecycleStatus =>
    overrides[d.id] ?? toLifecycleStatus(d.status);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  function onDragEnd(event: DragEndEvent) {
    setErrorMsg(null);
    const demoId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || !overId.startsWith("col:")) return;
    const target = overId.slice("col:".length) as DemoLifecycleStatus;

    const demo = demos.find((d) => d.id === demoId);
    if (!demo) return;
    const current = effectiveStatus(demo);
    if (target === current) return;

    // Optimistic flip.
    setOverrides((p) => ({ ...p, [demoId]: target }));

    startTransition(async () => {
      const result = await moveDemoToStatusJson(demoId, target);
      if (!result.ok) {
        // Roll back optimistic + show banner.
        setOverrides((p) => {
          const next = { ...p };
          delete next[demoId];
          return next;
        });
        setErrorMsg(result.error || "Couldn't save — try again.");
        return;
      }
      // Pull fresh server data so the rest of the panel (timeline,
      // counts, sort order) updates.
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {errorMsg ? <Alert tone="danger">{errorMsg}</Alert> : null}

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div
          className="flex gap-3 overflow-x-auto pb-3"
          // Force overlay above the page footer for long boards.
          style={{ scrollbarWidth: "thin" } as CSSProperties}
        >
          {DEMO_LIFECYCLE_STATUSES.map((status) => {
            const rows = demos.filter((d) => effectiveStatus(d) === status);
            return (
              <Column
                key={status}
                status={status}
                count={rows.length}
                pending={pending}
              >
                {rows.length === 0 ? (
                  <EmptySlot status={status} />
                ) : (
                  rows.map((d) => (
                    <DraggableCard key={d.id} demo={d} status={status}>
                      <DemoCard
                        demo={d}
                        status={status}
                        active={openId === d.id}
                        onOpen={() => onOpen(d.id)}
                      />
                    </DraggableCard>
                  ))
                )}
              </Column>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

// --------------------------------------------------------------------

function Column({
  status,
  count,
  pending,
  children,
}: {
  status: DemoLifecycleStatus;
  count: number;
  pending: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const a = accent(STATUS_ACCENT[status]);
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-2xl border bg-slate-900/40 transition ${
        isOver
          ? "border-indigo-400/40 bg-indigo-500/5 ring-2 ring-inset ring-indigo-400/40"
          : "border-slate-800"
      }`}
      aria-label={`${DEMO_STATUS_LABELS[status]} column`}
    >
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${a.chip}`}
        >
          {DEMO_STATUS_LABELS[status]}
          <span className="rounded-sm bg-slate-950/40 px-1 text-[10px] font-bold">
            {count}
          </span>
        </span>
        {pending ? (
          <span className="text-[10px] text-slate-500">Saving…</span>
        ) : null}
      </header>
      <div className="flex flex-1 flex-col gap-2 p-2">{children}</div>
    </div>
  );
}

function DraggableCard({
  demo,
  status,
  children,
}: {
  demo: DemoRow;
  status: DemoLifecycleStatus;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: demo.id,
      data: { status },
    });

  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    opacity: isDragging ? 0.6 : 1,
    cursor: "grab",
    touchAction: "none",
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

function EmptySlot({ status }: { status: DemoLifecycleStatus }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 px-3 py-6 text-center text-[11px] text-slate-500">
      Drop a demo here to mark{" "}
      <strong className="font-semibold text-slate-300">
        {DEMO_STATUS_LABELS[status]}
      </strong>
    </p>
  );
}
