import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { outboundWebhooksEnabled } from "@/lib/webhooks/flags";
import { CreateWebhookForm, EndpointActions } from "./_forms";

/**
 * /settings/webhooks — org outbound webhook endpoints (Train A).
 *
 * Admin-gated exactly like /settings/api-keys: the page checks the membership role
 * for the UX, and the webhook_endpoints RLS policies (admin-only) are the real
 * authority. THE READ BELOW NAMES ITS COLUMNS ON PURPOSE — `secret` is excluded
 * from the authenticated role by column-level privilege (20261087), so a
 * select('*') here fails by design. Never "fix" that by widening the grant.
 *
 * When NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS is off the manager is hidden behind a
 * "coming soon" notice — the whole delivery path is dark.
 */

export const dynamic = "force-dynamic";

type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  event_verbs: string[] | null;
  status: string;
  consecutive_failures: number;
  verified_at: string | null;
  last_delivery_at: string | null;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  verb: string;
  state: string;
  attempt: number;
  last_status_code: number | null;
  created_at: string;
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  disabled_by_failures: "bg-red-100 text-red-700",
};
const STATE_STYLES: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-800",
  pending: "bg-slate-100 text-slate-600",
  delivering: "bg-blue-100 text-blue-700",
  dead: "bg-red-100 text-red-700",
};

export default async function WebhooksSettingsPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Header />
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            Only owners and admins can manage webhooks.
          </p>
        </section>
      </div>
    );
  }

  const enabled = outboundWebhooksEnabled();
  if (!enabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Header />
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Coming soon</h2>
          <p className="mt-2 text-sm text-slate-600">
            Outbound webhooks let your systems react to CrewFlow events in real time.
            This feature is being finalised and isn&apos;t switched on for your account yet.
          </p>
        </section>
      </div>
    );
  }

  const supabase = await createClient();
  // Explicit safe columns — `secret` is structurally unreadable on this client.
  const { data: endpointsData, error: epError } = await (
    supabase.from("webhook_endpoints" as never) as unknown as {
      select: (c: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => PromiseLike<{ data: EndpointRow[] | null; error: { message: string; code?: string } | null }> } };
    }
  )
    .select("id, url, description, event_verbs, status, consecutive_failures, verified_at, last_delivery_at, created_at")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false });
  if (epError) throw readFailure("webhooks: endpoints", epError);
  const endpoints = endpointsData ?? [];

  const { data: deliveriesData, error: delError } = await (
    supabase.from("webhook_deliveries" as never) as unknown as {
      select: (c: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => PromiseLike<{ data: DeliveryRow[] | null; error: { message: string; code?: string } | null }> } } };
    }
  )
    .select("id, endpoint_id, verb, state, attempt, last_status_code, created_at")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(25);
  if (delError) throw readFailure("webhooks: deliveries", delError);
  const deliveries = deliveriesData ?? [];
  const urlById = new Map(endpoints.map((e) => [e.id, e.url]));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Header />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Add an endpoint</h2>
        <p className="mt-1 text-sm text-slate-600">
          We&apos;ll send a signed verification ping first; the endpoint goes live once it
          responds with a 2xx.
        </p>
        <div className="mt-4">
          <CreateWebhookForm />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your endpoints</h2>
        {endpoints.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No webhooks yet. Add one above.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {endpoints.map((e) => (
              <li key={e.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <code className="block truncate font-mono text-sm text-slate-900">{e.url}</code>
                    {e.description ? <p className="mt-0.5 text-xs text-slate-500">{e.description}</p> : null}
                  </div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[e.status] ?? "bg-slate-100 text-slate-600"}`}>
                    {e.status.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(e.event_verbs ?? []).map((v) => (
                    <span key={v} className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">{v}</span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {e.verified_at ? `Verified ${fmt(e.verified_at)}` : "Not yet verified"}
                  {" · "}Last delivery {fmt(e.last_delivery_at)}
                  {e.consecutive_failures > 0 ? ` · ${e.consecutive_failures} consecutive failures` : ""}
                </p>
                <div className="mt-3">
                  <EndpointActions endpointId={e.id} status={e.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Recent deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No deliveries yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-medium">Event</th>
                  <th className="py-2 pr-3 font-medium">Endpoint</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 pr-3 font-medium">Attempts</th>
                  <th className="py-2 pr-3 font-medium">HTTP</th>
                  <th className="py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-700">{d.verb}</td>
                    <td className="py-2 pr-3 max-w-[220px] truncate text-xs text-slate-500">{urlById.get(d.endpoint_id) ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLES[d.state] ?? "bg-slate-100 text-slate-600"}`}>{d.state}</span>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{d.attempt}</td>
                    <td className="py-2 pr-3 text-slate-600">{d.last_status_code ?? "—"}</td>
                    <td className="py-2 text-slate-600">{fmt(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Webhooks</h1>
      <p className="mt-1 text-sm text-slate-600">
        Get a signed HTTPS POST whenever a CrewFlow event happens. Each delivery
        carries an <code className="font-mono text-xs">X-CrewFlow-Signature</code> header you can
        verify with the endpoint&apos;s signing secret.
      </p>
    </header>
  );
}
