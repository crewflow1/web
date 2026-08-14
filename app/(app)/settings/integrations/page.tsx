import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { listCalendarConnections } from "@/server/services/calendar-connections";
import { getHmrcConnection } from "@/server/services/hmrc-connections";
import {
  isGoogleCalendarConnectable,
  isMicrosoftCalendarConnectable,
} from "@/lib/integrations/calendar/oauth";
import { isHmrcConnectable } from "@/lib/integrations/hmrc/oauth";
import { listBankConnections } from "@/server/services/bank-connections";
import { isBankingProviderConnectable } from "@/lib/integrations/banking/oauth";
import { listTelematicsConnections } from "@/server/services/telematics-connections";
import { isTelematicsProviderConnectable } from "@/lib/integrations/telematics/oauth";
import { CalendarConnectionsPanel } from "./CalendarConnectionsPanel";
import { HmrcConnectionPanel } from "./HmrcConnectionPanel";
import { BankConnectionsPanel } from "./BankConnectionsPanel";
import { TelematicsConnectionsPanel } from "./TelematicsConnectionsPanel";

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
  const bankConnections = await listBankConnections(ctx.org.id);
  const telematicsConnections = await listTelematicsConnections(ctx.org.id);

  // The HMRC connect flow resolves the VRN from organizations.vat_number (HMRC
  // never returns one). Read it org-pinned so the panel can surface the
  // precondition — offering Connect only when a VAT number is on file.
  const supabase = await createClient();
  const { data: orgRow, error: orgErr } = await supabase
    .from("organizations")
    .select("vat_number" as never)
    .eq("id", ctx.org.id)
    .maybeSingle();
  // Loud: a failed read must not silently render "add your VAT number" (a lie
  // that would block a correctly-configured org from connecting).
  if (orgErr) throw readFailure("integrations settings: org vat_number", orgErr);
  const vatRaw = (orgRow as { vat_number?: unknown } | null)?.vat_number;
  const hasVatNumber = typeof vatRaw === "string" && vatRaw.trim().length > 0;

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
      <HmrcConnectionPanel
        connection={hmrc}
        connectable={isHmrcConnectable()}
        hasVatNumber={hasVatNumber}
      />
      <BankConnectionsPanel
        connections={bankConnections}
        connectable={{
          truelayer: isBankingProviderConnectable("truelayer"),
          plaid: isBankingProviderConnectable("plaid"),
          nordigen: isBankingProviderConnectable("nordigen"),
        }}
      />
      <TelematicsConnectionsPanel
        connections={telematicsConnections}
        connectable={{
          samsara: isTelematicsProviderConnectable("samsara"),
          verizon_connect: isTelematicsProviderConnectable("verizon_connect"),
        }}
      />
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
