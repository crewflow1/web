import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { setOrganizationStatus } from "../actions";

/**
 * CrewFlow super-admin organisation moderation panel.
 *
 * Lists every organisation grouped by status. Each pending row gets
 * approve / approve-as-trial / reject buttons; active rows can be
 * suspended. Powered by the service-role admin client because we're
 * looking across all tenants.
 *
 * Gated by `isSuperAdminEmail(user.email)`. Non-admins get a 404 so
 * the route's existence doesn't leak to non-allowlisted users.
 */

type SP = Promise<{ error?: string; saved?: string }>;

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  status: string;
  plan: string;
  trial_ends_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  suspended_at: string | null;
  rejection_reason: string | null;
  phone: string | null;
  email: string | null;
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  trial: "bg-blue-100 text-blue-800",
  suspended: "bg-red-100 text-red-700",
  rejected: "bg-slate-200 text-slate-600",
};

const STATUS_ORDER = ["pending", "trial", "active", "suspended", "rejected"];

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  const sp = await searchParams;
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("organizations")
    .select(
      "id, name, slug, created_at, status, plan, trial_ends_at, approved_at, approved_by, suspended_at, rejection_reason, phone, email" as never,
    )
    .order("created_at", { ascending: false });

  const orgs = ((rows ?? []) as unknown as OrgRow[]);

  // Pull owner emails in a single follow-up query (no relational join
  // available here without RLS shenanigans).
  const orgIds = orgs.map((o) => o.id);
  let ownerByOrg: Map<string, { full_name: string | null; email: string }> =
    new Map();
  if (orgIds.length > 0) {
    const { data: ownerships } = await admin
      .from("memberships")
      .select("org_id, user:users ( full_name, email )")
      .in("org_id", orgIds)
      .eq("role", "owner");
    ownerByOrg = new Map(
      (ownerships ?? []).map((row) => [
        row.org_id,
        {
          full_name: row.user?.full_name ?? null,
          email: row.user?.email ?? "",
        },
      ]),
    );
  }

  const grouped = new Map<string, OrgRow[]>();
  for (const o of orgs) {
    const status = STATUS_ORDER.includes(o.status) ? o.status : "active";
    const list = grouped.get(status) ?? [];
    list.push(o);
    grouped.set(status, list);
  }

  const errorMessage = sp.error
    ? sp.error === "invalid_input"
      ? "Invalid input."
      : sp.error === "update_failed"
        ? "Couldn't update. Try again."
        : decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved
    ? `Org marked ${decodeURIComponent(sp.saved)}.`
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          Organisation moderation
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Approve new signups, set trial windows, suspend access. Signed
          in as <strong>{user.email}</strong>.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {savedMessage}
        </div>
      ) : null}

      {STATUS_ORDER.map((status) => {
        const list = grouped.get(status) ?? [];
        if (list.length === 0) return null;
        return (
          <section
            key={status}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold capitalize text-slate-900">
                {status}{" "}
                <span className="ml-1 text-xs font-normal text-slate-500">
                  ({list.length})
                </span>
              </h2>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}
              >
                {status}
              </span>
            </header>
            <ul className="divide-y divide-slate-100">
              {list.map((org) => {
                const owner = ownerByOrg.get(org.id);
                return (
                  <li key={org.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">
                          {org.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {owner
                            ? `${owner.full_name ?? "—"} · ${owner.email}`
                            : "no owner row"}
                          {" · created "}
                          {org.created_at.slice(0, 10)}
                          {" · plan "}
                          <strong>{org.plan}</strong>
                        </p>
                        {org.rejection_reason ? (
                          <p className="mt-1 text-xs text-red-700">
                            Rejection note: {org.rejection_reason}
                          </p>
                        ) : null}
                        {org.suspended_at ? (
                          <p className="mt-1 text-xs text-amber-700">
                            Suspended at {org.suspended_at.slice(0, 16).replace("T", " ")}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {/* Approve as active */}
                        {status !== "active" ? (
                          <form action={setOrganizationStatus}>
                            <input type="hidden" name="org_id" value={org.id} />
                            <input type="hidden" name="status" value="active" />
                            <button
                              type="submit"
                              className="rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-800"
                            >
                              Approve
                            </button>
                          </form>
                        ) : null}
                        {status !== "trial" ? (
                          <form action={setOrganizationStatus}>
                            <input type="hidden" name="org_id" value={org.id} />
                            <input type="hidden" name="status" value="trial" />
                            <button
                              type="submit"
                              className="rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                            >
                              Approve as trial
                            </button>
                          </form>
                        ) : null}
                        {status !== "suspended" && status !== "rejected" ? (
                          <form action={setOrganizationStatus}>
                            <input type="hidden" name="org_id" value={org.id} />
                            <input type="hidden" name="status" value="suspended" />
                            <button
                              type="submit"
                              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
                            >
                              Suspend
                            </button>
                          </form>
                        ) : null}
                        {status === "pending" ? (
                          <form action={setOrganizationStatus}>
                            <input type="hidden" name="org_id" value={org.id} />
                            <input type="hidden" name="status" value="rejected" />
                            <button
                              type="submit"
                              className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              Reject
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <p className="text-center text-xs text-slate-400">
        <Link href="/dashboard" className="hover:text-slate-700">
          ← Back to CrewFlow
        </Link>
      </p>
    </div>
  );
}
