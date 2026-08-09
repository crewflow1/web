import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * ACTIVE-ORG READ-PIN GUARD — the systemic backstop for the read slice (#456).
 *
 * The defect class (see active-org-read-stragglers.test.ts / lib/jobs/load.ts
 * for the full narrative): CrewFlow users can belong to MORE THAN ONE
 * organisation, and the app tracks an "active org" (the `active_org_id` cookie →
 * `requireOrgContext()`). Every RLS policy in this schema is
 * `org_id in current_org_ids()` or `is_org_admin(org_id)`, and BOTH admit EVERY
 * org the viewer belongs to — neither constrains a query to the ACTIVE org. So
 * RLS is the OUTER tenant boundary, not the inner active-org scope. A by-id
 * `.single()` / `.maybeSingle()` read on an org-scoped table via the tenant
 * (user-JWT) client that pins ONLY `.eq("id", …)` therefore returns, for a
 * dual-org member, the OTHER org's row — rendered inside the ACTIVE org's shell
 * (its nav, its money actions). That leaks financial + PII rows across the
 * viewer's own orgs (a same-user multi-org integrity leak, not a cross-tenant
 * breach).
 *
 * THE HOUSE STANDARD (enforced here): every by-id `.single()` / `.maybeSingle()`
 * read on an org-scoped table via the TENANT client, inside a dynamic
 * `app/(app)` dynamic `[id]` detail route, must ALSO chain `.eq("org_id", …)` in the
 * SAME statement — OR be a genuinely-safe pattern captured in ALLOWLIST below
 * with a per-entry reason.
 *
 * WHY A GUARD, not hand-enumeration: the read-side programme (#456/#459/#463/
 * #464/#465/#468/#473 — see active-org-read-stragglers.test.ts §4) closed the
 * class one file at a time, and a hostile red-team wave found it had MISSED
 * three live detail pages (quotes/[id], diary/[id], expenses/[id]). Reads were
 * out of scope for BOTH existing systemic guards: the C40 write-pin guard
 * (active-org-write-pin-guard.test.ts) covers only `.update()`/`.delete()`, and
 * the C42 signed-url guard (signed-url-active-org-pin-guard.test.ts) covers only
 * the `createSignedUrl` sink. Nothing covered the by-id detail READ. This guard
 * does: it scans every dynamic detail route for the dangerous shape and fails
 * CI on any offender not in the ALLOWLIST — so the class cannot silently regrow.
 *
 * ANTI-EVASION: like the write-pin guard, the org pin must appear IN THE SAME
 * fluent statement as the flagged read (not merely somewhere in the enclosing
 * function). A sibling pinned read in the same file therefore cannot mask an
 * unpinned one — the exact way the stragglers slipped past manual review.
 *
 * SCOPE / non-goals (mirroring the write-pin guard):
 *   - TENANT client only. Reads on the SERVICE-ROLE (`createAdminClient()`)
 *     client bypass RLS entirely — a different security model, out of scope.
 *   - Single-row reads only (`.single()`/`.maybeSingle()`). List reads carry no
 *     `.eq("id", …)` subject and are covered by the list-scoping suites.
 *   - Writes are out of scope (the write-pin guard owns `.update()`/`.delete()`).
 *   - Scoped to dynamic `app/(app)` `[id]` detail routes: a by-id subject read
 *     addressed by a URL param is exactly the shape this class is about.
 *   - This guard adds NO migration and changes NO RLS policy — a static scan.
 */

const ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Org-scoped table set — derived from the migrations (the source of truth),
// exactly like the write-pin guard. A table is "org-scoped" if a migration
// creates it with an `org_id` column or adds one later. Deriving it (rather
// than hard-coding) means a NEW org-scoped table is protected the moment its
// migration lands.
//
// NOTE vs the write-pin guard: this derivation ALSO matches quoted identifiers
// (`create table … public."quotes" (`). The baseline schema quotes the earliest
// (and highest-value) tables — quotes, customers, leads, properties, invoices'
// ancestors — and an unquoted-only regex silently drops them, which would make
// this guard vacuous for exactly the rows that matter most.
// ---------------------------------------------------------------------------
function deriveOrgScopedTables(): Set<string> {
  const dir = join(ROOT, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const set = new Set<string>();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const createRe =
      /create table (?:if not exists )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql))) {
      const table = m[1] ?? "";
      const body = m[2] ?? "";
      if (table && /\borg_id\b/.test(body)) set.add(table);
    }
    const alterRe =
      /alter table (?:only )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,120}?add column (?:if not exists )?org_id/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = alterRe.exec(sql))) {
      if (m2[1]) set.add(m2[1]);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Source scanning helpers (string-aware). Comments are blanked so prose that
// mentions the shape never triggers a match; string literals are preserved so
// table names and `.eq("id", …)` inside code count.
// ---------------------------------------------------------------------------

/** Blank out comments while preserving string/template contents verbatim. */
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

/** Index of the '(' matching the ')' at `close` (paren-only). */
function matchParenBack(src: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src.charAt(i) === ")") depth++;
    else if (src.charAt(i) === "(") { depth--; if (depth === 0) return i; }
  }
  return -1;
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

