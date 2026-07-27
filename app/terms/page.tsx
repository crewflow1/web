import type { Metadata } from "next";
import { LegalShell } from "@/app/_components/legal-shell";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The rules of using CrewFlow. Written for UK construction operators in plain English.",
  alternates: { canonical: "/terms" },
};

/**
 * Terms of service.
 *
 * Plain-English baseline terms. Substantive enough to ship publicly, not a
 * substitute for legal advice. Operators with bespoke procurement
 * requirements should contact hello@crewflow.uk for a side letter.
 */
export default function TermsPage() {
  return (
    <LegalShell
      title="Terms of service"
      intro="The rules of using CrewFlow — what we promise to do, what we ask of you."
      lastUpdated="2026-05-21"
    >
      <h2>The agreement</h2>
      <p>
        These terms govern your use of CrewFlow. By signing up or accepting
        an invite to a workspace, you agree to them. CrewFlow is operated
        from Belfast, Northern Ireland. The agreement is governed by the
        laws of Northern Ireland.
      </p>

      <h2>Your workspace</h2>
      <p>
        A workspace belongs to an <strong>organisation</strong> (your
        construction company). One person — the owner — is responsible for
        billing and for who else has access. Admins can invite or remove
        staff. Staff can use the product within the permissions the
        organisation grants. Don&apos;t share your sign-in with anyone:
        each person should have their own account.
      </p>

      <h2>What you can use it for</h2>
      <p>
        CrewFlow is built for UK construction companies to run their
        operations — leads, quotes, jobs, staff, payroll, invoices, and
        payments. You can use it for any lawful business purpose that fits
        that shape.
      </p>

      <h2>What you can&apos;t use it for</h2>
      <ul>
        <li>Anything illegal under UK law.</li>
        <li>Sending unsolicited bulk email or messages from your account.</li>
        <li>
          Storing data you have no lawful right to process (e.g. customer
          data scraped from another company&apos;s systems).
        </li>
        <li>
          Reverse-engineering the product, scraping it, or running automated
          attacks against it. If you&apos;re a security researcher, email{" "}
          <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a> first;
          we&apos;re happy to authorise responsible testing.
        </li>
      </ul>

      <h2>Your data</h2>
      <p>
        Everything you enter — customers, quotes, invoices, photos,
        anything — is yours. We hold it on your behalf to provide the
        service. You can export it (CSV) or ask for a full database export
        at any time by emailing us. When you cancel, we delete it within 30
        days, except where tax law (HMRC) obliges us to retain it.
      </p>
      <p>
        See the <a href="/privacy">privacy policy</a> for the full picture
        of how we handle data.
      </p>

      <h2>Uptime &amp; support</h2>
      <p>
        We aim for 99.9% monthly uptime. We don&apos;t currently offer a
        contractual SLA — if that&apos;s a procurement requirement, email{" "}
        <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a> and
        we&apos;ll talk. Support is via email; we aim to respond within one
        UK business day.
      </p>

      <h2>Billing</h2>
      <p>
        Pricing is shown on the product&apos;s pricing page at sign-up.
        Subscriptions auto-renew unless you cancel before the renewal date.
        We won&apos;t lock you out of your data if a payment fails — your
        workspace becomes read-only first, and you have 30 days to pay or
        export before access is suspended.
      </p>
      <p>
        VAT is charged where applicable. Refunds are issued for unused
        prepaid time when you cancel; pro-rata.
      </p>

      <h2>Money flowing through CrewFlow</h2>
      <p>
        CrewFlow records invoices and payments — it isn&apos;t the
        merchant of record for any money your customers pay you. We
        don&apos;t hold client funds. Bank details you show on invoices
        and quotes are yours; you&apos;re responsible for keeping them
        accurate.
      </p>
      <p>
        Payroll figures (PAYE, NI) are <strong>estimates</strong> based on
        the hours logged. Use them as a starting point — your accountant or
        payroll bureau is the source of truth for what actually gets paid
        to HMRC.
      </p>

      <h2>Changes to the service</h2>
      <p>
        We add features, fix bugs, and occasionally retire things that
        aren&apos;t earning their keep. If we remove something you rely on,
        we&apos;ll email account owners at least 30 days before it goes
        away.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent permitted by law, our liability for any claim arising
        from these terms or your use of the product is limited to the
        amount you&apos;ve paid us in the 12 months before the claim. We
        don&apos;t exclude liability for fraud, death, personal injury
        caused by negligence, or anything else that can&apos;t be excluded
        under UK law.
      </p>

      <h2>Termination</h2>
      <p>
        You can cancel at any time from the settings page or by emailing
        us. We can suspend or terminate accounts that breach these terms
        (especially the &ldquo;what you can&apos;t use it for&rdquo; list)
        with reasonable notice — immediately if the breach is severe or
        illegal.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        If we change these terms, we&apos;ll email account owners at least
        30 days before the change takes effect. Continued use after that
        date is acceptance of the new terms. If you don&apos;t accept
        them, cancel before the effective date and we&apos;ll refund any
        unused prepaid time.
      </p>

      <h2>Contact</h2>
      <p>
        Email <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a>{" "}
        for anything — billing, support, procurement, complaints.
      </p>
    </LegalShell>
  );
}
