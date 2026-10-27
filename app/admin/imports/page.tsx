import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { listOperatorImports, listOperatorOrgs } from "@/lib/admin/operator-imports";

/**
 * Operator Migration OS — super-admin READ surface.
 *
 * Gated by `requireHqPage()` (the layout gates too; this is defence in depth).
 * An operator explicitly selects ONE target org (`?org=<id>`); nothing is shown
 * until they do, and only that org's imports are listed. READ-ONLY — see
 * docs/migration/MIGRATION-OS-OPERATOR-RUNBOOK.md for the deferred write slice.
 */
export const dynamic = "force-dynamic";

type SP = Promise<{ org?: string }>;

export default async function OperatorImportsPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const { org } = await searchParams;
  const targetOrgId = typeof org === "string" ? org.trim() : "";

  const orgs = await listOperatorOrgs();
  // Only query imports for an org that actually exists in the roster — an
  // arbitrary ?org=<uuid> selects nothing.
  const selected = orgs.find((o) => o.id === targetOrgId) ?? null;
  const imports = selected ? await listOperatorImports(selected.id) : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Migration OS — operator</h1>
        <p className="mt-1 text-sm text-slate-600">
          Super-admin read-only view of any org&apos;s imports. Select an organisation to
          see its import sessions. Mapping, commit and rollback for an org are not available
          from this surface yet.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Organisation</h2>
        <p className="mt-1 text-xs text-slate-500">
          {selected ? (
            <>
              Viewing <strong className="text-slate-700">{selected.org_name}</strong>.{" "}
              <Link href="/admin/imports" className="text-slate-600 underline">
                Change
              </Link>
            </>
          ) : (
            "Choose an organisation to view its imports."
          )}
        </p>
        {!selected ? (
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {orgs.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/admin/imports?org=${encodeURIComponent(o.id)}`}
                  className="block rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 hover:bg-slate-50"
                >
                  {o.org_name}
                </Link>
              </li>
            ))}
            {orgs.length === 0 ? (
              <li className="text-sm text-slate-500">No organisations found.</li>
            ) : null}
          </ul>
        ) : null}
      </section>

      {selected ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-base font-semibold text-slate-900">Imports</h2>
          </header>
          {imports.length === 0 ? (
            <p className="px-6 py-4 text-sm text-slate-500">No imports for this organisation.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {imports.map((im) => (
                <li key={im.id} className="flex items-center justify-between px-6 py-3 text-sm">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/imports/${encodeURIComponent(selected.id)}/${encodeURIComponent(im.id)}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {im.name}
                    </Link>
                    <div className="text-xs text-slate-500">
                      started {im.created_at.slice(0, 16).replace("T", " ")}
                      {im.committed_at ? ` · committed ${im.committed_at.slice(0, 10)}` : ""}
                      {im.rolled_back_at ? ` · rolled back ${im.rolled_back_at.slice(0, 10)}` : ""}
                    </div>
                  </div>
                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                    {im.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
