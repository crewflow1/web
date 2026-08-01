import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPortalPhotoView,
  extractSnapshotPhotoIds,
  MAX_PORTAL_PHOTOS,
  PHOTO_PORTAL_KEYS,
} from "@/lib/site-reports/portal-photos";

/**
 * Customer-portal photos — publication gate, scoping, path derivation.
 *
 * The portal runs on the RLS-bypassing service-role client, so every guard in
 * the photo chain is one somebody could delete without Postgres noticing.
 * Pinned on source:
 *
 *   • the ONLY id source is the frozen snapshot of a report that is already
 *     customer-scoped AND passes isPortalVisible;
 *   • ids leaving the snapshot are uuid-revalidated (a corrupted snapshot
 *     cannot smuggle a path or filter fragment into the query);
 *   • attachment rows are re-verified org + target_table='jobs' in SQL and
 *     target_id === the publishing report's job_id in code;
 *   • signed URLs are built from the VERIFIED ROW's storage_path, short-lived,
 *     and no client-supplied identifier exists anywhere on the surface;
 *   • the DTO is declared field by field — storage paths, filenames and staff
 *     identity never serialise.
 */

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
// Comments stripped: assertions are about what the CODE does, and these
// modules document the rules at length in prose.
const read = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const LOADER = read("app/customer-portal/_photos.ts");
const PAGE = read("app/customer-portal/[token]/photos/page.tsx");

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("extractSnapshotPhotoIds — untrusted snapshot, validated ids", () => {
  it("reads content.sources.photo_attachment_ids and nothing else", () => {
    expect(
      extractSnapshotPhotoIds({
        content: { sources: { photo_attachment_ids: [UUID_A, UUID_B] } },
      }),
    ).toEqual([UUID_A, UUID_B]);
  });

  it("rejects every malformed shape without throwing", () => {
    for (const bad of [
      null,
      undefined,
      "string",
      42,
      [],
      {},
      { content: null },
      { content: { sources: null } },
      { content: { sources: { photo_attachment_ids: "not-an-array" } } },
      { content: { sources: { photo_attachment_ids: { 0: UUID_A } } } },
    ]) {
      expect(extractSnapshotPhotoIds(bad)).toEqual([]);
    }
  });

  it("drops non-uuid entries — a path or filter fragment cannot ride along", () => {
    expect(
      extractSnapshotPhotoIds({
        content: {
          sources: {
            photo_attachment_ids: [
              "org-a/secret/path.jpg",
              "id.eq.anything",
              "../../../etc/passwd",
              42,
              null,
              { id: UUID_A },
              UUID_A,
            ],
          },
        },
      }),
    ).toEqual([UUID_A]);
  });

  it("dedupes and caps at MAX_PORTAL_PHOTOS", () => {
    const many = Array.from({ length: MAX_PORTAL_PHOTOS + 50 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    expect(
      extractSnapshotPhotoIds({
        content: { sources: { photo_attachment_ids: [UUID_A, UUID_A, ...many] } },
      }),
    ).toHaveLength(MAX_PORTAL_PHOTOS);
  });
});

describe("buildPortalPhotoView — the shape is declared, not inherited", () => {
  const SENTINELS = {
    storage_path: "SENTINEL-ORG/SENTINEL-JOB/secret.jpg",
    filename: "SENTINEL-internal-filename.jpg",
    org_id: "SENTINEL-ORG-UUID",
    uploaded_by: "SENTINEL-STAFF-UUID",
    target_id: "SENTINEL-JOB-UUID",
    mime_type: "SENTINEL-MIME",
  };
  const view = buildPortalPhotoView({
    attachmentId: UUID_A,
    signedUrl: "https://example.test/signed?token=abc",
    reportId: UUID_B,
    reportTitle: "July progress",
    reportNumber: "SR-0001",
    portalPublishedAt: "2026-07-20T10:00:00.000Z",
    // The whole-row shape a spread would produce.
    ...SENTINELS,
  } as Parameters<typeof buildPortalPhotoView>[0]);

  it("has exactly the declared key set", () => {
    expect(Object.keys(view).sort()).toEqual([...PHOTO_PORTAL_KEYS].sort());
  });

  it("truncates the publication timestamp to a date", () => {
    expect(view.published_on).toBe("2026-07-20");
  });

  it.each(Object.entries(SENTINELS))(
    "%s never reaches the serialised payload",
    (key, value) => {
      const json = JSON.stringify(view);
      expect(json).not.toContain(value);
      expect(json).not.toContain(`"${key}"`);
    },
  );
});

describe("the loader's id source is the published, customer-scoped snapshot", () => {
  it("scopes the report query by customer_id AND org_id", () => {
    expect(LOADER).toMatch(
      /\.eq\("customer_id", customerId\)\s*\n?\s*\.eq\("org_id", orgId\)/,
    );
  });

  it("applies the full publication filter in SQL", () => {
    expect(LOADER).toMatch(/\.in\("status", \["issued", "superseded"\]\)/);
    expect(LOADER).toMatch(/\.not\("portal_published_at", "is", null\)/);
    expect(LOADER).toMatch(/\.is\("portal_withdrawn_at", null\)/);
  });

  it("re-applies isPortalVisible in code — defence in depth over the SQL filter", () => {
    expect(LOADER).toMatch(/isPortalVisible\(\{/);
  });

  it("ids come only from extractSnapshotPhotoIds over those reports", () => {
    expect(LOADER).toMatch(/extractSnapshotPhotoIds\(report\.snapshot\)/);
  });
});

describe("attachment rows are re-verified before anything is signed", () => {
  it("pins the attachment query to the org and to job attachments", () => {
    expect(LOADER).toMatch(
      /\.in\("id", \[\.\.\.reportByPhotoId\.keys\(\)\]\)\s*\n?\s*\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("target_table", "jobs"\)/,
    );
  });

  it("binds each attachment to the publishing report's own job in code", () => {
    expect(LOADER).toMatch(/a\.target_id === report\.job_id/);
  });

  it("serves images only", () => {
    expect(LOADER).toMatch(/\.startsWith\("image\/"\)/);
  });

  it("never selects filename or uploaded_by — they cannot leak by render change", () => {
    const sel = LOADER.match(/select\("id, target_id[^"]*"\)/)?.[0] ?? "";
    expect(sel).toBeTruthy();
    expect(sel).not.toContain("filename");
    expect(sel).not.toContain("uploaded_by");
  });
});

describe("signed URLs — object-scoped, short-lived, server-derived", () => {
  it("signs the VERIFIED rows' storage paths for 60 seconds", () => {
    expect(LOADER).toMatch(
      /createSignedUrls\(\s*verified\.map\(\(a\) => a\.storage_path\),\s*60,?\s*\)/,
    );
  });

  it("the loader accepts no caller-supplied identifiers at all", () => {
    // Its whole input surface is the token-resolved (customerId, orgId) pair.
    expect(LOADER).toMatch(
      /listPortalPhotos\(\s*customerId: string,\s*orgId: string,?\s*\)/,
    );
    for (const shape of [/formData/i, /searchParams/i, /request\./i]) {
      expect(LOADER).not.toMatch(shape);
    }
  });

  it("no storage path or bucket-widening call exists on the page", () => {
    expect(PAGE).not.toMatch(/storage_path/);
    expect(PAGE).not.toMatch(/createSignedUrl/);
    expect(PAGE).not.toMatch(/getPublicUrl/);
  });

  it("fails loud on every read (reports, attachments, signing)", () => {
    expect(LOADER.match(/throw readFailure/g) ?? []).toHaveLength(3);
  });
});

describe("the page surface", () => {
  it("takes only the token param — no photo/job/report id to vary", () => {
    expect(PAGE).toMatch(/params: Promise<\{ token: string \}>/);
    expect(PAGE).not.toMatch(/searchParams/);
  });

  it("resolves the customer through the single auth chokepoint, then loads by the token-resolved pair", () => {
    expect(PAGE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(PAGE).toMatch(/listPortalPhotos\(customer\.id, customer\.org_id\)/);
    expect(PAGE).toMatch(/InvalidLinkPage kind="portal"/);
  });
});
