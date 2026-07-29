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

  it("demo_requests Stripe-checkout tracking migration exists (Blocker 1)", () => {
    const path = "supabase/migrations/20260629000000_demo_stripe_checkout.sql";
    expect(exists(path)).toBe(true);
    const mig = read(path);
    expect(mig).toMatch(/stripe_checkout_session_id text/);
    expect(mig).toMatch(/stripe_checkout_url\s+text/);
    expect(mig).toMatch(/stripe_payment_status\s+text/);
    expect(mig).toMatch(/setup_fee_paid_at\s+timestamp/);
    // Constrained enum so we never persist a bogus state.
    expect(mig).toMatch(/'pending',\s*'paid',\s*'expired'/);
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
    // Renamed in the auth-fix sprint: was onboardingWelcomeEmail, now
    // customerOnboardingEmail (carries the magic-link URL directly).
    expect(src).toMatch(/export function customerOnboardingEmail/);
  });

  it("setup payment template renders a 'reply for instructions' fallback when no Stripe link", () => {
    expect(src).toMatch(/payment instructions/);
  });

  it("setup payment template renders a real Stripe CTA when a link IS supplied (Blocker 1)", () => {
    // The template must branch on paymentLinkUrl: a clickable CTA button +
    // the raw URL in the text part when present, fallback copy when null.
    expect(src).toMatch(/paymentLinkUrl/);
    expect(src).toMatch(/Pay setup fee/);
    expect(src).toMatch(/href:\s*input\.paymentLinkUrl/);
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
    // Recovery must use the PAGINATED lookup — a bare listUsers() only
    // sees the first ~50 users, so accounts beyond page 1 were reported
    // as auth_create_user failures (loud-read-failures audit finding).
    expect(src).toMatch(/findAuthUserByEmail/);
    expect(src).not.toMatch(/\.listUsers\(/);
  });

  it("promoteDemoToCustomer rolls back the org if membership creation fails", () => {
    expect(src).toMatch(/Best-effort rollback/);
    expect(src).toMatch(/from\("organizations"\)\s*\.delete\(\)/);
  });

  it("creates the customer org in 'trial' status with a 14-day window", () => {
    expect(src).toMatch(/status:\s*"trial"/);
    expect(src).toMatch(/14 \* 24 \* 60 \* 60 \* 1000/);
  });

  // ---- Blocker 1: onSetupPaymentSent must mint a real Stripe link ----
  it("onSetupPaymentSent generates a Stripe Checkout link (not a hardcoded null)", () => {
    expect(src).toMatch(/createOrReuseDemoSetupCheckout\(\{\s*demoId:/);
    expect(src).toMatch(/done\.push\("stripe_checkout_created"\)/);
    // The link flows into the email template.
    expect(src).toMatch(/paymentLinkUrl\s*=\s*checkout\.url/);
    expect(src).toMatch(/setupPaymentEmail\(\{[\s\S]*?paymentLinkUrl/);
  });

  it("onSetupPaymentSent degrades gracefully — Stripe failure is non-fatal, only email failure fails it", () => {
    expect(src).toMatch(/demo\.payment_link_failed/);
    expect(src).toMatch(/step:\s*"stripe_checkout"/);
    // Overall ok hinges on the EMAIL step, not the Stripe step.
    expect(src).toMatch(/ok:\s*!failed\.some\(\(f\)\s*=>\s*f\.step === "email_setup_payment"\)/);
  });

  // ---- Blocker 1: webhook-driven auto-advance to payment_received ----
  it("exports onDemoStripePaymentConfirmed for the webhook to call", () => {
    expect(src).toMatch(/export async function onDemoStripePaymentConfirmed/);
  });

  it("onDemoStripePaymentConfirmed is idempotent (no double-charge handling)", () => {
    expect(src).toMatch(/stripe_payment_status === "paid"/);
    expect(src).toMatch(/alreadyHandled:\s*true/);
  });

  it("onDemoStripePaymentConfirmed advances to payment_received but never downgrades active rows", () => {
    expect(src).toMatch(/PRE_PAYMENT_STATUSES/);
    expect(src).toMatch(/update\.status\s*=\s*"payment_received"/);
    expect(src).toMatch(/demo\.payment_confirmed/);
    // active / active_onboarding intentionally excluded from the advance set.
    expect(src).not.toMatch(/PRE_PAYMENT_STATUSES = new Set\(\[[\s\S]*?"active"/);
  });
});

describe("Demo Stripe Checkout helper (lib/stripe/demo-checkout.ts)", () => {
  it("exists and is keyed on the demo, not an org", () => {
    expect(exists("lib/stripe/demo-checkout.ts")).toBe(true);
    const src = read("lib/stripe/demo-checkout.ts");
    expect(src).toMatch(/export async function createOrReuseDemoSetupCheckout/);
    expect(src).toMatch(/mode:\s*"payment"/);
    expect(src).toMatch(/customer_email:\s*demo\.email/);
    expect(src).toMatch(/demo_id:\s*demo\.id/);
  });

  it("create-or-reuse: returns an open session instead of minting duplicates", () => {
    const src = read("lib/stripe/demo-checkout.ts");
    expect(src).toMatch(/checkout\.sessions\.retrieve/);
    expect(src).toMatch(/existing\.status === "open"/);
    expect(src).toMatch(/reused:\s*true/);
  });

  it("never throws — returns a structured ok/false result for graceful fallback", () => {
    const src = read("lib/stripe/demo-checkout.ts");
    expect(src).toMatch(/ok:\s*false;\s*reason:\s*string/);
    expect(src).toMatch(/STRIPE_SECRET_KEY not configured/);
  });

  it("short-circuits when the demo is already paid (no re-bill)", () => {
    const src = read("lib/stripe/demo-checkout.ts");
    expect(src).toMatch(/stripe_payment_status === "paid"/);
    expect(src).toMatch(/alreadyPaid:\s*true/);
  });
});

describe("Stripe webhook routes the demo setup-fee branch (Blocker 1)", () => {
  const src = read("server/services/stripe-webhook-handler.ts");

  it("handleCheckoutCompleted resolves demo_id BEFORE org_id", () => {
    const demoIdx = src.indexOf("if (meta.demo_id)");
    const orgIdx = src.indexOf("if (!meta.org_id)");
    expect(demoIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(-1);
    expect(demoIdx).toBeLessThan(orgIdx);
  });

  it("calls onDemoStripePaymentConfirmed and audits the paid event", () => {
    expect(src).toMatch(/onDemoStripePaymentConfirmed\(/);
    expect(src).toMatch(/stripe\.demo_setup_fee_paid/);
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
    // active_onboarding is NOT a switch case anymore — it runs through the
    // atomic gate BEFORE the status flip (see Blocker 2 tests below).
  });

  it("surfaces done + failed steps via the redirect query string", () => {
    expect(src).toMatch(/params\.set\(\s*"done"/);
    expect(src).toMatch(/params\.set\(\s*"failed"/);
  });

  it("drag-drop variant also runs the lifecycle work", () => {
    expect(src).toMatch(/moveDemoToStatusJson/);
    // promoteDemoToCustomer is referenced in the import + both variants' gates.
    const matches = src.match(/promoteDemoToCustomer/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates Customers OS + Onboarding pages on lifecycle move", () => {
    expect(src).toMatch(/revalidatePath\("\/admin\/customers"\)/);
    expect(src).toMatch(/revalidatePath\("\/admin\/onboarding"\)/);
  });

  // ---- Blocker 2: onboarding must be ATOMIC -----------------------
  it("moveDemoToStatus provisions BEFORE flipping status (gate, not switch)", () => {
    // The promote call must precede the .update({ status }) write so a
    // failure can halt before the row is ever marked active_onboarding.
    const gateIdx = src.search(/if \(targetStatus === "active_onboarding"\)/);
    const updateIdx = src.indexOf('.update(update as never)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(updateIdx);
  });

  it("moveDemoToStatus HALTS + surfaces onboarding_failed when provisioning fails", () => {
    expect(src).toMatch(/if \(!promo\.ok\)/);
    expect(src).toMatch(/demo\.onboarding_failed/);
    expect(src).toMatch(/onboarding_failed/);
    // It redirects out (no status flip) on the failure path.
    expect(src).toMatch(/redirect\(`\/admin\/demos\?\$\{fp\.toString\(\)\}`\)/);
  });

  it("moveDemoToStatusJson ALSO gates active_onboarding (returns ok:false, no flip)", () => {
    // Both variants must enforce the gate. The JSON variant returns a
    // structured error so the kanban rolls back its optimistic move.
    expect(src).toMatch(/if \(status === "active_onboarding"\)[\s\S]*?promoteDemoToCustomer/);
    expect(src).toMatch(/Onboarding failed:/);
    // active_onboarding removed from the JSON post-flip switch too.
    expect(src).not.toMatch(/case "active_onboarding":/);
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

  it("has labels for the new Stripe done-steps (Blocker 1)", () => {
    expect(src).toMatch(/stripe_checkout_created:/);
    expect(src).toMatch(/stripe_already_paid:/);
  });

  it("reads onboarding_failed param and renders a distinct HALT banner (Blocker 2)", () => {
    expect(src).toMatch(/onboarding_failed\?:\s*string/);
    expect(src).toMatch(/if \(sp\.onboarding_failed\)/);
    // The copy must make clear NOTHING was activated + retry is safe.
    expect(src).toMatch(/Onboarding halted/);
    expect(src).toMatch(/NOT activated/);
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
      // New events from the launch-blocker fix.
      "demo.onboarding_failed",
      "demo.payment_link_created",
      "demo.payment_link_failed",
      "demo.payment_confirmed",
    ];
    for (const label of expected) {
      expect(src).toMatch(new RegExp(`"${label.replace(".", "\\.")}"`));
    }
  });
});
