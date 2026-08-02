/**
 * H2-CIS M5 — emailing a subcontractor their payment & deduction statement, as
 * pure planning.
 *
 * PURE. No Supabase, no server-only, no network. The DB reads, the queue writes
 * and the actual Resend send all live in server/services/cis-statement-emails.ts
 * and the existing notification-email drain; this module only decides WHAT to
 * queue and computes the deterministic idempotency key, so both the decision and
 * the dedupe are unit-testable without a database.
 *
 * ── WHAT "EMAILING A STATEMENT" IS, AND IS NOT ──────────────────────────────
 * Giving a subcontractor their payment and deduction statement is a CONTRACTOR
 * OBLIGATION (CIS340 3.15 / CISR12160), owed directly to the subcontractor —
 * NOT a filing with HMRC. CrewFlow still files nothing. This puts the document
 * the subcontractor is owed into the existing outbound email queue; it reaches
 * HMRC through no path here.
 *
 * ── ONLY STATUTORY, ONLY ISSUED ─────────────────────────────────────────────
 * A statement is compelled only where a deduction was made (`is_statutory`); a
 * gross-paid subcontractor's statement is "good practice ... but there is no
 * obligation" (CIS340 3.15), so it is NOT auto-emailed. Superseded and withdrawn
 * statements are never emailed — the subcontractor is owed the current document,
 * not a retracted one. The plan records every exclusion with its reason so the
 * caller surfaces it rather than dropping statements silently.
 *
 * ── IDEMPOTENCY: ONE EMAIL PER STATEMENT ────────────────────────────────────
 * A statement is emailed at most once. The key is the statement NUMBER, which is
 * unique per org, immutable, and changes on reissue — so a reissued (corrected)
 * statement is a NEW number and is correctly emailed again, while re-running the
 * action over an unchanged month queues nothing new. The key is carried in the
 * queue row's `subject` (see `cisStatementEmailSubject`), and the caller passes
 * the set of subjects already queued for this org as `existingKeys`; anything
 * already present is skipped. (Dedupe against the existing queue rather than a
 * new table because this train is zero-migration — see the service for the
 * residual-race note.)
 */

/** The statement fields the emailing plan reads. */
export type CisStatementForEmail = {
  id: string;
  supplier_id: string;
  statement_number: string;
  status: "issued" | "superseded" | "withdrawn";
  subcontractor_name: string;
  contractor_name: string;
  contractor_paye_reference: string;
  tax_month_start: string;
  tax_month_end: string;
  statement_due_on: string;
  gross_amount: number | string;
  materials_amount: number | string;
  deduction_amount: number | string;
  rate_is_uniform: boolean;
  deduction_rate: number | string | null;
  is_statutory: boolean;
};

/**
 * The stable subject line, which doubles as the idempotency key. The statement
 * NUMBER makes it unique per org and stable across re-runs; the prefix lets the
 * service fetch every already-queued CIS statement email with one `like` query.
 */
export const CIS_STATEMENT_EMAIL_SUBJECT_PREFIX =
  "Your CIS payment and deduction statement";

export function cisStatementEmailSubject(statementNumber: string): string {
  return `${CIS_STATEMENT_EMAIL_SUBJECT_PREFIX} ${statementNumber}`;
}

/** Frozen money → "£1,234.50" for the body copy. Local to avoid an I/O import. */
function gbp(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return `£${safe.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The plain-text body a subcontractor receives. Built ENTIRELY from the frozen
 * statement — no live re-read, no recomputation. Deliberately restates the
 * figures HMRC requires on the statement (gross ex-VAT, materials, deduction)
 * and points to the tax month and deadline. It does NOT claim anything was filed.
 */
export function cisStatementEmailBody(s: CisStatementForEmail): string {
  const rate = s.rate_is_uniform
    ? `${gbp(s.deduction_rate).replace("£", "")}% deduction rate`
    : "rate varied within the month";
  return [
    `Dear ${s.subcontractor_name},`,
    ``,
    `Please find your CIS payment and deduction statement (${s.statement_number}) ` +
      `from ${s.contractor_name} for the tax month ${s.tax_month_start} to ${s.tax_month_end}.`,
    ``,
    `Gross amount paid (excluding VAT): ${gbp(s.gross_amount)}`,
    `Cost of materials: ${gbp(s.materials_amount)}`,
    `Amount deducted under CIS: ${gbp(s.deduction_amount)}`,
    `Rate: ${rate}`,
    ``,
    `Contractor: ${s.contractor_name} (Employer PAYE reference ${s.contractor_paye_reference})`,
    ``,
    `Keep this statement — you use it to claim the CIS deduction back. ` +
      `This is your payment and deduction statement, not a submission to HMRC.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type CisStatementEmailToQueue = {
  statementId: string;
  supplierId: string;
  statementNumber: string;
  toEmail: string;
  subject: string;
  body: string;
};

export type CisStatementEmailSkip = {
  statementId: string;
  supplierId: string;
  statementNumber: string;
  reason: "not_issued" | "not_statutory" | "no_email" | "already_queued";
};

export type CisStatementEmailPlan = {
  toQueue: CisStatementEmailToQueue[];
  skipped: CisStatementEmailSkip[];
};

/**
 * Decide which statements to queue for emailing, and why the rest are skipped.
 *
 * Deterministic and side-effect-free. `emailBySupplier` maps supplier_id → the
 * subcontractor's email (trimmed, non-empty). `existingKeys` is the set of email
 * subjects already queued for this org — the idempotency guard.
 */
export function planStatementEmails(input: {
  statements: readonly CisStatementForEmail[];
  emailBySupplier: ReadonlyMap<string, string>;
  existingKeys: ReadonlySet<string>;
}): CisStatementEmailPlan {
  const toQueue: CisStatementEmailToQueue[] = [];
  const skipped: CisStatementEmailSkip[] = [];

  for (const s of input.statements) {
    const base = {
      statementId: s.id,
      supplierId: s.supplier_id,
      statementNumber: s.statement_number,
    };

    if (s.status !== "issued") {
      skipped.push({ ...base, reason: "not_issued" });
      continue;
    }
    if (!s.is_statutory) {
      // Gross-paid: statement is good practice, not compelled — never auto-sent.
      skipped.push({ ...base, reason: "not_statutory" });
      continue;
    }

    const email = input.emailBySupplier.get(s.supplier_id)?.trim();
    if (!email) {
      skipped.push({ ...base, reason: "no_email" });
      continue;
    }

    const subject = cisStatementEmailSubject(s.statement_number);
    if (input.existingKeys.has(subject)) {
      skipped.push({ ...base, reason: "already_queued" });
      continue;
    }

    toQueue.push({
      ...base,
      toEmail: email,
      subject,
      body: cisStatementEmailBody(s),
    });
  }

  return { toQueue, skipped };
}
