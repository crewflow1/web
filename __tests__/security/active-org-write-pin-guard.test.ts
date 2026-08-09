import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { deriveOrgScopedTables } from "./org-scoped-tables";

/**
 * ACTIVE-ORG WRITE-PIN GUARD — the systemic backstop for the write slice.
 *
 * The defect class (see active-org-write-slice.test.ts for the full narrative):
 * CrewFlow users can belong to MORE THAN ONE organisation, and the app tracks
 * an "active org" (the `active_org_id` cookie → `requireOrgContext()`). Every
 * RLS policy in this schema is `org_id in current_org_ids()` or
 * `is_org_admin(org_id)`, and BOTH admit EVERY org the viewer belongs to —
 * neither constrains a query to the ACTIVE org. So RLS is the OUTER tenant
 * boundary, not the inner active-org scope. A by-id `.update()` / `.delete()`
 * on an org-scoped table via the tenant (user-JWT) client that pins ONLY
 * `.eq("id", …)` therefore reaches, for a dual-org member, the OTHER org's row.
 *
 * THE HOUSE STANDARD (enforced here): every by-id `.update()` / `.delete()` on
 * an org-scoped table via the TENANT client must ALSO chain
 * `.eq("org_id", ctx.org.id)` in the SAME statement — OR be a genuinely-safe
 * pattern captured in ALLOWLIST below with a per-entry reason.
 *
 * The earlier sweep (active-org-write-slice.test.ts) enumerated sites by hand,
 * one file at a time, and a hostile audit found it had MISSED several
 * (job_billing, job_documents, blueprint pins/markup, …). Hand-enumeration does
 * not scale and cannot prove completeness. THIS guard does: it scans every
 * `app/(app)/**` and `server/services/**` source file for the dangerous shape
 * and fails CI on any offender not in the ALLOWLIST — so the class cannot
 * silently regrow one new action at a time.
 *
 * SCOPE / non-goals:
 *   - TENANT client only. Writes on the SERVICE-ROLE (`createAdminClient()`)
 *     client bypass RLS entirely — a different security model with its own
 *     guards (storage-evidence-wave, the `as never` org pins proven in
 *     active-org-write-slice.test.ts's imports block). They are deliberately
 *     out of scope here so this guard's signal stays about the active-org
 *     predicate on the RLS-scoped client, not about RLS bypass.
 *   - INSERTs are out of scope: they stamp `org_id: ctx.org.id` in the payload
 *     (a different, positively-verified shape) rather than filter by it.
 *   - Reads are out of scope (covered by the active-org-*-scoping suites).
 *   - This guard adds NO migration and changes NO RLS policy — it is a static
 *     source scan.
 */

const ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Org-scoped table set — derived from the migrations (the source of truth) by
// the SHARED, quoted-identifier-aware helper in ./org-scoped-tables. A table is
// "org-scoped" if a migration creates it with an `org_id` column or adds one
// later; deriving it means a NEW org-scoped table is protected the moment its
// migration lands.
//
// HISTORY: this guard originally carried its OWN copy of the derivation regex
// that matched only UNQUOTED identifiers, so since C40 it silently did not cover
// by-id writes to the baseline's quoted-identifier tables (`public."quotes" (`,
// `"customers"`, `"leads"`, …) — the highest-value org-scoped rows. The shared
// helper is quoted-identifier aware and is used by BOTH the write-pin and
// read-pin guards so the two can never drift again.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A small, string-aware source scanner. It walks method chains starting at a
// `.from("table")` and inspects the WHOLE fluent statement, so a pin on a later
// `.eq()` in the same chain counts and a pin on a *sibling* statement does not.
// ---------------------------------------------------------------------------

