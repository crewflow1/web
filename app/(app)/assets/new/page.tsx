import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  ASSET_CATEGORY_SUGGESTIONS,
  ASSET_OWNERSHIPS,
  ASSET_OWNERSHIP_LABELS,
} from "@/lib/assets/schema";
import { createAsset } from "../actions";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the asset. Try again.",
  validation: "Please check the form and try again.",
};

type SP = Promise<{ error?: string }>;

export default async function NewAssetPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  // `suppliers` is not in the generated Supabase types — cast like the other
  // post-types tables. Pinned to the active org: RLS returns every org the
  // viewer belongs to, which would blend another org's suppliers into this
  // picker for a dual-org member.
  const { data: suppliersRaw, error: suppliersError } = await (
    supabase.from("suppliers" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            col: string,
            o: { ascending: boolean },
          ) => {
            limit: (
              n: number,
            ) => Promise<{ data: { id: string; name: string }[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("id, name")
    .eq("org_id", ctx.org.id)
    .order("name", { ascending: true })
    .limit(500);
  if (suppliersError) throw readFailure("new asset: supplier picker", suppliersError);
  const suppliers = suppliersRaw ?? [];

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;

  const field =
    "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
  const label = "block text-sm font-medium text-slate-800";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/assets" className="hover:text-slate-900">Assets</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Add an asset</h1>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <form action={createAsset} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <label htmlFor="name" className={label}>
            Name<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input id="name" name="name" type="text" required autoFocus placeholder="Kubota KX016-4 mini excavator" className={field} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="category" className={label}>Category</label>
            <input id="category" name="category" list="asset-categories" placeholder="Plant / machinery" className={field} />
            <datalist id="asset-categories">
              {ASSET_CATEGORY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="ownership" className={label}>Ownership</label>
            <select id="ownership" name="ownership" defaultValue="owned" className={field}>
              {ASSET_OWNERSHIPS.map((o) => (
                <option key={o} value={o}>{ASSET_OWNERSHIP_LABELS[o]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="manufacturer" className={label}>Manufacturer</label>
            <input id="manufacturer" name="manufacturer" type="text" placeholder="Kubota" className={field} />
          </div>
          <div>
            <label htmlFor="model" className={label}>Model</label>
            <input id="model" name="model" type="text" placeholder="KX016-4" className={field} />
          </div>
          <div>
            <label htmlFor="serial_number" className={label}>Serial number</label>
            <input id="serial_number" name="serial_number" type="text" className={field} />
          </div>
          <div>
            <label htmlFor="registration" className={label}>Registration</label>
            <input id="registration" name="registration" type="text" placeholder="AB12 CDE" className={field} />
          </div>
          <div>
            <label htmlFor="asset_ref" className={label}>Your reference</label>
            <input id="asset_ref" name="asset_ref" type="text" placeholder="Fleet no. 14" className={field} />
          </div>
          <div>
            <label htmlFor="supplier_id" className={label}>Supplier / hire company</label>
            <select id="supplier_id" name="supplier_id" defaultValue="" className={field}>
              <option value="">None</option>
              {(suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="grid gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">Finance</legend>
          <div>
            <label htmlFor="purchase_date" className={label}>Purchase date</label>
            <input id="purchase_date" name="purchase_date" type="date" className={field} />
          </div>
          <div>
            <label htmlFor="purchase_price" className={label}>Purchase price £</label>
            <input id="purchase_price" name="purchase_price" type="number" min={0} step="0.01" className={field} />
          </div>
          <div>
            <label htmlFor="current_value" className={label}>Current value £</label>
            <input id="current_value" name="current_value" type="number" min={0} step="0.01" className={field} />
          </div>
          <div>
            <label htmlFor="warranty_expires_at" className={label}>Warranty expiry</label>
            <input id="warranty_expires_at" name="warranty_expires_at" type="date" className={field} />
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">Hire (if hired)</legend>
          <div>
            <label htmlFor="hire_start" className={label}>Hire start</label>
            <input id="hire_start" name="hire_start" type="date" className={field} />
          </div>
          <div>
            <label htmlFor="hire_end" className={label}>Hire end</label>
            <input id="hire_end" name="hire_end" type="date" className={field} />
          </div>
          <div>
            <label htmlFor="hire_rate" className={label}>Hire rate £</label>
            <input id="hire_rate" name="hire_rate" type="number" min={0} step="0.01" className={field} />
          </div>
        </fieldset>

        <div>
          <label htmlFor="notes" className={label}>Notes</label>
          <textarea id="notes" name="notes" rows={3} className={field} />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Add asset
          </button>
          <Link href="/assets" className="text-sm font-medium text-slate-600 hover:text-slate-900">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
