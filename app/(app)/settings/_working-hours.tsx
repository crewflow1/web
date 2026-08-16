import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readOrgSettings } from "@/lib/org-config/service";
import { saveWorkingHours } from "./org-config-actions";
import { WorkingHoursForm } from "./_working-hours.client";

/**
 * Settings → Working hours (P3W2) — self-contained section.
 *
 * Rendered from settings/page.tsx with a single import + JSX line. Reads the
 * org's structured working-hours config (defaults when no row exists — a LOUD
 * read that throws on a real error) and hands it to the client editor. Admin
 * (owner/admin) may edit; members see it read-only.
 */
export async function WorkingHoursSettings() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  const settings = await readOrgSettings(supabase, ctx.org.id);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Working hours</h2>
          <p className="mt-1 text-sm text-slate-600">
            Your standard business hours and working days — used as the default
            window when scheduling jobs and rota shifts.
          </p>
        </div>
        {!isAdmin ? (
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            Read only · ask an admin
          </span>
        ) : null}
      </div>
      <WorkingHoursForm
        workingHours={settings.working_hours}
        isAdmin={isAdmin}
        action={saveWorkingHours}
      />
    </section>
  );
}