/** Blank out comments while preserving string/template contents verbatim, so
 *  prose that mentions `.delete()` or `.eq("id", …)` never triggers a match. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let st: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src.charAt(i);
    const c2 = src.charAt(i + 1);
    if (st === "code") {
      if (c === "/" && c2 === "/") { st = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { st = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { st = "sq"; out += c; i++; continue; }
      if (c === '"') { st = "dq"; out += c; i++; continue; }
      if (c === "`") { st = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === "line") {
      if (c === "\n") { st = "code"; out += c; i++; } else { out += " "; i++; }
      continue;
    }
    if (st === "block") {
      if (c === "*" && c2 === "/") { st = "code"; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    // inside a string literal
    if (c === "\\") { out += c + (c2 ?? ""); i += 2; continue; }
    if (st === "sq" && c === "'") { st = "code"; out += c; i++; continue; }
    if (st === "dq" && c === '"') { st = "code"; out += c; i++; continue; }
    if (st === "tpl" && c === "`") { st = "code"; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Index of the ')' matching the '(' at `open` (string-aware). */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let st: "code" | "sq" | "dq" | "tpl" = "code";
  for (let i = open; i < src.length; i++) {
    const c = src.charAt(i);
    if (st === "code") {
      if (c === "'") st = "sq";
      else if (c === '"') st = "dq";
      else if (c === "`") st = "tpl";
      else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) return i; }
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (st === "sq" && c === "'") st = "code";
    else if (st === "dq" && c === '"') st = "code";
    else if (st === "tpl" && c === "`") st = "code";
  }
  return -1;
}

/** Index of the '(' matching the ')' at `close` (paren-only; good enough for
 *  the receiver-wrapper case, which never contains a bare ')' in a string). */
function matchParenBack(src: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src.charAt(i) === ")") depth++;
    else if (src.charAt(i) === "(") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** From the '.' of `.from(`, consume the full method chain and return its end. */
function consumeChain(src: string, dotFrom: number): number {
  let i = dotFrom;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    if (src.charAt(i) !== ".") break;
    let j = i + 1;
    while (j < src.length && /\s/.test(src.charAt(j))) j++;
    let k = j;
    while (k < src.length && /[A-Za-z0-9_$]/.test(src.charAt(k))) k++;
    if (k === j) break; // `.` not followed by an identifier
    let p = k;
    while (p < src.length && /\s/.test(src.charAt(p))) p++;
    if (src.charAt(p) !== "(") break; // property access without a call → chain ends
    const close = matchParen(src, p);
    if (close === -1) break;
    i = close + 1;
  }
  return i;
}

/** Is the receiver of this `.from(` the service-role/admin client? */
function receiverIsAdmin(src: string, dotIdx: number, admins: Set<string>): boolean {
  let i = dotIdx - 1;
  while (i >= 0 && /\s/.test(src.charAt(i))) i--;
  if (src.charAt(i) === ")") {
    // Inline wrapper form, e.g. `bp(tenant).from(...)` or
    // `createAdminClient().from(...)`. Inspect the wrapper + its argument.
    const open = matchParenBack(src, i);
    const inner = open >= 0 ? src.slice(open + 1, i) : "";
    let j = open - 1;
    while (j >= 0 && /\s/.test(src.charAt(j))) j--;
    const e = j;
    while (j >= 0 && /[A-Za-z0-9_$.]/.test(src.charAt(j))) j--;
    const wrapper = src.slice(j + 1, e + 1);
    return (
      /createAdminClient/.test(inner) ||
      /createAdminClient/.test(wrapper) ||
      admins.has(inner.trim())
    );
  }
  const e = i;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(src.charAt(i))) i--;
  const ident = src.slice(i + 1, e + 1);
  return admins.has(ident);
}

