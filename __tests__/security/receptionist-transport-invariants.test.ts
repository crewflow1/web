import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — FIRST OUTBOUND TRANSPORT enforcement invariants
 * (the AI Receptionist Programme, R5 — first outbound transport).
 *
 * R4 proved the internal loop (Draft → Enforce → Audit) is welded and the audit is
 * mandatory. R5 carries an enforced, audited, AUTO-SENDABLE reply out over exactly ONE
 * transport (SMS). The directive's law is absolute: "There must be no execution path
 * capable of reaching a transport adapter without first passing through both the
 * canonical enforcement seam and the mandatory audit ledger." This suite proves that
 * law as a matter of SOURCE, not discipline (the house bar of
 * receptionist-reply-audit-invariants.test.ts), and the DB-level gate as a matter of
 * MIGRATION:
 *
 *   • SINGLE TRANSPORT WRITE PATH — across all non-test source, the transport ledger's
 *     write primitive (`record_ai_reply_transport`) is named by EXACTLY ONE module: the
 *     canonical receptionist service. No other file can file a transport row.
 *   • THE PROVIDER FACTORY IS CAPTIVE — `getSmsProvider` (the only door to a vendor
 *     adapter) is reached by EXACTLY ONE consumer: the canonical service. No route,
 *     action, or component can grab a transport adapter directly.
 *   • TRANSPORT IS GATED, IN SOURCE — the send is reached only inside `dispatchReply`,
 *     AFTER `enforceAndAuditReply` (the R4 mandatory chokepoint) AND behind the
 *     deny-by-default `decision.allowed` gate. There is no branch to a provider that
 *     skips enforce+audit.
 *   • THE TRANSPORT RECORD IS MANDATORY — a failed ledger write THROWS; it is not
 *     swallowed and does not rest on the best-effort event spine.
 *   • THE DB GATE IS UNBYPASSABLE, IN THE MIGRATION — the transport table is RLS:hq
 *     (enabled, zero policies), append-only (UPDATE/DELETE rejected), written only
 *     through a SECURITY DEFINER primitive, SMS-only by CHECK, and — the load-bearing
 *     R5 boundary — a BEFORE INSERT trigger refuses any row whose `ai_reply_audits`
 *     verdict was not `allow` (`allowed is distinct from true`), plus a partial unique
 *     index that makes a duplicate SENT message physically un-recordable.
 *
 * The transport's runtime behaviour (audit+transport on allow; no transport on
 * review/block; the DB gate; append-only; RLS; dedup) is pinned against real Postgres
 * in __tests__/integration/receptionist/transport-pipeline.test.ts. This tier is
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
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SERVICE = "server/services/receptionist.ts";
const COMMS_INDEX = "lib/comms/index.ts";
const TWILIO_PROVIDER = "lib/comms/providers/twilio.ts";
const MIGRATION = "supabase/migrations/20260816000000_ai_reply_transports.sql";

/** The transport ledger's write primitive — the function that files a transport row. */
const TRANSPORT_WRITE_FN = /\brecord_ai_reply_transport\b/;
/** The service's ONE door to a provider — the no-fallback channel→provider registry (SMS + WhatsApp). */
const PROVIDER_FACTORY = /\bgetTransportProvider\b/;
/** The RAW vendor factories — captive BEHIND the registry; no module outside lib/comms may reach them. */
const RAW_PROVIDER_FACTORY = /\bget(?:Sms|WhatsApp)Provider\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The transport ledger, the provider seam, and the dispatch all ship.
// =====================================================================

