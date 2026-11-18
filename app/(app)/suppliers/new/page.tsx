import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadImportDraftDefaults } from "@/server/services/document-autofill";
import { ImportPrefillBanner } from "@/components/import/import-prefill-banner";
import { SupplierForm } from "../_form";
import { createSupplier } from "../actions";
import { requireCapability } from "@/server/auth/capabilities";

export default async function NewSupplierPage({
  searchParams,
}: {
  searchParams: Promise<{ import?: string }>;
}) {
  // Page-level copy of the segment gate: a layout's gate does not stop this
  // page from rendering in parallel, so the page enforces it before any data.
  await requireCapability("suppliers", "view");
  await requireOrgContext();

  const sp = await searchParams;
  const prefill = sp.import ? await loadImportDraftDefaults("supplier", sp.import) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/suppliers" className="hover:text-slate-900">
          Suppliers
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>
      <h1 className="text-2xl font-bold text-slate-900">Add supplier</h1>
      {prefill ? <ImportPrefillBanner engine={prefill.engine} recordLabel="supplier" /> : null}
      <SupplierForm
        action={createSupplier}
        submitLabel="Save supplier"
        cancelHref="/suppliers"
        defaults={prefill?.fields}
      />
    </div>
  );
}
