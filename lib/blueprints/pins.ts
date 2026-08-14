import { z } from "zod";
import { clamp01 } from "./viewer";
import {
  SNAG_PRIORITIES,
  SNAG_STATUS_LABELS,
  type SnagStatus,
} from "@/lib/snags/schema";

/**
 * Blueprint Pins — pure domain (coordinates, schemas, display derivation).
 *
 * The coordinate model is deliberately the DOM page-box model, NOT the
 * PDF-user-space `normalizePoint` in ./viewer.ts: a pin's (u,v) is
 * `(clientXY - pageBoxRect.topLeft) / pageBoxRect.size`, normalized 0..1 with
 * the origin at the visual top-left (v increases DOWN). This is the ONLY model
 * that is (a) identical for PDF and image drawings (images have no viewBox) and
 * (b) stable across zoom/pan/DPR/resize, because the page-box rect already
 * reflects the live zoom size + pan translate. A later markup layer reuses this
 * exact model, so both must agree — hence the shared `clamp01`.
 *
 * No DOM imports here: everything is a pure function of numbers/rects so it is
 * unit-testable under vitest's node environment (no canvas/DOM).
 */

// ── kinds ────────────────────────────────────────────────────────────────────
export const PIN_KINDS = ["snag", "note", "task"] as const;
export type PinKind = (typeof PIN_KINDS)[number];
export const PIN_KIND_LABELS: Record<PinKind, string> = {
  snag: "Snag",
  note: "Note",
  task: "Task",
};

// ── task-pin lifecycle (a task pin is a first-class task anchored to a point) ──
// Mirrors the snag lifecycle's shape but is intentionally simpler: a task moves
// open -> in_progress -> done, with no separate "verify" step (the pin IS the
// record). 'done' is the only terminal status.
export const TASK_PIN_STATUSES = ["open", "in_progress", "done"] as const;
export type TaskPinStatus = (typeof TASK_PIN_STATUSES)[number];
export const TASK_PIN_STATUS_LABELS: Record<TaskPinStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};
export function isTaskPinDone(status: TaskPinStatus): boolean {
  return status === "done";
}

// ── coordinate helpers ───────────────────────────────────────────────────────
export type Norm = { u: number; v: number };
export type BoxRect = { left: number; top: number; width: number; height: number };

/** A pointer's client position → normalized (u,v) within the page box. */
export function pointerToNormalized(clientX: number, clientY: number, rect: BoxRect): Norm {
  if (rect.width <= 0 || rect.height <= 0) return { u: 0, v: 0 };
  return {
    u: clamp01((clientX - rect.left) / rect.width),
    v: clamp01((clientY - rect.top) / rect.height),
  };
}

/** Normalized (u,v) → CSS percentage anchor for absolute positioning in the box. */
export function normalizedToPercent(n: Norm): { left: string; top: string } {
  return { left: `${clamp01(n.u) * 100}%`, top: `${clamp01(n.v) * 100}%` };
}

/** Was a pointer gesture a tap (place) rather than a drag (pan)? Measured against
 * the DOWN point, since pan updates every move so even a jittery tap nudges it. */
export function isTap(downX: number, downY: number, upX: number, upY: number, threshold = 6): boolean {
  return Math.hypot(upX - downX, upY - downY) < threshold;
}

// ── page-number convention (viewer state is 0-based; storage is 1-based) ──────
/** Viewer's 0-based sheet index → the 1-based `page_number` stored on the pin. */
export const toStoredPage = (zeroBasedPage: number): number => Math.max(1, Math.floor(zeroBasedPage) + 1);
/** Pins on the sheet the viewer currently shows (its `page` state is 0-based). */
export function pinsForSheet<T extends { page_number: number }>(pins: readonly T[], zeroBasedPage: number): T[] {
  const want = toStoredPage(zeroBasedPage);
  return pins.filter((p) => p.page_number === want);
}

// ── the pin row shape (what the UI consumes) ─────────────────────────────────
export type BlueprintPin = {
  id: string;
  blueprint_version_id: string;
  page_number: number;
  u: number;
  v: number;
  kind: PinKind;
  title: string | null;
  note: string | null;
  snag_id: string | null;
  created_at: string;
  /** Joined from the linked snag (the AUTHORITY for a snag pin's status). null for note pins. */
  snag_status?: SnagStatus | null;
  snag_title?: string | null;
  // Task-pin fields (null for snag/note pins). A task pin OWNS its status —
  // unlike a snag pin, whose status is derived from the linked snag row.
  task_status?: TaskPinStatus | null;
  assigned_to?: string | null;
  due_date?: string | null;
  /** Joined display name of the assignee (from users). null when unassigned. */
  assignee_name?: string | null;
};

// ── display derivation ───────────────────────────────────────────────────────
export type PinTone = "open" | "progress" | "resolved" | "muted" | "note";

/**
 * A pin's display status is DERIVED, never stored ON A SNAG PIN: a snag pin
 * mirrors its snag's status (single source of truth), a note pin is just
 * "Note". A TASK pin owns its own `task_status`, so it reads that directly.
 */
