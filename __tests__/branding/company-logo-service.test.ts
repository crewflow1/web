import { describe, it, expect, vi, beforeEach } from "vitest";
import { LOGO_SIGNED_TTL } from "@/lib/branding/logo";

/**
 * Service matrix for server/services/company-logo.ts — the storage + DB +
 * audit layer. Mocks the tenant client, the service-role (admin) client,
 * requireOrgContext and the admin-activity audit helper, then asserts the
 * permission gate, validation pass-through, tenant-scoped upload path, the
 * org-row write (logo_path set, legacy logo_url cleared), orphan cleanup on
 * failure, audit logging, and the display resolver's signed-URL behaviour.
 *
 * vi.hoisted holds the shared mutable state, spies, and a `captured` bag so the
 * (hoisted) vi.mock factories can record call args without the temporal-dead-
 * zone trap — and assertions read typed values instead of indexing mock.calls.
 */

const ORG = "11111111-1111-1111-1111-111111111111";

type AuditEntry = {
  action: string;
  targetTable: string;
  targetId: string;
  metadata: { storage_path: string | null; mime_type?: string; replaced?: boolean };
};

const h = vi.hoisted(() => ({
  ORG: "11111111-1111-1111-1111-111111111111",
  state: {
    role: "admin" as string,
    existingLogoPath: null as string | null,
    update: { error: null as unknown, count: 1 as number | null },
    uploadError: null as unknown,
    signed: {
      data: { signedUrl: "https://signed.example/logo?token=abc" } as
        | { signedUrl: string }
        | null,
      error: null as unknown,
    },
  },
  captured: {
    uploadPath: null as string | null,
    uploadOpts: null as unknown,
    updatePayload: null as unknown,
    updateOpts: null as unknown,
    removePaths: [] as string[][],
    signedArgs: null as [string, number] | null,
    audits: [] as AuditEntry[],
  },
  uploadMock: vi.fn(),
  removeMock: vi.fn(),
  createSignedUrlMock: vi.fn(),
  updateMock: vi.fn(),
  recordAdminActivityMock: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    user: { id: "user-1", email: "admin@acme.test" },
    ctx: { org: { id: h.ORG }, membership: { role: h.state.role } },
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { logo_path: h.state.existingLogoPath },
            error: null,
          }),
        }),
      }),
      update: (payload: unknown, opts: unknown) => {
        h.updateMock(payload, opts);
        h.captured.updatePayload = payload;
        h.captured.updateOpts = opts;
        return { eq: async () => h.state.update };
      },
    }),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: () => ({
        upload: async (path: string, bytes: unknown, opts: unknown) => {
          h.uploadMock(path, bytes, opts);
          h.captured.uploadPath = path;
          h.captured.uploadOpts = opts;
          return { error: h.state.uploadError };
        },
        remove: (paths: string[]) => {
          h.removeMock(paths);
          h.captured.removePaths.push(paths);
          return Promise.resolve({ error: null });
        },
        createSignedUrl: async (path: string, ttl: number) => {
          h.createSignedUrlMock(path, ttl);
          h.captured.signedArgs = [path, ttl];
          return h.state.signed;
        },
      }),
    },
  })),
}));

vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async (entry: AuditEntry) => {
    h.recordAdminActivityMock(entry);
    h.captured.audits.push(entry);
  },
}));

const { uploadCompanyLogo, deleteCompanyLogo, resolveOrgLogoSrc } = await import(
  "@/server/services/company-logo"
);

const PNG = { filename: "logo.png", mimeType: "image/png", bytes: new Uint8Array(2048) };

beforeEach(() => {
  h.state.role = "admin";
  h.state.existingLogoPath = null;
  h.state.update = { error: null, count: 1 };
  h.state.uploadError = null;
  h.state.signed = {
    data: { signedUrl: "https://signed.example/logo?token=abc" },
    error: null,
  };
  h.captured.uploadPath = null;
  h.captured.uploadOpts = null;
  h.captured.updatePayload = null;
  h.captured.updateOpts = null;
  h.captured.removePaths = [];
  h.captured.signedArgs = null;
  h.captured.audits = [];
  h.uploadMock.mockClear();
  h.removeMock.mockClear();
  h.createSignedUrlMock.mockClear();
  h.updateMock.mockClear();
  h.recordAdminActivityMock.mockClear();
});

