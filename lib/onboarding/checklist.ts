/**
 * Onboarding setup checklist — premium-tier customer's first session.
 *
 * Directive Part 3: a paid construction-company owner should see
 * "Setup 6/10 complete" at the top of their dashboard, with a
 * one-click CTA for each item still to do. No hunting through menus
 * for the next obvious thing.
 *
 * This module is server/client-safe — no Supabase imports. The
 * server-only snapshot lives in `server/services/onboarding-snapshot.ts`.
 *
 * Step lifecycle:
 *   - required steps cannot be dismissed; they stay until done
 *   - optional steps (import existing data) can be dismissed → user
 *     explicitly told us they're starting fresh
 *   - completion is recomputed live from DB state, NOT cached on the
 *     org row; the user can never get stuck on "done but says undone"
 */

export type ChecklistStepId =
  | "company_profile"
  | "logo"
  | "vat"
  | "bank"
  | "terms"
  | "staff"
  | "customers"
  | "imports"
  | "invoices_import"
  | "first_quote"
  | "first_invoice"
  | "connect_email";

/** Stable, ordered list — used by the guided stepper to know the
 *  sequence and by tests to assert the catalogue. */
export const CHECKLIST_STEP_ORDER: ReadonlyArray<ChecklistStepId> = [
  "company_profile",
  "logo",
  "connect_email",
  "vat",
  "bank",
  "terms",
  "staff",
  "customers",
  "first_quote",
  "first_invoice",
  "imports",
  "invoices_import",
] as const;

export type ChecklistStep = {
  id: ChecklistStepId;
  title: string;
  description: string;
  cta: { label: string; href: string };
  /** required: never hidden until done. optional: user can dismiss. */
  required: boolean;
};

/**
 * The directive's 10 setup items. Order matters — the panel renders
 * them top-down in this order, so put the cheapest wins first.
 */
export const CHECKLIST_STEPS: ReadonlyArray<ChecklistStep> = [
  {
    id: "company_profile",
    title: "Add company details",
    description:
      "Trading name + phone + postcode. Appears on every quote, invoice, and PDF you send.",
    cta: { label: "Open Settings", href: "/settings" },
    required: true,
  },
  {
    id: "logo",
    title: "Upload your logo",
    description:
      "Customers expect to see your brand on the quote PDF — it builds trust before they read the number.",
    cta: { label: "Upload your logo", href: "/settings" },
    required: false,
  },
  {
    id: "connect_email",
    title: "Set your reply-to email",
    description:
      "Customer-facing quote + invoice replies go to this address. Default is your sign-in email; set a team mailbox if you'd rather route there.",
    cta: { label: "Set reply-to email", href: "/settings" },
    required: false,
  },
  {
    id: "vat",
    title: "Add your VAT number",
    description:
      "Required on every customer-facing invoice if you're VAT-registered.",
    cta: { label: "Add VAT number", href: "/settings" },
    required: false,
  },
  {
    id: "bank",
    title: "Add bank details",
    description:
      "Shown on the invoice PDF so customers can pay by bank transfer.",
    cta: { label: "Add bank details", href: "/settings" },
    required: true,
  },
  {
    id: "terms",
    title: "Set your default quote terms",
    description:
      "Pre-fills the Terms field on every new quote — payment terms, warranty wording, anything you say to every customer.",
    cta: { label: "Set default terms", href: "/settings" },
    required: false,
  },
  {
    id: "staff",
    title: "Invite your team",
    description:
      "Add the people who'll be using CrewFlow with you — admins and field staff. They can clock in/out and see their own jobs.",
    cta: { label: "Add staff", href: "/staff" },
    required: false,
  },
  {
    id: "customers",
    title: "Add or import your customers",
    description:
      "Either add them one by one, or upload a CSV from your existing system in Migration OS.",
    cta: { label: "Add customer", href: "/customers/new" },
    required: true,
  },
  {
    id: "imports",
    title: "Migrate from your old system",
    description:
      "Upload Sage / Xero / QuickBooks / Buildertrend exports, or paste in CSVs / Excel / PDF invoices.",
    cta: { label: "Open Migration OS", href: "/imports" },
    required: false,
  },
  {
    id: "invoices_import",
    title: "Import existing invoices",
    description:
      "Bring across any in-flight invoices so payments and reports start from a real position, not zero.",
    cta: { label: "Import invoices", href: "/imports" },
    required: false,
  },
  {
    id: "first_quote",
    title: "Create your first quote",
    description:
      "Turn a lead or customer into a quote. CrewFlow auto-creates the job + invoice when the customer accepts.",
    cta: { label: "Create quote", href: "/quotes/new" },
    required: true,
  },
  {
    id: "first_invoice",
    title: "Send your first invoice",
    description:
      "An invoice closes the loop — the customer can pay, you get reminded if they don't.",
    cta: { label: "Open invoices", href: "/invoices" },
    required: false,
  },
] as const;

export type OnboardingSnapshot = {
  org: {
    /** Name was required at signup but a placeholder slug is possible. */
    name: string | null;
    phone: string | null;
    /** Reply-to email at the org level (citext column on organizations). */
    email: string | null;
    vat_number: string | null;
    /** Path to an uploaded logo object in the private company-logos bucket. */
    logo_path?: string | null;
    /** Legacy external logo URL (read-only back-compat; no longer settable). */
    logo_url: string | null;
    /** jsonb — non-null + has at least name/sort_code/account_number = "done". */
    bank_details: {
      name?: string | null;
      sort_code?: string | null;
      account_number?: string | null;
    } | null;
    default_terms: string | null;
    /** Postcode is stored inside address jsonb. */
    address: { line1?: string | null; postcode?: string | null } | null;
  };
  counts: {
    /** Excludes the owner — only counts admin + staff invites. */
    staffMembers: number;
    customers: number;
    invoices: number;
    quotes: number;
    /** Successful commits — uncommitted imports don't count. */
    importsCommitted: number;
  };
  /** Step ids the user explicitly dismissed from their checklist. */
  dismissed: ReadonlySet<ChecklistStepId>;
  /** Lifecycle timestamps from organizations.onboarding_state JSONB. */
  timestamps: {
    /** First time the operator landed on /onboarding/setup. Best-effort. */
    started_at: string | null;
    /** Stamped when computeProgress().pct first reached 100. */
    completed_at: string | null;
  };
};

