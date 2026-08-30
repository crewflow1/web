import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_CHANNELS,
  INBOUND_URGENCY,
} from "@/lib/receptionist/types";
import { supplierFormSchema, expenseDraftApproveSchema } from "@/lib/suppliers/schema";
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_TARGET_TABLES,
} from "@/server/services/tenant-attachments";
import { SIGNABLE_TARGET_TABLES } from "@/server/services/signatures";
import { REVIEW_PLATFORMS } from "@/server/services/review-requests";

/**
 * Final additions — comprehensive verification across phases A–H.
 *
 * Each phase has a section. We pin contracts (allowed values,
 * schema gates, idempotency keys) + source-file existence + key
 * invariants the directive named.
 *
 * Runtime DB behaviour is verified separately by the lifecycle
 * SQL audit script and the production smoke step in the deploy.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

const MIGRATION = read("supabase/migrations/20260623000000_final_additions.sql");

// =====================================================================
// Migration covers every phase
// =====================================================================

describe("Final additions — migration", () => {
  it("creates inbound_enquiries (Phase A)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.inbound_enquiries/);
    expect(MIGRATION).toMatch(/channel\s+text not null/);
    expect(MIGRATION).toMatch(/ai_summary\s+text/);
    expect(MIGRATION).toMatch(/ai_confidence\s+smallint/);
  });
  it("creates lead_followup_state (Phase B)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.lead_followup_state/);
    expect(MIGRATION).toMatch(/reminder_72h_at\s+timestamp/);
    expect(MIGRATION).toMatch(/reminder_7d_at\s+timestamp/);
    expect(MIGRATION).toMatch(/acted_kind/);
  });
  it("creates suppliers + adds finances.supplier_id + creates expense_drafts (Phase D)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.suppliers/);
    expect(MIGRATION).toMatch(
      /alter table public\.finances[\s\S]*add column if not exists supplier_id/,
    );
    expect(MIGRATION).toMatch(/create table if not exists public\.expense_drafts/);
    expect(MIGRATION).toMatch(/status\s+text not null default 'extracted'/);
  });
  it("creates compliance_documents with expiry tracking (Phase E)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.compliance_documents/);
    expect(MIGRATION).toMatch(/expires_at\s+date/);
    expect(MIGRATION).toMatch(/reminded_30d_at/);
    expect(MIGRATION).toMatch(/reminded_7d_at/);
    expect(MIGRATION).toMatch(/reminded_today_at/);
  });
  it("creates tenant_attachments (Phase F)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.tenant_attachments/);
    expect(MIGRATION).toMatch(
      /target_table[\s\S]*check[\s\S]*'customers'[\s\S]*'jobs'[\s\S]*'leads'/,
    );
  });
  it("creates signatures (Phase G)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.signatures/);
    expect(MIGRATION).toMatch(/signer_name\s+text not null/);
    expect(MIGRATION).toMatch(/signature_text\s+text/);
  });
  it("creates review_requests (Phase H)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.review_requests/);
    expect(MIGRATION).toMatch(/delay_days\s+integer not null default 0/);
    expect(MIGRATION).toMatch(/status[\s\S]*'scheduled'[\s\S]*'sent'[\s\S]*'completed'/);
  });
  it("creates compliance-docs + tenant-attachments storage buckets", () => {
    expect(MIGRATION).toMatch(/insert into storage\.buckets[\s\S]*'compliance-docs'/);
    expect(MIGRATION).toMatch(/insert into storage\.buckets[\s\S]*'tenant-attachments'/);
  });
  it("RLS is enabled on every new table", () => {
    for (const tbl of [
      "inbound_enquiries",
      "lead_followup_state",
      "suppliers",
      "expense_drafts",
      "compliance_documents",
      "tenant_attachments",
      "signatures",
      "review_requests",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`alter table public\\.${tbl} enable row level security`),
      );
    }
  });
});

// =====================================================================
// Phase A — AI Receptionist
// =====================================================================

describe("Phase A — AI Receptionist", () => {
  it("INBOUND_CHANNELS covers every directive channel", () => {
    for (const ch of [
      "phone",
      "sms",
      "whatsapp_msg",
      "whatsapp_call",
      "instagram_dm",
      "facebook_dm",
    ]) {
      expect(INBOUND_CHANNELS).toContain(ch);
    }
  });

  it("INBOUND_URGENCY is the four-band scale", () => {
    expect(INBOUND_URGENCY).toEqual(["low", "medium", "high", "urgent"]);
  });

  it("processInboundEnquiry service exists + is server-only", () => {
    const src = read("server/services/receptionist.ts");
    expect(src).toMatch(/^import "server-only"/);
    expect(src).toMatch(/export async function processInboundEnquiry/);
  });

  it("processor inserts inbound_enquiries → creates lead → notifies → audits", () => {
    const src = read("server/services/receptionist.ts");
    expect(src).toMatch(/from\("inbound_enquiries" as never\)/);
    expect(src).toMatch(/from\("leads"\)/);
    expect(src).toMatch(/emitNotifications/);
    expect(src).toMatch(/recordAdminActivity/);
    expect(src).toMatch(/dispatchAutomation/);
  });

  it("AI extraction has deterministic fallback when no key", () => {
    const src = read("server/services/receptionist.ts");
    expect(src).toMatch(/isAiConfigured/);
    expect(src).toMatch(/function deterministicExtract/);
  });

  it("AI receptionist NEVER books / schedules / prices — system prompt enforces it", () => {
    const src = read("server/services/receptionist.ts");
    expect(src).toMatch(/DO NOT invent budget/);
    expect(src).toMatch(/DO NOT promise prices or book appointments/);
  });

  it("inbound webhook is rate-limited + secret-gated + auth-checked", () => {
    const route = read("app/api/receptionist/inbound/route.ts");
    expect(route).toMatch(/enforce\(request, "receptionist_inbound"/);
    expect(route).toMatch(/CHANNEL_INBOUND_SECRET/);
    expect(route).toMatch(/status: 401/);
    expect(route).toMatch(/status: 422/);
  });

  it("middleware excludes api/receptionist so Twilio/WhatsApp/Meta webhooks aren't redirected to /login", () => {
    // Critical: inbound channel webhooks won't have a Supabase session
    // cookie. If the auth middleware catches them, they 307 → /login
    // and channel-secret verification never runs.
    const mw = read("middleware.ts");
    expect(mw).toMatch(/api\/receptionist/);
  });
});

// =====================================================================
// Phase B — Smart follow-ups
// =====================================================================

describe("Phase B — Smart follow-ups", () => {
  it("scheduler service exists with 72h + 7d stages", () => {
    const src = read("server/services/lead-followups.ts");
    expect(src).toMatch(/runLeadFollowups/);
    expect(src).toMatch(/SEVENTY_TWO_HOURS_MS/);
    expect(src).toMatch(/SEVEN_DAYS_MS/);
  });

  it("fires 7d before 72h when both would fire (escalation)", () => {
    const src = read("server/services/lead-followups.ts");
    // The if/else block prefers `past7d && !fired7d` over the 72h stage.
    expect(src).toMatch(/if \(past7d && !fired7d\)[\s\S]*else if \(!fired72h\)/);
  });

  it("acted_at gate stops reminders (owner controls)", () => {
    const src = read("server/services/lead-followups.ts");
    expect(src).toMatch(/state\?\.acted_at/);
    expect(src).toMatch(/skippedActed|skipped_acted\+\+/);
  });

  it("markLeadActed exists for call / message / archive", () => {
    const src = read("server/services/lead-followups.ts");
    expect(src).toMatch(/markLeadActed/);
    expect(src).toMatch(/kind: "call" \| "message" \| "archive"/);
  });

  it("cron route is registered + wraps with telemetry", () => {
    expect(exists("app/api/cron/lead-followups/route.ts")).toBe(true);
    const route = read("app/api/cron/lead-followups/route.ts");
    expect(route).toMatch(/withCronTelemetry\(\s*"lead-followups"/);
    expect(route).toMatch(/isCronAuthorised/);
  });

  it("vercel.json schedules the cron daily", () => {
    const vercel = read("vercel.json");
    expect(vercel).toMatch(/\/api\/cron\/lead-followups/);
  });
});

// =====================================================================
// Phase C — Lead summaries
// =====================================================================

describe("Phase C — Lead summaries", () => {
  it("summariseLead exists + returns shape with suggested_action", () => {
    const src = read("server/services/lead-summary.ts");
    expect(src).toMatch(/export async function summariseLead/);
    expect(src).toMatch(/suggested_action: "call" \| "quote" \| "archive" \| null/);
  });

  it("AI prompt forbids pricing + scheduling", () => {
    const src = read("server/services/lead-summary.ts");
    expect(src).toMatch(/DO NOT suggest a price/);
    expect(src).toMatch(/DO NOT propose a schedule/);
  });

  it("deterministic fallback handles no-AI case", () => {
    const src = read("server/services/lead-summary.ts");
    expect(src).toMatch(/function deterministicSummary/);
    expect(src).toMatch(/isAiConfigured/);
  });

  it("includes photo count via tenant_attachments", () => {
    const src = read("server/services/lead-summary.ts");
    expect(src).toMatch(/tenant_attachments/);
    expect(src).toMatch(/target_table[\s\S]*leads/);
  });
});

// =====================================================================
// Phase D — Suppliers + expenses
// =====================================================================

describe("Phase D — Suppliers + expense drafts", () => {
  it("supplierFormSchema validates name required, email format", () => {
    expect(supplierFormSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      supplierFormSchema.safeParse({ name: "X", email: "not-email" }).success,
    ).toBe(false);
    expect(supplierFormSchema.safeParse({ name: "Acme Ltd" }).success).toBe(true);
  });

  it("expenseDraftApproveSchema clamps VAT rate to 0/5/20", () => {
    expect(
      expenseDraftApproveSchema.safeParse({
        draft_id: "00000000-0000-0000-0000-000000000000",
        amount: 100,
        vat_rate: 12,
      }).success,
    ).toBe(false);
    expect(
      expenseDraftApproveSchema.safeParse({
        draft_id: "00000000-0000-0000-0000-000000000000",
        amount: 100,
        vat_rate: 20,
      }).success,
    ).toBe(true);
  });

  it("expense draft workflow exists with extracted → approved / rejected lifecycle", () => {
    const src = read("server/services/expense-drafts.ts");
    expect(src).toMatch(/createExpenseDraftFromUpload/);
    expect(src).toMatch(/approveExpenseDraft/);
    expect(src).toMatch(/finances/);
    expect(src).toMatch(/status: "approved"/);
  });

  it("approve writes to finances + stamps the draft (audit logged)", () => {
    const src = read("server/services/expense-drafts.ts");
    expect(src).toMatch(/recordAdminActivity/);
    expect(src).toMatch(/action: "expense_draft\.approved"/);
  });

  it("OCR extraction is capped to 85% confidence (per imports/ocr pattern)", () => {
    const src = read("server/services/expense-drafts.ts");
    expect(src).toMatch(/Math\.min\(85, confidence\)/);
  });

  it("AI cannot auto-post — drafts always require explicit approval", () => {
    const src = read("server/services/expense-drafts.ts");
    expect(src).toMatch(/status: "extracted"/);
    expect(src).toMatch(/approved_at/);
    expect(src).toMatch(/approved_by/);
  });
});

// =====================================================================
// Phase E — Compliance + expiry reminders
// =====================================================================

describe("Phase E — Compliance documents", () => {
  it("runComplianceExpiry fires 30d / 7d / today stages with idempotent stamps", () => {
    const src = read("server/services/compliance-docs.ts");
    expect(src).toMatch(/runComplianceExpiry/);
    expect(src).toMatch(/reminded_30d_at/);
    expect(src).toMatch(/reminded_7d_at/);
    expect(src).toMatch(/reminded_today_at/);
  });

  it("priority escalates: medium → high → urgent", () => {
    const src = read("server/services/compliance-docs.ts");
    expect(src).toMatch(
      /stage === "today" \? "urgent" : stage === "7d" \? "high" : "medium"/,
    );
  });

  it("only compliance docs have expiry (other attachments DON'T)", () => {
    // Pin invariant: compliance_documents has expires_at; tenant_attachments does NOT.
    expect(MIGRATION).toMatch(/compliance_documents[\s\S]*expires_at\s+date/);
    const tenant = MIGRATION.match(
      /create table if not exists public\.tenant_attachments[\s\S]*?\);/,
    )?.[0];
    expect(tenant).toBeTruthy();
    expect(tenant!).not.toMatch(/expires_at/);
  });

  it("cron route exists + telemetry wrapped", () => {
    expect(exists("app/api/cron/compliance-expiry/route.ts")).toBe(true);
    const route = read("app/api/cron/compliance-expiry/route.ts");
    expect(route).toMatch(/withCronTelemetry\(\s*"compliance-expiry"/);
  });
});

// =====================================================================
// Phase F — Universal attachments
// =====================================================================

describe("Phase F — Universal tenant attachments", () => {
  it("ATTACHMENT_TARGET_TABLES covers every directive entity", () => {
    for (const t of ["customers", "jobs", "quotes", "invoices", "suppliers", "leads"]) {
      expect(ATTACHMENT_TARGET_TABLES).toContain(t);
    }
  });

  it("ALLOWED_ATTACHMENT_MIME includes PDF + image variants + docs/Excel", () => {
    for (const m of [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/webp",
      "text/csv",
    ]) {
      expect(ALLOWED_ATTACHMENT_MIME.has(m)).toBe(true);
    }
  });

  it("MAX_ATTACHMENT_BYTES = 25MB", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  });

  it("upload service path is org-scoped + uuid-keyed", () => {
    const src = read("server/services/tenant-attachments.ts");
    expect(src).toMatch(
      /storagePath = `\$\{ctx\.org\.id\}\/\$\{input\.targetTable\}\/\$\{input\.targetId\}\/\$\{id\}/,
    );
  });

  it("upload deletes orphan file if DB insert fails", () => {
    const src = read("server/services/tenant-attachments.ts");
    expect(src).toMatch(/storage[\s\S]*?\.from\("tenant-attachments"\)[\s\S]*?\.remove\(\[storagePath\]\)/);
  });
});

// =====================================================================
// Phase G — E-signatures
// =====================================================================

describe("Phase G — E-signatures", () => {
  it("SIGNABLE_TARGET_TABLES covers quotes + contracts + invoices", () => {
    expect(SIGNABLE_TARGET_TABLES).toEqual(["quotes", "contracts", "invoices"]);
  });

  it("recordSignature stores name + signature_text + timestamp + ip + UA", () => {
    const src = read("server/services/signatures.ts");
    expect(src).toMatch(/signer_name/);
    expect(src).toMatch(/signature_text/);
    expect(src).toMatch(/signed_at/);
    expect(src).toMatch(/ip_address/);
    expect(src).toMatch(/user_agent/);
  });

  it("recordSignature notifies owner + audit logs + dispatches automation (quotes)", () => {
    const src = read("server/services/signatures.ts");
    expect(src).toMatch(/emitNotifications/);
    expect(src).toMatch(/recordAdminActivity/);
    expect(src).toMatch(/dispatchAutomation/);
    expect(src).toMatch(/type: "quote\.accepted"/);
  });
});

// =====================================================================
// Phase H — Review requests
// =====================================================================

describe("Phase H — Review requests", () => {
  it("REVIEW_PLATFORMS covers google / facebook / trustpilot / other", () => {
    expect(REVIEW_PLATFORMS).toEqual([
      "google",
      "facebook",
      "trustpilot",
      "other",
    ]);
  });

  it("createReviewRequest supports delay 0/3/7 days", () => {
    const src = read("server/services/review-requests.ts");
    expect(src).toMatch(/delay_days: 0 \| 3 \| 7/);
  });

  it("cron picks scheduled rows where send_at <= now (idempotent)", () => {
    const src = read("server/services/review-requests.ts");
    expect(src).toMatch(
      /\.eq\("status", "scheduled"\)[\s\S]*\.lte\("send_at"/,
    );
    expect(src).toMatch(/status: "sent"/);
  });

  it("status transitions: scheduled → sent → completed / ignored / cancelled", () => {
    expect(MIGRATION).toMatch(
      /'scheduled'[\s\S]*'sent'[\s\S]*'completed'[\s\S]*'ignored'[\s\S]*'cancelled'/,
    );
  });

  it("audit logs every status transition", () => {
    const src = read("server/services/review-requests.ts");
    expect(src).toMatch(/action: "review_request\.created"/);
    expect(src).toMatch(/action: "review_request\.completed"/);
    expect(src).toMatch(/action: "review_request\.cancelled"/);
  });
});

// =====================================================================
// Ops snapshot includes the new crons + env var
// =====================================================================

describe("Ops snapshot — new crons + env wired", () => {
  it("CRON_ROUTES covers lead-followups, compliance-expiry, review-requests", () => {
    // L11: ops-snapshot now DERIVES its roster from vercel.json via
    // lib/ops/cron-routes.ts (full parity pinned in ops/cron-coverage.test.ts),
    // so the coverage proof is: the routes are scheduled + the derivation is
    // wired.
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/from "@\/lib\/ops\/cron-routes"/);
    const vercel = read("vercel.json");
    for (const r of ["lead-followups", "compliance-expiry", "review-requests"]) {
      expect(vercel).toMatch(new RegExp(`"/api/cron/${r}"`));
    }
  });

  it("tracks the new CHANNEL_INBOUND_SECRET env var (presence only)", () => {
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/CHANNEL_INBOUND_SECRET/);
  });
});
