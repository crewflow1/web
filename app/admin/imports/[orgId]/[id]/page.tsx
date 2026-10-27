import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHqPage } from "@/server/auth/hq";
import { getOperatorImport } from "@/lib/admin/operator-imports";

/**
 * Operator Migration OS — read-only detail of ONE import of ONE target org.
 * `getOperatorImport` requires BOTH the org id and the row id to match, so an
 * operator cannot reach another org's import by guessing its id. 404s otherwise.
 */
export const dynamic = "force-dynamic";

type Params = Promise<{ orgId: string; id: string }>;

export default async function OperatorImportDetailPage({ params }: { params: Params }) {
  await requireHqPage();
  const { orgId, id } = await params;
  const im = await getOperatorImport(decodeURIComponent(orgId), decodeURIComponent(id));
  if (!im) notFound();

  const rows: Array<[string, string]> = [
    ["Status", im.status.replace("_", " ")],
    ["Started", im.created_at.replace("T", " ").slice(0, 19)],
    ["Committed", im.committed_at ? im.committed_at.replace("T", " ").slice(0, 19) : "—"],
    ["Rolled back", im.rolled_back_at ? im.rolled_back_at.replace("T", " ").slice(0, 19) : "—"],
  ];

  return (
    <div className="space-y-6">
      <nav className="text-xs text-slate-500">
        <Link href={`/admin/imports?org=${encodeURIComponent(orgId)}`} className="underline">
          ← Back to this org&apos;s imports
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">{im.name}</h1>
        <p className="mt-1 text-sm text-slate-600">Read-only operator view.</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-slate-100 py-1.5 text-sm">
              <dt className="text-slate-500">{k}</dt>
              <dd className="font-medium text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
