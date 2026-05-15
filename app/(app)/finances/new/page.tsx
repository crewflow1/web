import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { NewFinanceForm } from "./_form";

/**
 * New finance entry — server wrapper around the client form.
 */
export default async function NewFinancePage() {
  await requireOrgContext();
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/finances" className="hover:text-slate-900">
          Finances
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New finance entry</h1>
        <p className="mt-1 text-sm text-slate-600">
          Record a receipt, earning, or expense. VAT is computed automatically.
        </p>
      </header>

      <NewFinanceForm />
    </div>
  );
}
