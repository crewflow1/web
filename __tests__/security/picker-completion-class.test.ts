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
  // camelCase variant — the quality pickers use name="jobId" (create + draft-edit),
  // written back to inspection_test_plans.job_id by updateInspectionPlan. Without
  // this the required edit re-render of a saved job_id slipped every net.
  "jobId",
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
  // NOTE: snags/_form.tsx:job_id was allowlisted here with the reason
  // "defaults to a preset, not a saved record, so nothing to null". That reason
  // was VACUOUS — the OPTIONAL preset picker is deep-linked (?job=<id>) and its
  // out-of-cap preset fell to the leading "No job" empty option, silently NULLing
  // the job (the exact silent-null this class is about). It is now fixed at the
  // source: snags/new pages the reader and snags/_form preserve-injects the
  // preset (withPreservedOption), so the shape detector keeps it green legitimately.
  // NOTE: reviews/new/page.tsx:job_id was allowlisted here with the same refuted
  // "preset, not a saved record" reason. Its OPTIONAL job picker read only the
  // recent-200 completed jobs, so with >200 done jobs an older one could not be
  // attributed and a `?job_id=` preset past the cap fell to "— No specific job —".
  // Now fixed at source: reviews/new pages the completed-job set (fetchAllRows)
  // and preserve-injects the ?job_id preset (withPreservedOption), so the shape
  // detector keeps it green legitimately — no allowlist.
  "app/(app)/staff/rota/_create-form.tsx:job_id":
    "create-only rota shift form — job_id echoes a failed submit (pick()), not a saved record; assigning a shift is a create action, not an edit re-render of a saved reference",
  // Surfaced by the tightened `required` exemption (a required select bound to a
  // SAVED record field, l.matched_invoice_id, is no longer blanket-exempt). This
  // one is genuinely NOT a silent-null edit re-render: each bank line renders its
  // OWN one-field <form> whose only control is this required invoice_id <select>
  // (pre-selected to that line's suggested match) and whose only action is
  // confirmBankMatch for THAT line. There is no unrelated "untouched save" that
  // could null a stored reference — if the suggested match is absent the select
  // shows empty and `required` refuses the per-line Confirm LOUDLY, and the
  // options are the line's suggested invoices, not a capped global reader. This is
  // the "per-line explicit-confirm action" category, not the silent-null this
  // class targets.
  "app/(app)/payments/reconcile/[id]/page.tsx:invoice_id":
    "per-line explicit-confirm — single-field form, required select pre-set to the line's suggested match, only action confirms THAT line; empty submit is refused loudly, options are per-line suggestions not a capped reader; not a silent-null edit re-render",
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

/** True when `binding` reads a field off a LOADED record object
 * (`plan.job_id`, `row.supplier_id`, `l.matched_invoice_id`, `entry.job_id`) —
 * the edit-re-render shape a `required` attribute CANNOT protect. A create-only
 * echo is NOT this: a bare preset identifier (`presetJob`, `preselectedJobId`,
 * `customerId`), a query-string field (`sp.jobId`, `searchParams.x`,
 * `params.id`), or a `pick(...)` call. */
