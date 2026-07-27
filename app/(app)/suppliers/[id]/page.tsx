import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { SupplierForm } from "../_form";
import { updateSupplier, deleteSupplier } from "../actions";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { getCisProfile } from "@/server/services/cis";
import { CIS_STATUS_LABELS } from "@/lib/cis/types";
import { verificationFreshness } from "@/lib/cis/verification";

type SupplierRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  category: string | null;
  notes: string | null;
};

type FinanceRow = {
  id: string;
  description: string | null;
  amount: number | null;
  vat_rate: number | null;
  created_at: string;
};

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const ERROR_MAP: Record<string, string> = {
  delete_failed: "Couldn't delete the supplier.",
  bad_id: "Invalid supplier id.",
};

type SP = Promise<{ error?: string }>;

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: supplier } = await (
    supabase.from("suppliers" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: SupplierRow | null }>;
        };
      };
    }
  )
    .select("id, name, email, phone, category, notes")
    .eq("id", id)
    .maybeSingle();

  if (!supplier) notFound();

  const { data: financeData } = await supabase
    .from("finances")
    .select("id, description, amount, vat_rate, created_at" as never)
    .eq("supplier_id" as never, id)
    .order("created_at", { ascending: false })
    .limit(20);

  const finances = ((financeData ?? []) as unknown) as FinanceRow[];

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? null : null;

  // CIS lives behind admin-only RLS, so only owners/admins get the panel at all
  // — a non-admin's read would return null and the link would lead to a refusal.
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const cis = isAdmin ? await getCisProfile(ctx.org.id, id) : null;
  const cisStale =
    cis != null &&
    ["none", "expired"].includes(
      verificationFreshness(
        {
          cis_status: cis.cis_status,
          verified_at: cis.verified_at,
          verification_expires_at: cis.verification_expires_at,
        },
        new Date().toISOString().slice(0, 10),
      ),
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/suppliers" className="hover:text-slate-900">
          Suppliers
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{supplier.name}</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">{supplier.name}</h1>
        {supplier.category ? (
          <p className="mt-1 text-sm text-slate-600">{supplier.category}</p>
        ) : null}
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Edit supplier</h2>
        <SupplierForm
          action={updateSupplier.bind(null, id)}
          submitLabel="Save changes"
          cancelHref="/suppliers"
          defaults={{
            name: supplier.name,
            email: supplier.email ?? "",
            phone: supplier.phone ?? "",
            category: supplier.category ?? "",
            notes: supplier.notes ?? "",
          }}
        />
      </section>

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                CIS subcontractor
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {cis
                  ? `${CIS_STATUS_LABELS[cis.cis_status]}${
                      cis.deduction_rate != null
                        ? ` — ${Number(cis.deduction_rate)}% deduction`
                        : ""
                    }`
                  : "Not set up. Add CIS details if you pay this supplier for construction work."}
              </p>
              {cisStale ? (
                <p className="mt-1 text-xs font-medium text-red-700">
                  Verification needed before the next payment.
                </p>
              ) : null}
            </div>
            <Link
              href={`/suppliers/${id}/cis`}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {cis ? "Manage CIS" : "Set up CIS"}
            </Link>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          Linked expenses ({finances.length})
        </h2>
        {finances.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No expenses linked yet. Approve a draft on{" "}
            <Link href="/expenses" className="font-medium text-slate-900 underline">
              Expenses
            </Link>{" "}
            to attach one.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {finances.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="text-slate-700">{f.description ?? "Expense"}</span>
                <span className="text-slate-500">
                  {f.amount != null ? GBP.format(Number(f.amount)) : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AttachmentsPanel targetTable="suppliers" targetId={id} />

      <form
        action={deleteSupplier.bind(null, id)}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this supplier</p>
        <p className="mt-1 text-xs text-red-700">
          Linked expenses lose their supplier reference but otherwise stay put.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Delete supplier
        </button>
      </form>
    </div>
  );
}
