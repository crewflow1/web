import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  allNavHrefs,
  navForRole,
  utilityForRole,
} from "@/app/(app)/_nav/nav-model";
import { buildCommands } from "@/app/(app)/_nav/commands";
import { HQ_AREAS } from "@/app/admin/_nav/hq-nav-model";

/**
 * Built-but-unreachable pack — source-contract reachability tests (build lane
 * L7). Each of the five previously-orphaned capabilities is pinned here so a
 * refactor can't silently strand it again:
 *
 *   1. /notifications      — LIVE, was orphaned: now in the nav model + the
 *                            bell dropdown's "View all" footer.
 *   2. /marketplace        — DARK (FEATURE_MARKETPLACE): nav entry exists but
 *                            is FLAG-CONDITIONAL — absent while dark, present
 *                            when the server layout lights the flag. The route
 *                            still 404s while dark.
 *   3. /settings/sso       — built-dark enterprise SSO now has its activation
 *                            page: admin-gated, honest dark state while off.
 *   4. GDPR export/erase   — surfaced on Settings → Data retention: live
 *                            export download + posture-matched erasure panel.
 *   5. /admin/outreach     — the first caller of startOutreach: HQ-gated
 *                            section page + launcher actions, in the HQ nav.
 */

const ROOT = resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

// ── 1. Notification centre ───────────────────────────────────────────────────

describe("/notifications is reachable (was live-but-orphaned)", () => {
  it("has a nav-model home", () => {
    expect(allNavHrefs()).toContain("/notifications");
  });

  it("is visible to every role (per-user centre), with the admin comms children still admin-only", () => {
    for (const role of ["owner", "admin", "staff"] as const) {
      const inbox = navForRole(role).find((a) => a.id === "inbox");
      expect(inbox, `${role} sees the Inbox area`).toBeTruthy();
      expect(
        inbox!.children.map((c) => c.href),
        `${role} can reach /notifications`,
      ).toContain("/notifications");
    }
    // Staff must NOT gain the owner/admin comms surfaces via the ALL_ROLES area.
    const staffInbox = navForRole("staff").find((a) => a.id === "inbox")!;
    const staffHrefs = staffInbox.children.map((c) => c.href);
    for (const adminOnly of ["/inbox", "/inbox/conversations", "/inbox/review", "/inbox/audit"]) {
      expect(staffHrefs, `staff must not see ${adminOnly}`).not.toContain(adminOnly);
    }
  });

  it("staff Inbox area lands on the notification centre, not the admin enquiries", () => {
    const staffInbox = navForRole("staff").find((a) => a.id === "inbox")!;
    expect(staffInbox.children[0]?.href).toBe("/notifications");
  });

  it("the bell dropdown links to the full centre (and keeps the activity-log link)", () => {
    const src = read("app", "(app)", "_components", "notifications.tsx");
    expect(src).toMatch(/href="\/notifications"/);
    expect(src).toMatch(/href="\/activity"/);
  });

  it("the notification centre page actually exists", () => {
    expect(existsSync(join(ROOT, "app", "(app)", "notifications", "page.tsx"))).toBe(true);
  });
});

// ── 2. Marketplace — flag-conditional nav ────────────────────────────────────

describe("/marketplace nav entry is flag-conditional (dark stays absent)", () => {
  const entry = [...PRIMARY_NAV, ...UTILITY_NAV]
    .flatMap((a) => a.children)
    .find((c) => c.href === "/marketplace");

  it("exists in the model and declares the marketplace flag", () => {
    expect(entry).toBeTruthy();
    expect(entry!.flag).toBe("marketplace");
  });

  it("is HIDDEN when no flags are lit (dark default)", () => {
    const hrefs = [...navForRole("owner"), ...utilityForRole("owner")]
      .flatMap((a) => [a.href, ...a.children.map((c) => c.href)]);
    expect(hrefs).not.toContain("/marketplace");
    // …and therefore never becomes a palette command either.
    expect(buildCommands("owner", "/dashboard").map((c) => c.href)).not.toContain("/marketplace");
  });

  it("appears when the server lights the flag", () => {
    const hrefs = [...navForRole("owner", ["marketplace"]), ...utilityForRole("owner", ["marketplace"])]
      .flatMap((a) => [a.href, ...a.children.map((c) => c.href)]);
    expect(hrefs).toContain("/marketplace");
    expect(
      buildCommands("owner", "/dashboard", ["marketplace"]).map((c) => c.href),
    ).toContain("/marketplace");
  });

  it("the route keeps its 404-while-dark gate (unchanged)", () => {
    const src = read("app", "(app)", "marketplace", "page.tsx");
    expect(src).toMatch(/isMarketplaceEnabled\(\)/);
    expect(src).toMatch(/notFound\(\)/);
  });

  it("the layout resolves the flag server-side (server-only env never reaches the client model)", () => {
    const layout = read("app", "(app)", "layout.tsx");
    expect(layout).toMatch(/isMarketplaceEnabled/);
    expect(layout).toMatch(/flags=\{navFlags\}/);
    // The pure-data nav model must not read env itself.
    const model = read("app", "(app)", "_nav", "nav-model.ts");
    expect(model).not.toMatch(/@\/lib\/env|process\.env/);
  });
});

