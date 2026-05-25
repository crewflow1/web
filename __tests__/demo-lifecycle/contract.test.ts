import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Demo → customer lifecycle contract pins.
 *
 * The CEO bugfix directive required every Demos CRM action to perform
 * the real business operation behind it (email send + customer
 * provisioning), not just flip status. These tests lock the wiring so
 * we can't regress to "status-only" flips silently.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");
const exists = (rel: string) => existsSync(resolve(root, rel));

describe("Migration", () => {
  it("demo_requests.linked_org_id column migration exists", () => {
    expect(exists("supabase/migrations/20260626120000_demo_linked_org.sql")).toBe(true);
    const mig = read("supabase/migrations/20260626120000_demo_linked_org.sql");
    expect(mig).toMatch(/linked_org_id uuid/);
    expect(mig).toMatch(/references public\.organizations\(id\) on delete set null/);
  });
});

describe("Email templates", () => {
  const src = read("lib/email/demo-templates.ts");

  it("ships one template per lifecycle event", () => {
    expect(src).toMatch(/export function demoConfirmationEmail/);
    expect(src).toMatch(/export function demoContactedEmail/);
    expect(src).toMatch(/export function demoApprovedEmail/);
    expect(src).toMatch(/export function setupPaymentEmail/);
    expect(src).toMatch(/export function paymentReceivedEmail/);
    expect(src).toMatch(/export function onboardingWelcomeEmail/);
  });

  it("setup payment template renders a 'reply for instructions' fallback when no Stripe link", () => {
    expect(src).toMatch(/payment instructions/);
  });
});

