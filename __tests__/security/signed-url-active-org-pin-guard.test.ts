import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

/**
 * Systemic guard for the READ→signed-URL active-org sub-class (C42).
 *
 * THE DEFECT CLASS: CrewFlow users can belong to more than one org and the app
 * tracks an "active org" (active_org_id cookie → requireOrgContext()). The RLS
 * helpers current_org_ids()/is_org_admin() are deliberately permissive — they
 * admit EVERY org the viewer belongs to. So a by-id read that then mints a
 * short-lived storage SIGNED URL, WITHOUT also pinning the ACTIVE org
 * (.eq("org_id", ctx.org.id)), lets a dual-org member active in org A hand a
 * versionId/attachmentId from org B, have RLS admit the row, and be minted a
 * signed URL for org B's bytes. storagePathBelongsToOrg() only proves the path
 * is under the ROW's OWN org (anti-poisoning) — NOT that the row is the active
 * org — so it does not stop this leak.
 *
 * Two live offenders were fixed in C42 (getJobDocumentDownloadUrl,
 * getAttachmentSignedUrl); the C40 active-org-write-pin guard EXCLUDES reads by
 * design, so this guard backstops the read→signer sink specifically: EVERY
 * createSignedUrl(s) call site must live in a file that pins the active org on
 * the row it signs, OR be explicitly allowlisted with a reason.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["server", "app", "components", "lib"];

/**
 * Files that legitimately mint a signed URL WITHOUT a by-id `.eq("org_id", …)`
 * pin — each must state exactly why it cannot leak across the active-org
 * boundary. Keep this TIGHT.
 */
const ALLOWLIST: Record<string, string> = {
  "server/services/company-logo.ts":
    "Mints the ACTIVE org's OWN logo: the storage path is derived from ctx.org.id " +
    "(targetId: ctx.org.id), never from a client-supplied foreign row id, so there is " +
    "no cross-active-org read to pin.",
  "app/customer-portal/_photos.ts":
    "Customer-portal surface: scope is the PORTAL TOKEN's org (orgId resolved from the " +
    "token, not an active_org cookie); it already filters .eq(\"org_id\", orgId) for that " +
    "token-derived org. Not an active-org-cookie code path.",
  "app/customer-portal/[token]/documents/attachments/[id]/route.ts":
    "Customer-portal surface: scope is the PORTAL TOKEN's org, not an active_org cookie. " +
    "The storage_path is taken from verifyPortalAttachment (app/customer-portal/_attachments.ts), " +
    "which pins .eq(\"org_id\", orgId) AND re-checks the attachment is portal_visible=true AND " +
    "owned by the token-resolved customer (.eq(\"customer_id\", customerId)) before returning any " +
    "path. Same class as _photos.ts — the org pin lives on the feeding read in the helper.",
  "server/services/signature-capture.ts":
    "signatureImageUrl performs NO row read — it takes an explicit orgId argument and " +
    "REFUSES to mint unless storagePathBelongsToOrg(path, orgId) (the object's org-first " +
    "prefix equals that orgId). Every caller passes the ACTIVE org (quote detail: ctx.org.id " +
    "after an org-scoped quote load; _signoff-data.listAcknowledgements: ctx.org.id, which it " +
    "also pins with .eq(\"org_id\", orgId) on the feeding read). So the active-org pin is applied " +
    "at the argument boundary, not via a by-id .eq() inside this helper.",
};

/** The two C42 fixes — asserted pinned AND never allowlisted (explicit regression pin). */
const MUST_BE_PINNED = [
  "server/services/job-documents.ts",
  "components/attachments/actions.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const full = resolve(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip line/block comments so a commented-out example never satisfies the pin check. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SIGNER_RE = /\.createSignedUrls?\s*\(/;
const ORG_PIN_RE = /\.eq\(\s*["']org_id["']/;
// EXPORTED top-level declaration starts — used to bound the "enclosing exported
// function" of a signer, so (a) a sibling pinned function in the SAME file
// cannot mask an unpinned signer, and (b) inner non-exported arrow closures
// (filter/map callbacks like `const paths = (p) => …`) between the pinned read
// and the signer are NOT mistaken for the enclosing scope. Every signer in this
// codebase lives in an exported function/action/handler.
const DECL_RE =
  /export\s+(?:async\s+)?(?:function\s+[A-Za-z0-9_]+|const\s+[A-Za-z0-9_]+\s*=)/g;

function findSigners(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(resolve(ROOT, d))) {
      const raw = readFileSync(file, "utf8");
      if (SIGNER_RE.test(stripComments(raw))) hits.push(relative(ROOT, file));
    }
  }
  return hits.sort();
}

/**
 * True iff EVERY createSignedUrl(s) call in `body` has an active-org
 * `.eq("org_id", …)` pin within its ENCLOSING function (from the nearest
 * preceding function/closure declaration up to the call). Function-scoped so a
 * sibling pinned function in the same file cannot mask an unpinned signer.
 */
function everySignerPinned(body: string): boolean {
  const signer = new RegExp(SIGNER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = signer.exec(body))) {
    const callIdx = m.index;
    // find the nearest declaration start before this call
    DECL_RE.lastIndex = 0;
    let funcStart = 0;
    let d: RegExpExecArray | null;
    while ((d = DECL_RE.exec(body)) && d.index < callIdx) funcStart = d.index;
    const scope = body.slice(funcStart, callIdx);
    if (!ORG_PIN_RE.test(scope)) return false;
  }
  return true;
}

describe("signed-url active-org pin guard (C42 read→signer sub-class)", () => {
  const signers = findSigners();

  it("finds the known signed-URL call sites (scanner is not vacuous)", () => {
    // Sanity: the scanner must at least see the two fixed files + the reference signer.
    expect(signers).toEqual(expect.arrayContaining([
      "server/services/job-documents.ts",
      "components/attachments/actions.ts",
      "server/services/blueprints.ts",
    ]));
    expect(signers.length).toBeGreaterThanOrEqual(7);
  });

  it("every createSignedUrl(s) site pins the active org or is allowlisted-with-reason", () => {
    const offenders: string[] = [];
    for (const rel of signers) {
      if (rel in ALLOWLIST) continue;
      const body = stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
      if (!everySignerPinned(body)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files mint a storage signed URL without an active-org .eq("org_id", …) pin ` +
        `on the feeding read and are not allowlisted. A dual-org member could be handed a ` +
        `signed URL for another org's bytes. Add the pin (mirror getJobDocumentDownloadUrl / ` +
        `getBlueprintVersionUrl) or, only if it provably cannot leak, add an ALLOWLIST entry ` +
        `with a reason.\nOffenders: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("the two C42-fixed signers carry a real active-org pin and are NOT allowlisted", () => {
    for (const rel of MUST_BE_PINNED) {
      expect(signers, `${rel} must still contain a createSignedUrl site`).toContain(rel);
      expect(rel in ALLOWLIST, `${rel} must be genuinely pinned, never allowlisted`).toBe(false);
      const body = stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(everySignerPinned(body), `${rel} signer must pin .eq("org_id", …) in its own function`).toBe(true);
    }
  });

  it("every allowlist entry still exists and is still a signer (no stale allowlist)", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(signers, `stale allowlist entry: ${rel} is no longer a signed-URL site`).toContain(rel);
    }
  });
});
