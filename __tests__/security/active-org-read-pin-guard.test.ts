import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { deriveOrgScopedTables } from "./org-scoped-tables";

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
// Org-scoped table set — derived from the migrations by the SHARED,
// quoted-identifier-aware helper in ./org-scoped-tables (used by the write-pin
// guard too, so the two derivations can never drift). Quoted-identifier
// awareness matters here: the baseline schema quotes the earliest and
// highest-value tables (`public."quotes" (`, `"customers"`, `"leads"`,
// `"properties"`), and an unquoted-only regex silently drops them — which would
// make this guard vacuous for exactly the rows that matter most.
// ---------------------------------------------------------------------------

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
// SERVICE-LAYER sweep (the blind-spot closure). The route-file scan above sees
// only reads that live IN a dynamic route file. But a detail page can DELEGATE
// its primary subject read to a `server/services/*` or `lib/**` loader and carry
// no `.from` of its own (exactly how jobs/[id]/billing leaked: the page called
// loadJobBilling and the unpinned `.from("jobs").eq("id", …)` lived in
// server/services/billing.ts, invisible to the route scan). This walker runs the
// SAME detector over every service/lib source, so an unpinned by-id single-row
// read on an org-scoped table cannot hide behind a service-layer delegation.
// ---------------------------------------------------------------------------

const SERVICE_LIB_ROOTS = ["server/services", "lib"];

function walkTsFiles(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", "__tests__"].includes(e.name)) continue;
      walkTsFiles(full, acc);
    } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      acc.push(full);
    }
  }
}

