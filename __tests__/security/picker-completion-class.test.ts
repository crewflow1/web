import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * PICKER-COMPLETION CLASS GUARD (repo-wide, SHAPE-based, FAIL-CLOSED).
 *
 * THE DEFECT CLASS. A CRM/finance edit form renders an OPTIONAL foreign-key
 * reference as `<select defaultValue={savedId}>` whose <option>s come from a
 * fetched list. If that list does not contain the currently-saved id — because
 * the option-source reader was capped at `.limit(N)` (PostgREST also clamps at
 * max_rows=1000) or otherwise filtered — then NO <option> matches, the browser
 * silently falls back to the empty `value=''` sentinel, and the next (possibly
 * unrelated) save submits '' → the server writes the reference as NULL. A valid
 * link is lost with no error and no user intent. This shipped on the jobs/leads
 * assignee pickers (memberships `.limit(500)`), and the same shape lived on the
 * supplier pickers (`listSuppliersForOrg .limit(500)`), the site picker
 * (`listSitesForOrg .limit(500)`) and the bounded job pickers.
 *
 * THE INVARIANT (two acceptable shapes, EITHER is enough):
 *   (A) the option-source reader PAGES the complete set via `fetchAllRows`
 *       (no cap), so the saved id is always present; OR
 *   (B) the form PRE-INJECTS the currently-set value as a preserved <option>
 *       (`withPreservedOption`, or the equivalent inline `.some(o => o.id === …)
 *       ? [preserved, …] : list` idiom), so even a capped/filtered list can
 *       never drop the saved id.
 * In practice the fixed surfaces do BOTH (belt-and-braces).
 *
 * WHY THIS GUARD IS SHAPE-BASED, NOT TABLE-BASED. The sibling F-1 guards
 * (f1-limit-clamp-guard / f1-bare-select-guard) key on a hardcoded set of
 * HIGH_VALUE/PRODUCER *tables*. `memberships`, `users`, `suppliers` and `sites`
 * were in NEITHER set and their `.limit(500)` is provably <=1000, so the staff /
 * supplier / site pickers slipped past all three nets. This guard instead keys
 * on the SHAPE that actually carries the bug — a writable-reference <select>
 * re-rendered with a saved value on edit — so it covers those readers AND any
 * future picker table without an allowlist edit.
 *
 * FAIL-CLOSED. Every writable-reference <select> that re-renders a saved value
 * (a non-empty, non-`required` `defaultValue`/`value`) MUST have its option
 * source preserve-protected in the form. The ALLOWLIST below carries ONLY
 * genuinely-not-a-silent-null selects (create-only forms with no saved-record
 * re-render, per-line explicit-confirm actions) — each with a written reason.
 * A `required` select is exempt because an empty submit fails validation LOUDLY
 * (values echoed, nothing written) — the opposite of the silent NULL this class
 * is about; a create-only `defaultValue=""` select has no saved id to drop.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app/(app)", "app/q", "app/customer-portal"];

/**
 * Column names whose selected value is written back to a reference / foreign-key
 * column. A <select> named one of these is a writable-reference picker. A plain
 * enum/status dropdown (`status`, `source`, `urgency`, `priority`, `unit`,
 * `vat_rate`, `kind`, …) is NOT here, so it is never flagged — no allowlist
 * needed for genuinely-bounded, non-writable selects.
 */
const WRITABLE_REF_NAMES = new Set<string>([
  "assigned_to",
  "customer_id",
  "property_id",
  "lead_id",
  "job_id",
  "supplier_id",
  "finance_provider_id",
  "preferred_supplier_id",
  "home_site_id",
  "site_id",
  "user_id",
  "staff_id",
  "quote_id",
  "invoice_id",
  "contact_id",
  "vehicle_id",
  "asset_id",
  "purchase_order_id",
  "category_id",
  "risk_assessment_id",
  "permit_to_work_id",
  "parent_id",
  "manager_id",
  "owner_id",
]);

/**
 * `rel:name` → written reason. ONLY genuinely-not-a-silent-null writable-ref
 * selects. NEVER add a real offender here — drive the guard green by paging the
 * reader or preserve-injecting the saved id, never by allowlisting.
 */
