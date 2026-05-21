import type { Metadata } from "next";
import { LegalShell } from "@/app/_components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "How CrewFlow collects, uses, and protects your data. Built for UK construction companies and governed by UK GDPR.",
};

/**
 * Privacy policy.
 *
 * Static, server-rendered. Plain English over legalese — the audience is
 * UK trades operators, not their solicitors. Substantive but not a
 * substitute for legal advice; we point operators at hello@crewflow.uk
 * for clarifications.
 */
export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy policy"
      intro="What we collect, why we collect it, and how we keep it safe."
      lastUpdated="2026-05-21"
    >
      <h2>Who we are</h2>
      <p>
        CrewFlow is operated from Belfast, Northern Ireland. We provide
        software for UK construction companies to manage leads, quotes, jobs,
        staff, payroll, invoices, and payments. When this policy says
        &ldquo;we&rdquo; or &ldquo;CrewFlow&rdquo;, that&apos;s us. When it
        says &ldquo;you&rdquo;, it means anyone using the product — owners,
        admins, staff, and the customers our users send quotes or invoices
        to.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> — your email, name, phone (optional),
          and the organisation you belong to. Stored when you sign up or are
          invited to a CrewFlow workspace.
        </li>
        <li>
          <strong>Business data you enter</strong> — customers, leads, jobs,
          quotes, invoices, payments, time entries, payroll runs, and any
          notes or files you attach. This is your data; we hold it to
          provide the service.
        </li>
        <li>
          <strong>Customer-facing data</strong> — when an end customer opens
          a quote link or signs in to the customer portal, we record the
          fact that the link was opened (timestamp + a hashed IP for audit).
          We do not sell or share this with anyone.
        </li>
        <li>
          <strong>Operational telemetry</strong> — error reports and
          performance traces via Sentry, and aggregate product analytics via
          PostHog. These are used to keep the product reliable and to
          improve it. We don&apos;t use them for advertising.
        </li>
      </ul>

      <h2>What we don&apos;t do</h2>
      <ul>
        <li>We don&apos;t sell your data. Ever.</li>
        <li>
          We don&apos;t use customer-facing data (the quote/invoice/portal
          links) to market anything to your end customers. They&apos;re your
          customers, not ours.
        </li>
        <li>
          We don&apos;t run third-party advertising trackers on the product
          (the CrewFlow app, the customer portal, or the public quote
          pages).
        </li>
      </ul>

      <h2>Where it&apos;s stored</h2>
      <p>
        Primary storage is Supabase (PostgreSQL), hosted in the European
        Union. Backups are encrypted at rest. File uploads (receipts,
        photos) live in Supabase Storage with the same regional scope.
        Operational telemetry goes to Sentry and PostHog under their
        respective DPAs.
      </p>

      <h2>Who can see your data</h2>
      <p>
        Row-Level Security on every table enforces that members of one
        organisation can&apos;t see another&apos;s rows. Customer-facing
        share links (the <code>/q/&lt;token&gt;</code> quote portal and the{" "}
        <code>/customer-portal/&lt;token&gt;</code> hub) use long random
        tokens — anyone with the token sees the data; the contractor can
        rotate the token to revoke access at any time.
      </p>
      <p>
        Internally, only the on-call engineer can access production
        infrastructure, and access is logged. We don&apos;t look at your
        business data unless you ask us to (e.g. to debug an issue).
      </p>

      <h2>Cookies</h2>
      <p>
        We use a small number of essential cookies:
      </p>
      <ul>
        <li>
          A Supabase auth session cookie so you stay signed in. Strictly
          necessary; cannot be disabled while using the product.
        </li>
        <li>
          A PostHog session ID for product analytics. You can opt out via
          your browser&apos;s do-not-track setting, which we honour.
        </li>
      </ul>
      <p>
        The customer portal and public quote pages do not set tracking
        cookies for end customers.
      </p>

      <h2>Your rights under UK GDPR</h2>
      <p>
        You can ask us to (a) confirm what data we hold about you,
        (b) provide a copy, (c) correct anything that&apos;s wrong, or
        (d) delete it (subject to lawful retention obligations, like tax
        records). Email{" "}
        <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a> and we
        aim to respond within 14 days. You also have the right to lodge a
        complaint with the Information Commissioner&apos;s Office (ICO)
        at <a href="https://ico.org.uk">ico.org.uk</a>.
      </p>

      <h2>Retention</h2>
      <p>
        Active workspaces retain data for as long as the account exists.
        When you delete a workspace, we delete the business data within
        30 days. Operational logs (Sentry, Supabase audit) roll off on a
        90-day window. Where UK tax law requires us to retain certain
        records (e.g. invoice metadata for HMRC), we&apos;ll do so for the
        statutory period and no longer.
      </p>

      <h2>Changes</h2>
      <p>
        We&apos;ll update this page when the product or the law changes.
        Material changes are emailed to account owners ahead of taking
        effect.
      </p>

      <h2>Contact</h2>
      <p>
        Email <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a>{" "}
        for anything — data requests, complaints, or questions.
      </p>
    </LegalShell>
  );
}
