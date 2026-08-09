import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  check,
  DEFAULT_LIMITS,
  enforce,
  identifyRequest,
  _resetForTests,
} from "@/lib/security/rate-limit";

/**
 * Phase 7 — Security + Compliance verification.
 *
 * The directive's 7-step checklist maps to:
 *   1. Auth audit       — covered by phase5 audit + this file's pins
 *   2. RLS audit        — covered by HQ-10.1 + migration tests
 *   3. Audit logs       — every sensitive action calls recordAdminActivity
 *   4. Backups          — documented in docs/SECURITY.md
 *   5. Rate limiting    — new in this sprint
 *   6. File safety      — portal_uploads MIME + size + path scoping
 *   7. Tests            — this file
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

// =====================================================================
// 1. Documentation exists
// =====================================================================

describe("Phase 7 — SECURITY.md is the contract document", () => {
  it("docs/SECURITY.md exists", () => {
    expect(exists("docs/SECURITY.md")).toBe(true);
  });

  it("covers auth surfaces, RLS, audit, rate limits, files, secrets, backups, impersonation", () => {
    const doc = read("docs/SECURITY.md");
    for (const section of [
      "Authentication",
      "RLS contract",
      "Audit logging",
      "Cron",
      "Rate limiting",
      "File safety",
      "Secrets",
      "Backup",
      "Impersonation",
    ]) {
      expect(doc).toMatch(new RegExp(section, "i"));
    }
  });
});

// =====================================================================
// 2. Rate limiter behaviour
// =====================================================================

describe("Phase 7 — rate limiter", () => {
  beforeEach(() => _resetForTests());

  it("allows up to `limit` requests inside the window", () => {
    const cfg = { limit: 3, windowSeconds: 60 };
    expect(check("r", "ip", cfg).allowed).toBe(true);
    expect(check("r", "ip", cfg).allowed).toBe(true);
    expect(check("r", "ip", cfg).allowed).toBe(true);
    expect(check("r", "ip", cfg).allowed).toBe(false);
  });

  it("decrements remaining each call", () => {
    const cfg = { limit: 3, windowSeconds: 60 };
    expect(check("r", "ip", cfg).remaining).toBe(2);
    expect(check("r", "ip", cfg).remaining).toBe(1);
    expect(check("r", "ip", cfg).remaining).toBe(0);
  });

  it("scopes counters by route + identifier (one ip's limit doesn't bleed)", () => {
    const cfg = { limit: 1, windowSeconds: 60 };
    expect(check("r1", "ipA", cfg).allowed).toBe(true);
    expect(check("r1", "ipA", cfg).allowed).toBe(false);
    expect(check("r1", "ipB", cfg).allowed).toBe(true);
    expect(check("r2", "ipA", cfg).allowed).toBe(true);
  });

  it("identifyRequest reads x-forwarded-for then x-real-ip then falls back", () => {
    expect(
      identifyRequest(
        new Request("http://x.test", {
          headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
        }),
      ),
    ).toBe("1.2.3.4");

    expect(
      identifyRequest(
        new Request("http://x.test", { headers: { "x-real-ip": "9.9.9.9" } }),
      ),
    ).toBe("9.9.9.9");

    expect(identifyRequest(new Request("http://x.test"))).toBe("anonymous");
  });

  it("enforce returns a 429 Response when rate-limited; null otherwise", async () => {
    const cfg = { limit: 1, windowSeconds: 60 };
    const req = new Request("http://x.test", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(enforce(req, "r", cfg)).toBeNull();

    const limited = enforce(req, "r", cfg);
    expect(limited).not.toBeNull();
    expect(limited!.status).toBe(429);
    expect(limited!.headers.get("retry-after")).toBeTruthy();
    const body = await limited!.json();
    expect(body.error).toBe("rate_limited");
  });

  it("default limits cover the abuse-prone surfaces", () => {
    expect(DEFAULT_LIMITS.demo_booking.limit).toBeLessThanOrEqual(10);
    expect(DEFAULT_LIMITS.ai_question.limit).toBeLessThanOrEqual(50);
    expect(DEFAULT_LIMITS.portal_write.limit).toBeLessThanOrEqual(50);
  });
});

// =====================================================================
// 3. Public/AI/portal routes invoke the limiter
// =====================================================================

describe("Phase 7 — rate limit is wired into abuse-prone routes", () => {
  it("/api/demo enforces demo_booking limit", () => {
    const src = read("app/api/demo/route.ts");
    expect(src).toMatch(/from "@\/lib\/security\/rate-limit"/);
    expect(src).toMatch(/enforce\(request, "demo_booking"/);
  });

  it("/api/ai/question enforces ai_question limit", () => {
    const src = read("app/api/ai/question/route.ts");
    expect(src).toMatch(/from "@\/lib\/security\/rate-limit"/);
    expect(src).toMatch(/enforce\(request, "ai_question"/);
  });
});

// =====================================================================
// 4. RLS + service-role isolation pins
// =====================================================================

describe("Phase 7 — sensitive tables are service-role only", () => {
  const tables = [
    "supabase/migrations/20260619000000_cron_runs_telemetry.sql",
    "supabase/migrations/20260620000000_portal_uploads.sql",
    "supabase/migrations/20260621000000_automation_runs.sql",
    "supabase/migrations/20260616000000_hq_settings.sql",
  ];

  for (const t of tables) {
    it(`${t} enables RLS with no policies`, () => {
      const src = read(t);
      expect(src).toMatch(/enable row level security/i);
      expect(src).not.toMatch(/create policy/i);
    });
  }
});

// =====================================================================
// 5. File safety contract
// =====================================================================

describe("Phase 7 — portal upload safety", () => {
  const upload = read("app/customer-portal/_upload-action.ts");

  it("MIME whitelist (PDF + image types only)", () => {
    expect(upload).toMatch(/ALLOWED_MIME/);
    expect(upload).toMatch(/application\/pdf/);
    expect(upload).toMatch(/image\/jpeg/);
    expect(upload).toMatch(/image\/png/);
  });

  it("10 MB size cap", () => {
    expect(upload).toMatch(/10 \* 1024 \* 1024/);
  });

  it("scopes storage path by org_id + customer_id (no cross-tenant collision)", () => {
    expect(upload).toMatch(
      /storagePath = `\$\{customer\.org_id\}\/\$\{customer\.id\}/,
    );
  });

  it("re-verifies invoice belongs to customer (no crafted-URL abuse)", () => {
    // Ownership resolves through the ONE authority invoiceCustomerId (invoice's
    // own customer_id, quote fallback) — NOT quote.customer_id alone. quote_id
    // is ON DELETE SET NULL, so gating on the quote chain wrongly rejected the
    // owner of a quote-less invoice. A crafted URL for a foreign invoice still
    // fails: invoiceCustomerId(inv) won't equal this customer's id, and the
    // read is scoped to customer.org_id.
    expect(upload).toMatch(/from "@\/lib\/invoices\/customer"/);
    expect(upload).toMatch(/invoiceCustomerId\(inv\) !== customer\.id/);
    expect(upload).toMatch(/\.eq\("org_id", customer\.org_id\)/);
    expect(upload).toMatch(/invoice_not_yours/);
    // The old quote-only gate must be gone.
    expect(upload).not.toMatch(/inv\.quote\?\.customer_id !== customer\.id/);
  });
});

// =====================================================================
// 6. Cron auth gates
// =====================================================================

describe("Phase 7 — every cron route Bearer-gated", () => {
  const cronRoutes = [
    "app/api/cron/alerts-poll/route.ts",
    "app/api/cron/notifications-drain/route.ts",
    "app/api/cron/health-recompute/route.ts",
    "app/api/cron/invoice-reminders/route.ts",
    "app/api/cron/quote-followup/route.ts",
  ];

  for (const r of cronRoutes) {
    it(`${r} returns 401 without Bearer CRON_SECRET`, () => {
      const src = read(r);
      expect(src).toMatch(/isCronAuthorised/);
      expect(src).toMatch(/status: 401/);
    });
  }
});

// =====================================================================
// 7. Impersonation safety
// =====================================================================

describe("Phase 7 — impersonation SQL-side invariants", () => {
  const mig = read(
    "supabase/migrations/20260614000000_impersonation_rls_aware.sql",
  );

  it("24h cap is SQL-enforced", () => {
    expect(mig).toMatch(/started_at > now\(\) - interval '24 hours'/);
  });

  it("ended_at IS NULL gate means Exit is instant", () => {
    expect(mig).toMatch(/ended_at is null/);
  });

  it("current_org_ids() is SECURITY DEFINER (bypasses impersonation_sessions RLS)", () => {
    expect(mig).toMatch(/security definer/);
  });
});

// =====================================================================
// 8. No secrets in client bundles
// =====================================================================

describe("Phase 7 — no secret env vars exposed to client", () => {
  it("rate-limit module is server-only", () => {
    expect(read("lib/security/rate-limit.ts")).toMatch(/^import "server-only"/);
  });

  it("ops snapshot reports env presence, never values", () => {
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/presence-only/);
    expect(src).not.toMatch(/value:\s*process\.env/);
  });
});
