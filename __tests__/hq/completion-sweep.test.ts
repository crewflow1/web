import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Completion Sweep — Phase 5 bundle.
 *
 * Pins the confirm-step coverage on every HQ destructive op flagged
 * by the Phase 5 audit, plus the new /admin loading + error
 * boundaries. The audit's tenant-side findings (customer/job/quote
 * /staff deletes) are scoped to Customer OS and NOT pinned here.
 *
 * Strategy: source-content checks for ClientConfirmForm / confirm
 * strings — same pattern as the other Phase tests in this sprint.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// =====================================================================
// 0. Shared confirm helper lives at the /admin root
// =====================================================================

describe("shared HQ confirm wrapper", () => {
  it("/admin/_client-confirm.tsx exists and exports ClientConfirmForm", () => {
    const f = read("app/admin/_client-confirm.tsx");
    expect(f).toMatch(/"use client"/);
    expect(f).toMatch(/export function ClientConfirmForm/);
    expect(f).toMatch(/window\.confirm\(confirm\)/);
  });

  it("legacy customers/[id]/_confirm.tsx re-exports from the shared root", () => {
    const f = read("app/admin/customers/[id]/_confirm.tsx");
    expect(f).toMatch(/export \{ ClientConfirmForm \} from/);
  });
});

// =====================================================================
// 1. /admin/billing — failed / refunded / void confirmed
// =====================================================================

describe("/admin/billing confirm gates", () => {
  const f = read("app/admin/billing/page.tsx");

  it("imports ClientConfirmForm", () => {
    expect(f).toMatch(/from "\.\.\/_client-confirm"/);
  });

  it("Mark paid stays one-click (recoverable, routine)", () => {
    expect(f).toMatch(/if \(status === "paid"\)/);
  });

  it("Mark failed has an explicit confirm string", () => {
    expect(f).toMatch(/Mark this invoice as FAILED/);
  });

  it("Refund has an explicit confirm string", () => {
    expect(f).toMatch(/Refund this invoice/);
  });

  it("Void has an explicit confirm string", () => {
    expect(f).toMatch(/Void this invoice/);
  });
});

// =====================================================================
// 2. /admin/support/[id] — Send reply confirmed when customer-visible
// =====================================================================

describe("/admin/support/[id] reply confirm", () => {
  it("the page renders the SupportReplyForm client component", () => {
    const page = read("app/admin/support/[id]/page.tsx");
    expect(page).toMatch(/<SupportReplyForm/);
    expect(page).toMatch(/import \{ SupportReplyForm \} from "\.\/_reply-form"/);
  });

  it("the client form confirms before sending a customer-visible reply", () => {
    const form = read("app/admin/support/[id]/_reply-form.tsx");
    expect(form).toMatch(/"use client"/);
    expect(form).toMatch(/window\.confirm/);
    // Internal notes skip the confirm.
    expect(form).toMatch(/if \(internal\) return/);
  });

  it("the confirm copy names the recipient", () => {
    const form = read("app/admin/support/[id]/_reply-form.tsx");
    expect(form).toMatch(/Send this reply to \$\{audience\}/);
  });

  it("the page no longer inlines its own one-click form", () => {
    const page = read("app/admin/support/[id]/page.tsx");
    expect(page).not.toMatch(/<form\s+action=\{replyAsHq\}/);
  });
});

// =====================================================================
// 3. /admin/alerts — Resolve / Snooze / Reopen confirmed
// =====================================================================

describe("/admin/alerts confirm gates", () => {
  const f = read("app/admin/alerts/page.tsx");

  it("imports ClientConfirmForm", () => {
    expect(f).toMatch(/from "\.\.\/_client-confirm"/);
  });

  it("Resolve form wraps in ClientConfirmForm with a resolution confirm", () => {
    expect(f).toMatch(
      /<ClientConfirmForm[\s\S]*action=\{markAlertResolved\}[\s\S]*Mark this alert resolved/,
    );
  });

  it("Snooze form wraps in ClientConfirmForm", () => {
    expect(f).toMatch(
      /<ClientConfirmForm[\s\S]*action=\{snoozeAlert\}[\s\S]*Snooze this alert/,
    );
  });

  it("Reopen form wraps in ClientConfirmForm", () => {
    expect(f).toMatch(
      /<ClientConfirmForm[\s\S]*action=\{reopenAlert\}[\s\S]*Reopen/,
    );
  });
});

// =====================================================================
// 4. /admin/impersonation — Start + Force-end confirmed
// =====================================================================

describe("/admin/impersonation confirm gates", () => {
  const f = read("app/admin/impersonation/page.tsx");

  it("imports ClientConfirmForm", () => {
    expect(f).toMatch(/from "\.\.\/_client-confirm"/);
  });

  it("Start impersonation wraps in ClientConfirmForm with a start confirm", () => {
    expect(f).toMatch(
      /<ClientConfirmForm[\s\S]*action=\{startImpersonation\}[\s\S]*Start impersonating this customer/,
    );
  });

  it("Force-end other operator's session wraps in ClientConfirmForm", () => {
    expect(f).toMatch(
      /<ClientConfirmForm[\s\S]*action=\{forceEndImpersonation\}[\s\S]*Force-end/,
    );
  });
});

// =====================================================================
// 5. /admin loading.tsx + error.tsx
// =====================================================================

describe("/admin loading + error shells", () => {
  it("app/admin/loading.tsx exists with skeleton chrome", () => {
    const p = resolve(ROOT, "app/admin/loading.tsx");
    expect(existsSync(p)).toBe(true);
    const f = read("app/admin/loading.tsx");
    expect(f).toMatch(/Loading HQ/);
    // Skeleton chrome is now the shared design-system <Shimmer> primitive
    // (Directive 006) rather than a raw `animate-pulse` utility class.
    expect(f).toMatch(/Shimmer/);
  });

  it("app/admin/error.tsx exists, is a client component, logs the error", () => {
    const p = resolve(ROOT, "app/admin/error.tsx");
    expect(existsSync(p)).toBe(true);
    const f = read("app/admin/error.tsx");
    expect(f).toMatch(/"use client"/);
    expect(f).toMatch(/console\.error/);
    expect(f).toMatch(/reset\(\)/);
  });

  it("error page links back to overview + support (no dead ends)", () => {
    const f = read("app/admin/error.tsx");
    expect(f).toMatch(/\/admin\/overview/);
    expect(f).toMatch(/\/admin\/support/);
  });
});