function isSavedRecordField(binding: string): boolean {
  // Drop a trailing default coalesce (`?? ""`, `|| ''`, `?? \`\``).
  const core = binding.replace(/\s*(?:\?\?|\|\|)\s*(?:""|''|``)\s*$/, "").trim();
  const m = /^([A-Za-z_$][\w$]*)\??\.[\w$]+$/.exec(core);
  if (!m) return false; // not a simple member access → create-only echo / literal
  const obj = m[1]!;
  // Query-string / form-echo objects are create-only, never a saved record.
  return !["sp", "searchParams", "params", "query", "props"].includes(obj);
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

    const nameM = /\bname="([a-zA-Z_]+)"/.exec(openTag);
    if (!nameM) continue; // dynamic name={…} (a wrapper component) — not scanned here
    const name = nameM[1]!;
    if (!WRITABLE_REF_NAMES.has(name)) continue; // enum/status/etc — never a ref

    const binding = extractBinding(openTag);
    if (binding === null) continue; // uncontrolled — not a saved-value re-render
    if (binding === "" || binding === '""') continue; // create-only, no saved id

    // `required` was BLANKET-exempt on the premise that an empty submit fails
    // validation LOUDLY. That premise holds for a CREATE form — the value is
    // echoed from the query string / a failed-submit pick(), and an empty submit
    // is refused with the fields intact. It is FALSE for an EDIT re-render of a
    // SAVED record's required reference: an out-of-cap saved id renders the select
    // EMPTY, and the operator is forced to abandon the edit or re-attribute to a
    // WRONG in-list option (silent mis-attribution) — not a loud refusal of an
    // empty save. So exempt a required select ONLY when its bound value is a
    // create-only echo (a bare preset identifier, a searchParams/params field, a
    // pick() echo, or a literal empty), never when it re-renders a SAVED record
    // field (`plan.job_id`, `row.supplier_id`, …). Saved-record required
    // edit-pickers fall through and must be preserve-protected (paged reader +
    // preserved option) or explicitly allowlisted with a reason — the reader-side
    // paging (see the auto-discovery guard below) is what actually protects them.
    if (/(?:^|\s)required(?:\s|=|\/|>|$)/.test(openTag) && !isSavedRecordField(binding)) {
      continue;
    }

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

  // The OPTIONAL preset-on-create variant (snags/new). Unlike the delay/report
  // job pickers it CANNOT lean on `required` — a snag need not belong to a job —
  // so a non-empty preset that is absent from the option list cannot fall to a
  // "first enabled option" the way a required select does; it falls to the
  // LEADING empty "No job" option and an untouched submit silently NULLs the job.
  // The ONLY defence is preserve-protecting the source in-file; a bare `jobs.map`
  // over a prop is the offending shape and MUST stay RED (this is what reverting
  // the snags fix reduces to — proving the guard's teeth, not the allowlist).
  it("RED on the pre-fix OPTIONAL preset-on-create job picker (snags); GREEN once preserve-wrapped", () => {
    const preFix = [
      `<select id="job_id" name="job_id" defaultValue={presetJob ?? ""}>`,
      `  <option value="">No job (general)</option>`,
      `  {jobs.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/snags/_form.tsx", preFix).length).toBeGreaterThan(0);

    const postFix = [
      `const jobOptions = withPreservedOption(jobs, presetJob || null, (id) => ({ id, label: "Selected job" }));`,
      `<select id="job_id" name="job_id" defaultValue={presetJob ?? ""}>`,
      `  <option value="">No job (general)</option>`,
      `  {jobOptions.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/snags/_form.tsx", postFix)).toEqual([]);
  });

  // (b)+(c) teeth: a REQUIRED select is NOT a get-out-of-jail card when it
  // re-renders a SAVED record field — the quality draft-edit shape. This also
  // exercises the camelCase `jobId` writable-ref name the quality pickers use.
  it("RED on a required EDIT re-render of a saved job_id (quality/[id]); GREEN once preserve-wrapped", () => {
    const preFix = [
      `<select id="edit-jobId" name="jobId" required defaultValue={plan.job_id ?? ""}>`,
      `  <option value="">Select a job…</option>`,
      `  {jobs.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/quality/[id]/page.tsx", preFix).length).toBeGreaterThan(0);

    const postFix = [
      `const jobOptions = withPreservedOption(jobs, plan.job_id ?? null, (id) => ({ id, label: "Current job" }));`,
      `<select id="edit-jobId" name="jobId" required defaultValue={plan.job_id ?? ""}>`,
      `  <option value="">Select a job…</option>`,
      `  {jobOptions.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/quality/[id]/page.tsx", postFix)).toEqual([]);

    // A required CREATE select that echoes the query string stays exempt (loud
    // empty submit, no saved id) — quality/new is `defaultValue={sp.jobId ?? ""}`.
    const createEcho = [
      `<select id="jobId" name="jobId" required defaultValue={sp.jobId ?? ""}>`,
      `  <option value="">Select a job…</option>`,
      `  {jobs.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}`,
      `</select>`,
    ].join("\n");
    expect(pickerOffendersIn("app/(app)/quality/new/page.tsx", createEcho)).toEqual([]);
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
// must PAGE (fetchAllRows), never a bare capped read. This nails the exact
// readers the table-keyed F-1 guards were blind to. ──────────────────────────

/** Return the body of `function <fn>` in `src`, from the declaration to the next
 * top-level `export ` (these reader files declare one exported fn per reader). */
function readerBody(src: string, fn: string): string | null {
  const start = src.indexOf(`function ${fn}`);
  if (start === -1) return null;
  const nextExport = src.indexOf("\nexport ", start + 1);
  return src.slice(start, nextExport === -1 ? src.length : nextExport);
}

describe("picker option-source readers page the complete set (F-1)", () => {
  // NON-JOB option-source readers (memberships / customers / suppliers / sites).
  // These live OUTSIDE _data.ts and read tables other than `jobs`, so the
  // jobs-table auto-discovery below cannot reach them — they stay individually
  // pinned here. The job pickers (delays / quality / diary / any future one) are
  // covered by AUTO-DISCOVERY, not this list, so a new job picker is caught
  // without a hand-list edit.
  const mustPage: Array<{ file: string; fn: string }> = [
    { file: "app/(app)/jobs/_form-helpers.ts", fn: "listStaffForOrg" },
    { file: "app/(app)/jobs/_form-helpers.ts", fn: "listCustomersForOrg" },
    { file: "app/(app)/leads/_form-helpers.ts", fn: "listStaffForLead" },
    { file: "app/(app)/leads/_form-helpers.ts", fn: "listCustomersForLead" },
    { file: "server/services/suppliers.ts", fn: "listSuppliersForOrg" },
    { file: "server/services/sites.ts", fn: "listSitesForOrg" },
  ];

  it("staff / customer / supplier / site loaders use fetchAllRows and carry no capped memberships/suppliers/sites read", () => {
    const failures: string[] = [];
    for (const { file, fn } of mustPage) {
      const src = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      const body = readerBody(src, fn);
      if (body === null) {
        failures.push(`${file}: ${fn} not found (renamed? update this guard)`);
        continue;
      }
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

// ── AUTO-DISCOVERY (kills the hand-list blind spot) ──────────────────────────
// The `mustPage` list above was, for job pickers, a HAND-MAINTAINED enumeration
// that only ever contained `delays`. Its siblings quality/_data.ts and
// diary/_data.ts read jobs at `.limit(200)` with no paging and were simply never
// listed, so the class re-hid. Instead of trusting a human to add each new
// picker reader, DISCOVER them: every `app/(app)/**/_data.ts` that exports a
// `list…Options` function reading the `jobs` table is a writable-ref job-picker
// source and MUST page via fetchAllRows. A picker reader added later is caught
// automatically — no allowlist edit, no way to silently miss it.

/** Reason-carrying allowlist for a discovered jobs-picker reader that legitimately
 * does NOT page (e.g. a genuinely bounded, non-writable use). Empty by design —
 * page the reader, don't allowlist it. */
const READER_PAGING_ALLOWLIST: Record<string, string> = {};

function walkDataFiles(dir: string, out: string[]): void {
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
    if (st.isDirectory()) walkDataFiles(p, out);
    else if (name === "_data.ts") out.push(p);
  }
}

type JobPickerReader = { key: string; file: string; fn: string; body: string };

/** Every `list…Options` function in an app/(app) _data.ts that reads the `jobs`
 * table — the writable-ref job-picker option sources, discovered structurally. */
function discoverJobPickerReaders(): JobPickerReader[] {
  const dataFiles: string[] = [];
  walkDataFiles(resolve(ROOT, "app/(app)"), dataFiles);
  const found: JobPickerReader[] = [];
  for (const abs of dataFiles) {
    const rel = abs.slice(ROOT.length + 1);
    const src = stripComments(readFileSync(abs, "utf8"));
    const fnRe = /export\s+(?:async\s+)?function\s+(list[A-Za-z0-9_]*Options)\b/g;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(src))) {
      const fn = m[1]!;
      const nextExport = src.indexOf("\nexport ", m.index + 1);
      const body = src.slice(m.index, nextExport === -1 ? src.length : nextExport);
      // Reads the jobs table? (`.from("jobs")` — quotes/backtick tolerant)
      if (/\.from\(\s*["'`]jobs["'`]\s*\)/.test(body)) {
        found.push({ key: `${rel}:${fn}`, file: rel, fn, body });
      }
    }
  }
  return found;
}

describe("every _data.ts job-picker reader pages the complete set — AUTO-DISCOVERED (no hand list)", () => {
  const readers = discoverJobPickerReaders();

  it("discovery is non-vacuous and covers the known job pickers (delays / quality / diary)", () => {
    // The discovery must actually inspect real files — an empty set would make
    // the paging assertion below trivially pass (the vacuous-guard failure mode).
    expect(readers.length).toBeGreaterThanOrEqual(3);
    expect(readers.map((r) => r.key).sort()).toEqual(
      expect.arrayContaining([
        "app/(app)/delays/_data.ts:listJobOptions",
        "app/(app)/diary/_data.ts:listJobOptions",
        "app/(app)/quality/_data.ts:listJobOptions",
      ]),
    );
  });

  it("each discovered job-picker reader pages via fetchAllRows and carries no bare .limit( on the jobs read", () => {
    const failures: string[] = [];
    for (const r of readers) {
      if (READER_PAGING_ALLOWLIST[r.key]) continue;
      if (!/fetchAllRows/.test(r.body)) {
        failures.push(
          `${r.key} reads the jobs table for a picker but does NOT page via fetchAllRows ` +
            `(F-1 picker-completion). An out-of-cap saved/preset job would be dropped from ` +
            `the option list. Page it on a stable (created_at desc, id desc) order like ` +
            `delays/_data.ts, or (only if genuinely bounded & non-writable) add a ` +
            `READER_PAGING_ALLOWLIST entry with a reason.`,
        );
      }
      if (/\.limit\(/.test(r.body)) {
        failures.push(
          `${r.key} carries a bare .limit( on the jobs picker read — a provable cap is the ` +
            `silent-drop cause. Remove it and page via fetchAllRows.range(from, to).`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