/**
 * The complete logical read chain for a `.from(` — precise per-statement, so a
 * SIBLING read in the same `Promise.all([...])` (or the same file) is never
 * lumped in. Handles the ONE cast-wrapper indirection the codebase uses for
 * dynamically-typed reads:
 *
 *     await (supabase.from("t" as never) as unknown as {…}).select(…).eq(…).maybeSingle()
 *
 * where the `.select()` hangs off the parenthesised+casted expression, not off
 * `.from(...)` directly. In that shape a bare chain-walk from `.from` stops at
 * the wrapper's `)`; we detect the wrapper (the receiver of `.from` is preceded
 * by `(`), jump to its matching `)`, and continue consuming the chain from there.
 */
function readChain(src: string, dotIdx: number): string {
  const bareEnd = consumeChain(src, dotIdx);
  // Locate the receiver of `.from` and see whether it sits inside a `(… )` group.
  let r = dotIdx - 1;
  while (r >= 0 && /\s/.test(src.charAt(r))) r--;
  if (src.charAt(r) === ")") {
    // Receiver is itself a call, e.g. `bp(tenant).from(...)`; jump before it.
    const o = matchParenBack(src, r);
    r = o - 1;
    while (r >= 0 && /\s/.test(src.charAt(r))) r--;
  }
  while (r >= 0 && /[A-Za-z0-9_$]/.test(src.charAt(r))) r--; // over the receiver ident
  while (r >= 0 && /\s/.test(src.charAt(r))) r--;
  if (src.charAt(r) === "(") {
    // Wrapped: `(<receiver>.from(...) as T …).<rest>`. Continue after the group.
    const close = matchParen(src, r);
    if (close > -1 && close >= bareEnd - 1) {
      let n = close + 1;
      while (n < src.length && /\s/.test(src.charAt(n))) n++;
      if (src.charAt(n) === ".") {
        return src.slice(dotIdx, consumeChain(src, n));
      }
    }
  }
  return src.slice(dotIdx, bareEnd);
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

/** Is the receiver of this `.from(` the service-role/admin client? */
function receiverIsAdmin(src: string, dotIdx: number, admins: Set<string>): boolean {
  let i = dotIdx - 1;
  while (i >= 0 && /\s/.test(src.charAt(i))) i--;
  if (src.charAt(i) === ")") {
    // Inline wrapper form, e.g. `createAdminClient().from(...)`.
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

const HAS_ID = /\.\s*eq\s*\(\s*["']id["']/;
const HAS_ORG = /\.\s*eq\s*\(\s*["']org_id["']/;
const IS_WRITE = /\.\s*(?:update|delete|insert|upsert)\s*\(/;
// The single-row read terminals. `.maybeSingle:`/`.single:` COLON forms inside
// an inline cast type literal (`{ maybeSingle: () => Promise<…> }`) are NOT
// matched — they lack the leading `.` and trailing `(` — so the cast-wrapper
// read shape used by diary/[id] and expenses/[id] is handled correctly.
const TERMINAL = /\.\s*(?:single|maybeSingle)\s*\(/;

function idArgOf(chain: string): string {
  const m =
    /\.\s*eq\s*\(\s*["']id["']\s*,\s*([^,)]+?)\s*\)/.exec(chain);
  return m && m[1] ? m[1].trim() : "?";
}

export type ReadOffender = {
  rel: string;
  table: string;
  key: string;
  chain: string;
};

/**
 * The core detector, factored out so the calibration block can drive it with
 * synthetic fixtures. For each `.from("<org table>")`, it isolates the fluent
 * read STATEMENT as the slice from the `.from(` up to and including its FIRST
 * `.single()`/`.maybeSingle()` terminal — which, because a read statement never
 * contains a second `.from(` before its own terminal, is precisely this read's
 * chain. The active-org pin must appear IN that slice; a pin on a sibling
 * statement does not count.
 */
export function findReadOffendersInSource(
  rel: string,
  raw: string,
  orgTables: Set<string>,
): ReadOffender[] {
  const src = stripComments(raw);
  const admins = adminVars(src);
  const out: ReadOffender[] = [];
  const fromRe = /\.\s*from\s*\(\s*["']([a-z_][a-z0-9_]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) {
    const table = m[1] ?? "";
    const dotIdx = m.index;
    if (!table || !orgTables.has(table)) continue;
    const chain = readChain(src, dotIdx); // precise per-statement chain
    if (!TERMINAL.test(chain)) continue; // single-row reads only
    if (IS_WRITE.test(chain)) continue; // write (owned by the write-pin guard)
    if (!HAS_ID.test(chain)) continue; // by-id subject reads only
    if (HAS_ORG.test(chain)) continue; // already pinned in-statement → safe
    if (receiverIsAdmin(src, dotIdx, admins)) continue; // service-role → out of scope
    out.push({
      rel,
      table,
      key: `${rel}::${table}::${idArgOf(chain)}`,
      chain: chain.replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return out;
}

/**
 * Walk `app/(app)`, returning only files that live inside a DYNAMIC segment
 * (a path component like `[id]`, `[token]`, `[versionId]`). That is the detail-
 * route family this class is about: a subject addressed by a URL param.
 */
function walkDynamicRoutes(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", "__tests__"].includes(e.name)) continue;
      walkDynamicRoutes(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && /\[[^/]+\][/\\]/.test(full + "/")) {
      acc.push(full);
    }
  }
}

function scanRepo(orgTables: Set<string>): ReadOffender[] {
  const files: string[] = [];
  walkDynamicRoutes(join(ROOT, "app/(app)"), files);
  const out: ReadOffender[] = [];
  for (const f of files) {
    out.push(
      ...findReadOffendersInSource(
        f.replace(ROOT + "/", ""),
        readFileSync(f, "utf8"),
        orgTables,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// ALLOWLIST — genuinely-safe by-id tenant single-row reads in a dynamic detail
// route that intentionally do NOT carry an in-statement `.eq("org_id", …)`.
// Each entry states WHY it cannot leak across the active-org boundary. Key
// shape: `<relative path>::<table>::<id-argument>`. Keep this TIGHT — a stale
// entry (one that no longer matches a real site) fails the suite.
// ---------------------------------------------------------------------------
const ALLOWLIST: Record<string, string> = {
  // RESOLVE-THEN-COMPARE. removeInvoicePayment fetches the payment's `org_id`
  // and immediately refuses a mismatch (`if (row.org_id !== ctx.org.id)
  // redirect(".../error=forbidden")`) BEFORE acting, and the DELETE that follows
  // is itself org-pinned (proven by the write-pin guard). The read deliberately
  // selects org_id to run that comparison and keeps the forbidden-vs-not_found
  // distinction; adding an in-chain pin would collapse "forbidden" into a bare
  // "not found". Mirrors the confirmBankMatch entry in the write-pin guard.
  "app/(app)/invoices/[id]/payment-actions.ts::invoice_payments::paymentId":
    "resolve-then-compare: row.org_id is checked against ctx.org.id before use and the follow-up DELETE is org-pinned; the read selects org_id precisely to run that check",
};

// ===========================================================================

describe("active-org read-pin guard · org-scoped table derivation", () => {
  const orgTables = deriveOrgScopedTables();

  it("derives a substantial org-scoped table set from the migrations", () => {
    // A derivation that silently collapsed to ~0 would make the whole guard a
    // no-op. The real schema has 150+ org-scoped tables.
    expect(orgTables.size).toBeGreaterThan(150);
  });

  it("includes the three tables the red-team wave found unpinned (quoted-identifier baseline)", () => {
    for (const t of ["quotes", "site_diary_entries", "expense_drafts"]) {
      expect(orgTables.has(t), `${t} should be recognised as org-scoped`).toBe(true);
    }
  });

  it("includes the other high-value quoted-identifier baseline tables", () => {
    // These are created as `public."customers" (` etc.; an unquoted-only regex
    // would drop them and leave the guard blind to the highest-value rows.
    for (const t of ["customers", "leads", "properties"]) {
      expect(orgTables.has(t), `${t} should be recognised as org-scoped`).toBe(true);
    }
  });
});

describe("active-org read-pin guard · detector calibration (synthetic)", () => {
  // These fixtures pin the DETECTOR's behaviour so the guard cannot be quietly
  // weakened. The wrapped-cast fixtures reproduce the exact shape the red-team
  // wave found unpinned in diary/[id] and expenses/[id].
  const org = new Set(["quotes", "site_diary_entries", "expense_drafts"]);

  it("FLAGS a by-id tenant read with no org pin (plain chain)", () => {
    const bad =
      'const supabase = await createClient();\n' +
      'const { data } = await supabase.from("quotes").select("id, total").eq("id", id).maybeSingle();';
    const found = findReadOffendersInSource("fixture.tsx", bad, org);
    expect(found).toHaveLength(1);
    expect(found[0]?.table).toBe("quotes");
  });

  it("FLAGS a by-id tenant read with no org pin (wrapped-cast chain — diary/expenses shape)", () => {
    const bad =
      'const { data: entry } = await (\n' +
      '  supabase.from("site_diary_entries" as never) as unknown as {\n' +
      '    select: (cols: string) => {\n' +
      '      eq: (k: string, v: unknown) => {\n' +
      '        maybeSingle: () => Promise<{ data: DiaryRow | null }>;\n' +
      '      };\n' +
      '    };\n' +
      '  }\n' +
      ').select("id, job_id").eq("id", id).maybeSingle();';
    const found = findReadOffendersInSource("fixture.tsx", bad, org);
    expect(found).toHaveLength(1);
    expect(found[0]?.table).toBe("site_diary_entries");
  });

  it("PASSES the same read once the active-org pin is chained in-statement", () => {
    const good =
      'await supabase.from("quotes").select("id, total").eq("id", id).eq("org_id", ctx.org.id).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", good, org)).toHaveLength(0);
  });

  it("PASSES the wrapped-cast read once the active-org pin is chained in-statement", () => {
    const good =
      'await (\n' +
      '  supabase.from("expense_drafts" as never) as unknown as {\n' +
      '    select: (cols: string) => {\n' +
      '      eq: (k: string, v: unknown) => {\n' +
      '        eq: (k: string, v: unknown) => {\n' +
      '          maybeSingle: () => Promise<{ data: DraftRow | null }>;\n' +
      '        };\n' +
      '      };\n' +
      '    };\n' +
      '  }\n' +
      ').select("id").eq("id", id).eq("org_id", ctx.org.id).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", good, org)).toHaveLength(0);
  });

  it("does NOT let a SIBLING pinned read in the same file mask an unpinned one", () => {
    // The exact evasion the stragglers relied on: one read pinned, another not.
    const mixed =
      'await supabase.from("quotes").select("id").eq("id", id).eq("org_id", ctx.org.id).maybeSingle();\n' +
      'await supabase.from("expense_drafts").select("id").eq("id", id).maybeSingle();';
    const found = findReadOffendersInSource("fixture.tsx", mixed, org);
    expect(found).toHaveLength(1);
    expect(found[0]?.table).toBe("expense_drafts");
  });

  it("PASSES a read on the SERVICE-ROLE client (out of scope)", () => {
    const admin =
      'const admin = createAdminClient();\n' +
      'await admin.from("quotes").select("id").eq("id", id).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", admin, org)).toHaveLength(0);
    const inline =
      'await createAdminClient().from("quotes").select("id").eq("id", id).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", inline, org)).toHaveLength(0);
  });

  it("IGNORES a read on a non-org-scoped table", () => {
    const global =
      'await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", global, org)).toHaveLength(0);
  });

  it("IGNORES a list read (no .single()/.maybeSingle() terminal)", () => {
    const list =
      'await supabase.from("quotes").select("id").eq("id", id);';
    expect(findReadOffendersInSource("fixture.tsx", list, org)).toHaveLength(0);
  });

  it("IGNORES a child read keyed by a foreign key, not id", () => {
    const child =
      'await supabase.from("quotes").select("id").eq("quote_id", id).maybeSingle();';
    expect(findReadOffendersInSource("fixture.tsx", child, org)).toHaveLength(0);
  });

  it("IGNORES a write (owned by the write-pin guard)", () => {
    const write =
      'await supabase.from("quotes").update({ status }).eq("id", id).select("id").single();';
    expect(findReadOffendersInSource("fixture.tsx", write, org)).toHaveLength(0);
  });

  it("does NOT let a comment mentioning the shape trigger a match", () => {
    const commented =
      '// await supabase.from("quotes").select("id").eq("id", id).maybeSingle()\n' +
      'const x = 1;';
    expect(findReadOffendersInSource("fixture.tsx", commented, org)).toHaveLength(0);
  });
});

describe("active-org read-pin guard · every dynamic detail route is swept", () => {
  const orgTables = deriveOrgScopedTables();
  const offenders = scanRepo(orgTables);

  it("RED-calibration: stripping the pin from each fixed file re-flags it (guard is not vacuous)", () => {
    // The three files the red-team wave found. This proves — permanently, in CI —
    // that the detector genuinely reaches these routes and would catch a
    // regression: remove their in-statement `.eq("org_id", …)` and each becomes
    // an offender again. (They pass the sweep above precisely because they are
    // now pinned, not because the scanner never sees them.)
    const cases: Array<[string, string]> = [
      ["app/(app)/quotes/[id]/page.tsx", "quotes"],
      ["app/(app)/diary/[id]/page.tsx", "site_diary_entries"],
      ["app/(app)/expenses/[id]/page.tsx", "expense_drafts"],
    ];
    for (const [rel, table] of cases) {
      const raw = readFileSync(join(ROOT, rel), "utf8");
      // Remove every active-org pin so the subject read reverts to by-id only.
      const stripped = raw.replace(/\.eq\(\s*["']org_id["'][^)]*\)/g, "");
      const found = findReadOffendersInSource(rel, stripped, orgTables);
      expect(
        found.some((o) => o.table === table),
        `${rel}: with the org pin stripped the detector must flag the ${table} by-id read`,
      ).toBe(true);
    }
  });

  it("every by-id tenant single-row read on an org-scoped table is pinned or allowlisted", () => {
    const unlisted = offenders.filter((o) => !(o.key in ALLOWLIST));
    const report = unlisted
      .map((o) => `  • ${o.rel}\n      ${o.table} → ${o.chain}`)
      .join("\n");
    expect(
      unlisted,
      unlisted.length === 0
        ? ""
        : `Unpinned by-id tenant single-row read(s) on org-scoped table(s) in a ` +
            `dynamic detail route — add .eq("org_id", ctx.org.id) to the read, ` +
            `drive it off an org-pinned loader (e.g. lib/jobs/load.ts), or (if ` +
            `genuinely safe) add a reasoned ALLOWLIST entry:\n${report}`,
    ).toHaveLength(0);
  });

  it("has no stale ALLOWLIST entries (each must still match a real site)", () => {
    const liveKeys = new Set(offenders.map((o) => o.key));
    const stale = Object.keys(ALLOWLIST).filter((k) => !liveKeys.has(k));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `ALLOWLIST entries no longer match any site (fixed or moved — delete ` +
            `these):\n${stale.map((k) => `  • ${k}`).join("\n")}`,
    ).toHaveLength(0);
  });
});
