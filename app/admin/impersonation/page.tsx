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
import {
  Alert,
  Button,
  ButtonLink,
  GlowHeader,
  Input,
  Panel,
  Select,
  Surface,
} from "@/components/ui";

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
    <Surface>
      <GlowHeader
        eyebrow="HQ · Impersonation"
        title="Customer impersonation"
        subtitle={
          <>
            {
              "Drop into a customer workspace and see what they see. Every start/stop is audit-logged. Sessions auto-expire after 24h. Cross-tenant access is enforced via "
            }
            <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
              current_org_ids()
            </code>
            {
              " — the same RLS predicate every tenant policy uses — so revocation via Exit is instant."
            }
          </>
        }
      />

      <div className="space-y-5 p-5 sm:p-7">
        {banner ? (
          <Alert tone={banner.tone === "ok" ? "success" : "danger"}>
            {banner.msg}
          </Alert>
        ) : null}

        {myActive ? (
          <section className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-300">
              You are currently impersonating
            </p>
            <p className="mt-1 text-base font-bold text-rose-200">
              {myActive.target_org_name ?? myActive.target_org_id.slice(0, 8)}
            </p>
            <p className="mt-1 text-xs text-rose-200/90">
              Started {myActive.started_at.slice(0, 16).replace("T", " ")} UTC
              {myActive.reason ? ` · Reason: ${myActive.reason}` : ""}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <ButtonLink href={`/dashboard`} variant="glass" size="sm">
                Open customer workspace →
              </ButtonLink>
              <form action={endImpersonation}>
                <Button type="submit" variant="danger" size="sm">
                  Exit impersonation
                </Button>
              </form>
            </div>
          </section>
        ) : null}

        {!myActive ? (
          <Panel title="Start a new impersonation">
            <ClientConfirmForm
              action={startImpersonation}
              confirm="Start impersonating this customer? Your auth.uid will gain temporary RLS access to their data and the action is broadcast to HQ + audit-logged."
              className="space-y-3"
            >
              <label className="block text-[11px] font-medium text-slate-400">
                Customer
                <Select name="org_id" required className="mt-1">
                  <option value="">Pick a customer…</option>
                  {orgList.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-[11px] font-medium text-slate-400">
                Reason (required, audit-logged)
                <Input
                  name="reason"
                  type="text"
                  required
                  minLength={3}
                  maxLength={2000}
                  placeholder="e.g. Diagnose customer-reported import failure"
                  className="mt-1"
                />
              </label>
              <Button type="submit" variant="danger">
                Start impersonating
              </Button>
            </ClientConfirmForm>
          </Panel>
        ) : null}

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Active sessions
          </h2>
          {active.length === 0 ? (
            <p className="mt-2 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 px-4 py-4 text-center text-sm text-slate-500">
              None.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/40">
              {active.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-100">
                      {s.admin_email} →{" "}
                      {s.target_org_name ?? s.target_org_id.slice(0, 8)}
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
                    <Button type="submit" variant="glass" size="sm">
                      Force end
                    </Button>
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
          <ul className="mt-2 divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/40">
            {sessions.slice(0, 50).map((s) => (
              <li key={s.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-slate-100">
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
                  <p className="mt-1 text-xs text-slate-300">{s.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Surface>
  );
}
