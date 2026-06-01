import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { expandZips, type UploadItem } from "@/lib/imports/zip";

/**
 * Migration-flow launch-readiness regressions.
 *
 * Three real defects fixed together:
 *   1. ZIP inner-file allowlist dropped xlt/xltx/xltm/dbf — formats that are
 *      accepted for direct upload + listed in the UI accept= attribute. Files
 *      of those types arriving inside a ZIP were silently discarded.
 *   2. commitImport reported a blanket "missing required fields" for every
 *      skipped row, even staff (which ALWAYS skips by design) and job/quote/
 *      payment rows whose referenced customer/invoice just couldn't be matched.
 *   3. The import staff-invite wrote the wrong auth-metadata key (org_id /
 *      source:"import") so the /onboarding join flow didn't recognise the
 *      invitee — they'd create a brand-new org instead of joining their
 *      employer. Must match the canonical contract in staff/actions.ts.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

async function zipItemWith(
  entries: Record<string, string | Uint8Array>,
): Promise<UploadItem> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const ab = (await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer;
  return {
    name: "archive.zip",
    type: "application/zip",
    size: ab.byteLength,
    arrayBuffer: async () => ab,
  };
}

describe("expandZips keeps every directly-supported spreadsheet format", () => {
  it("extracts xlt / xltx / xltm / dbf (previously silently dropped)", async () => {
    const item = await zipItemWith({
      "customers.csv": "name,email\nAcme,a@b.com",
      "legacy.dbf": new Uint8Array([1, 2, 3]),
      "template.xlt": new Uint8Array([1, 2, 3]),
      "modern.xltx": new Uint8Array([1, 2, 3]),
      "macros.xltm": new Uint8Array([1, 2, 3]),
      "notes.txt": "hello",
    });
    const out = await expandZips([item]);
    const names = out.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "customers.csv",
        "legacy.dbf",
        "macros.xltm",
        "modern.xltx",
        "notes.txt",
        "template.xlt",
      ].sort(),
    );
  });

  it("still skips junk + macOS resource forks + dotfiles", async () => {
    const item = await zipItemWith({
      "real.csv": "a,b\n1,2",
      "installer.exe": new Uint8Array([0]),
      "__MACOSX/._real.csv": new Uint8Array([0]),
      ".DS_Store": new Uint8Array([0]),
    });
    const out = await expandZips([item]);
    const names = out.map((f) => f.name);
    expect(names).toEqual(["real.csv"]);
  });

  it("gives xltx/xltm a real spreadsheet MIME (not octet-stream)", async () => {
    const item = await zipItemWith({ "modern.xltx": new Uint8Array([1]) });
    const [expanded] = await expandZips([item]);
    expect(expanded?.type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("leaves non-zip uploads untouched (pass-through)", async () => {
    const csv: UploadItem = {
      name: "direct.csv",
      type: "text/csv",
      size: 3,
      arrayBuffer: async () => new TextEncoder().encode("a,b").buffer,
    };
    const out = await expandZips([csv]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("direct.csv");
  });
});

describe("ZIP allowlist stays in sync with the direct-upload dispatch", () => {
  const zipSrc = read("lib/imports/zip.ts");
  const actionsSrc = read("app/(app)/imports/actions.ts");

  it("SUPPORTED_INNER includes the template/dbf formats the direct path accepts", () => {
    for (const ext of ["xlt", "xltx", "xltm", "dbf"]) {
      expect(zipSrc).toMatch(new RegExp(`\\b${ext}\\b`));
    }
  });

  it("direct-upload isSpreadsheet regex remains the source of truth", () => {
    expect(actionsSrc).toMatch(
      /xlsx\|xlsm\|xlsb\|xls\|xlt\|xltx\|xltm\|ods\|fods\|numbers\|dif\|prn\|slk\|dbf/,
    );
  });
});

describe("commitImport reports an actionable skip reason (not blanket 'missing required fields')", () => {
  const src = read("app/(app)/imports/actions.ts");

  it("uses skipReason(entity) when insertOne returns null", () => {
    expect(src).toMatch(/error_message:\s*skipReason\(entity\)/);
  });

  it("staff skip message points at the invite flow, not 'missing fields'", () => {
    expect(src).toMatch(/case "staff":\s*\n\s*return ['"].*invite/i);
  });

  it("job/quote/payment skips name the unresolved reference", () => {
    expect(src).toMatch(/couldn.t match a customer for this job/);
    expect(src).toMatch(/couldn.t match a customer for this quote/);
    expect(src).toMatch(/couldn.t match an invoice for this payment/);
  });
});

describe("import staff-invite uses the canonical join-flow metadata contract", () => {
  const importSrc = read("app/(app)/imports/actions.ts");
  const staffSrc = read("app/(app)/staff/actions.ts");

  it("import invite writes invited_org_id + source:staff_invite (NOT org_id/source:import)", () => {
    // Pull the sendStaffInvitesFromImport invite payload region.
    const region = importSrc.slice(
      importSrc.indexOf("sendStaffInvitesFromImport"),
      importSrc.indexOf("function tableFor"),
    );
    expect(region).toMatch(/invited_org_id:\s*ctx\.org\.id/);
    expect(region).toMatch(/source:\s*"staff_invite"/);
    expect(region).not.toMatch(/source:\s*"import"/);
  });

  it("the canonical staff invite still defines that same contract", () => {
    expect(staffSrc).toMatch(/invited_org_id:\s*ctx\.org\.id/);
    expect(staffSrc).toMatch(/source:\s*"staff_invite"/);
  });

  it("the /onboarding entry recognises invitees by invited_org_id", () => {
    const page = read("app/onboarding/company/page.tsx");
    expect(page).toMatch(/invited_org_id/);
  });
});