describe("receptionist transport — the transport ships", () => {
  it(`ships the append-only transport ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the Twilio SMS provider ${TWILIO_PROVIDER}`, () => {
    expect(existsSync(resolve(ROOT, TWILIO_PROVIDER)), TWILIO_PROVIDER).toBe(true);
  });

  it("the canonical service exports the dispatch seams", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/export async function dispatchReply\(/);
    expect(code).toMatch(/export async function dispatchReceptionistReply\(/);
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module can file a transport row.
// =====================================================================

describe("receptionist transport — exactly one module writes the transport ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => TRANSPORT_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the transport write primitive is the canonical service", () => {
    // If this list ever grows, a second transport-write path (or a bypass) has appeared.
    expect(writers).toEqual([SERVICE]);
  });

  it("no app/ route, action, or component writes the transport ledger directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module writes the transport ledger directly", () => {
    expect(writers.filter((p) => p !== SERVICE && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The provider factory is CAPTIVE — reached only by the canonical service.
// =====================================================================

describe("receptionist transport — the provider factory is captive", () => {
  const providerReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== COMMS_INDEX) // exclude the definer/factory home
    .filter((full) => PROVIDER_FACTORY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  // The RAW vendor factories (getSmsProvider / getWhatsAppProvider) must be reached ONLY inside the
  // comms registry (getTransportProvider). No server/app/lib module may grab a raw provider and bypass
  // the registry's no-cross-channel-fallback logic — that bypass is exactly how a WhatsApp reply could
  // leak onto the SMS wire.
  const rawReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== COMMS_INDEX) // exclude the registry/factory home
    .filter((full) => RAW_PROVIDER_FACTORY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("getTransportProvider is reached by EXACTLY ONE consumer — the canonical service", () => {
    expect(providerReachers).toEqual([SERVICE]);
  });

  it("the RAW vendor factories are captive to the comms registry — nothing else reaches them", () => {
    // If this list is ever non-empty, a module has bypassed getTransportProvider (and with it the
    // no-SMS-fallback guarantee). getSmsProvider/getWhatsAppProvider may be reached ONLY by the registry.
    expect(rawReachers).toEqual([]);
  });

  it("no app/ module reaches a transport adapter directly", () => {
    expect(providerReachers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(rawReachers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });
});

// =====================================================================
// 3. Transport is GATED — reached only after enforce+audit and behind the
//    deny-by-default allowed gate. No branch to a provider skips the audit.
// =====================================================================

describe("receptionist transport — the send is gated behind enforce + audit", () => {
  const code = codeOf(read(SERVICE));

  it("dispatchReply ENFORCES+AUDITS, THEN gates on decision.allowed, THEN transports — in that order", () => {
    expect(code).toMatch(
      /export async function dispatchReply\([\s\S]*?enforceAndAuditReply\([\s\S]*?decision\.allowed[\s\S]*?transportReply\(/,
    );
  });

  it("carries a deny-by-default gate — a non-allow reply returns without a send", () => {
    expect(code).toMatch(/if\s*\(\s*!\s*outcome\.decision\.allowed\s*\)/);
  });

  it("reaches a vendor adapter in exactly one place — inside the gated transport helper", () => {
    // getTransportProvider() (the channel→provider registry) and provider.send() are each invoked
    // exactly once, so the only door to a provider is the single gated path — for SMS AND WhatsApp.
    expect((code.match(/getTransportProvider\s*\(/g) ?? []).length).toBe(1);
    expect((code.match(/provider\.send\s*\(/g) ?? []).length).toBe(1);
  });

  it("the transport record is MANDATORY — a failed transport write THROWS", () => {
    expect(code).toMatch(/record_ai_reply_transport[\s\S]{0,1200}throw new Error/);
  });

  it("dispatchReceptionistReply short-circuits a duplicate BEFORE generating or sending", () => {
    // R13: the draft is generated (generateReplyDraft) rather than composed inline; the duplicate
    // short-circuit still precedes it, so a duplicate spends no generation and reaches no provider.
    expect(code).toMatch(
      /export async function dispatchReceptionistReply\([\s\S]*?findSentTransport\([\s\S]*?duplicate:\s*true[\s\S]*?generateReplyDraft\(/,
    );
  });

  it("does not lean the transport on the best-effort event spine, nor manufacture a send", () => {
    expect(importSpecifiers(code)).not.toContain("@/server/services/event-spine");
    expect(code).not.toMatch(/\bemitEvent\s*\(/);
    expect(code).not.toMatch(/allowed:\s*true/);
  });
});

// =====================================================================
// 4. The migration installs an APPEND-ONLY, service-role-only, ENFORCEMENT-GATED,
//    SMS-only, duplicate-proof transport ledger.
// =====================================================================

describe("receptionist transport — the ledger is gated, append-only and service-role-only", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the ai_reply_transports table", () => {
    expect(sql).toMatch(/create table if not exists public\.ai_reply_transports/i);
  });

  it("captures the audit anchor, routing, provider, status, cost and dedup facts", () => {
    for (const column of [
      "reply_audit_id",
      "org_id",
      "employee_slug",
      "channel",
      "provider",
      "to_ref",
      "provider_message_id",
      "status",
      "failure_reason",
      "cost_usd",
      "latency_ms",
      "attempt",
      "dedup_key",
      "correlation_id",
      "metadata",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("is SMS-only by CHECK and bounds status to sent|failed", () => {
    expect(sql).toMatch(/check\s*\(\s*channel\s+in\s*\(\s*'sms'\s*\)\s*\)/i);
    expect(sql).toMatch(/check\s*\(\s*status\s+in\s*\(\s*'sent'\s*,\s*'failed'\s*\)\s*\)/i);
  });

  it("THE ENFORCEMENT GATE — a BEFORE INSERT trigger refuses any row whose audit was not `allow`", () => {
    // The load-bearing R5 boundary: a transport may only exist for an enforced,
    // auto-sendable reply. The gate reads the audit's `allowed` and rejects anything
    // that is not `true` (a non-allow verdict OR a missing audit → NULL).
    expect(sql).toMatch(/create or replace function public\.ai_reply_transports_guard\(/i);
    expect(sql).toMatch(/from public\.ai_reply_audits\b/i);
    expect(sql).toMatch(/is distinct from true/i);
    expect(sql).toMatch(/errcode\s*=\s*'check_violation'/i);
    expect(sql).toMatch(
      /create trigger ai_reply_transports_guard_ins\s+before insert on public\.ai_reply_transports/i,
    );
  });

  it("couples the born state to the provider message id (sent carries one; failed must not)", () => {
    expect(sql).toMatch(/new\.status\s*=\s*'sent'[\s\S]{0,160}provider_message_id/i);
    expect(sql).toMatch(/new\.status\s*=\s*'failed'[\s\S]{0,160}provider_message_id/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(/alter table public\.ai_reply_transports enable row level security/i);
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.ai_reply_transports/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.ai_reply_transports_block_mutation\(/i,
    );
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger ai_reply_transports_no_update\s+before update on public\.ai_reply_transports/i,
    );
    expect(sql).toMatch(
      /create trigger ai_reply_transports_no_delete\s+before delete on public\.ai_reply_transports/i,
    );
  });

  it("makes a duplicate SENT message un-recordable — a partial unique index on dedup_key", () => {
    expect(sql).toMatch(
      /create unique index[\s\S]*?on public\.ai_reply_transports\s*\(dedup_key\)[\s\S]*?where status\s*=\s*'sent'/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_ai_reply_transport\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.ai_reply_transports/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

// =====================================================================
// N. The channel vocabulary is widened to EXACTLY {sms, whatsapp} — no more.
//    (Directive #018 R6.) WhatsApp is the SECOND reviewed transport; the CHECK
//    stays deliberately narrow so no UNREVIEWED channel slips onto the wire.
// =====================================================================

describe("receptionist transport — the channel vocabulary is exactly {sms, whatsapp}", () => {
  const WIDEN = "supabase/migrations/20260920000000_widen_transport_channel_whatsapp.sql";

  it("ships the channel-widening migration", () => {
    expect(existsSync(resolve(ROOT, WIDEN)), WIDEN).toBe(true);
  });

  it("widens BOTH ledgers' channel CHECK to exactly ('sms','whatsapp') — and nothing else", () => {
    const sql = sqlCodeOf(read(WIDEN));
    // Both ai_reply_transports AND ai_reply_delivery_receipts must admit whatsapp (the receipt table
    // copies the transport's channel on correlation, so both widen together or a receipt fails its CHECK).
    expect((sql.match(/check\s*\(\s*channel\s+in\s*\(\s*'sms'\s*,\s*'whatsapp'\s*\)\s*\)/gi) ?? []).length).toBe(2);
    // Deliberately narrow: no unreviewed channel (email/push/voice/social) may enter the transport
    // vocabulary. If this ever admits a third value, an unreviewed channel could be carried to a provider.
    expect(sql).not.toMatch(/'email'|'push'|'voice'|'instagram'|'facebook'|'manual'/i);
  });
});
