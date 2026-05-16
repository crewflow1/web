/** Shared types for the schedule API + calendar UI. */

export type CalendarJobStatus =
  | "new"
  | "in-progress"
  | "completed"
  | "blocked";

export type CalendarJob = {
  /**
   * Stable identifier for the rendered item.
   * For real DB rows this is the jobs.id (uuid).
   * For recurring occurrences it's "<parent_id>:<iso_date>" so React
   * keys + drag handles stay unique.
   */
  id: string;
  /** True parent id. Mutations must target this row. */
  parent_id: string;
  /** Date for this occurrence (ISO date). */
  date: string;
  status: CalendarJobStatus | string;
  notes: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** True if this row is a generated recurring occurrence (not editable inline). */
  is_recurring_occurrence: boolean;
};

export type CalendarStaff = {
  id: string;
  name: string;
};