function scanServiceLayer(orgTables: Set<string>): ReadOffender[] {
  const files: string[] = [];
  for (const root of SERVICE_LIB_ROOTS) walkTsFiles(join(ROOT, root), files);
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
// SERVICE_ALLOWLIST — genuinely-safe by-id tenant single-row reads in a
// server/services or lib loader that intentionally do NOT carry an in-statement
// `.eq("org_id", …)`. Same key shape and same TIGHT-list discipline as ALLOWLIST
// above: a stale entry (no live matching site) fails the suite. The canonical
// safe pattern here is RESOLVE-THEN-COMPARE — a mutation gate that SELECTs
// `org_id` and refuses a mismatch (`if (row.org_id !== ctx.org.id) return
// not_found`) before writing, so an in-chain pin would collapse the deliberate
// forbidden/not-found handling. These are WRITE gates, not detail-route READ
// loaders; the class this guard closes (a rendered subject) does not apply.
// ---------------------------------------------------------------------------
const SERVICE_ALLOWLIST: Record<string, string> = {
  // addBlueprintRevision: reads the drawing shell to gate an upload, then
  // `if (shell.org_id !== ctx.org.id) return { ok:false, error:"Drawing not
  // found." }` (blueprints.ts) BEFORE the version insert. The read selects
  // org_id precisely to run that check; it is a write gate, not a rendered read.
  "server/services/blueprints.ts::blueprints::input.blueprintId":
    "resolve-then-compare write gate: shell.org_id is checked against ctx.org.id (return not-found on mismatch) before the revision insert; the read selects org_id to run that check",
  // createJobDocument: reads the parent job to gate a document create, then
  // `if (!jobRow || jobRow.org_id !== ctx.org.id) return { ok:false,
  // error:"job_not_found" }` (job-documents.ts) BEFORE the insert. Same
  // resolve-then-compare write-gate shape; not a rendered detail read.
  "server/services/job-documents.ts::jobs::input.jobId":
    "resolve-then-compare write gate: jobRow.org_id is checked against ctx.org.id (return job_not_found on mismatch) before the document insert; the read selects org_id to run that check",
};

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

// ===========================================================================
// BLIND-SPOT CLOSURE #1 — the jobs/[id]/** detail family must route its subject
// through the org-pinned chokepoint. This is the class that let jobs/[id]/billing
// slip: the page carried no `.from` (it delegated to loadJobBilling), so the
// route-file scan above saw nothing, and the unpinned read lived in the service
// layer. The rule for this family is simple and already followed by every OTHER
// sub-page: resolve the subject via loadJobForOrg(...) + notFound() (the
// lib/jobs/load.ts chokepoint), OR pin org_id on an in-page by-id jobs read.
// ===========================================================================
describe("active-org read-pin guard · jobs/[id]/** subject goes through the org chokepoint", () => {
  const orgTables = deriveOrgScopedTables();
  const jobPages: string[] = [];
  (function collect(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) collect(full);
      else if (e.name === "page.tsx") jobPages.push(full);
    }
  })(join(ROOT, "app/(app)/jobs/[id]"));

  it("finds the jobs/[id] sub-page family", () => {
    // If this ever collapses to ~0 the assertion below becomes vacuous.
    expect(jobPages.length).toBeGreaterThanOrEqual(5);
  });

  it("every jobs/[id]/** page resolves its subject via loadJobForOrg + notFound() or pins org_id in-page", () => {
    const bad: string[] = [];
    for (const f of jobPages) {
      const rel = f.replace(ROOT + "/", "");
      const raw = readFileSync(f, "utf8");
      // Accept both the plain call and the generic form `loadJobForOrg<{…}>(`.
      const usesChokepoint =
        /loadJobForOrg\s*[<(]/.test(raw) && /notFound\s*\(/.test(raw);
      // In-page fallback: a jobs by-id read that is itself org-pinned (so the
      // detector reports no offender for this file) AND actually reads jobs.
      const stripped = stripComments(raw);
      const pinsInPage =
        /\.from\(\s*["']jobs["']/.test(stripped) &&
        HAS_ORG.test(stripped) &&
        findReadOffendersInSource(rel, raw, orgTables).length === 0;
      if (!(usesChokepoint || pinsInPage)) bad.push(rel);
    }
    expect(
      bad,
      bad.length === 0
        ? ""
        : `jobs/[id]/** page(s) that neither route the subject through ` +
            `loadJobForOrg(...) + notFound() nor pin org_id on an in-page jobs ` +
            `read — a delegated (no-.from) page like this is exactly how ` +
            `jobs/[id]/billing leaked another org's billing:\n` +
            bad.map((b) => `  • ${b}`).join("\n"),
    ).toHaveLength(0);
  });

  it("RED-calibration: jobs/[id]/billing without its loadJobForOrg gate is flagged", () => {
    // Prove the chokepoint assertion is not vacuous for the file that leaked:
    // strip the loadJobForOrg gate from billing and it must fail the rule.
    const rel = "app/(app)/jobs/[id]/billing/page.tsx";
    const raw = readFileSync(join(ROOT, rel), "utf8");
    const stripped = raw
      .replace(/loadJobForOrg/g, "loadJobBilling_noGate")
      .replace(/\bnotFound\b/g, "noop");
    const usesChokepoint =
      /loadJobForOrg\s*\(/.test(stripped) && /notFound\s*\(/.test(stripped);
    const s2 = stripComments(stripped);
    const pinsInPage =
      /\.from\(\s*["']jobs["']/.test(s2) &&
      HAS_ORG.test(s2) &&
      findReadOffendersInSource(rel, stripped, orgTables).length === 0;
    expect(usesChokepoint || pinsInPage).toBe(false);
  });
});

// ===========================================================================
// BLIND-SPOT CLOSURE #2 — the service/lib loader sweep. Runs the SAME by-id
// single-row read detector over server/services/*.ts and lib/**/*.ts, so an
// unpinned subject read cannot hide behind a delegating (no-.from) detail page.
// This is the guard that would have caught loadJobBilling directly.
// ===========================================================================
describe("active-org read-pin guard · service/lib loaders pin org on by-id reads", () => {
  const orgTables = deriveOrgScopedTables();
  const offenders = scanServiceLayer(orgTables);

  it("RED-calibration: server/services/billing.ts loadJobBilling without its org pins is flagged", () => {
    // The exact leak this fix closes. Strip every in-statement org pin from the
    // billing service and the detector must flag the subject `jobs` by-id read —
    // proving the sweep genuinely reaches the service layer and is not vacuous.
    const rel = "server/services/billing.ts";
    const raw = readFileSync(join(ROOT, rel), "utf8");
    const stripped = raw.replace(/\.eq\(\s*["']org_id["'][^)]*\)/g, "");
    const found = findReadOffendersInSource(rel, stripped, orgTables);
    expect(
      found.some((o) => o.table === "jobs"),
      "with the org pin stripped the detector must flag billing.ts's jobs by-id read",
    ).toBe(true);
  });

  it("every by-id tenant single-row read in a service/lib loader is pinned or allowlisted", () => {
    const unlisted = offenders.filter((o) => !(o.key in SERVICE_ALLOWLIST));
    const report = unlisted
      .map((o) => `  • ${o.rel}\n      ${o.table} → ${o.chain}\n      key: ${o.key}`)
      .join("\n");
    expect(
      unlisted,
      unlisted.length === 0
        ? ""
        : `Unpinned by-id tenant single-row read(s) on org-scoped table(s) in a ` +
            `service/lib loader — a delegating detail page renders these without ` +
            `an active-org pin. Add .eq("org_id", orgId) to the read, or (if a ` +
            `genuinely-safe resolve-then-compare write gate) add a reasoned ` +
            `SERVICE_ALLOWLIST entry:\n${report}`,
    ).toHaveLength(0);
  });

  it("has no stale SERVICE_ALLOWLIST entries (each must still match a real site)", () => {
    const liveKeys = new Set(offenders.map((o) => o.key));
    const stale = Object.keys(SERVICE_ALLOWLIST).filter((k) => !liveKeys.has(k));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `SERVICE_ALLOWLIST entries no longer match any site (fixed or moved — ` +
            `delete these):\n${stale.map((k) => `  • ${k}`).join("\n")}`,
    ).toHaveLength(0);
  });
});
