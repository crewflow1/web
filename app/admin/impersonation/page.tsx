import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import {
  listImpersonationSessions,
  getActiveImpersonation,
} from "@/server/services/impersonation";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  startImpersonation,
  endImpersonation,
  forceEndImpersonation,
} from "./actions";
import { ClientConfirmForm } from "../_client-confirm";

/**
 * HQ Impersonation centre — /admin/impersonation (HQ-10).
 *
 * Three sections:
 *   1. Active sessions across the team (with force-end controls).
 *   2. Start a new session form.
 *   3. Recent history (audit log).
 */

type SP = Promise<{ saved?: string; error?: string }>;

export const dynamic = "force-dynamic";

export default async function HqImpersonationPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const myActive = await getActiveImpersonation(user.email ?? null);
  const sessions = await listImpersonationSessions(100);
  const active = sessions.filter((s) => s.ended_at === null);

  const admin = createAdminClient();
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name" as never)
    .order("name", { ascending: true });
  const orgList = ((orgs ?? []) as unknown) as Array<{
    id: string;
    name: string;
  }>;

  const banner = (() => {
    if (sp.saved === "ended")
      return { tone: "ok" as const, msg: "Impersonation session ended." };
    if (sp.saved === "force_ended")
      return { tone: "ok" as const, msg: "Session force-ended." };
    if (sp.error)
      return {
        tone: "err" as const,
        msg: `Error: ${decodeURIComponent(sp.error)}`,
      };
    return null;
  })();

  return (
    <div className="space-y-5 p-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          HQ · Impersonation
        </p>
        <h1 className="text-2xl font-bold text-slate-900">
          Customer impersonation
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Drop into a customer workspace and see what they see. Every
          start/stop is audit-logged. Sessions auto-expire after 24h.
          Cross-tenant access is enforced via{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">
            current_org_ids()
          </code>{" "}
          — the same RLS predicate every tenant policy uses — so revocation
          via Exit is instant.
        </p>
      </header>

      {banner ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.msg}
        </div>
      ) : null}

      {myActive ? (
        <section className="rounded-xl border-2 border-red-300 bg-red-50 p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-red-700">
            You are currently impersonating
          </p>
          <p className="mt-1 text-base font-bold text-red-900">
            {myActive.target_org_name ?? myActive.target_org_id.slice(0, 8)}
          </p>
          <p className="mt-1 text-xs text-red-800">
            Started {myActive.started_at.slice(0, 16).replace("T", " ")} UTC
            {myActive.reason ? ` · Reason: ${myActive.reason}` : ""}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Link
              href={`/dashboard`}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-900 hover:bg-red-100"
            >
              Open customer workspace →
            </Link>
            <form action={endImpersonation}>
              <button
                type="submit"
                className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
              >
                Exit impersonation
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {!myActive ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Start a new impersonation
          </h2>
          <ClientConfirmForm
            action={startImpersonation}
            confirm="Start impersonating this customer? Your auth.uid will gain temporary RLS access to their data and the action is broadcast to HQ + audit-logged."
            className="mt-3 space-y-3"
          >
            <label className="block text-[11px] font-medium text-slate-700">
              Customer
              <select
                name="org_id"
                required
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Pick a customer…</option>
                {orgList.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] font-medium text-slate-700">
              Reason (required, audit-logged)
              <input
                name="reason"
                type="text"
                required
                minLength={3}
                maxLength={2000}
                placeholder="e.g. Diagnose customer-reported import failure"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
            >
              Start impersonating
            </button>
          </ClientConfirmForm>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          Active sessions
        </h2>
        {active.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed border-slate-300 bg-white px-4 py-4 text-center text-sm text-slate-500">
            None.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
            {active.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {s.admin_email} → {s.target_org_name ?? s.target_org_id.slice(0, 8)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Started {s.started_at.slice(0, 16).replace("T", " ")} UTC
                    {s.reason ? ` · ${s.reason}` : ""}
                  </p>
                </div>
                <ClientConfirmForm
                  action={forceEndImpersonation}
                  confirm={`Force-end ${s.admin_email}'s active impersonation? Their cross-tenant RLS access stops immediately.`}
                >
                  <input type="hidden" name="session_id" value={s.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Force end
                  </button>
                </ClientConfirmForm>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          Recent history
        </h2>
        <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
          {sessions.slice(0, 50).map((s) => (
            <li key={s.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-slate-900">
                  {s.admin_email}
                </span>
                <span className="text-slate-500">
                  → {s.target_org_name ?? s.target_org_id.slice(0, 8)}
                </span>
                <span className="text-slate-500">
                  {s.started_at.slice(0, 16).replace("T", " ")}
                  {s.ended_at
                    ? ` → ${s.ended_at.slice(0, 16).replace("T", " ")}`
                    : " · ACTIVE"}
                </span>
              </div>
              {s.reason ? (
                <p className="mt-1 text-xs text-slate-600">{s.reason}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
