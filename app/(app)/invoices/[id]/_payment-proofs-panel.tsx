import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { PaymentProofRow, type PaymentProof } from "./_payment-proofs-client";

/**
 * Customer-submitted payment proofs for one invoice — the staff half.
 *
 * The customer half already shipped: the portal uploads a proof into
 * `portal_uploads` + the private `portal-uploads` bucket and reads it back on
 * the customer's invoices page, telling them the org "will confirm here once
 * it's matched to your payment". Nothing on the staff side read that table, so
 * the proof reached no one who could act on it. This closes that loop by
 * surfacing the proofs right above the payments panel, where the matching
 * decision is actually made.
 *
 * Strictly read-only. `portal_uploads` remains the one authoritative owner of
 * the proof record, and `invoice_payments` (via <PaymentsPanel>) remains the
 * sole authority on payment state — viewing a proof never mutates either, and
 * no payment/upload logic is re-derived here.
 *
 * SECURITY: `portal_uploads` has RLS enabled with NO policies (service-role
 * only), so this must run on the RLS-BYPASSING admin client. The `org_id`
 * filter is therefore the ONLY thing enforcing organisation isolation and must
 * never be removed. `target_table` + `target_id` + `kind` narrow to this
 * invoice's payment proofs — the same five filters the customer-side read
 * uses, so neither side can drift into a wider scope.
 *
 * Server component: fetched per page load, so it reflects proofs that arrive
 * after the page was first rendered.
 */

export async function PaymentProofsPanel({ invoiceId }: { invoiceId: string }) {
  const { ctx } = await requireOrgContext();
  const admin = createAdminClient();

  // `portal_uploads` isn't in the generated Supabase types — cast exactly like
  // the portal read/write sides do.
  type ProofQuery = {
    eq: (k: string, v: unknown) => ProofQuery;
    order: (
      k: string,
      opts: { ascending: boolean },
    ) => {
      limit: (n: number) => Promise<{
        data: PaymentProof[] | null;
        error: { message: string } | null;
      }>;
    };
  };
  const { data } = await (
    admin.from("portal_uploads" as never) as unknown as {
      select: (cols: string) => ProofQuery;
    }
  )
    .select("id, filename, mime_type, size_bytes, notes, uploaded_at")
    .eq("org_id", ctx.org.id)
    .eq("target_table", "invoices")
    .eq("target_id", invoiceId)
    .eq("kind", "payment_proof")
    .order("uploaded_at", { ascending: false })
    .limit(50);

  const proofs = data ?? [];

  // Graceful degradation: no proof (or an unavailable read) renders nothing
  // rather than an empty box competing with the payments panel — mirroring the
  // customer side, which likewise only renders the section when a proof exists.
  if (proofs.length === 0) return null;

  return (
    <section
      aria-labelledby={`payment-proofs-${invoiceId}`}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2
        id={`payment-proofs-${invoiceId}`}
        className="text-sm font-semibold text-slate-900"
      >
        Customer payment proof ({proofs.length})
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Sent by the customer through their portal. Open it to check the payment,
        then record it below — this list is a record of what they sent, not a
        payment.
      </p>
      <ul className="mt-2 divide-y divide-slate-100">
        {proofs.map((proof) => (
          <PaymentProofRow key={proof.id} proof={proof} />
        ))}
      </ul>
    </section>
  );
}