/** Local vars bound to `createAdminClient()` (incl. ternary writer forms). */
function adminVars(src: string): Set<string> {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createAdminClient\s*\(/g;
  while ((m = re.exec(src))) { if (m[1]) set.add(m[1]); }
  const re2 =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*createAdminClient\s*\([^;\n]*[:?]/g;
  while ((m = re2.exec(src))) { if (m[1]) set.add(m[1]); }
  return set;
}

const HAS_ID = /\.\s*eq\s*\(\s*["']id["']/;
const HAS_ORG = /\.\s*eq\s*\(\s*["']org_id["']/;
const IS_UPDATE = /\.\s*update\s*\(/;
const IS_DELETE = /\.\s*delete\s*\(/;
function idArgOf(chain: string): string {
  const m =
    /\.\s*eq\s*\(\s*["']id["'](?:\s+as\s+never)?\s*,\s*([^,)]+?)\s*(?:as\s+never\s*)?\)/.exec(
      chain,
    );
  return m && m[1] ? m[1].trim() : "?";
}

export type Offender = {
  rel: string;
  table: string;
  op: "update" | "delete";
  key: string;
  chain: string;
};

/**
 * The core detector, factored out so the calibration block can drive it with
 * synthetic fixtures (proving it FLAGS the bad shape and PASSES the good one).
 */
export function findOffendersInSource(
  rel: string,
  raw: string,
  orgTables: Set<string>,
): Offender[] {
  const src = stripComments(raw);
  const admins = adminVars(src);
  const out: Offender[] = [];
  const fromRe = /\.\s*from\s*\(\s*["']([a-z_][a-z0-9_]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) {
    const table = m[1] ?? "";
    const dotIdx = m.index;
    if (!table || !orgTables.has(table)) continue;
    const chain = src.slice(dotIdx, consumeChain(src, dotIdx));
    if (!IS_UPDATE.test(chain) && !IS_DELETE.test(chain)) continue; // writes only
    if (!HAS_ID.test(chain)) continue; // by-id only
    if (HAS_ORG.test(chain)) continue; // already pinned in-chain → safe
    if (receiverIsAdmin(src, dotIdx, admins)) continue; // service-role → out of scope
    const op: "update" | "delete" = IS_DELETE.test(chain) ? "delete" : "update";
    out.push({
      rel,
      table,
      op,
      key: `${rel}::${table}::${op}::${idArgOf(chain)}`,
      chain: chain.replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return out;
}

function walk(dir: string, filter: (f: string) => boolean, acc: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", "__tests__"].includes(e.name)) continue;
      walk(full, filter, acc);
    } else if (filter(full)) acc.push(full);
  }
}

function scanRepo(orgTables: Set<string>): Offender[] {
  const files: string[] = [];
  walk(join(ROOT, "app/(app)"), (f) => /\.(ts|tsx)$/.test(f), files);
  walk(join(ROOT, "server/services"), (f) => /\.ts$/.test(f), files);
  const out: Offender[] = [];
  for (const f of files) {
    out.push(...findOffendersInSource(f.replace(ROOT + "/", ""), readFileSync(f, "utf8"), orgTables));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ALLOWLIST — genuinely-safe by-id tenant writes that intentionally do NOT
// carry an in-chain `.eq("org_id", …)`. Each entry states WHY it is safe. Key
// shape: `<relative path>::<table>::<op>::<id-argument>`. A single key can
// cover multiple physical sites that share the exact pattern (e.g. the three
// clock writes). Keep this TIGHT — an entry that stops matching a real site is
// treated as a failure (see "no stale allowlist entries"), forcing cleanup.
// ---------------------------------------------------------------------------
const ALLOWLIST: Record<string, string> = {
  // USER-SCOPED BY DESIGN. `time_entries` has a UNIQUE index on (user_id) WHERE
  // ended_at IS NULL — "am I clocked in?" is a question about the PERSON, not
  // the company (migration 20260525000000_field_operations.sql). These writes
  // act on `open`, the caller's single open entry resolved by
  // `.eq("user_id", user.id).is("ended_at", null)`, and are keyed on `open.id`.
  // Adding an org pin would make the guard miss an open entry in the other org,
  // let the INSERT through, and the unique index would then reject it — turning
  // a clear "already clocked in" into an opaque failure. Proven in
  // active-org-write-slice.test.ts §7.
  "app/(app)/me/actions.ts::time_entries::update::open.id":
    "user-scoped clock: acts on the caller's single open entry (unique index is on user_id alone); an org pin would BREAK it",

  // RESOLVE-THEN-COMPARE. `line` is fetched and its org_id is compared to
  // ctx.org.id with an immediate refusal (`if (line.org_id !== ctx.org.id) …`)
  // BEFORE these writes; every subsequent write keys off `line.id` /
  // `line.bank_statement_id`, so the id is already proven active-org. Pinned as
  // safe-by-design in active-org-write-slice.test.ts §4 (confirmBankMatch).
  "app/(app)/payments/actions.ts::bank_statement_lines::update::line.id":
    "confirmBankMatch resolve-then-compare: line.org_id is checked against ctx.org.id before this write; keyed off the org-verified line",
  "app/(app)/payments/actions.ts::bank_statements::update::line.bank_statement_id":
    "confirmBankMatch resolve-then-compare: derived from the org-verified `line`; keyed off line.bank_statement_id",

  // OWN-ORG ROLLBACK. `shell` is a row the SAME function just INSERTed under the
  // tenant client with `org_id: ctx.org.id`; these are best-effort rollback
  // deletes on a failed multi-step create, keyed on `shell.id`. The row is the
  // function's own freshly-created active-org row, never a foreign id. The
  // headline deleteBlueprint DELETE (by a caller-supplied id) IS org-pinned and
  // is proven in active-org-write-slice.test.ts §1.
  "server/services/blueprints.ts::blueprints::delete::shell.id":
    "rollback of a shell this function just inserted with org_id=ctx.org.id (own-org, not a caller id)",

  // SPLIT-REFERENCE PIN. The org pin is applied on a sibling statement via the
  // saved query builder: `const q = supabase.from("notifications")…eq("id", id)`
  // then `await (options.orgId ? q.eq("org_id", options.orgId) : q)`. Every
  // live TENANT caller (app/(app)/notifications/actions.ts) passes
  // `orgId: ctx.org.id`; the HQ/admin callers take the service-role branch
  // (audience "hq"/"both"), which is cross-org by design and out of scope.
  "server/services/notifications-service.ts::notifications::update::id":
    "org pin applied via split builder reference q.eq('org_id', options.orgId); tenant callers always pass ctx.org.id, HQ branch is service-role",
};

// ===========================================================================

describe("active-org write-pin guard · org-scoped table derivation", () => {
  const orgTables = deriveOrgScopedTables();

  it("derives a substantial org-scoped table set from the migrations", () => {
    // A derivation that silently collapsed to ~0 would make the whole guard a
    // no-op. The real schema has 100+ org-scoped tables.
    expect(orgTables.size).toBeGreaterThan(100);
  });

  it("includes the tables this slice touches (derivation sanity)", () => {
    for (const t of [
      "job_billing_plans",
      "job_billing_stages",
      "job_documents",
      "job_document_versions",
      "blueprint_pins",
      "blueprint_markup",
      "review_requests",
      "tenant_attachments",
      "invoice_payments",
      "notifications",
      "time_entries",
      "bank_statement_lines",
    ]) {
      expect(orgTables.has(t), `${t} should be recognised as org-scoped`).toBe(true);
    }
  });

  it("covers the QUOTED-IDENTIFIER baseline tables (the C40 vacuity fix)", () => {
    // These are created as `create table … public."quotes" (` etc. Until this
    // guard adopted the shared quoted-identifier-aware derivation, they were
    // SILENTLY excluded — so a by-id tenant write to any of them was never
    // checked. They are the highest-value org-scoped rows in the schema.
    for (const t of ["quotes", "customers", "leads", "properties", "quote_line_items"]) {
      expect(orgTables.has(t), `${t} (quoted-identifier baseline) must now be covered`).toBe(true);
    }
  });

  it("the OLD unquoted-only regex would have MISSED those tables (proves the fix is real)", () => {
    // Reconstruct the pre-fix derivation (no `"?` around the identifier) and
    // show it drops the quoted-identifier baseline tables — the exact silent gap
    // this change closes. If the schema ever stopped quoting these, this test
    // would go stale and force a re-check.
    const dir = join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const oldSet = new Set<string>();
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const oldCreate =
        /create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi;
      let m: RegExpExecArray | null;
      while ((m = oldCreate.exec(sql))) {
        if (m[1] && /\borg_id\b/.test(m[2] ?? "")) oldSet.add(m[1]);
      }
    }
    // The bug: the old regex never saw these...
    for (const t of ["quotes", "customers", "leads"]) {
      expect(oldSet.has(t), `pre-fix set unexpectedly contained ${t}`).toBe(false);
      // ...but the shared (new) derivation does.
      expect(orgTables.has(t), `post-fix set must contain ${t}`).toBe(true);
    }
  });
});

describe("active-org write-pin guard · detector calibration (synthetic)", () => {
  // These fixtures pin the DETECTOR's behaviour so the guard cannot be quietly
  // weakened. They are the shapes the hostile audit found unpinned.
  const org = new Set(["job_billing_stages", "job_documents", "blueprint_pins"]);

  it("FLAGS an unpinned by-id tenant write to a QUOTED-IDENTIFIER table (C40 vacuity)", () => {
    // The regression this whole follow-up closes: with `quotes` now in the
    // derived set, an unpinned by-id tenant write to it is caught. Before the
    // fix `quotes` was absent from the set, so this exact write was invisible.
    const org2 = new Set(["quotes", "customers", "leads"]);
    const bad =
      'const supabase = await createClient();\n' +
      'await supabase.from("quotes").update({ status: "sent" }).eq("id", id);';
    const found = findOffendersInSource("fixture.ts", bad, org2);
    expect(found).toHaveLength(1);
    expect(found[0]?.table).toBe("quotes");
    // Same write, pinned → clean.
    const good =
      'await supabase.from("quotes").update({ status: "sent" }).eq("id", id).eq("org_id", ctx.org.id);';
    expect(findOffendersInSource("fixture.ts", good, org2)).toHaveLength(0);
    // Same write on the public/anonymous service-role path → out of scope.
    const pub =
      'const admin = createAdminClient();\n' +
      'await admin.from("quotes").update({ status: "expired" }).eq("id", quote.id);';
    expect(findOffendersInSource("fixture.ts", pub, org2)).toHaveLength(0);
  });

  it("FLAGS a by-id tenant DELETE with no org pin", () => {
    const bad =
      'const db = looseFrom(await createClient());\n' +
      'await db.from("job_billing_stages").delete().eq("id", stageId);';
    const found = findOffendersInSource("fixture.ts", bad, org);
    expect(found).toHaveLength(1);
    expect(found[0]?.op).toBe("delete");
    expect(found[0]?.table).toBe("job_billing_stages");
  });

  it("FLAGS a by-id tenant UPDATE with no org pin", () => {
    const bad =
      'const tenant = await createClient();\n' +
      'await tenant.from("job_documents").update({ status: "completed" }).eq("id", documentId);';
    expect(findOffendersInSource("fixture.ts", bad, org)).toHaveLength(1);
  });

  it("PASSES the same write once the active-org pin is chained in-statement", () => {
    const good =
      'await db.from("job_billing_stages").delete().eq("id", stageId).eq("org_id", ctx.org.id);';
    expect(findOffendersInSource("fixture.ts", good, org)).toHaveLength(0);
  });

  it("PASSES a write on the SERVICE-ROLE client (out of scope)", () => {
    const admin =
      'const admin = createAdminClient();\n' +
      'await admin.from("job_documents").delete().eq("id", documentId);';
    expect(findOffendersInSource("fixture.ts", admin, org)).toHaveLength(0);
    const inline =
      'await createAdminClient().from("job_documents").delete().eq("id", documentId);';
    expect(findOffendersInSource("fixture.ts", inline, org)).toHaveLength(0);
  });

  it("IGNORES a write on a non-org-scoped table", () => {
    const global =
      'await supabase.from("organizations").update({ name }).eq("id", orgId);';
    expect(findOffendersInSource("fixture.ts", global, org)).toHaveLength(0);
  });

  it("IGNORES an INSERT (org_id is stamped in the payload, not filtered)", () => {
    const ins =
      'await db.from("job_billing_stages").insert({ org_id: ctx.org.id, id }).select("id").single();';
    expect(findOffendersInSource("fixture.ts", ins, org)).toHaveLength(0);
  });

  it("does NOT let a comment mentioning the shape trigger a match", () => {
    const commented =
      '// await db.from("job_billing_stages").delete().eq("id", stageId)\n' +
      'const x = 1;';
    expect(findOffendersInSource("fixture.ts", commented, org)).toHaveLength(0);
  });

  it("sees through a wrapped tenant client (bp(tenant).from(...))", () => {
    const wrapped =
      'await bp(tenant).from("blueprint_pins").delete({ count: "exact" }).eq("id", pinId);';
    expect(findOffendersInSource("fixture.ts", wrapped, org)).toHaveLength(1);
  });
});

describe("active-org write-pin guard · the whole tree is swept", () => {
  const orgTables = deriveOrgScopedTables();
  const offenders = scanRepo(orgTables);

  it("every by-id tenant write on an org-scoped table is pinned or allowlisted", () => {
    const unlisted = offenders.filter((o) => !(o.key in ALLOWLIST));
    const report = unlisted
      .map((o) => `  • ${o.rel}\n      ${o.op} ${o.table} → ${o.chain}`)
      .join("\n");
    expect(
      unlisted,
      unlisted.length === 0
        ? ""
        : `Unpinned by-id tenant write(s) on org-scoped table(s) — add ` +
            `.eq("org_id", ctx.org.id) to the write, drive it off an org-pinned ` +
            `load, or (if genuinely safe) add a reasoned ALLOWLIST entry:\n${report}`,
    ).toHaveLength(0);
  });

  it("has no stale ALLOWLIST entries (each must still match a real site)", () => {
    const liveKeys = new Set(offenders.map((o) => o.key));
    const stale = Object.keys(ALLOWLIST).filter((k) => !liveKeys.has(k));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `ALLOWLIST entries no longer match any site (the code was fixed or ` +
            `moved — delete these):\n${stale.map((k) => `  • ${k}`).join("\n")}`,
    ).toHaveLength(0);
  });
});
