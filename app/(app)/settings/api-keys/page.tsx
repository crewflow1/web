import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { CreateApiKeyForm, RevokeApiKeyButton } from "./_forms";

/**
 * /settings/api-keys — org API keys (Train 9 substrate).
 *
 * Admin-gated exactly like the other admin-only settings surfaces: the page
 * checks the membership role for the UX, and the api_keys RLS policies
 * (admin-only select/insert/update, NO delete) are the real authority.
 *
 * THE READ BELOW NAMES ITS COLUMNS ON PURPOSE. key_hash is excluded from the
 * authenticated role by COLUMN-LEVEL privilege (migration 20261086), so a
 * `select("*")` on this table fails with a permission error BY DESIGN — the
 * mechanism that guarantees no tenant surface can ever render the hash.
 * Never "fix" a failing star-select here by widening the grant.
 */

export const dynamic = "force-dynamic";

type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[] | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

type ListChain = {
  select: (cols: string) => {
    eq: (c: string, v: string) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => PromiseLike<{
        data: ApiKeyRow[] | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function keyStatus(k: ApiKeyRow): { label: string; style: string } {
  if (k.revoked_at) return { label: "Revoked", style: "bg-red-100 text-red-700" };
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) {
    return { label: "Expired", style: "bg-slate-200 text-slate-600" };
  }
  return { label: "Active", style: "bg-emerald-100 text-emerald-800" };
}

export default async function ApiKeysSettingsPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Header />
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            Only owners and admins can manage API keys. Ask an owner or admin
            if your integration needs one.
          </p>
        </section>
      </div>
    );
  }

  const supabase = await createClient();
  // Explicit safe columns — see the header. key_hash is structurally
  // unreadable on this client and must never be added to this list.
  const { data, error } = await (
    supabase.from("api_keys" as never) as unknown as ListChain
  )
    .select(
      "id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at",
    )
    .eq("org_id", ctx.org.id) // active-org pin, not "any org I belong to"
    .order("created_at", { ascending: false });
  // Loud read: this list drives revocation decisions — an empty table over a
  // failed query would read as "no keys exist", which is exactly wrong.
  if (error) throw readFailure("api-keys: list", error);
  const keys = data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Header />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Create a key</h2>
        <p className="mt-1 text-sm text-slate-600">
          The full key is shown once, straight after you create it. CrewFlow
          stores only a fingerprint — if a key is lost, revoke it and create a
          new one.
        </p>
        <div className="mt-4">
          <CreateApiKeyForm />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your keys</h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            No API keys yet. Create one above to try the API:{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
              GET /api/v1/me
            </code>{" "}
            with{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
              Authorization: Bearer &lt;key&gt;
            </code>
            .
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Key</th>
                  <th className="py-2 pr-3 font-medium">Scopes</th>
                  <th className="py-2 pr-3 font-medium">Created</th>
                  <th className="py-2 pr-3 font-medium">Last used</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const status = keyStatus(k);
                  const revocable = !k.revoked_at;
                  return (
                    <tr key={k.id} className="border-b border-slate-100 align-top">
                      <td className="py-3 pr-3 font-medium text-slate-900">{k.name}</td>
                      <td className="py-3 pr-3">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                          {k.key_prefix}…
                        </code>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {(k.scopes ?? []).map((s) => (
                            <span
                              key={s}
                              className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-slate-600">{fmt(k.created_at)}</td>
                      <td className="py-3 pr-3 text-slate-600">{fmt(k.last_used_at)}</td>
                      <td className="py-3 pr-3 text-slate-600">
                        {k.expires_at ? fmt(k.expires_at) : "Never"}
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${status.style}`}
                        >
                          {status.label}
                        </span>
                        {k.revoked_at ? (
                          <span className="mt-1 block text-[11px] text-slate-400">
                            {fmt(k.revoked_at)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-3">
                        {revocable ? (
                          <RevokeApiKeyButton keyId={k.id} keyName={k.name} />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Revoked keys stay listed as an audit trail — keys are never deleted.
          Revocation takes effect on the next request.
        </p>
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
      <h1 className="mt-2 text-2xl font-bold text-slate-900">API keys</h1>
      <p className="mt-1 text-sm text-slate-600">
        Keys for the CrewFlow API. Today the API exposes a single probe
        endpoint (<code className="font-mono text-xs">/api/v1/me</code>) while
        the platform surface is being decided — keys you create now will keep
        working as endpoints are added.
      </p>
    </header>
  );
}
