import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { FadeIn } from "@/components/ui";

/**
 * Pre-launch QA checklist — internal page for owners verifying every
 * end-to-end flow before going public. Not linked from the landing.
 * Each row is a self-test instruction with a link straight to where
 * the work happens.
 */

type Step = { label: string; href?: string; sub?: string };
type Flow = { title: string; steps: Step[]; tldr: string };

const FLOWS: Flow[] = [
  {
    title: "Lead → Quote → Approval → Job → Invoice → Reminder → Paid",
    tldr: "The main commercial loop. End-to-end.",
    steps: [
      { label: "Create a lead", href: "/leads/new", sub: "name, source, service, urgency" },
      { label: "Convert to quote (or create from scratch)", href: "/quotes/new", sub: "line items + VAT" },
      { label: "Request approval", href: "/quotes", sub: "moves status → pending_approval" },
      { label: "Approve as owner", href: "/quotes?status=pending_approval" },
      { label: "Send quote to customer", href: "/quotes", sub: "branded PDF via email" },
      { label: "Customer accepts via portal", sub: "auto-creates an invoice" },
      { label: "Verify invoice exists", href: "/invoices?status=sent" },
      { label: "Send reminder (or wait for auto-reminder day 3/7/14/21)", href: "/invoices" },
      { label: "Upload bank CSV with the payment", href: "/payments", sub: "auto-match suggestion ≥ 70%" },
      { label: "Confirm match", href: "/payments", sub: "trigger flips invoice to paid" },
      { label: "Check dashboard cashflow tile reflects the payment", href: "/dashboard" },
    ],
  },
  {
    title: "Staff → Rota → Clock in → Payroll",
    tldr: "The field-ops loop. Hours feed payroll which feeds tax.",
    steps: [
      { label: "Invite a staff member", href: "/staff", sub: "by email; they must already exist as a user" },
      { label: "Add a rota entry assigning a job", href: "/staff" },
      { label: "Sign in as that staff member", sub: "incognito; staff role gets /me-scoped sidebar" },
      { label: "Clock in on /me", href: "/me", sub: "pick a job, hit the green button" },
      { label: "Start + end a break", href: "/me" },
      { label: "Clock out", href: "/me" },
      { label: "Back as owner — generate a weekly payroll run", href: "/payroll" },
      { label: "Download CSV + payslip PDF", href: "/payroll", sub: "1 PDF per staff member" },
      { label: "Finalise the run", sub: "locks the time entries" },
      { label: "Verify /tax PAYE tile shows real numbers", href: "/tax" },
    ],
  },
  {
    title: "Import → Review → Commit → Rollback",
    tldr: "Migration OS end-to-end including reversibility.",
    steps: [
      { label: "Open the wizard", href: "/imports" },
      { label: "Upload a CSV of customers", sub: "name + email + phone columns" },
      { label: "Check detection summary shows ≥80% confidence" },
      { label: "Preview the first 50 rows", sub: "duplicates flagged amber" },
      { label: "Commit", sub: "rows insert + audit log entries written" },
      { label: "Verify rows visible in /customers" },
      { label: "Roll back via the wizard or audit page", sub: "imported rows deleted" },
      { label: "Verify /customers no longer shows the rolled-back rows" },
    ],
  },
  {
    title: "Customer → Portal → Quote / Invoice",
    tldr: "The customer-facing surface for non-CrewFlow users.",
    steps: [
      { label: "Pick a customer", href: "/customers" },
      { label: "Generate or rotate their portal token" },
      { label: "Open the portal URL in an incognito window" },
      { label: "Verify quotes + invoices listed", sub: "no auth required, portal token is the secret" },
      { label: "Verify partial-paid invoice shows paid-so-far + outstanding" },
    ],
  },
  {
    title: "Profitability → Tax",
    tldr: "Owner truth-of-the-business view.",
    steps: [
      { label: "Open dashboard", href: "/dashboard" },
      { label: "Confirm profit-by-month chart pulls last 6 months" },
      { label: "Confirm margin pills show green/amber/red bands" },
      { label: "Open /tax", href: "/tax" },
      { label: "Confirm VAT quarter tile has 'computed' confidence" },
      { label: "Download quarterly VAT PDF", sub: "totals + every paid invoice + finance row" },
      { label: "Confirm Corp Tax tile uses the correct rate band (19/marginal/25%)" },
    ],
  },
];

export default async function QaPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) {
    return (
      <p className="text-sm text-slate-700">
        QA checklist is admin-only.
      </p>
    );
  }

  return (
    <FadeIn className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Pre-launch QA checklist</h1>
        <p className="mt-1 text-sm text-slate-600">
          Walk every loop before you flip the marketing switch. Tick the
          boxes mentally as you go. Anything broken belongs in the bug
          tracker, not your launch announcement.
        </p>
      </header>

      <ol className="space-y-6">
        {FLOWS.map((flow, i) => (
          <li key={flow.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-900">
                {i + 1}. {flow.title}
              </h2>
              <span className="text-xs text-slate-500">{flow.tldr}</span>
            </div>
            <ol className="mt-4 space-y-2">
              {flow.steps.map((s, j) => (
                <li key={j} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 text-[10px] font-medium text-slate-500">
                    {j + 1}
                  </span>
                  <div className="min-w-0">
                    {s.href ? (
                      <Link href={s.href} className="font-medium text-slate-900 hover:underline">
                        {s.label}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-900">{s.label}</span>
                    )}
                    {s.sub ? (
                      <span className="ml-2 text-xs text-slate-500">— {s.sub}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h2 className="text-base font-semibold">Known production-readiness gaps</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            AI receptionist + missed-call SMS — not built yet. Marketing
            should not promise this until shipped.
          </li>
          <li>
            CRM social integrations (Instagram DM, Facebook Messenger,
            WhatsApp inbound) — not built.
          </li>
          <li>
            Staff invites from Migration OS send the Supabase magic-link
            but don&apos;t auto-create the membership row — recipient lands
            on /onboarding/company and the owner approves there.
          </li>
          <li>
            NI numbers live in a separate `staff_secrets` table with
            admin-only RLS and a UK-format check constraint. Displayed
            masked (AB****56C) in payroll tables; full value visible
            only on the admin-downloaded payslip PDF + CSV.
          </li>
          <li>
            PAYE/NI estimator assumes 1257L tax code + UK 2025-26 thresholds.
            No K-codes, Scottish bands, or student loan deductions.
          </li>
        </ul>
      </section>
    </FadeIn>
  );
}
