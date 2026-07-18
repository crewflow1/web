import { z } from "zod";

/**
 * Snagging — shared domain constants + input validation.
 *
 * Pure module (no I/O): imported by the server actions AND unit-tested
 * directly (__tests__/snags/schema.test.ts). The DB CHECK constraints in
 * 20260919000000_snags.sql are the source of truth for the allowed values;
 * these mirror them exactly.
 */

export const SNAG_PRIORITIES = ["low", "medium", "high"] as const;
export type SnagPriority = (typeof SNAG_PRIORITIES)[number];

export const SNAG_STATUSES = [
  "open",
  "in_progress",
  "fixed",
  "verified",
  "wont_fix",
] as const;
export type SnagStatus = (typeof SNAG_STATUSES)[number];

/** Terminal statuses stamp resolved_at; leaving them clears it. */
export const TERMINAL_SNAG_STATUSES = ["verified", "wont_fix"] as const;

export function isTerminalStatus(status: SnagStatus): boolean {
  return (TERMINAL_SNAG_STATUSES as readonly string[]).includes(status);
}

export const SNAG_STATUS_LABELS: Record<SnagStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  fixed: "Fixed",
  verified: "Verified",
  wont_fix: "Won't fix",
};

export const SNAG_PRIORITY_LABELS: Record<SnagPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Given the current stored status and the requested next status, decide what
 * resolved_at should become:
 *   - entering a terminal status for the first time  -> stamp `now`
 *   - leaving a terminal status (reopen)             -> clear to null
 *   - otherwise                                      -> leave unchanged
 * Returns `undefined` to mean "don't touch the column".
 */
export function resolvedAtForTransition(
  current: SnagStatus,
  next: SnagStatus,
  now: Date,
): Date | null | undefined {
  const wasTerminal = isTerminalStatus(current);
  const willBeTerminal = isTerminalStatus(next);
  if (!wasTerminal && willBeTerminal) return now;
  if (wasTerminal && !willBeTerminal) return null;
  return undefined;
}

// Treat a blank/whitespace-only value as absent BEFORE validation. Using
// z.preprocess (not `.or(z.literal(""))`) matters: a plain `z.string()` accepts
// "" and a naive union would short-circuit on it and keep the empty string. We
// map "" -> undefined first so an untouched form input never writes a blank.
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

// An optional free-text field: trims, caps length, treats "" as absent.
const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

// An optional uuid reference from a <select>: "" (no selection) becomes absent.
const optionalUuid = z.preprocess(
  blankToUndefined,
  z.string().uuid().optional(),
);

export const createSnagSchema = z.object({
  title: z.string().trim().min(1, "Give the snag a short title").max(200),
  description: optionalText(4000),
  location: optionalText(200),
  trade: optionalText(120),
  priority: z.preprocess(
    blankToUndefined,
    z.enum(SNAG_PRIORITIES).default("medium"),
  ),
  job_id: optionalUuid,
  assigned_to: optionalUuid,
  due_date: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(
        /^\d{4}-\d{2}-\d{2}$/,
        "Use the date picker — format must be YYYY-MM-DD",
      )
      .optional(),
  ),
});
export type CreateSnagInput = z.infer<typeof createSnagSchema>;

export const updateSnagStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SNAG_STATUSES),
});

export const reassignSnagSchema = z.object({
  id: z.string().uuid(),
  // "" means unassign.
  assigned_to: optionalUuid,
});

export const setSnagPrioritySchema = z.object({
  id: z.string().uuid(),
  priority: z.enum(SNAG_PRIORITIES),
});

export const snagIdSchema = z.string().uuid();
