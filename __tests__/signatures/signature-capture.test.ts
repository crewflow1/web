import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Service-layer proof for the drawn e-signature storage path
 * (server/services/signature-capture.ts). The Supabase admin client is mocked
 * so the test is hermetic. What we verify:
 *   1. a valid PNG is uploaded to the PRIVATE `signatures` bucket under an
 *      org-first, server-built key, and the returned path is org-scoped;
 *   2. an invalid / absent signature stores nothing (typed-name path unbroken);
 *   3. a signed-URL is only minted for a path under the row's OWN org
 *      (cross-tenant path is refused) — the app half of the org-first invariant.
 */

const uploads: Array<{ bucket: string; key: string; contentType: string }> = [];
const signedFor: Array<{ bucket: string; path: string }> = [];

const storageApi = {
  from(bucket: string) {
    return {
      upload: async (key: string, _bytes: Uint8Array, opts: { contentType: string }) => {
        uploads.push({ bucket, key, contentType: opts.contentType });
        return { data: { path: key }, error: null };
      },
      createSignedUrl: async (path: string) => {
        signedFor.push({ bucket, path });
        return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null };
      },
      remove: async () => ({ data: [], error: null }),
    };
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: storageApi }),
}));

import {
  storeSignatureImage,
  signatureImageUrl,
} from "@/server/services/signature-capture";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const validPng = `data:image/png;base64,${Buffer.concat([PNG_MAGIC, Buffer.from("sig")]).toString("base64")}`;

const orgA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const subject = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeEach(() => {
  uploads.length = 0;
  signedFor.length = 0;
});

describe("storeSignatureImage — persists a valid drawn signature", () => {
  it("uploads to the private signatures bucket under an org-first key", async () => {
    const res = await storeSignatureImage({ orgId: orgA, scope: "quotes", subjectId: subject, dataUrl: validPng });
    expect(res).not.toBeNull();
    expect(res!.bucket).toBe("signatures");
    // org_id is the first path segment (tenant scoping of the object).
    expect(res!.path.split("/")[0]).toBe(orgA);
    expect(res!.path).toMatch(new RegExp(`^${orgA}/quotes/${subject}/[0-9a-f-]+\\.png$`));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ bucket: "signatures", contentType: "image/png" });
  });

  it("scopes H&S signatures under their own subject scope", async () => {
    const res = await storeSignatureImage({ orgId: orgB, scope: "safety_acknowledgements", subjectId: subject, dataUrl: validPng });
    expect(res!.path.startsWith(`${orgB}/safety_acknowledgements/`)).toBe(true);
  });
});

describe("storeSignatureImage — never breaks the typed-name path", () => {
  it("returns null (stores nothing) for an invalid / non-PNG signature", async () => {
    const res = await storeSignatureImage({ orgId: orgA, scope: "quotes", subjectId: subject, dataUrl: "data:image/jpeg;base64,/9j/xxxx" });
    expect(res).toBeNull();
    expect(uploads).toHaveLength(0);
  });
  it("returns null when no signature is provided", async () => {
    const res = await storeSignatureImage({ orgId: orgA, scope: "quotes", subjectId: subject, dataUrl: null });
    expect(res).toBeNull();
    expect(uploads).toHaveLength(0);
  });
  it("returns null when org / subject is missing (no ungoverned upload)", async () => {
    const res = await storeSignatureImage({ orgId: "", scope: "quotes", subjectId: subject, dataUrl: validPng });
    expect(res).toBeNull();
    expect(uploads).toHaveLength(0);
  });
});

describe("signatureImageUrl — org-scoped signed URL minting", () => {
  it("mints a signed URL for a path under the row's own org", async () => {
    const path = `${orgA}/quotes/${subject}/sig.png`;
    const url = await signatureImageUrl("signatures", path, orgA);
    expect(url).toContain(path);
    expect(signedFor).toHaveLength(1);
  });
  it("REFUSES to mint for a path belonging to a different org (cross-tenant guard)", async () => {
    const crossOrgPath = `${orgB}/quotes/${subject}/sig.png`;
    const url = await signatureImageUrl("signatures", crossOrgPath, orgA);
    expect(url).toBeNull();
    expect(signedFor).toHaveLength(0);
  });
  it("returns null when bucket/path is absent", async () => {
    expect(await signatureImageUrl(null, null, orgA)).toBeNull();
    expect(await signatureImageUrl("signatures", null, orgA)).toBeNull();
  });
});
