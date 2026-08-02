import Link from "next/link";

import { requireOrgContext } from "@/server/auth/session";
import { listCalendarConnections } from "@/server/services/calendar-connections";
import { getHmrcConnection } from "@/server/services/hmrc-connections";
import {
  isGoogleCalendarConnectable,
  isMicrosoftCalendarConnectable,
} from "@/lib/integrations/calendar/oauth";
import { isHmrcConnectable } from "@/lib/integrations/hmrc/oauth";
import { CalendarConnectionsPanel } from "./CalendarConnectionsPanel";
import { HmrcConnectionPanel } from "./HmrcConnectionPanel";

/**
 * /settings/integrations — third-party integration connections (calendar today).
 *
 * Admin-gated: the page checks the membership role for the UX, and the
 * calendar_connections RLS policies (admin-write) are the real authority. The
 * connection state is read org-pinned + token-free by the service.
 *
 * DARK. Every provider's `connectable` is false today (no OAuth client
 * credentials, FEATURE_CALENDAR_CONNECT off), so the panel renders disabled
 * "configure credentials" controls that never link to the OAuth flow.
 */

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Header />
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            Only owners and admins can manage integrations.
          </p>
        </section>
      </div>
    );
  }

  const connections = await listCalendarConnections(ctx.org.id);
  const hmrc = await getHmrcConnection(ctx.org.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Header />
      <CalendarConnectionsPanel
        connections={connections}
        connectable={{
          google: isGoogleCalendarConnectable(),
          microsoft: isMicrosoftCalendarConnectable(),
        }}
      />
      <HmrcConnectionPanel connection={hmrc} connectable={isHmrcConnectable()} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <div className="text-sm">
        <Link href="/settings" className="text-slate-500 hover:text-slate-700">
          ← Settings
        </Link>
      </div>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Integrations</h1>
      <p className="mt-1 text-sm text-slate-600">
        Connect CrewFlow to the tools your team already uses. Calendar push keeps
        scheduled jobs and rota shifts in sync with Google or Microsoft calendars.
      </p>
    </header>
  );
}
