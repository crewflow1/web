import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — ASYNC DELIVERY RECEIPT invariants (the AI Receptionist
 * Programme, R7 — ASYNC DELIVERY RECEIPTS).
 *
 * R5 carried an enforced, audited reply out over one transport and recorded the
 * provider's SYNCHRONOUS acceptance; R6 armed it behind a default-off flag. R7 completes
 * the lifecycle by ingesting the provider's ASYNCHRONOUS terminal status through an
 * authenticated status-callback webhook, recorded as a NEW append-only receipt row — the
 * transport is NEVER mutated. The directive's law: "There must never be an unknown final
 * state once the provider has reported it," and "No alternative path may update delivery
 * status." This suite proves that law as a matter of SOURCE (not discipline) and the
 * DB-level guarantees as a matter of MIGRATION:
 *
 *   • SINGLE RECEIPT WRITE PATH — across all non-test source, the receipt ledger's write
 *     primitive (`record_ai_reply_delivery_receipt`) is named by EXACTLY ONE module: the
 *     canonical receptionist service. No other file can file a receipt.
 *   • THE RECEIPT WRITER IS CAPTIVE — the service function `recordSmsDeliveryReceipt` is
 *     reached by EXACTLY ONE consumer: the authenticated webhook route. No other path
 *     updates delivery status.
 *   • THE ROUTE AUTHENTICATES AND ADDS NO NEW SEND — it verifies the Twilio signature
 *     (the SDK-owned model, NOT a weaker bearer), rejects the unauthenticated /
 *     malformed / unknown callback, and reaches NO provider, NO transport write, and NO
 *     event spine. It persists ONLY through `recordSmsDeliveryReceipt`.
 *   • VERIFICATION IS SDK-OWNED — `verifyTwilioSignature` delegates to Twilio's
 *     `validateRequest` (HMAC-SHA1 the SDK owns), reading the auth token from the
 *     environment at call time; a missing token or signature fails closed.
 *   • THE RECEIPT RECORD IS MANDATORY — a failed ledger write THROWS (the webhook 500s
 *     and the provider retries); it is never swallowed.
 *   • THE DB GATE IS UNBYPASSABLE, IN THE MIGRATION — the receipt table is RLS:hq
 *     (enabled, zero policies), append-only (UPDATE/DELETE rejected), SMS-only + canonical
 *     status by CHECK, `terminal` a generated fact, idempotent via a UNIQUE
 *     (provider_message_id, status) index, correlation-guarded by a BEFORE INSERT trigger
 *     that binds a receipt to a real SENT transport, and written only through a SECURITY
 *     DEFINER primitive granted only to service_role.
 *
 * The runtime behaviour (correlation, idempotency, terminal states, traceability,
 * append-only, RLS) is pinned against real Postgres in
 * __tests__/integration/receptionist/delivery-receipts-pipeline.test.ts; the vocabulary,
 * Twilio verify/parse and the route decision tree in the unit tier. This tier is
 * HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting
 * the contract can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip `--` line comments so only executable SQL is matched. */
function sqlCodeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Recursively collect every non-test .ts/.tsx source file under the given roots. */
function walkSources(roots: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is simply skipped
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry)) {
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SERVICE = "server/services/receptionist.ts";
const ROUTE = "app/api/webhooks/twilio/sms-status/route.ts";
const TWILIO_PROVIDER = "lib/comms/providers/twilio.ts";
const TYPES = "lib/comms/types.ts";
const MIGRATION = "supabase/migrations/20260817000000_ai_reply_delivery_receipts.sql";

/** The receipt ledger's write primitive — the function that files a receipt row. */
const RECEIPT_WRITE_FN = /\brecord_ai_reply_delivery_receipt\b/;
/** The single service-side persistence function — the only door to the write primitive. */
const RECEIPT_SERVICE_FN = /\brecordSmsDeliveryReceipt\b/;
/** The WhatsApp receipt writer (Directive #018 R6, PR3) — a DISTINCT writer captive to the Meta webhook handler. */
const RECEIPT_WA_SERVICE_FN = /\brecordWhatsAppDeliveryReceipt\b/;
const WA_HANDLER = "server/services/whatsapp-webhook-handler.ts";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

const CANONICAL_STATUSES = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
] as const;