export function isStepComplete(
  stepId: ChecklistStepId,
  snap: OnboardingSnapshot,
): boolean {
  switch (stepId) {
    case "company_profile":
      // Name + phone + postcode is "complete enough" for invoicing.
      return Boolean(
        snap.org.name && snap.org.phone && snap.org.address?.postcode,
      );
    case "logo":
      // An uploaded logo (logo_path) OR a legacy external URL counts as done.
      return Boolean(
        (snap.org.logo_path && snap.org.logo_path.length > 0) ||
          (snap.org.logo_url && snap.org.logo_url.length > 0),
      );
    case "connect_email":
      return Boolean(snap.org.email && snap.org.email.length > 0);
    case "vat":
      return Boolean(snap.org.vat_number && snap.org.vat_number.length > 0);
    case "bank":
      return Boolean(
        snap.org.bank_details?.sort_code &&
          snap.org.bank_details?.account_number,
      );
    case "terms":
      return Boolean(
        snap.org.default_terms && snap.org.default_terms.length > 0,
      );
    case "staff":
      return snap.counts.staffMembers > 0;
    case "customers":
      return snap.counts.customers > 0;
    case "imports":
      return snap.counts.importsCommitted > 0;
    case "invoices_import":
      return snap.counts.invoices > 0;
    case "first_quote":
      return snap.counts.quotes > 0;
    case "first_invoice":
      return snap.counts.invoices > 0;
  }
}

export type ChecklistProgress = {
  /** Steps marked done by `isStepComplete`. Dismissed-but-incomplete steps DON'T count as done — they just don't render. */
  done: number;
  /** Required steps + optional steps the user hasn't dismissed. */
  total: number;
  /** Integer 0–100. */
  pct: number;
  /** Whether the checklist should still render at all. */
  showChecklist: boolean;
  /** Per-step render input. Already filtered for dismissed-and-incomplete optional steps. */
  steps: Array<{
    step: ChecklistStep;
    complete: boolean;
    dismissed: boolean;
  }>;
};

export function computeProgress(snap: OnboardingSnapshot): ChecklistProgress {
  const annotated = CHECKLIST_STEPS.map((step) => ({
    step,
    complete: isStepComplete(step.id, snap),
    dismissed: snap.dismissed.has(step.id),
  }));

  // Visible = required-always-visible OR optional-and-not-dismissed.
  // Dismissed-but-now-complete steps still show (with the green tick) so
  // the user can confirm what they decided was "done".
  const visible = annotated.filter(
    (a) => a.step.required || !a.dismissed || a.complete,
  );

  const done = visible.filter((a) => a.complete).length;
  const total = visible.length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);

  return {
    done,
    total,
    pct,
    showChecklist: done < total,
    steps: visible,
  };
}

// ---------------------------------------------------------------------------
// Helpers for the guided stepper + retention hooks
// ---------------------------------------------------------------------------

/**
 * Return the step ids the snapshot considers DONE. Order matches
 * CHECKLIST_STEP_ORDER so callers can render a stable timeline.
 */
export function completedSteps(
  snap: OnboardingSnapshot,
): ChecklistStepId[] {
  return CHECKLIST_STEP_ORDER.filter((id) => isStepComplete(id, snap));
}

/**
 * Return the step ids the user explicitly skipped (dismissed) AND
 * which are still incomplete. Dismissed-but-now-complete steps are
 * not "skipped" — they ended up done by another path.
 */
export function skippedSteps(snap: OnboardingSnapshot): ChecklistStepId[] {
  return CHECKLIST_STEP_ORDER.filter(
    (id) => snap.dismissed.has(id) && !isStepComplete(id, snap),
  );
}

/**
 * The step the operator should be nudged toward right now.
 *
 *   1. First INCOMPLETE required step in CHECKLIST_STEP_ORDER.
 *   2. Else, the first INCOMPLETE optional step that hasn't been
 *      skipped.
 *   3. Else null — everything visible is done.
 *
 * Drives:
 *   - The dashboard "Continue setup" CTA destination.
 *   - The retention banner ("You haven't created your first quote").
 *   - The /onboarding/setup auto-jump on entry.
 */
export function nextRecommendedAction(
  snap: OnboardingSnapshot,
): ChecklistStep | null {
  const byId = new Map(CHECKLIST_STEPS.map((s) => [s.id, s] as const));
  // Required first.
  for (const id of CHECKLIST_STEP_ORDER) {
    const s = byId.get(id);
    if (!s || !s.required) continue;
    if (isStepComplete(id, snap)) continue;
    return s;
  }
  // Optional next (skip skipped).
  for (const id of CHECKLIST_STEP_ORDER) {
    const s = byId.get(id);
    if (!s || s.required) continue;
    if (isStepComplete(id, snap)) continue;
    if (snap.dismissed.has(id)) continue;
    return s;
  }
  return null;
}

/**
 * True when the snapshot says every visible step is done.
 * The progress.pct can briefly be 100 without `completed_at` being
 * stamped — server actions write the timestamp in a follow-up call
 * after the celebration page is shown.
 */
export function isOnboardingComplete(snap: OnboardingSnapshot): boolean {
  return computeProgress(snap).pct === 100;
}
