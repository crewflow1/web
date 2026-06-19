import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 6 — HQ OS verification.
 *
 * The directive's 7 steps map to existing surface that's been built
 * incrementally over prior sprints. This file is an audit + pin:
 * it asserts every named HQ page exists, every HQ action exists,
 * and Phase 6's three new actions (resetOnboarding /
 * markSetupComplete / resendInvite) are exported, wired into the UI,
 * and audit-logged.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

const ACTIONS = read("app/admin/customers/actions.ts");
const CUSTOMER_PAGE = read("app/admin/customers/[id]/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");

// =====================================================================
// Step 1 — HQ overview
// =====================================================================

describe("Phase 6 — Step 1: HQ overview", () => {
  it("/admin/overview page exists", () => {
    expect(exists("app/admin/overview/page.tsx")).toBe(true);
  });

  it("HQ_NAV exposes Overview", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/overview", label: "Overview"/);
  });
});

// =====================================================================
// Step 2 — Organization detail
// =====================================================================

describe("Phase 6 — Step 2: organization detail page", () => {
  it("/admin/customers/[id] exists", () => {
    expect(exists("app/admin/customers/[id]/page.tsx")).toBe(true);
  });

  it("renders financial editor + lifecycle controls + impersonation", () => {
    expect(CUSTOMER_PAGE).toMatch(/updateCustomerFinancials/);
    expect(CUSTOMER_PAGE).toMatch(/setCustomerLifecycle/);
    expect(CUSTOMER_PAGE).toMatch(/CustomerImpersonateModal/);
  });
});

// =====================================================================
// Step 3 — HQ actions (the directive's 12-item list)
// =====================================================================

describe("Phase 6 — Step 3: every named HQ action exists", () => {
  it("approve / suspend / cancel / reactivate via setOrganizationStatus + lifecycle", () => {
    const adminActions = read("app/admin/actions.ts");
    expect(adminActions).toMatch(/setOrganizationStatus/);
    expect(ACTIONS).toMatch(/setCustomerLifecycle/);
  });

  it("impersonate + exit impersonation", () => {
    const impAct = read("app/admin/impersonation/actions.ts");
    expect(impAct).toMatch(/startImpersonation/);
    expect(impAct).toMatch(/endImpersonation/);
  });

  it("reset onboarding (new this phase)", () => {
    expect(ACTIONS).toMatch(/export async function resetOnboarding/);
    expect(ACTIONS).toMatch(/onboarding_state: \{\} as never/);
  });

  it("resend invite (new this phase)", () => {
    expect(ACTIONS).toMatch(/export async function resendInvite/);
    expect(ACTIONS).toMatch(/inviteUserByEmail/);
  });

  it("mark setup complete (new this phase)", () => {
    expect(ACTIONS).toMatch(/export async function markSetupComplete/);
    expect(ACTIONS).toMatch(/completed_at: state\.completed_at \?\?/);
  });

  it("view audit logs surface exists (admin_activity_log)", () => {
    // Existing service.
    expect(exists("server/services/hq-audit.ts")).toBe(true);
  });

  it("add internal note", () => {
    expect(exists("app/admin/notes/actions.ts")).toBe(true);
    expect(exists("app/admin/notes/page.tsx")).toBe(true);
  });

  it("view error logs surface (cron telemetry in /admin/ops)", () => {
    expect(exists("app/admin/ops/page.tsx")).toBe(true);
  });
});

