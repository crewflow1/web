import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261046000000_cis_subcontractors.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

/**
 * Strip SQL line comments so NEGATIVE assertions test the EXECUTABLE statements
 * and are not satisfied (or defeated) by documentation that quotes a policy.
 */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The table's RLS is ADMIN-ONLY — no member read of a tax identifier
// ---------------------------------------------------------------------------

describe("cis_subcontractors — RLS is admin-only, not the member-read norm", () => {
  const mig = read(MIGRATION);
  const sql = sqlOnly(mig);

  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.cis_subcontractors enable row level security/i);
  });

  it("gates the single policy on public.is_org_admin for BOTH using and with check", () => {
    expect(sql).toMatch(/for all\s+to authenticated/i);
    expect(sql).toMatch(/using\s*\(\s*public\.is_org_admin\(org_id\)\s*\)/i);
    expect(sql).toMatch(/with check\s*\(\s*public\.is_org_admin\(org_id\)\s*\)/i);
  });

  it("NEVER grants access via org membership — current_org_ids would expose UTRs to every member", () => {
    // This is the single most important line in the file. `suppliers` itself is
    // member-readable; this extension deliberately is not, which is the whole
    // reason the UTR lives here rather than on the supplier row.
    expect(sql).not.toMatch(/current_org_ids/);
  });

  it("declares exactly ONE policy on the table (no second, looser one)", () => {
    const policies = sql.match(/create policy[\s\S]*?on public\.cis_subcontractors/gi) ?? [];
    expect(policies).toHaveLength(1);
  });

  it("has no permissive per-command policy that could widen reads", () => {
    expect(sql).not.toMatch(/for select\s+to/i);
    expect(sql).not.toMatch(/for insert\s+to/i);
    expect(sql).not.toMatch(/for update\s+to/i);
    expect(sql).not.toMatch(/for delete\s+to/i);
  });

  it("is the LAST migration to define any cis_subcontractors policy (replayed state)", () => {
    // Migrations replay in filename order; whichever creates the policy last wins.
    const definers = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /create policy[\s\S]{0,200}?cis_subcontractors/i.test(readFileSync(resolve(MIG_DIR, f), "utf8")))
      .sort();
    expect(definers.length).toBeGreaterThanOrEqual(1);
    const last = definers[definers.length - 1]!;
    expect(last).toBe("20261046000000_cis_subcontractors.sql");
    const src = sqlOnly(readFileSync(resolve(MIG_DIR, last), "utf8"));
    expect(src).toMatch(/public\.is_org_admin\(org_id\)/);
    expect(src).not.toMatch(/current_org_ids/);
  });
});

// ---------------------------------------------------------------------------
// 2. The UTR is format-constrained and tenant-bound at the database
// ---------------------------------------------------------------------------

describe("cis_subcontractors — identifier + tenant integrity", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("constrains the UTR to exactly 10 digits", () => {
    expect(sql).toMatch(/utr\s*~\s*'\^\[0-9\]\{10\}\$'/);
  });

  it("binds the profile to its supplier with a COMPOSITE (supplier_id, org_id) FK", () => {
    // A bare supplier_id FK would let a forged id cross tenants; the composite
    // key binds every role, including service_role.
    expect(sql).toMatch(
      /foreign key\s*\(\s*supplier_id\s*,\s*org_id\s*\)\s*references\s+public\.suppliers\s*\(\s*id\s*,\s*org_id\s*\)/i,
    );
  });

  it("pairs the deduction rate to the status with a CHECK, not only a trigger", () => {
    expect(sql).toMatch(/constraint cis_subcontractors_rate_matches_status check/i);
    // `is not distinct from` rather than `=`, so a NULL rate cannot satisfy the
    // constraint by evaluating to NULL instead of false.
    expect(sql).toMatch(/is not distinct from/i);
  });

  it("keys the table (org_id, supplier_id) so a profile is 1:1 and tenant-scoped", () => {
    expect(sql).toMatch(/primary key\s*\(\s*org_id\s*,\s*supplier_id\s*\)/i);
  });

  it("pins search_path on the trigger function (no schema-hijack surface)", () => {
    expect(sql).toMatch(/create or replace function public\.tg_cis_rate_authority\(\)[\s\S]*?set search_path = public/i);
  });
});

// ---------------------------------------------------------------------------
// 3. The UTR never reaches a customer-facing path
// ---------------------------------------------------------------------------