// ── 3. Enterprise SSO activation surface ─────────────────────────────────────

describe("/settings/sso page exists and is gated", () => {
  const pagePath = join(ROOT, "app", "(app)", "settings", "sso", "page.tsx");

  it("the page exists and has a nav-model home (admin-only)", () => {
    expect(existsSync(pagePath)).toBe(true);
    expect(allNavHrefs()).toContain("/settings/sso");
    const settings = utilityForRole("staff").find((a) => a.id === "settings")!;
    expect(settings.children.map((c) => c.href)).not.toContain("/settings/sso");
    const adminSettings = utilityForRole("owner").find((a) => a.id === "settings")!;
    expect(adminSettings.children.map((c) => c.href)).toContain("/settings/sso");
  });

  it("renders the honest dark state off the feature flag and gates the live surface", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).toMatch(/isEnterpriseSsoEnabled\(\)/);
    expect(src).toMatch(/requireOrgContext/);
    expect(src).toMatch(/isn(&apos;|')t enabled for this workspace/);
    // Admin check present (non-admins get a read-only refusal).
    expect(src).toMatch(/owner.*admin|isAdminRole/s);
  });

  it("the existing server actions remain the only mutation path (forms call them)", () => {
    const forms = read("app", "(app)", "settings", "sso", "_forms.client.tsx");
    for (const action of [
      "saveSamlConfigAction",
      "saveOidcConfigAction",
      "setSsoEnabledAction",
      "mintScimTokenAction",
      "setScimEnabledAction",
    ]) {
      expect(forms, `forms wire ${action}`).toContain(action);
    }
  });
});

// ── 4. GDPR export / erasure surface ─────────────────────────────────────────

describe("GDPR export + erasure are surfaced on Settings → Data retention", () => {
  const src = read("app", "(app)", "settings", "data-retention", "page.tsx");

  it("offers the live export download as a plain admin-only anchor", () => {
    expect(src).toMatch(/href="\/api\/gdpr\/export"/);
    expect(src).toMatch(/isAdmin \?/);
  });

  it("matches the erase route's posture: support panel while dark, owner-only type-to-confirm when lit", () => {
    expect(src).toMatch(/gdprErasureEnabled\(\)/);
    expect(src).toMatch(/GdprEraseForm/);
    expect(src).toMatch(/support-assisted/);
    expect(src).toMatch(/isOwner/);
  });

  it("the live erase flow uses the route's REAL confirmation token (the org slug) and never fires un-armed", () => {
    const erase = read("app", "(app)", "settings", "data-retention", "_gdpr-erase.client.tsx");
    expect(erase).toMatch(/typed === orgSlug/);
    expect(erase).toMatch(/acknowledged/);
    expect(erase).toMatch(/\/api\/gdpr\/erase/);
    expect(erase).toMatch(/disabled=\{!armed\}/);
  });
});

// ── 5. Outreach AI surface ───────────────────────────────────────────────────

describe("/admin/outreach exists, is HQ-gated, and is linked from the HQ nav", () => {
  it("page + actions exist", () => {
    expect(existsSync(join(ROOT, "app", "admin", "outreach", "page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app", "admin", "outreach", "actions.ts"))).toBe(true);
  });

  it("is gated: the /admin layout requires HQ and the actions re-check the allowlist", () => {
    const layout = read("app", "admin", "layout.tsx");
    expect(layout).toMatch(/requireHqPage/);
    const actions = read("app", "admin", "outreach", "actions.ts");
    expect(actions).toMatch(/isSuperAdminEmail/);
    expect(actions).toMatch(/startOutreach/);
  });

  it("has an HQ nav home (Growth area) so the HQ palette derives it too", () => {
    const growth = HQ_AREAS.find((a) => a.id === "growth")!;
    expect(growth.children.map((c) => c.href)).toContain("/admin/outreach");
  });

  it("stays draft-only: the surface never imports a send/transport path", () => {
    const actions = read("app", "admin", "outreach", "actions.ts");
    expect(actions).not.toMatch(/sendEmail|mailer|transport|nodemailer/i);
  });
});