export function pinDisplayStatus(
  pin: Pick<BlueprintPin, "kind" | "snag_status" | "task_status">,
): {
  label: string;
  tone: PinTone;
} {
  if (pin.kind === "note") return { label: "Note", tone: "note" };
  if (pin.kind === "task") {
    const t = pin.task_status ?? "open";
    const tone: PinTone = t === "open" ? "open" : t === "in_progress" ? "progress" : "resolved";
    return { label: TASK_PIN_STATUS_LABELS[t], tone };
  }
  const s = pin.snag_status ?? null;
  if (!s) return { label: "Snag", tone: "muted" };
  const tone: PinTone =
    s === "open" ? "open"
    : s === "in_progress" ? "progress"
    : s === "fixed" ? "progress"
    : s === "verified" ? "resolved"
    : "muted"; // wont_fix
  return { label: SNAG_STATUS_LABELS[s], tone };
}

/** The one-line label shown on a pin marker / in its tooltip. */
export function pinShortLabel(pin: BlueprintPin): string {
  const t = (pin.title ?? "").trim();
  if (t) return t;
  if (pin.kind === "snag") return (pin.snag_title ?? "").trim() || "Snag";
  if (pin.kind === "task") return (pin.note ?? "").trim().slice(0, 60) || "Task";
  return (pin.note ?? "").trim().slice(0, 60) || "Note";
}

// ── filtering (local, bounded) ───────────────────────────────────────────────
export type PinFilter = { kind: PinKind | "all"; status: "all" | "open" | "resolved" };
export const DEFAULT_PIN_FILTER: PinFilter = { kind: "all", status: "all" };

export function filterPins(pins: readonly BlueprintPin[], filter: PinFilter): BlueprintPin[] {
  return pins.filter((p) => {
    if (filter.kind !== "all" && p.kind !== filter.kind) return false;
    if (filter.status === "all") return true;
    // "open" = anything not yet resolved; "resolved" = done work. Note pins have
    // no lifecycle → they only match "all". Snag and TASK pins both participate.
    if (p.kind === "snag") {
      const resolved = p.snag_status === "verified" || p.snag_status === "wont_fix";
      return filter.status === "resolved" ? resolved : !resolved;
    }
    if (p.kind === "task") {
      const resolved = p.task_status === "done";
      return filter.status === "resolved" ? resolved : !resolved;
    }
    return false;
  });
}

// ── zod input schemas (server actions validate against these) ────────────────
const uuid = z.string().uuid();
const coord = z.number().min(0).max(1);
const page = z.number().int().min(1);
const titleOpt = z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined));

/** Place a note pin (self-contained; no external entity). */
export const createNotePinSchema = z.object({
  blueprint_version_id: uuid,
  page_number: page,
  u: coord,
  v: coord,
  title: titleOpt,
  note: z.string().trim().min(1, "A note needs some text.").max(2000),
});
export type CreateNotePinInput = z.infer<typeof createNotePinSchema>;

/** Place a pin that CREATES a new snag at that location. */
export const createSnagPinSchema = z.object({
  blueprint_version_id: uuid,
  page_number: page,
  u: coord,
  v: coord,
  pin_title: titleOpt,
  snag_title: z.string().trim().min(1, "The snag needs a title.").max(200),
  snag_description: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  snag_priority: z.enum(SNAG_PRIORITIES).default("medium"),
  snag_location: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
});
export type CreateSnagPinInput = z.infer<typeof createSnagPinSchema>;

/** Place a pin that LINKS an existing snag. */
export const linkSnagPinSchema = z.object({
  blueprint_version_id: uuid,
  page_number: page,
  u: coord,
  v: coord,
  snag_id: uuid,
  title: titleOpt,
});
export type LinkSnagPinInput = z.infer<typeof linkSnagPinSchema>;

/** Place a pin that is a first-class task (assignee, status, due date). */
export const createTaskPinSchema = z.object({
  blueprint_version_id: uuid,
  page_number: page,
  u: coord,
  v: coord,
  title: z.string().trim().min(1, "The task needs a title.").max(120),
  note: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  assigned_to: uuid.optional().or(z.literal("").transform(() => undefined)),
  due_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type CreateTaskPinInput = z.infer<typeof createTaskPinSchema>;

/** Update a task pin's lifecycle fields (status / assignee / due date). */
export const updateTaskPinSchema = z.object({
  id: uuid,
  status: z.enum(TASK_PIN_STATUSES).optional(),
  // A distinguishable "unassign" (null) vs "leave unchanged" (undefined): the
  // literal "" from an empty <select> maps to null (clear the assignee).
  assigned_to: uuid.nullable().optional().or(z.literal("").transform(() => null)),
  // "" clears the due date; a date string sets it; undefined leaves it.
  due_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
export type UpdateTaskPinInput = z.infer<typeof updateTaskPinSchema>;

/** Move an existing pin (member-allowed reposition). */
export const movePinSchema = z.object({ id: uuid, u: coord, v: coord });
export type MovePinInput = z.infer<typeof movePinSchema>;