const ALLOWLIST: Record<string, string> = {
  // Create/new forms: the <select> defaults to a query-param / preset context id
  // on the NEW page, never to a saved record being edited, so there is no saved
  // reference for an untouched save to null. The EDIT counterparts resolve the
  // saved reference some other way (a single .eq('id') lookup, or a separate
  // preserve-injected control).
  "app/(app)/snags/_form.tsx:job_id":
    "create/new snag form — job_id defaults to the ?jobId preset, not a saved record; the EDIT surface (snags/[id]/page.tsx reassign) is the assignee picker and IS preserve-injected",
  "app/(app)/reviews/new/page.tsx:job_id":
    "create/new review form — job_id defaults to the ?job_id search param, not a saved record; there is no edit-a-review picker",
  "app/(app)/staff/rota/_create-form.tsx:job_id":
    "create-only rota shift form — job_id echoes a failed submit (pick()), not a saved record; assigning a shift is a create action, not an edit re-render of a saved reference",
};

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes("__tests__")) {
      out.push(p);
    }
  }
}

/** From `<select`/`<SelectField` at `tagStart`, return the index just past the
 * opening tag's closing `>` (the depth-0 `>`; `=>` inside `{...}` is skipped
 * because it sits at brace-depth >= 1). */
function openTagEnd(src: string, tagStart: number): number {
  let depth = 0;
  for (let i = tagStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return src.length;
}

/** Extract the value-binding expression (defaultValue/value): the literal string
 * for `="..."`, or the trimmed expression for `={…}` (no nested braces — every
 * real binding in scope is a simple expr). null when the attr is absent. */
function extractBinding(openTag: string): string | null {
  const lit = /\b(?:defaultValue|value)="([^"]*)"/.exec(openTag);
  if (lit) return lit[1]!.trim();
  const expr = /\b(?:defaultValue|value)=\{([^{}]*)\}/.exec(openTag);
  if (expr) return expr[1]!.trim();
  return null;
}

/** The options-source identifier: the FIRST `<ident>.map(` in the tag+children
 * region. For a <SelectField options={[…, ...SRC.map(…)]}> the SRC is inside the
 * tag; for a raw <select>…{SRC.map(…)} it is in the children. */
function optionSource(region: string): string | null {
  const m = /([A-Za-z_$][\w$]*)\.map\(/.exec(region);
  return m ? m[1]! : null;
}

/** True when `source` is preserve-protected in the file: assigned from
 * `withPreservedOption(...)`, OR built with the inline `.some(o => o.id === …)`
 * prepend idiom (toolbox). The RHS is captured with BALANCED brackets so a
 * `const X = useMemo(() => { … return withPreservedOption(…); }, […])` wrapper
 * (which contains `;`s inside its body) is read whole, not truncated at the
 * first semicolon. */
function isPreserveProtected(src: string, source: string): boolean {
  const esc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:const|let)\\s+${esc}\\s*=`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const rhsStart = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === ";" && depth === 0) break;
    }
    const rhs = src.slice(rhsStart, i);
    if (/withPreservedOption\s*\(/.test(rhs)) return true;
    if (/\.some\s*\([\s\S]*?\.id\s*===/.test(rhs)) return true; // inline preserve idiom
  }
  return false;
}

export type PickerOffender = { key: string; table: string; reason: string };

/** Every writable-reference edit-re-render <select> in one file whose option
 * source is NOT preserve-protected — the silent-NULL shape. */
export function pickerOffendersIn(rel: string, raw: string): PickerOffender[] {
  const src = stripComments(raw);
  const offenders: PickerOffender[] = [];
  const tagRe = /<(?:select|SelectField)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const tagStart = m.index;
    const tagEnd = openTagEnd(src, tagStart);
    const openTag = src.slice(tagStart, tagEnd);

    const nameM = /\bname="([a-z_]+)"/.exec(openTag);
    if (!nameM) continue; // dynamic name={…} (a wrapper component) — not scanned here
    const name = nameM[1]!;
    if (!WRITABLE_REF_NAMES.has(name)) continue; // enum/status/etc — never a ref

    // required ⇒ an empty submit fails validation LOUDLY, not a silent NULL.
    if (/(?:^|\s)required(?:\s|=|\/|>|$)/.test(openTag)) continue;

    const binding = extractBinding(openTag);
    if (binding === null) continue; // uncontrolled — not a saved-value re-render
    if (binding === "" || binding === '""') continue; // create-only, no saved id

    const region = src.slice(tagStart, Math.min(src.length, tagEnd + 600));
    // Inline `withPreservedOption(list, savedId, …).map(…)` directly in the
    // options — the saved id is preserved right at the mapping site.
    if (/withPreservedOption\s*\(/.test(region)) continue; // shape (B) satisfied
    const source = optionSource(region);
    if (!source) continue; // no mapped source — nothing to preserve
    if (isPreserveProtected(src, source)) continue; // shape (B) satisfied

    const line = src.slice(0, tagStart).split("\n").length;
    const key = `${rel}:${line}`;
    if (ALLOWLIST[`${rel}:${name}`]) continue;
    offenders.push({
      key,
      table: name,
      reason:
        `${key} → <select name="${name}"> re-renders a saved value ` +
        `(defaultValue=${JSON.stringify(binding)}) but its options (\`${source}\`) are NOT ` +
        `preserve-protected. An out-of-list saved id submits '' on an untouched save and NULLs ` +
        `the reference. Wrap the source in withPreservedOption (and page the reader) — or, if this ` +
        `is genuinely not a silent-null (create-only / required / explicit-confirm), add a ` +
        `rel:name ALLOWLIST entry with a reason.`,
    });
  }
  return offenders;
}