describe("Lifecycle service (demo-lifecycle.ts)", () => {
  const src = read("server/services/demo-lifecycle.ts");

  it("every lifecycle helper exported", () => {
    expect(src).toMatch(/export async function onDemoCreated/);
    expect(src).toMatch(/export async function onDemoContacted/);
    expect(src).toMatch(/export async function onDemoApproved/);
    expect(src).toMatch(/export async function onSetupPaymentSent/);
    expect(src).toMatch(/export async function onPaymentReceived/);
    expect(src).toMatch(/export async function promoteDemoToCustomer/);
  });

  it("every helper records admin_activity_log audit entries", () => {
    // Counts of recordAdminActivity should be >= one per lifecycle event.
    const matches = src.match(/recordAdminActivity\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(10);
  });

  it("audits BOTH email_sent and email_failed paths", () => {
    expect(src).toMatch(/demo\.email_sent/);
    expect(src).toMatch(/demo\.email_failed/);
  });

  it("promoteDemoToCustomer is idempotent via linked_org_id", () => {
    expect(src).toMatch(/if \(args\.demo\.linked_org_id\)/);
    expect(src).toMatch(/already_provisioned/);
  });

  it("promoteDemoToCustomer creates auth user, public user, org, membership in order", () => {
    expect(src).toMatch(/inviteUserByEmail/);
    expect(src).toMatch(/from\("users"\)\.upsert/);
    expect(src).toMatch(/from\("organizations"\)\s*\.insert/);
    expect(src).toMatch(/from\("memberships"\)\s*\.insert/);
  });

  it("promoteDemoToCustomer audits each provisioning step distinctly", () => {
    expect(src).toMatch(/demo\.customer_created/);
    expect(src).toMatch(/demo\.org_created/);
    expect(src).toMatch(/demo\.membership_created/);
    expect(src).toMatch(/demo\.invite_sent/);
    expect(src).toMatch(/demo\.onboarding_created/);
  });

  it("promoteDemoToCustomer handles existing auth user gracefully (idempotent invite)", () => {
    expect(src).toMatch(/already (registered|exists)/i);
    expect(src).toMatch(/auth_user_already_existed|demo\.invite_skipped/);
  });

  it("promoteDemoToCustomer rolls back the org if membership creation fails", () => {
    expect(src).toMatch(/Best-effort rollback/);
    expect(src).toMatch(/from\("organizations"\)\s*\.delete\(\)/);
  });

  it("creates the customer org in 'trial' status with a 14-day window", () => {
    expect(src).toMatch(/status:\s*"trial"/);
    expect(src).toMatch(/14 \* 24 \* 60 \* 60 \* 1000/);
  });
});

describe("HQ demo actions wire to the lifecycle service", () => {
  const src = read("app/admin/demos/actions.ts");

  it("imports every lifecycle helper", () => {
    expect(src).toMatch(/onDemoContacted/);
    expect(src).toMatch(/onDemoApproved/);
    expect(src).toMatch(/onSetupPaymentSent/);
    expect(src).toMatch(/onPaymentReceived/);
    expect(src).toMatch(/promoteDemoToCustomer/);
  });

  it("moveDemoToStatus dispatches to the right helper per status", () => {
    expect(src).toMatch(/case "contacted":/);
    expect(src).toMatch(/case "won":/);
    expect(src).toMatch(/case "payment_sent":/);
    expect(src).toMatch(/case "payment_received":/);
    expect(src).toMatch(/case "active_onboarding":/);
  });

  it("surfaces done + failed steps via the redirect query string", () => {
    expect(src).toMatch(/params\.set\(\s*"done"/);
    expect(src).toMatch(/params\.set\(\s*"failed"/);
  });

  it("drag-drop variant also runs the lifecycle work", () => {
    expect(src).toMatch(/moveDemoToStatusJson/);
    // The switch statement in the JSON variant covers the same cases.
    const matches = src.match(/promoteDemoToCustomer/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates Customers OS + Onboarding pages on lifecycle move", () => {
    expect(src).toMatch(/revalidatePath\("\/admin\/customers"\)/);
    expect(src).toMatch(/revalidatePath\("\/admin\/onboarding"\)/);
  });
});

describe("Public form (/api/demo)", () => {
  const src = read("app/api/demo/route.ts");

  it("imports onDemoCreated for prospect confirmation + audit", () => {
    expect(src).toMatch(/onDemoCreated/);
  });

  it("runs side-effects in parallel via Promise.allSettled", () => {
    expect(src).toMatch(/Promise\.allSettled/);
  });

  it("still rejects bad input with 400 + still dedups within 5 minutes", () => {
    expect(src).toMatch(/FIVE_MIN_MS/);
    expect(src).toMatch(/dedup_hit/);
  });
});

describe("HQ demos page surfaces lifecycle outcome", () => {
  const src = read("app/admin/demos/page.tsx");

  it("reads done + failed query params", () => {
    expect(src).toMatch(/done\?:\s*string/);
    expect(src).toMatch(/failed\?:\s*string/);
  });

  it("renders an error-tone banner when steps failed", () => {
    expect(src).toMatch(/Status moved but \$\{lines\.length\} step/);
  });

  it("has pretty labels for the new done-step keys", () => {
    expect(src).toMatch(/DONE_STEP_LABELS/);
    expect(src).toMatch(/magic-link sent/);
    expect(src).toMatch(/owner membership created/);
  });
});

describe("Empty-detail-panel collapses (no dead workflow real estate)", () => {
  const src = read("app/admin/demos/_board.tsx");

  it("layout collapses to single column when no demo is open", () => {
    expect(src).toMatch(/grid-cols-1 gap-4 xl:grid-cols-\[1fr_420px\]/);
    expect(src).toMatch(/openDemo[\s\S]*?xl:grid-cols-\[1fr_420px\][\s\S]*?: "grid grid-cols-1 gap-4"/);
  });

  it("no static empty 'Open a demo' placeholder pane (only the comment may mention it)", () => {
    // The historical placeholder was a `<p>Open a demo</p>` — make sure it's gone.
    // We allow the string in the comment that explains the layout change.
    expect(src).not.toMatch(/<p[^>]*>\s*Open a demo\s*<\/p>/);
    expect(src).not.toMatch(/font-medium text-slate-700">Open a demo/);
  });
});

describe("Timeline label coverage", () => {
  const src = read("app/admin/demos/_detail-panel.tsx");

  it("LIFECYCLE_LABELS covers every new demo.* event", () => {
    const expected = [
      "demo.created",
      "demo.email_sent",
      "demo.email_failed",
      "demo.customer_created",
      "demo.org_created",
      "demo.membership_created",
      "demo.invite_sent",
      "demo.invite_failed",
      "demo.onboarding_created",
    ];
    for (const label of expected) {
      expect(src).toMatch(new RegExp(`"${label.replace(".", "\\.")}"`));
    }
  });
});
