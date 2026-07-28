import { z } from "zod";

import { canonicaliseUtr } from "./verification";

/**
 * H2-CIS M4 — the CONTRACTOR's own CIS identity.
 *
 * PURE. No Supabase, no server-only, no I/O.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A payment and deduction statement must show the "contractor's own name and
 * employer tax reference" (CIS340 §3.15, CISR12160). CrewFlow held NEITHER:
 * `organizations` carries a name, a VAT number and an address, but no employer
 * PAYE reference. Without one, a statement is legally incomplete.
 *
 * So the reference is COLLECTED, never derived. There is deliberately no
 * fallback that manufactures a plausible-looking reference from the org, and
 * `issue_cis_statement` refuses outright until a real one is on file. A wrong
 * employer reference on a statement sends the subcontractor's reclaim to the
 * wrong place; an absent one at least fails visibly.
 *
 * ── SHAPE VALIDATION LIVES HERE, NOT IN THE DATABASE ────────────────────────
 * The migration constrains only length. That is the same call M1 made for
 * `verification_reference`, for the same reason: these are externally-issued
 * references typed in by hand, and a too-strict CHECK on an external format is a
 * support trap that needs a migration to relax. Validating in TypeScript keeps
 * the friendly message and the tunable rule in one place.
 */

// ---------------------------------------------------------------------------
// Employer PAYE reference
// ---------------------------------------------------------------------------

/**
 * HMRC employer PAYE reference: a 3-digit HMRC office number, a slash, then the
 * employer's reference (letters and digits). Commonly written `123/A246` or
 * `123/AB45678`.
 *
 * Kept deliberately permissive on the second part — HMRC has issued a wide
 * variety of employer references over the years and rejecting a real one a user
 * is holding in their hand is worse than accepting an odd-looking one. The
 * structure that actually matters (three digits, a slash, something after it) is
 * enforced; the rest is not guessed at.
 */
const PAYE_REFERENCE = /^[0-9]{3}\/[A-Z0-9]{1,10}$/;

/**
 * Accounts Office reference, e.g. `123PX00123456`: 3 digits, 'P', a letter,
 * then 8 characters. Used to PAY deductions over, not shown on a statement.
 */
const ACCOUNTS_OFFICE_REFERENCE = /^[0-9]{3}P[A-Z][0-9A-Z]{8}$/;

/** Upper-case and strip spaces, so "123 / ab45678" is accepted as typed. */
export function canonicalisePayeReference(input: string): string | null {
  const cleaned = input.replace(/\s+/g, "").toUpperCase();
  return PAYE_REFERENCE.test(cleaned) ? cleaned : null;
}

export function canonicaliseAccountsOfficeReference(input: string): string | null {
  const cleaned = input.replace(/\s+/g, "").toUpperCase();
  return ACCOUNTS_OFFICE_REFERENCE.test(cleaned) ? cleaned : null;
}

/**
 * Whether an org is able to issue statements at all.
 *
 * Used by the UI to explain the gap BEFORE the operator gets a database error,
 * and by the statements page to route them to the setup form. The database is
 * still the control: `issue_cis_statement` refuses regardless of what any UI
 * decides here.
 */
export type ContractorReadiness =
  | { ready: true; reason: null }
  | { ready: false; reason: string };

export function assessContractorReadiness(
  profile: { legal_name?: string | null; employer_paye_reference?: string | null } | null,
): ContractorReadiness {
  if (!profile) {
    return {
      ready: false,
      reason:
        "Add your CIS contractor details first. A payment and deduction statement must show your business name and employer PAYE reference.",
    };
  }
  if (!profile.legal_name || profile.legal_name.trim().length === 0) {
    return { ready: false, reason: "Your CIS contractor name is missing." };
  }
  if (!profile.employer_paye_reference || profile.employer_paye_reference.trim().length === 0) {
    return {
      ready: false,
      reason:
        "Your employer PAYE reference is missing. HMRC requires it on every payment and deduction statement.",
    };
  }
  return { ready: true, reason: null };
}

// ---------------------------------------------------------------------------
// Form schema
// ---------------------------------------------------------------------------

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));

export const cisContractorProfileSchema = z.object({
  legal_name: z
    .string()
    .trim()
    .min(1, "Enter the name HMRC holds for your business")
    .max(200),
  employer_paye_reference: z
    .string()
    .trim()
    .min(1, "Enter your employer PAYE reference — HMRC requires it on every statement")
    .transform((v) => canonicalisePayeReference(v) ?? "__invalid__")
    .refine((v) => v !== "__invalid__", {
      message: "An employer PAYE reference is 3 digits, a slash, then your reference (e.g. 123/AB45678).",
    }),
  accounts_office_reference: optionalText(20)
    .transform((v) => (v ? canonicaliseAccountsOfficeReference(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "An Accounts Office reference looks like 123PX00123456.",
    }),
  contractor_utr: optionalText(20)
    .transform((v) => (v ? canonicaliseUtr(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "A UTR is exactly 10 digits (e.g. 1234567890).",
    }),
});

export type CisContractorProfileInput = z.infer<typeof cisContractorProfileSchema>;

export const cisStatementIssueSchema = z.object({
  supplier_id: z.string().uuid("Choose a subcontractor."),
  tax_month_end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a tax month.")
    .refine((v) => v.endsWith("-05"), {
      message: "A CIS tax month always ends on the 5th.",
    }),
});

export const cisStatementWithdrawSchema = z.object({
  statement_id: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Say why this statement is being withdrawn — the subcontractor holds it")
    .max(500),
});

export const cisReturnPrepareSchema = z.object({
  tax_month_end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a tax month.")
    .refine((v) => v.endsWith("-05"), {
      message: "A CIS tax month always ends on the 5th.",
    }),
});