// =====================================================================
// 0. The receipt ledger, the route, the service writer, and the adapter helpers ship.
// =====================================================================

describe("receptionist delivery receipt — the receipt path ships", () => {
  it(`ships the append-only receipt ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the authenticated status-callback route ${ROUTE}`, () => {
    expect(existsSync(resolve(ROOT, ROUTE)), ROUTE).toBe(true);
  });

  it("the canonical service exports the receipt writer", () => {
    expect(codeOf(read(SERVICE))).toMatch(/export async function recordSmsDeliveryReceipt\(/);
  });

  it("the Twilio adapter exports the verification and parsing helpers", () => {
    const code = codeOf(read(TWILIO_PROVIDER));
    expect(code).toMatch(/export async function verifyTwilioSignature\(/);
    expect(code).toMatch(/export function parseTwilioSmsStatusCallback\(/);
  });

  it("the pure comms module exports the delivery-status vocabulary", () => {
    const code = codeOf(read(TYPES));
    expect(code).toMatch(/export const SMS_DELIVERY_STATUSES/);
    expect(code).toMatch(/export const TERMINAL_SMS_DELIVERY_STATUSES/);
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module names the receipt write primitive.
// =====================================================================

describe("receptionist delivery receipt — exactly one module writes the receipt ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => RECEIPT_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the receipt write primitive is the canonical service", () => {
    // If this list ever grows, a second receipt-write path (or a bypass) has appeared.
    expect(writers).toEqual([SERVICE]);
  });

  it("no app/ route, action, or component writes the receipt ledger directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The receipt writer is CAPTIVE — reached only by the authenticated route.
// =====================================================================

describe("receptionist delivery receipt — the receipt writer is captive to the route", () => {
  const reachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== SERVICE) // exclude the definer home
    .filter((full) => RECEIPT_SERVICE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("recordSmsDeliveryReceipt is reached by EXACTLY ONE consumer — the webhook route", () => {
    expect(reachers).toEqual([ROUTE]);
  });

  it("no other server/ module reaches the SMS receipt writer", () => {
    // SMS captivity preserved: the WhatsApp handler uses its OWN writer, never this one.
    expect(reachers.filter((p) => p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2b. The WhatsApp receipt writer is DISTINCT and CAPTIVE to the Meta webhook handler.
//     (Directive #018 R6, PR3.) Meta multiplexes messages + statuses through the ONE
//     /api/webhooks/whatsapp route → handleStatus, so — unlike the SMS writer's app/
//     route captivity — the WhatsApp writer is reached from a server/ handler. Both
//     writers share ONE channel-agnostic core (the RPC is still named exactly once).
// =====================================================================

describe("receptionist delivery receipt — the WhatsApp receipt writer is captive to the webhook handler", () => {
  const waReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== SERVICE) // exclude the definer home
    .filter((full) => RECEIPT_WA_SERVICE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("recordWhatsAppDeliveryReceipt is reached by EXACTLY ONE consumer — the Meta webhook handler", () => {
    expect(waReachers).toEqual([WA_HANDLER]);
  });

  it("no app/ route reaches the WhatsApp receipt writer directly", () => {
    expect(waReachers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("the two writers are DISTINCT — the SMS route never reaches the WhatsApp writer, and vice versa", () => {
    // A WhatsApp status cannot be recorded through the SMS writer (the P4 security-gate finding),
    // nor an SMS receipt through the WhatsApp writer. They share a core but not a call site.
    expect(waReachers).not.toContain(ROUTE); // the Twilio SMS route
    const smsReachers = walkSources(SOURCE_ROOTS)
      .filter((full) => rel(full) !== SERVICE)
      .filter((full) => RECEIPT_SERVICE_FN.test(codeOf(read(rel(full)))))
      .map(rel);
    expect(smsReachers).not.toContain(WA_HANDLER);
  });
});

// =====================================================================
// 3. The route AUTHENTICATES and adds NO new send. It is the ONE ingress, it verifies
//    the signature, and it persists only through the canonical writer.
// =====================================================================

describe("receptionist delivery receipt — the route authenticates and adds no new send", () => {
  const code = codeOf(read(ROUTE));

  it("verifies the Twilio signature and normalises the callback", () => {
    expect(code).toMatch(/verifyTwilioSignature\s*\(/);
    expect(code).toMatch(/parseTwilioSmsStatusCallback\s*\(/);
  });

  it("rejects the unauthenticated, malformed, and unknown callback with distinct statuses", () => {
    expect(code).toMatch(/status:\s*401/); // signature verification failed
    expect(code).toMatch(/status:\s*400/); // malformed / unknown status
    expect(code).toMatch(/status:\s*404/); // unknown provider message id
  });

  it("persists ONLY through the canonical receipt writer", () => {
    expect(code).toMatch(/recordSmsDeliveryReceipt\s*\(/);
    // No direct table writes from the route.
    expect(code).not.toMatch(/\.(insert|update|delete)\s*\(/);
  });

  it("imports verify/parse from the Twilio adapter and the writer from the service", () => {
    const specs = importSpecifiers(code);
    expect(specs).toContain("@/lib/comms/providers/twilio");
    expect(specs).toContain("@/server/services/receptionist");
  });

  it("reaches NO provider, NO transport write, and NO event spine — it only records a receipt", () => {
    expect(code).not.toMatch(/\bgetSmsProvider\s*\(/); // no provider construction
    expect(code).not.toMatch(/provider\.send\s*\(/); // no send
    expect(code).not.toMatch(/\brecord_ai_reply_transport\b/); // no transport write
    expect(code).not.toMatch(/\brecord_ai_reply_audit\b/); // no audit write
    expect(code).not.toMatch(/\bemitEvent\s*\(/); // no event spine
    expect(importSpecifiers(code)).not.toContain("@/server/services/event-spine");
  });

  it("does NOT reuse the weaker channel-inbound bearer — it uses SDK-owned verification", () => {
    expect(code).not.toMatch(/CHANNEL_INBOUND_SECRET/);
  });

  it("is a Node runtime, force-dynamic webhook (raw body available for signing)", () => {
    expect(code).toMatch(/runtime\s*=\s*["']nodejs["']/);
    expect(code).toMatch(/dynamic\s*=\s*["']force-dynamic["']/);
    // It reads the RAW body — signature is computed over these exact bytes.
    expect(code).toMatch(/request\.text\s*\(\s*\)/);
  });
});

// =====================================================================
// 4. Verification is SDK-owned — the SAME model the Stripe route uses, not weaker.
// =====================================================================

describe("receptionist delivery receipt — Twilio verification is SDK-owned", () => {
  const code = codeOf(read(TWILIO_PROVIDER));

  it("delegates signature verification to the Twilio SDK's validateRequest", () => {
    expect(code).toMatch(/\bvalidateRequest\s*\(/);
  });

  it("reads the auth token from the environment at call time and fails closed", () => {
    expect(code).toMatch(/process\.env\.TWILIO_AUTH_TOKEN/);
    // A missing token or signature returns false BEFORE any crypto — never a pass.
    expect(code).toMatch(/if\s*\(\s*!authToken\s*\|\|\s*!input\.signature\s*\)\s*return false/);
    // A crypto error degrades closed, never open.
    expect(code).toMatch(/catch\b[\s\S]{0,80}return false/);
  });

  it("the parser bounds the status to the canonical vocabulary (unknown → null)", () => {
    expect(code).toMatch(/isSmsDeliveryStatus\s*\(/);
    expect(code).toMatch(/return null/);
  });

  it("the adapter loads the vendor SDK LAZILY — no top-level twilio import", () => {
    // A dynamic import keeps the SDK out of bundles that don't verify callbacks.
    expect(code).toMatch(/await import\(\s*["']twilio["']\s*\)/);
    expect(importSpecifiers(code)).not.toContain("twilio");
  });
});

// =====================================================================
// 5. The service receipt writer is MANDATORY — a failed write throws.
// =====================================================================

describe("receptionist delivery receipt — the receipt record is mandatory", () => {
  const code = codeOf(read(SERVICE));

  it("names the receipt write primitive exactly once — the single write site", () => {
    expect((code.match(RECEIPT_WRITE_FN) ?? []).length).toBe(1);
  });

  it("a failed receipt write THROWS — it is not swallowed", () => {
    expect(code).toMatch(/record_ai_reply_delivery_receipt[\s\S]{0,600}throw new Error/);
  });

  it("an unknown message id is a recorded decision, not a throw (recorded:false)", () => {
    expect(code).toMatch(/recorded:\s*false/);
    expect(code).toMatch(/unknown_message/);
  });
});

// =====================================================================
// 6. The migration installs an APPEND-ONLY, service-role-only, correlation-guarded,
//    SMS-only, idempotent receipt ledger.
// =====================================================================

describe("receptionist delivery receipt — the ledger is guarded, append-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the ai_reply_delivery_receipts table", () => {
    expect(sql).toMatch(/create table if not exists public\.ai_reply_delivery_receipts/i);
  });

  it("captures the correlation, linkage, provider, status and observability facts", () => {
    for (const column of [
      "transport_id",
      "reply_audit_id",
      "org_id",
      "employee_slug",
      "channel",
      "provider",
      "provider_message_id",
      "status",
      "terminal",
      "provider_status",
      "error_code",
      "correlation_id",
      "metadata",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("is SMS-only by CHECK and bounds status to the nine canonical statuses", () => {
    expect(sql).toMatch(/check\s*\(\s*channel\s+in\s*\(\s*'sms'\s*\)\s*\)/i);
    expect(sql).toMatch(/check\s*\(\s*status\s+in\s*\(/i);
    for (const status of CANONICAL_STATUSES) {
      expect(sql, `status ${status}`).toMatch(new RegExp(`'${status}'`));
    }
  });

  it("makes `terminal` a GENERATED fact of the row, not a caller claim", () => {
    expect(sql).toMatch(
      /terminal\s+boolean[\s\S]{0,120}generated always as\s*\([\s\S]{0,160}status in \(\s*'delivered'\s*,\s*'undelivered'\s*,\s*'failed'\s*,\s*'canceled'\s*\)[\s\S]{0,40}stored/i,
    );
  });

  it("IS IDEMPOTENT — a UNIQUE (provider_message_id, status) index is the no-duplicate backstop", () => {
    expect(sql).toMatch(
      /create unique index[\s\S]*?on public\.ai_reply_delivery_receipts\s*\(\s*provider_message_id\s*,\s*status\s*\)/i,
    );
  });

  it("THE CORRELATION GUARD — a BEFORE INSERT trigger binds a receipt to a real SENT transport", () => {
    // The load-bearing R7 boundary: a receipt may only exist for a sent transport, and
    // its provider message id / org / audit must match that transport — honest linkage.
    expect(sql).toMatch(/create or replace function public\.ai_reply_delivery_receipts_guard\(/i);
    expect(sql).toMatch(/from public\.ai_reply_transports\b/i);
    expect(sql).toMatch(/is distinct from 'sent'/i); // transport must be sent
    expect(sql).toMatch(/provider_message_id is distinct from v_pmid/i); // honest message id
    expect(sql).toMatch(/org_id is distinct from v_org/i); // same tenant
    expect(sql).toMatch(/reply_audit_id is distinct from v_audit/i); // same audited reply
    expect(sql).toMatch(/errcode\s*=\s*'check_violation'/i);
    expect(sql).toMatch(
      /create trigger ai_reply_delivery_receipts_guard_ins\s+before insert on public\.ai_reply_delivery_receipts/i,
    );
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.ai_reply_delivery_receipts enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.ai_reply_delivery_receipts/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.ai_reply_delivery_receipts_block_mutation\(/i,
    );
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger ai_reply_delivery_receipts_no_update\s+before update on public\.ai_reply_delivery_receipts/i,
    );
    expect(sql).toMatch(
      /create trigger ai_reply_delivery_receipts_no_delete\s+before delete on public\.ai_reply_delivery_receipts/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive, idempotent and service-role-only", () => {
    expect(sql).toMatch(/create or replace function public\.record_ai_reply_delivery_receipt\(/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    // Correlate by resolving the transport by its provider message id.
    expect(sql).toMatch(
      /from public\.ai_reply_transports[\s\S]*?where t\.provider_message_id = p_provider_message_id/i,
    );
    // Idempotent append — a duplicate (message id, status) is a no-op.
    expect(sql).toMatch(/on conflict \(provider_message_id, status\) do nothing/i);
    // The unknown-identifier signal the route turns into a 404.
    expect(sql).toMatch(/transport_found/i);
    expect(sql).toMatch(/insert into public\.ai_reply_delivery_receipts/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});