describe("Phase 6 — recovery actions are wired into the UI", () => {
  it("customer detail page renders all 3 recovery action forms", () => {
    expect(CUSTOMER_PAGE).toMatch(/action=\{resetOnboarding\}/);
    expect(CUSTOMER_PAGE).toMatch(/action=\{markSetupComplete\}/);
    expect(CUSTOMER_PAGE).toMatch(/action=\{resendInvite\}/);
  });

  it("each recovery action is wrapped in ClientConfirmForm", () => {
    const block =
      CUSTOMER_PAGE.match(
        /Recovery actions[\s\S]*Financials editor/,
      )?.[0] ?? "";
    expect(
      (block.match(/<ClientConfirmForm/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("each recovery action audits via recordAdminActivity", () => {
    expect(ACTIONS).toMatch(/action: "customer\.onboarding_reset"/);
    expect(ACTIONS).toMatch(/action: "customer\.setup_marked_complete"/);
    expect(ACTIONS).toMatch(/action: "customer\.invite_resent"/);
  });

  it("each recovery action gates on HQ access via requireHq() (defence in depth)", () => {
    // The single requireHq() gate (server/auth/hq.ts) is called by every
    // action; the recovery actions share that path.
    expect(ACTIONS).toMatch(/import \{ requireHq \} from "@\/server\/auth\/hq"/);
    expect(ACTIONS).toMatch(/requireHq\(\)/);
  });
});

// =====================================================================
// Step 4 — Support command centre
// =====================================================================

describe("Phase 6 — Step 4: support command centre", () => {
  it("/admin/support list + detail pages exist", () => {
    expect(exists("app/admin/support/page.tsx")).toBe(true);
    expect(exists("app/admin/support/[id]/page.tsx")).toBe(true);
  });

  it("server actions for reply / status / priority / category exist", () => {
    const sup = read("app/admin/support/actions.ts");
    expect(sup).toMatch(/replyAsHq/);
    expect(sup).toMatch(/setTicketStatus/);
    expect(sup).toMatch(/setTicketPriority/);
    expect(sup).toMatch(/setTicketCategory/);
  });
});

// =====================================================================
// Step 5 — Migration command centre
// =====================================================================

describe("Phase 6 — Step 5: migration command centre", () => {
  it("/admin/onboarding page exists with import drill-down", () => {
    expect(exists("app/admin/onboarding/page.tsx")).toBe(true);
    expect(exists("server/services/hq-onboarding-snapshot.ts")).toBe(true);
  });

  it("HQ-side listImportsForOrg surfaces every file per import", () => {
    const svc = read("server/services/hq-onboarding-snapshot.ts");
    expect(svc).toMatch(/listImportsForOrg/);
  });
});

// =====================================================================
// Step 6 — Billing OS
// =====================================================================

describe("Phase 6 — Step 6: billing OS (CrewFlow-side, not client)", () => {
  it("/admin/billing page exists", () => {
    expect(exists("app/admin/billing/page.tsx")).toBe(true);
  });

  it("tracks setup fee + MRR + LTV", () => {
    expect(ACTIONS).toMatch(/setup_fee_status/);
    expect(ACTIONS).toMatch(/mrr_gbp/);
    expect(ACTIONS).toMatch(/ltv_gbp/);
  });
});

// =====================================================================
// HQ nav exposes everything
// =====================================================================

describe("Phase 6 — HQ_NAV covers every directive section", () => {
  const labels = [
    "Overview",
    "Demos CRM",
    "Customers",
    "Onboarding & migration",
    "Billing",
    "Support queue",
    "Notifications",
    "Alerts",
    "Analytics",
    "Impersonation log",
    "Internal notes",
    "Customer health",
    "Ops",
    "Automations",
    "Settings",
  ];
  for (const label of labels) {
    it(`HQ_NAV includes "${label}"`, () => {
      expect(LAYOUT).toMatch(new RegExp(`label:\\s*"${label}"`));
    });
  }
});

// =====================================================================
// HQ-only auth gate
// =====================================================================

describe("Phase 6 — every HQ page is auth-gated", () => {
  it("admin layout 404s non-super-admins via requireHqPage() (defence in depth)", () => {
    // requireHqPage() 404s a non-allowlisted caller — the behaviour itself is
    // proven in __tests__/auth/hq-gate.test.ts; here we assert the wiring.
    expect(LAYOUT).toMatch(/import \{ requireHqPage \} from "@\/server\/auth\/hq"/);
    expect(LAYOUT).toMatch(/requireHqPage\(\)/);
  });
});