describe("picker-completion class — no writable-ref <select> can silently NULL a saved reference on edit", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of form files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every writable-reference edit picker is preserve-protected (paged reader + preserved option)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...pickerOffendersIn(rel, readFileSync(file, "utf8")).map((o) => o.reason));
    }
    expect(
      offenders,
      `Picker-completion silent-NULL trap. Each <select> below re-renders a SAVED foreign-key ` +
        `reference on edit but its option list can drop that id, so an untouched save writes NULL:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // ── TEETH (calibration): the detector must flag the exact pre-fix shapes of ──
  // all the offenders this wave closed, and go green on the fixed shape.
  it("RED on the pre-fix memberships/staff assignee picker; GREEN once preserve-wrapped", () => {
    // Pre-fix jobs/leads assignee: raw <select defaultValue={pick('assigned_to')}>
    // over a bare `staff.map` (fed by a `.limit(500)` memberships read).
    const preFix = [
      `<SelectField`,
      `  name="assigned_to"`,
      `  defaultValue={pick("assigned_to")}`,
      `  options={[`,
      `    { value: "", label: "— Unassigned —" },`,
      `    ...staff.map((s) => ({ value: s.id, label: s.full_name ?? s.email })),`,
      `  ]}`,
      `/>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/jobs/_form.tsx", preFix).length).toBeGreaterThan(0);

    const postFix = [
      `const staffOptions = withPreservedOption(staff, selectedAssignee, (id) => ({ id, full_name: "Current assignee", email: "" }));`,
      `<SelectField`,
      `  name="assigned_to"`,
      `  defaultValue={selectedAssignee}`,
      `  options={[`,
      `    { value: "", label: "— Unassigned —" },`,
      `    ...staffOptions.map((s) => ({ value: s.id, label: s.full_name ?? s.email })),`,
      `  ]}`,
      `/>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/jobs/_form.tsx", postFix)).toEqual([]);
  });

  it("RED on the pre-fix supplier / site / job raw-select pickers; GREEN when preserved", () => {
    const preSupplier = [
      `<select name="supplier_id" defaultValue={row.supplier_id ?? ""}>`,
      `  <option value="">— No supplier —</option>`,
      `  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/expenses/[id]/page.tsx", preSupplier).length).toBeGreaterThan(0);

    const preSite = [
      `<select name="home_site_id" defaultValue={v?.homeSiteId ?? ""}>`,
      `  <option value="">Not set</option>`,
      `  {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/fleet/_components/vehicle-form.tsx", preSite).length).toBeGreaterThan(0);

    const preJob = [
      `<select name="job_id" defaultValue={d.job_id ?? ""}>`,
      `  <option value="">No job (general)</option>`,
      `  {jobs.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/diary/_form.tsx", preJob).length).toBeGreaterThan(0);

    // withPreservedOption fix
    const postSupplier = [
      `const supplierOptions = withPreservedOption(suppliers, selectedSupplierId, (id) => ({ id, name: "Current supplier" }));`,
      `<select name="supplier_id" defaultValue={selectedSupplierId}>`,
      `  <option value="">— No supplier —</option>`,
      `  {supplierOptions.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/expenses/[id]/page.tsx", postSupplier)).toEqual([]);

    // inline-preserve idiom (toolbox) is also accepted
    const postInline = [
      `const jobOptions = d.job_id && !options.jobs.some((j) => j.id === d.job_id) ? [{ id: d.job_id, label: "Current job" }, ...options.jobs] : options.jobs;`,
      `<select name="job_id" defaultValue={d.job_id ?? ""}>`,
      `  <option value="">No job</option>`,
      `  {jobOptions.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/toolbox/_talk-form.tsx", postInline)).toEqual([]);
  });

  it("no false positive on enum / required / create-only selects", () => {
    // A status enum dropdown is not a writable ref → never flagged.
    const enumSelect = [
      `<SelectField name="status" defaultValue={pick("status", "new")} options={STATUS.map((s) => ({ value: s, label: s }))} />`,
    ].join("\n");
    expect(pickerOffendersIn("x.tsx", enumSelect)).toEqual([]);

    // A required writable-ref select fails an empty submit LOUDLY (not silent).
    const requiredSelect = [
      `<select name="customer_id" required defaultValue={sp.customer_id ?? ""}>`,
      `  {customers.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/reviews/new/page.tsx", requiredSelect)).toEqual([]);

    // A create-only select (literal empty default) has no saved id to drop.
    const createSelect = [
      `<select name="supplier_id" defaultValue="">`,
      `  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/assets/new/page.tsx", createSelect)).toEqual([]);
  });
});

// ── READER-LAYER TEETH: the option-source loaders that the missed surfaces used
// must PAGE (fetchAllRows), never a bare `.limit(500)`. This nails the exact
// readers the table-keyed F-1 guards were blind to. ──────────────────────────
describe("picker option-source readers page the complete set (F-1)", () => {
  const mustPage: Array<{ file: string; fn: string }> = [
    { file: "app/(app)/jobs/_form-helpers.ts", fn: "listStaffForOrg" },
    { file: "app/(app)/jobs/_form-helpers.ts", fn: "listCustomersForOrg" },
    { file: "app/(app)/leads/_form-helpers.ts", fn: "listStaffForLead" },
    { file: "app/(app)/leads/_form-helpers.ts", fn: "listCustomersForLead" },
    { file: "server/services/suppliers.ts", fn: "listSuppliersForOrg" },
    { file: "server/services/sites.ts", fn: "listSitesForOrg" },
    // The delay/EOT create form's REQUIRED job picker (jobs/[id] deep-links a
    // ?jobId= that can be older than any cap) — must page the full job set.
    { file: "app/(app)/delays/_data.ts", fn: "listJobOptions" },
  ];

  it("staff / customer / supplier / site loaders use fetchAllRows and carry no capped memberships/suppliers/sites read", () => {
    const failures: string[] = [];
    for (const { file, fn } of mustPage) {
      const src = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      const start = src.indexOf(`function ${fn}`);
      if (start === -1) {
        failures.push(`${file}: ${fn} not found (renamed? update this guard)`);
        continue;
      }
      // Body: up to the next top-level `export ` after the fn (good enough — these
      // files declare one exported fn per reader).
      const nextExport = src.indexOf("\nexport ", start + 1);
      const body = src.slice(start, nextExport === -1 ? src.length : nextExport);
      if (!/fetchAllRows/.test(body)) {
        failures.push(`${file}: ${fn} must page the complete set via fetchAllRows (F-1 picker class)`);
      }
      // The picker path must not carry a bare complete-set `.limit(500)`; a
      // provable capped list on the picker default path is the silent-null cause.
      if (/\.limit\(\s*500\s*\)/.test(body)) {
        failures.push(`${file}: ${fn} still carries a bare .limit(500) on the picker read`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
