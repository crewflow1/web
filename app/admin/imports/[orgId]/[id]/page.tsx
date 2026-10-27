import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHqPage } from "@/server/auth/hq";
import {
  getOperatorImport,
  getOperatorImportEntities,
  type OperatorImportEntity,
} from "@/lib/admin/operator-imports";
import { entityFieldNames, type EntityType } from "@/lib/imports/detect";
import { operatorRemapColumnsAction } from "../../actions";

/**
 * Operator Migration OS — read-only detail + the one operator WRITE op:
 * staging-only column remap (reversible; never touches live business tables).
 * `getOperatorImport` requires BOTH org id and row id, so an operator cannot
 * reach another org's import by guessing its id. 404s otherwise.
 */
export const dynamic = "force-dynamic";

// Entities whose mapping an operator may override (mirrors the data layer).
const REMAPPABLE: readonly EntityType[] = [
  "customer",
  "staff",
  "job",
  "quote",
  "invoice",
  "supplier",
  "cost",
  "payment",
];

type Params = Promise<{ orgId: string; id: string }>;
type SP = Promise<{ saved?: string; count?: string; error?: string }>;

export default async function OperatorImportDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  await requireHqPage();
  const { orgId: rawOrg, id: rawId } = await params;
  const orgId = decodeURIComponent(rawOrg);
  const id = decodeURIComponent(rawId);
  const im = await getOperatorImport(orgId, id);
  if (!im) notFound();

  const sp = await searchParams;
  const entities = im.status === "detected" ? await getOperatorImportEntities(orgId, id) : [];

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
        <p className="mt-1 text-sm text-slate-600">
          Operator view. Column remap is staging-only and reversible; commit and rollback
          are not available from this surface.
        </p>
      </header>

      {sp.saved === "remapped" ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Re-mapped {sp.count ?? "0"} row(s).
        </div>
      ) : null}
      {sp.error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {remapErrorMessage(sp.error)}
        </div>
      ) : null}

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

      {im.status === "detected" ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-base font-semibold text-slate-900">Column mapping</h2>
            <p className="mt-1 text-xs text-slate-500">
              For each entity, bind a canonical field to a source column. Leaving a field
              on &quot;(auto)&quot; keeps the detected binding. Remapping is reversible and
              only affects staged rows.
            </p>
          </header>
          <div className="divide-y divide-slate-100">
            {entities.filter((e) => REMAPPABLE.includes(e.entity as EntityType)).length === 0 ? (
              <p className="px-6 py-4 text-sm text-slate-500">No remappable open rows.</p>
            ) : (
              entities
                .filter((e) => REMAPPABLE.includes(e.entity as EntityType))
                .map((e) => <RemapForm key={e.entity} orgId={orgId} importId={im.id} entity={e} />)
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RemapForm({
  orgId,
  importId,
  entity,
}: {
  orgId: string;
  importId: string;
  entity: OperatorImportEntity;
}) {
  const fields = entityFieldNames(entity.entity as EntityType);
  return (
    <form action={operatorRemapColumnsAction} className="px-6 py-4">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="importId" value={importId} />
      <input type="hidden" name="entity" value={entity.entity} />
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize text-slate-900">{entity.entity}</h3>
        <span className="text-xs text-slate-500">{entity.openRows} open row(s)</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-xs text-slate-600">
            {field}
            <select
              name={`map.${field}`}
              defaultValue=""
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            >
              <option value="">(auto)</option>
              {entity.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
      >
        Re-map {entity.entity}
      </button>
    </form>
  );
}

function remapErrorMessage(code: string): string {
  const map: Record<string, string> = {
    pick_entity_type: "Choose an entity type to remap.",
    pick_column: "Choose at least one column to remap.",
    not_reviewable: "This import is no longer in the reviewable (detected) state.",
    not_found: "Import not found for this organisation.",
    bad_id: "Invalid import id.",
    invalid_input: "Invalid request.",
  };
  return map[code] ?? "Remap failed.";
}
