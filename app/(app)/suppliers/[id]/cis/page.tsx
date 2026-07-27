import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { getCisProfile } from "@/server/services/cis";
import {
  CIS_STATUS_DESCRIPTIONS,
  CIS_STATUS_LABELS,
  SUBCONTRACTOR_TYPE_LABELS,
  type CisStatus,
  type VerificationFreshness,
} from "@/lib/cis/types";
import {
  deriveVerificationExpiry,
  maskUtr,
  verificationFreshness,
} from "@/lib/cis/verification";
import {
  CisProfileForm,
  CisReverificationForm,
  CisVerificationForm,
} from "./_forms";
import {
  saveCisProfile,
  saveCisVerification,
  requestCisReverification,
} from "./actions";

/**
 * CIS subcontractor profile — the admin surface for a supplier's Construction
 * Industry Scheme identity and HMRC verification state.
 *
 * ADMIN ONLY. Non-admins are shown a plain refusal rather than an empty form:
 * `cis_subcontractors` RLS returns them nothing, so rendering the form would
 * silently fail on submit.
 *
 * THE UTR IS NEVER RENDERED IN FULL, and there is deliberately NO reveal
 * control. See the note on the masked line below.
 */

type SupplierRow = { id: string; name: string };

const FRESHNESS_STYLES: Record<VerificationFreshness, string> = {
  current: "border-emerald-200 bg-emerald-50 text-emerald-800",
  expiring_soon: "border-amber-200 bg-amber-50 text-amber-900",
  expired: "border-red-200 bg-red-50 text-red-800",
  none: "border-slate-200 bg-slate-50 text-slate-700",
};

