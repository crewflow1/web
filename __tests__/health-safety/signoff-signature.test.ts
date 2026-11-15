import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: the operative sign-off action must READ the drawn signature.
 *
 * The SignoffPanel (RAMS / permit / toolbox) renders a <SignaturePad
 * name="signatureDataUrl">, and `acknowledgeSchema` defines a `signatureDataUrl`
 * field — but `acknowledgeSafetyDocument` hand-built its safeParse input from
 * only four fields and omitted `signatureDataUrl`. The result: `v.signatureDataUrl`
 * was always undefined, `storeSignatureImage` was never called, and every drawn
 * signature a worker captured on the sign-off form was silently discarded (only
 * the typed name recorded). This pins that the posted data-URL is now read and
 * stored, and that its bucket/path land on the acknowledgement row.
 */

const storeSignatureImage = vi.fn(async () => ({
  bucket: "safety-signatures",
  path: "org-1/safety_acknowledgements/sub-1/abc.png",
}));
const deleteSignatureImage = vi.fn(async () => {});

const inserts: Array<Record<string, unknown>> = [];
const insertResult = { error: null as { code?: string; message?: string } | null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve(insertResult);
      },
    }),
  })),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    user: { id: "user-1" },
    ctx: { org: { id: "org-1" } },
  })),
}));
vi.mock("@/server/services/signature-capture", () => ({
  storeSignatureImage: (...a: unknown[]) => storeSignatureImage(...(a as [])),
  deleteSignatureImage: (...a: unknown[]) => deleteSignatureImage(...(a as [])),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const redirectMock = vi.fn((path: string) => {
  throw new Error(`__redirect:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
}));

const { acknowledgeSafetyDocument } = await import(
  "@/app/(app)/health-safety/signoff-actions"
);

const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',";

function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("subjectType", "risk_assessment");
  fd.set("subjectId", SUBJECT_ID);
  fd.set("subjectVersion", "RA-0001");
  fd.set("signedName", "Jordan Smith");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  inserts.length = 0;
  insertResult.error = null;
  storeSignatureImage.mockClear();
  deleteSignatureImage.mockClear();
  redirectMock.mockClear();
});

describe("acknowledgeSafetyDocument — drawn signature capture", () => {
  it("stores the posted signatureDataUrl and records its bucket/path", async () => {
    await expect(acknowledgeSafetyDocument(form({ signatureDataUrl: PNG }))).rejects.toThrow(
      /__redirect:.*saved=acknowledged/,
    );
    expect(storeSignatureImage).toHaveBeenCalledTimes(1);
    expect(storeSignatureImage).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: PNG, subjectId: SUBJECT_ID, orgId: "org-1" }),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      signature_image_bucket: "safety-signatures",
      signature_image_path: "org-1/safety_acknowledgements/sub-1/abc.png",
    });
  });

  it("records a typed-name-only sign-off with no image when no signature is drawn", async () => {
    await expect(acknowledgeSafetyDocument(form())).rejects.toThrow(
      /__redirect:.*saved=acknowledged/,
    );
    expect(storeSignatureImage).not.toHaveBeenCalled();
    expect(inserts[0]).toMatchObject({
      signature_image_bucket: null,
      signature_image_path: null,
      signed_name: "Jordan Smith",
    });
  });
});
