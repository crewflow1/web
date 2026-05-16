import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../_form-helpers";
import { CalendarClient } from "./_calendar";

/**
 * /jobs/calendar — scheduling / dispatch.
 *
 * Server component fetches: the visible jobs (via the same RLS-scoped
 * query the /api/schedule route does) + the staff list for the
 * assignee dropdowns. Client component handles week navigation, view
 * toggle, drag-drop, and PUT-back to the API.
 *
 * The seed for "this week" is the URL's ?d=YYYY-MM-DD anchor — if not
 * present, defaults to today. That way deep-links to a specific week
 * survive refreshes.
 */

type SP = Promise<{ d?: string; status?: string; staff?: string; view?: string }>;

function startOfWeekIso(anchorIso: string): string {
  // ISO week starts Monday. JS Date getUTCDay() returns 0=Sunday..6=Saturday.
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  const dow = anchor.getUTCDay(); // 0 Sun, 1 Mon, ...
  const daysFromMonday = (dow + 6) % 7;
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - daysFromMonday);
  return start.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  const anchorIso = (sp.d && /^\d{4}-\d{2}-\d{2}$/.test(sp.d) ? sp.d : new Date().toISOString().slice(0, 10));
  const weekStart = startOfWeekIso(anchorIso);
  const weekEnd = addDaysIso(weekStart, 6);

  const staff = await listStaffForOrg();

  // Initial fetch through the same code-path the API uses — server-side
  // for the first render so the user doesn't see a flash of empty grid.
  const apiUrl = new URL("/api/schedule", `https://crewflow.uk`);
  apiUrl.searchParams.set("from", weekStart);
  apiUrl.searchParams.set("to", weekEnd);
  if (sp.status) apiUrl.searchParams.set("status", sp.status);
  if (sp.staff) apiUrl.searchParams.set("staff", sp.staff);

  // The page is already authed, so re-query directly via Supabase rather
  // than fetching our own API route (avoids a round-trip).
  const supabase = await createClient();
  let q = supabase
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, notes, assigned_to, customer_id, recurring,
        customer:customers ( id, name ),
        assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
      `,
    )
    .limit(1000);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.staff) q = q.eq("assigned_to", sp.staff);
  const { data: rawJobs } = await q;

  return (
    <CalendarClient
      orgName={ctx.org.name}
      staff={staff.map((s) => ({
        id: s.id,
        name: s.full_name ?? s.email,
      }))}
      initialJobs={rawJobs ?? []}
      weekStart={weekStart}
      weekEnd={weekEnd}
      statusFilter={sp.status ?? ""}
      staffFilter={sp.staff ?? ""}
    />
  );
}