function freshnessNote(
  freshness: VerificationFreshness,
  expiry: string | null,
): string {
  switch (freshness) {
    case "current":
      return expiry ? `Valid until ${formatDate(expiry)}.` : "Verification is current.";
    case "expiring_soon":
      return expiry
        ? `Expires ${formatDate(expiry)} — re-verify soon.`
        : "Expiring soon — re-verify.";
    case "expired":
      return expiry
        ? `Expired ${formatDate(expiry)}. Re-verify before the next payment.`
        : "Verification has expired. Re-verify before the next payment.";
    case "none":
      return "No current verification. Verify with HMRC before paying them.";
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export default async function SupplierCisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
    .select("id, name")
    .eq("id", id)
    .maybeSingle();

  if (!supplier) notFound();

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const crumb = (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
      <Link href="/suppliers" className="hover:text-slate-900">
        Suppliers
      </Link>
      <span aria-hidden>/</span>
      <Link href={`/suppliers/${id}`} className="hover:text-slate-900">
        {supplier.name}
      </Link>
      <span aria-hidden>/</span>
      <span className="text-slate-900">CIS</span>
    </div>
  );

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {crumb}
        <header>
          <h1 className="text-2xl font-bold text-slate-900">CIS subcontractor</h1>
        </header>
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Only an owner or admin can view CIS details. They include tax identifiers, so
          they are kept off the general supplier record.
        </div>
      </div>
    );
  }

  const profile = await getCisProfile(ctx.org.id, id);
  const today = new Date().toISOString().slice(0, 10);

  const status: CisStatus = profile?.cis_status ?? "unverified";
  const freshness = profile
    ? verificationFreshness(
        {
          cis_status: profile.cis_status,
          verified_at: profile.verified_at,
          verification_expires_at: profile.verification_expires_at,
        },
        today,
      )
    : "none";
  const effectiveExpiry =
    profile?.verification_expires_at ?? deriveVerificationExpiry(profile?.verified_at ?? null);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {crumb}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">CIS subcontractor</h1>
          <p className="mt-1 text-sm text-slate-600">{supplier.name}</p>
        </div>
      </header>

      {/* ── Status summary ─────────────────────────────────────────────── */}
      <section className={`rounded-xl border p-4 shadow-sm ${FRESHNESS_STYLES[freshness]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-semibold">{CIS_STATUS_LABELS[status]}</h2>
          <p className="text-2xl font-bold tabular-nums">
            {profile?.deduction_rate != null ? `${Number(profile.deduction_rate)}%` : "—"}
            <span className="ml-1 text-xs font-medium opacity-80">deduction</span>
          </p>
        </div>
        <p className="mt-2 text-sm">{CIS_STATUS_DESCRIPTIONS[status]}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="font-medium opacity-70">Verified</dt>
            <dd className="tabular-nums">{formatDate(profile?.verified_at ?? null)}</dd>
          </div>
          <div>
            <dt className="font-medium opacity-70">Expires</dt>
            <dd className="tabular-nums">{formatDate(effectiveExpiry)}</dd>
          </div>
          <div>
            <dt className="font-medium opacity-70">HMRC reference</dt>
            <dd className="break-all">{profile?.verification_reference ?? "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs font-medium">{freshnessNote(freshness, effectiveExpiry)}</p>
      </section>

      {/* ── Held identifiers ───────────────────────────────────────────── */}
      {profile ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">On record</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-slate-500">Legal name</dt>
              <dd className="text-slate-900">{profile.legal_name}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Legal form</dt>
              <dd className="text-slate-900">
                {profile.subcontractor_type
                  ? SUBCONTRACTOR_TYPE_LABELS[profile.subcontractor_type]
                  : "—"}
              </dd>
            </div>
            <div>
              {/*
                MASKED, AND THERE IS NO REVEAL CONTROL.
                A reveal was considered and rejected: no operator task in M1 needs
                the full UTR on screen. It is needed only by the M4/M5 statement
                and monthly-return generators, which read it server-side. Adding a
                reveal would ship the most sensitive identifier we hold to the
                browser — and put it in screenshots and screen shares — to solve a
                problem nobody has. The masked form is enough to confirm the right
                record; to correct a wrong one you retype it. `staff_secrets` has
                no reveal either, for the same reason.
              */}
              <dt className="text-xs font-medium text-slate-500">UTR</dt>
              <dd className="font-mono tabular-nums text-slate-900">
                {maskUtr(profile.utr)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Company number</dt>
              <dd className="font-mono text-slate-900">{profile.company_number ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">VAT</dt>
              <dd className="text-slate-900">
                {profile.vat_registered ? profile.vat_number ?? "Registered" : "Not registered"}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {/* ── Verification ───────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Record a verification</h2>
        <p className="mt-1 text-xs text-slate-500">
          CrewFlow does not contact HMRC. Verify the subcontractor using HMRC&apos;s CIS
          online service or the CIS helpline, then record what they told you here.
        </p>
        <div className="mt-4">
          {profile ? (
            <CisVerificationForm
              action={saveCisVerification.bind(null, id)}
              currentStatus={status}
              defaultDate={today}
              hasUtr={Boolean(profile.utr)}
            />
          ) : (
            <p className="text-sm text-slate-600">
              Save the CIS details below first.
            </p>
          )}
        </div>
      </section>

      {profile && status !== "unverified" && status !== "verification_required" ? (
        <CisReverificationForm action={requestCisReverification.bind(null, id)} />
      ) : null}

      {/* ── Identity ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">CIS details</h2>
        <CisProfileForm
          action={saveCisProfile.bind(null, id)}
          maskedUtr={maskUtr(profile?.utr ?? null)}
          hasUtr={Boolean(profile?.utr)}
          defaults={{
            legal_name: profile?.legal_name ?? supplier.name,
            trading_name: profile?.trading_name ?? "",
            company_number: profile?.company_number ?? "",
            subcontractor_type: profile?.subcontractor_type ?? "",
            vat_registered: profile?.vat_registered ?? false,
            vat_number: profile?.vat_number ?? "",
            notes: profile?.notes ?? "",
          }}
        />
      </section>
    </div>
  );
}