describe("cis_subcontractors — the UTR never leaves the admin surface", () => {
  const portalFiles = walk(resolve(ROOT, "app/customer-portal"));

  it("finds the customer-portal tree (guards against a vacuous pass)", () => {
    expect(portalFiles.length).toBeGreaterThan(5);
  });

  it("no customer-portal file queries cis_subcontractors at all", () => {
    const offenders = portalFiles.filter((f) => /cis_subcontractors/.test(codeOf(readFileSync(f, "utf8"))));
    expect(offenders, `portal files touching cis_subcontractors: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no customer-portal file selects a utr column", () => {
    const offenders = portalFiles.filter((f) => /\butr\b/i.test(codeOf(readFileSync(f, "utf8"))));
    expect(offenders, `portal files referencing a UTR: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the supplier detail page shows CIS status but never the UTR", () => {
    // The page fetches the whole profile for its summary card. Rendering the
    // UTR there — or passing the profile to a client component — would push a
    // tax identifier into the RSC payload of a much more heavily-trafficked page.
    const supplierPage = codeOf(read("app/(app)/suppliers/[id]/page.tsx"));
    expect(supplierPage).toMatch(/CIS_STATUS_LABELS/);
    expect(supplierPage, "the supplier page must not touch the UTR").not.toMatch(/\butr\b/i);
  });

  it("only the masked UTR is ever handed to a client component", () => {
    const page = read("app/(app)/suppliers/[id]/cis/page.tsx");
    // Props crossing into <CisProfileForm> must carry maskUtr(...) / Boolean(...),
    // never the raw value.
    const propsBlock = page.slice(page.indexOf("<CisProfileForm"), page.indexOf("/>", page.indexOf("<CisProfileForm")));
    expect(propsBlock).toMatch(/maskedUtr=\{maskUtr\(/);
    expect(propsBlock).toMatch(/hasUtr=\{Boolean\(/);
    expect(propsBlock).not.toMatch(/utr=\{profile\??\.?\.utr\}/);
  });

  it("cis_subcontractors is only ever read through the admin-gated service", () => {
    // Any other module hitting the table directly would bypass the app-layer
    // role check and the masking that goes with it.
    const sources = [
      ...walk(resolve(ROOT, "app")),
      ...walk(resolve(ROOT, "lib")),
      ...walk(resolve(ROOT, "server")),
    ];
    const readers = sources
      .filter((f) => /from\(\s*["']cis_subcontractors["']/.test(codeOf(readFileSync(f, "utf8"))))
      .map((f) => f.replace(`${ROOT}/`, ""));
    expect(readers).toEqual(["server/services/cis.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 4. The service + actions contract
// ---------------------------------------------------------------------------

describe("CIS service — tenant client only, never service_role", () => {
  const service = read("server/services/cis.ts");
  const code = codeOf(service);

  it("never reaches for the service-role client (which would bypass admin-only RLS)", () => {
    expect(code).not.toMatch(
      /serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/,
    );
  });

  it("uses the tenant server client, so RLS applies to every call", () => {
    expect(code).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(code).toMatch(/import "server-only"/);
  });

  it("derives the deduction rate rather than accepting one from the caller", () => {
    expect(code).toMatch(/rateForStatus\(/);
    // The verification writer must not read a rate out of its input.
    const record = code.slice(code.indexOf("export async function recordVerification"));
    expect(record).not.toMatch(/input\.deduction_rate/);
  });

  it("runs the outcome guard before writing a verification", () => {
    const record = code.slice(code.indexOf("export async function recordVerification"));
    const guardIdx = record.indexOf("canRecordVerificationOutcome");
    const writeIdx = record.indexOf(".update(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(writeIdx);
    // And it must refuse anything that is not one of the four HMRC outcomes.
    expect(record.indexOf("isOutcomeStatus")).toBeLessThan(writeIdx);
  });

  it("runs the transition guard before flagging for re-verification", () => {
    const flag = code.slice(code.indexOf("export async function flagForReverification"));
    const guardIdx = flag.indexOf("transitionRefusal");
    const writeIdx = flag.indexOf(".update(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(writeIdx);
  });

  it("never echoes a raw database message back to the caller (it can quote the UTR)", () => {
    // Postgres CHECK violations include the whole failing row in DETAIL.
    expect(code).not.toMatch(/error:\s*error\.message/);
    expect(code).toMatch(/function friendly\(/);
  });
});

describe("CIS server actions — admin-gated at the app layer too", () => {
  const actions = read("app/(app)/suppliers/[id]/cis/actions.ts");
  const code = codeOf(actions);

  it("re-checks owner/admin in every exported action (a POST endpoint can be replayed)", () => {
    const exported = code.match(/export async function (\w+)/g) ?? [];
    expect(exported.length).toBeGreaterThanOrEqual(3);
    const bodies = code.split(/export async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      expect(body, `${name} must gate on isManager`).toMatch(/isManager\(ctx\.membership\.role\)/);
    }
  });

  it("gates BEFORE doing any work in each action", () => {
    const bodies = code.split(/export async function /).slice(1);
    for (const body of bodies) {
      const gate = body.indexOf("isManager(ctx.membership.role)");
      const work = body.indexOf("validateFormData");
      if (work > -1) expect(gate).toBeLessThan(work);
    }
  });

  it("resolves the org from the session, never from form input", () => {
    expect(code).toMatch(/requireOrgContext\(\)/);
    expect(code).toMatch(/ctx\.org\.id/);
    expect(code).not.toMatch(/formData\.get\(\s*["']org_id["']/);
  });

  it("never writes an identifier value into the audit log", () => {
    // The audit log is a separate, HQ-readable table — a UTR must never land in
    // it. Only the FACT that one is held may be recorded.
    expect(code).toMatch(/has_utr:\s*Boolean\(/);
    expect(code).not.toMatch(/\butr:\s*parsed/);
    expect(code).not.toMatch(/\butr:\s*result/);
    expect(code).not.toMatch(/\butr:\s*input/);
    expect(code).not.toMatch(/company_number/);
    expect(code).not.toMatch(/vat_number/);
  });
});

// ---------------------------------------------------------------------------
// 5. The UI masks, and there is no HMRC simulation anywhere
// ---------------------------------------------------------------------------

describe("CIS UI — the UTR is masked and never rendered whole", () => {
  const page = read("app/(app)/suppliers/[id]/cis/page.tsx");
  const forms = read("app/(app)/suppliers/[id]/cis/_forms.tsx");

  it("renders the UTR only through maskUtr", () => {
    expect(page).toMatch(/maskUtr\(/);
    // No raw `profile.utr` in JSX — every appearance is inside a maskUtr(...) call
    // or a Boolean() presence test.
    const rawRenders = page.match(/\{\s*profile[.?]*\.utr\s*\}/g) ?? [];
    expect(rawRenders).toEqual([]);
  });

  it("offers no reveal / unmask control", () => {
    // Comments are stripped first: the page carries a written justification for
    // NOT having a reveal, and that prose must not trip its own assertion.
    for (const src of [codeOf(page), codeOf(forms)]) {
      expect(src).not.toMatch(/reveal|unmask|showUtr|show_utr/i);
    }
  });

  it("never pre-fills the UTR input with the stored value", () => {
    // The field is write-only: a stored UTR is shown masked in the help text and
    // the input renders empty, so the full number is never sent to the browser.
    const utrField = forms.slice(forms.indexOf('name="utr"'), forms.indexOf('name="utr"') + 600);
    expect(utrField).not.toMatch(/defaultValue=\{defaults\.utr\}/);
    expect(utrField).toMatch(/maskedUtr/);
  });

  it("gates the whole page on owner/admin", () => {
    expect(page).toMatch(/ctx\.membership\.role === "owner"/);
    expect(page).toMatch(/isAdmin/);
  });
});

describe("CIS — no HMRC integration is claimed or simulated", () => {
  const sources = [
    ...walk(resolve(ROOT, "lib/cis")),
    ...walk(resolve(ROOT, "app/(app)/suppliers")),
    resolve(ROOT, "server/services/cis.ts"),
  ];

  it("makes no network call to HMRC (or anywhere) from the CIS feature", () => {
    for (const file of sources) {
      const code = codeOf(readFileSync(file, "utf8"));
      const rel = file.replace(`${ROOT}/`, "");
      expect(code, `${rel} must not fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${rel} must not use axios`).not.toMatch(/axios/);
      expect(code, `${rel} must not reference an HMRC endpoint`).not.toMatch(
        /https?:\/\/[^"'\s]*hmrc/i,
      );
    }
  });

  it("reads no HMRC credential from the environment", () => {
    for (const file of sources) {
      const code = codeOf(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/process\.env\.[A-Z_]*HMRC/);
      expect(code).not.toMatch(/process\.env\.[A-Z_]*CIS_(API|KEY|SECRET|TOKEN)/);
    }
  });

  it("the provider seam is declared but deliberately unimplemented", () => {
    const verification = read("lib/cis/verification.ts");
    expect(verification).toMatch(/export interface CisVerificationProvider/);
    // A class or object implementing it would mean something is pretending to verify.
    const all = sources.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toMatch(/implements CisVerificationProvider/);
    expect(all).not.toMatch(/:\s*CisVerificationProvider\s*=/);
  });

  it("tells the operator plainly that CrewFlow does not contact HMRC", () => {
    const page = read("app/(app)/suppliers/[id]/cis/page.tsx");
    expect(page).toMatch(/does not contact HMRC/i);
  });
});

// ---------------------------------------------------------------------------
// 6. The pure lib stays pure
// ---------------------------------------------------------------------------

describe("lib/cis — pure, importable anywhere", () => {
  for (const file of ["lib/cis/types.ts", "lib/cis/verification.ts", "lib/cis/schema.ts"]) {
    it(`${file} imports no server or database module`, () => {
      const code = codeOf(read(file));
      expect(code).not.toMatch(/from "server-only"/);
      expect(code).not.toMatch(/import "server-only"/);
      expect(code).not.toMatch(/@supabase\//);
      expect(code).not.toMatch(/@\/lib\/supabase/);
      expect(code).not.toMatch(/next\/(headers|cache|navigation)/);
    });
  }

  it("verification.ts reads no clock (callers pass the date, so behaviour is testable)", () => {
    const code = codeOf(read("lib/cis/verification.ts"));
    expect(code).not.toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/new Date\(\)/);
  });
});