describe("uploadCompanyLogo — permission gate", () => {
  it("blocks staff: no storage write, no DB write, no audit", async () => {
    h.state.role = "staff";
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(h.uploadMock).not.toHaveBeenCalled();
    expect(h.updateMock).not.toHaveBeenCalled();
    expect(h.recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("blocks a plain member", async () => {
    h.state.role = "member";
    expect(await uploadCompanyLogo(PNG)).toEqual({ ok: false, error: "forbidden" });
    expect(h.uploadMock).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("allows %s", async (role) => {
    h.state.role = role;
    expect(await uploadCompanyLogo(PNG)).toEqual({ ok: true });
    expect(h.uploadMock).toHaveBeenCalledTimes(1);
  });
});

describe("uploadCompanyLogo — validation is enforced server-side", () => {
  it("rejects a disallowed MIME without touching storage", async () => {
    const res = await uploadCompanyLogo({ filename: "logo.gif", mimeType: "image/gif", bytes: new Uint8Array(100) });
    expect(res).toEqual({ ok: false, error: "bad_file_type" });
    expect(h.uploadMock).not.toHaveBeenCalled();
  });
  it("rejects an oversized file (> 2 MB)", async () => {
    const res = await uploadCompanyLogo({ filename: "logo.png", mimeType: "image/png", bytes: new Uint8Array(2 * 1024 * 1024 + 1) });
    expect(res).toEqual({ ok: false, error: "file_too_large" });
    expect(h.uploadMock).not.toHaveBeenCalled();
  });
  it("rejects an extension/MIME mismatch", async () => {
    const res = await uploadCompanyLogo({ filename: "logo.jpg", mimeType: "image/png", bytes: new Uint8Array(100) });
    expect(res).toEqual({ ok: false, error: "ext_mismatch" });
    expect(h.uploadMock).not.toHaveBeenCalled();
  });
});

describe("uploadCompanyLogo — happy path writes a tenant-scoped object + clears legacy URL + audits", () => {
  it("uploads under `<org_id>/`, records logo_path, nulls logo_url, logs the audit", async () => {
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: true });

    // tenant-scoped storage key
    const uploadedPath = h.captured.uploadPath ?? "";
    expect(uploadedPath.startsWith(`${ORG}/`)).toBe(true);
    expect(uploadedPath).toMatch(/^[^/]+\/logo-[0-9a-f-]+\.png$/i);
    // contentType + no-overwrite
    expect(h.captured.uploadOpts).toEqual({ contentType: "image/png", upsert: false });

    // org row: logo_path set to the uploaded key, legacy logo_url cleared
    expect(h.updateMock).toHaveBeenCalledTimes(1);
    expect(h.captured.updatePayload).toEqual({ logo_path: uploadedPath, logo_url: null });
    expect(h.captured.updateOpts).toEqual({ count: "exact" });

    // audit
    expect(h.captured.audits).toHaveLength(1);
    const audit = h.captured.audits[0]!;
    expect(audit.action).toBe("company_logo.upload");
    expect(audit.targetTable).toBe("organizations");
    expect(audit.targetId).toBe(ORG);
    expect(audit.metadata.storage_path).toBe(uploadedPath);
    expect(audit.metadata.mime_type).toBe("image/png");
    expect(audit.metadata.replaced).toBe(false);

    // nothing removed when there was no previous logo
    expect(h.removeMock).not.toHaveBeenCalled();
  });

  it("removes the previously-stored object on a replace and flags replaced=true", async () => {
    h.state.existingLogoPath = `${ORG}/logo-old.png`;
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: true });

    expect(h.captured.uploadPath).not.toBe(`${ORG}/logo-old.png`);
    expect(h.removeMock).toHaveBeenCalledWith([`${ORG}/logo-old.png`]);
    expect(h.captured.audits[0]!.metadata.replaced).toBe(true);
  });
});

describe("uploadCompanyLogo — failure handling never orphans objects or logs success", () => {
  it("returns upload_failed and does NOT write the org row when storage upload errors", async () => {
    h.state.uploadError = { message: "storage down" };
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: false, error: "upload_failed" });
    expect(h.updateMock).not.toHaveBeenCalled();
    expect(h.recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("rolls back the just-uploaded object when the DB row update errors", async () => {
    h.state.update = { error: { message: "db boom" }, count: null };
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: false, error: "record_failed" });
    expect(h.removeMock).toHaveBeenCalledWith([h.captured.uploadPath]);
    expect(h.recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("rolls back + returns forbidden when the update matches no row (RLS / wrong org)", async () => {
    h.state.update = { error: null, count: 0 };
    const res = await uploadCompanyLogo(PNG);
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(h.removeMock).toHaveBeenCalledWith([h.captured.uploadPath]);
    expect(h.recordAdminActivityMock).not.toHaveBeenCalled();
  });
});

describe("deleteCompanyLogo", () => {
  it("blocks staff (no DB write, no audit)", async () => {
    h.state.role = "staff";
    expect(await deleteCompanyLogo()).toEqual({ ok: false, error: "forbidden" });
    expect(h.updateMock).not.toHaveBeenCalled();
    expect(h.recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("admin: clears logo_path + logo_url, removes the stored object, audits the delete", async () => {
    h.state.role = "admin";
    h.state.existingLogoPath = `${ORG}/logo-current.webp`;
    const res = await deleteCompanyLogo();
    expect(res).toEqual({ ok: true });
    expect(h.captured.updatePayload).toEqual({ logo_path: null, logo_url: null });
    expect(h.removeMock).toHaveBeenCalledWith([`${ORG}/logo-current.webp`]);
    const audit = h.captured.audits[0]!;
    expect(audit.action).toBe("company_logo.delete");
    expect(audit.metadata.storage_path).toBe(`${ORG}/logo-current.webp`);
  });

  it("admin with no stored object: still clears the row + audits, removes nothing", async () => {
    h.state.existingLogoPath = null;
    const res = await deleteCompanyLogo();
    expect(res).toEqual({ ok: true });
    expect(h.removeMock).not.toHaveBeenCalled();
    expect(h.captured.audits).toHaveLength(1);
  });
});

describe("resolveOrgLogoSrc — display resolution", () => {
  it("uploaded logo_path → a signed URL on the private bucket (TTL applied)", async () => {
    const src = await resolveOrgLogoSrc({ logo_path: `${ORG}/logo-x.png`, logo_url: null });
    expect(src).toBe("https://signed.example/logo?token=abc");
    expect(h.captured.signedArgs).toEqual([`${ORG}/logo-x.png`, LOGO_SIGNED_TTL]);
  });

  it("legacy http(s) logo_url → returned as-is, no storage call", async () => {
    const src = await resolveOrgLogoSrc({ logo_path: null, logo_url: "https://cdn.example/old.png" });
    expect(src).toBe("https://cdn.example/old.png");
    expect(h.createSignedUrlMock).not.toHaveBeenCalled();
  });

  it("no logo → null", async () => {
    expect(await resolveOrgLogoSrc({ logo_path: null, logo_url: null })).toBeNull();
    expect(await resolveOrgLogoSrc(null)).toBeNull();
    expect(h.createSignedUrlMock).not.toHaveBeenCalled();
  });

  it("non-http(s) legacy URL is never rendered (returns null)", async () => {
    expect(await resolveOrgLogoSrc({ logo_url: "javascript:alert(1)" })).toBeNull();
    expect(h.createSignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns null (not a throw) when signing fails", async () => {
    h.state.signed = { data: null, error: { message: "nope" } };
    expect(await resolveOrgLogoSrc({ logo_path: `${ORG}/logo-x.png` })).toBeNull();
  });
});
