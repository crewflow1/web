import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P4 Job Documents — service-layer execution tests.
 *
 * These execute the real service against a chainable Supabase mock to prove the
 * load-bearing security invariants that source-contract tests can't:
 *   - PRIVATE-area writes go through the service-role (admin) client; STAFF-area
 *     writes go through the tenant (RLS) client.
 *   - The drop box re-checks org ownership on the admin path (cross-org → fail).
 *   - Downloads are gated by an RLS-scoped row read BEFORE any signed URL.
 *   - Audit always flows through the tenant client's _record_activity RPC, with
 *     'job_document.private.*' actions for the private area.
 *   - The bucket is derived from visibility; orphan files are cleaned up.
 */

type DbResult = { data: unknown; error: unknown };
type ClientLabel = "tenant" | "admin";
type DbOp = "select" | "insert" | "update" | "delete";
type OpRecord = {
  client: ClientLabel;
  table: string;
  op: DbOp;
  row?: unknown;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, readonly unknown[]]>;
  single: boolean;
};
type StorageCall = {
  client: ClientLabel;
  bucket: string;
  method: "upload" | "createSignedUrl" | "remove";
  path?: string;
  paths?: string[];
};
type RpcCall = { client: ClientLabel; fn: string; args: Record<string, unknown> };

const h = vi.hoisted(() => {
  const dbCalls: OpRecord[] = [];
  const storageCalls: StorageCall[] = [];
  const rpcCalls: RpcCall[] = [];

  const org = { id: "org-1", role: "staff", userId: "user-1" };

  const cfg: {
    job: unknown;
    parent: unknown;
    version: unknown;
    versions: unknown[];
    updated: unknown;
    deleted: unknown;
    docInsertError: unknown;
    versionInsertError: unknown;
    updateError: unknown;
    deleteError: unknown;
    uploadError: unknown;
    signedUrlError: unknown;
  } = {
    job: { id: "job-1", org_id: "org-1" },
    parent: null,
    version: null,
    versions: [],
    updated: null,
    deleted: null,
    docInsertError: null,
    versionInsertError: null,
    updateError: null,
    deleteError: null,
    uploadError: null,
    signedUrlError: null,
  };

  function respond(rec: OpRecord): DbResult {
    if (rec.table === "jobs") return { data: cfg.job, error: null };
    if (rec.table === "job_documents") {
      if (rec.op === "update") return { data: cfg.updated, error: cfg.updateError };
      if (rec.op === "delete") return { data: cfg.deleted, error: cfg.deleteError };
      if (rec.op === "insert") return { data: null, error: cfg.docInsertError };
      return { data: cfg.parent, error: null }; // select (addVersion parent read)
    }
    if (rec.table === "job_document_versions") {
      if (rec.op === "insert") return { data: null, error: cfg.versionInsertError };
      // select: single → download lookup; list → delete gather
      return rec.single
        ? { data: cfg.version, error: null }
        : { data: cfg.versions, error: null };
    }
    return { data: null, error: null };
  }

  interface Builder extends PromiseLike<DbResult> {
    select(cols: string): Builder;
    eq(col: string, val: unknown): Builder;
    in(col: string, vals: readonly unknown[]): Builder;
    order(col: string, opts?: { ascending: boolean }): Builder;
    insert(row: unknown): Builder;
    update(row: unknown): Builder;
    delete(): Builder;
    maybeSingle(): Builder;
  }

  function makeBuilder(client: ClientLabel, table: string): Builder {
    const rec: OpRecord = { client, table, op: "select", eqs: [], ins: [], single: false };
    dbCalls.push(rec);
    const builder: Builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        rec.eqs.push([col, val]);
        return builder;
      },
      in(col, vals) {
        rec.ins.push([col, vals]);
        return builder;
      },
      order() {
        return builder;
      },
      insert(row) {
        rec.op = "insert";
        rec.row = row;
        return builder;
      },
      update(row) {
        rec.op = "update";
        rec.row = row;
        return builder;
      },
      delete() {
        rec.op = "delete";
        return builder;
      },
      maybeSingle() {
        rec.single = true;
        return builder;
      },
      then(onfulfilled, onrejected) {
        return Promise.resolve(respond(rec)).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  function makeStorage(client: ClientLabel) {
    return {
      from(bucket: string) {
        return {
          upload(path: string) {
            storageCalls.push({ client, bucket, method: "upload", path });
            return Promise.resolve({ data: { path }, error: cfg.uploadError });
          },
          createSignedUrl(path: string) {
            storageCalls.push({ client, bucket, method: "createSignedUrl", path });
            return Promise.resolve({
              data: cfg.signedUrlError ? null : { signedUrl: "https://signed.example/url" },
              error: cfg.signedUrlError,
            });
          },
          remove(paths: string[]) {
            storageCalls.push({ client, bucket, method: "remove", paths });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
  }

  function makeClient(client: ClientLabel) {
    return {
      from: (table: string) => makeBuilder(client, table),
      storage: makeStorage(client),
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ client, fn, args });
        return Promise.resolve({ error: null });
      },
    };
  }

  return {
    dbCalls,
    storageCalls,
    rpcCalls,
    org,
    cfg,
    makeTenant: () => makeClient("tenant"),
    makeAdmin: () => makeClient("admin"),
    reset() {
      dbCalls.length = 0;
      storageCalls.length = 0;
      rpcCalls.length = 0;
      org.id = "org-1";
      org.role = "staff";
      org.userId = "user-1";
      cfg.job = { id: "job-1", org_id: "org-1" };
      cfg.parent = null;
      cfg.version = null;
      cfg.versions = [];
      cfg.updated = null;
      cfg.deleted = null;
      cfg.docInsertError = null;
      cfg.versionInsertError = null;
      cfg.updateError = null;
      cfg.deleteError = null;
      cfg.uploadError = null;
      cfg.signedUrlError = null;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(h.makeTenant()),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => h.makeAdmin(),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: () =>
    Promise.resolve({
      ctx: { org: { id: h.org.id }, membership: { role: h.org.role } },
      user: { id: h.org.userId, email: "u@test.example" },
    }),
}));

const {
  createJobDocument,
  addJobDocumentVersion,
  listJobDocuments,
  listJobDocumentVersionsForDocuments,
  getJobDocumentDownloadUrl,
  completeJobDocument,
  deleteJobDocument,
  bucketForVisibility,
} = await import("@/server/services/job-documents");

const PDF = "application/pdf";
const bytes = (n: number) => new Uint8Array(n);

const findDb = (table: string, op: DbOp) =>
  h.dbCalls.find((c) => c.table === table && c.op === op);
const lastRpc = () => h.rpcCalls[h.rpcCalls.length - 1];

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.reset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// =====================================================================
// bucket mapping
// =====================================================================
describe("bucketForVisibility", () => {
  it("maps private → job-docs-private and staff → job-docs", () => {
    expect(bucketForVisibility("private")).toBe("job-docs-private");
    expect(bucketForVisibility("staff")).toBe("job-docs");
  });
});

// =====================================================================
// createJobDocument
// =====================================================================
describe("createJobDocument", () => {
  it("staff-area doc is inserted via the TENANT client and audited as job_document.created", async () => {
    const res = await createJobDocument({ jobId: "job-1", visibility: "staff", title: "RAMS" });
    expect(res.ok).toBe(true);
    expect(findDb("job_documents", "insert")?.client).toBe("tenant");
    expect(lastRpc()?.client).toBe("tenant");
    expect(lastRpc()?.args.p_action).toBe("job_document.created");
  });

  it("private-area doc is inserted via the ADMIN client and audited as job_document.private.created", async () => {
    const res = await createJobDocument({ jobId: "job-1", visibility: "private", title: "Insurance" });
    expect(res.ok).toBe(true);
    // The RETURNING-dodge: private rows are written with the service-role client.
    expect(findDb("job_documents", "insert")?.client).toBe("admin");
    // Audit still flows through the tenant client so auth.uid() is the actor.
    expect(lastRpc()?.client).toBe("tenant");
    expect(lastRpc()?.args.p_action).toBe("job_document.private.created");
  });

  it("rejects a job in another org (job lookup is RLS-scoped) without inserting", async () => {
    h.cfg.job = { id: "job-1", org_id: "org-OTHER" };
    const res = await createJobDocument({ jobId: "job-1", visibility: "private", title: "x" });
    expect(res).toEqual({ ok: false, error: "job_not_found" });
    expect(findDb("job_documents", "insert")).toBeUndefined();
  });

  it("rejects a missing job", async () => {
    h.cfg.job = null;
    const res = await createJobDocument({ jobId: "nope", visibility: "staff", title: "x" });
    expect(res).toEqual({ ok: false, error: "job_not_found" });
  });

  it("persists the forward-compat fields on the inserted row", async () => {
    await createJobDocument({
      jobId: "job-1",
      visibility: "staff",
      title: "EICR",
      docType: "eicr",
      assignedTo: "user-7",
      externalReference: "CERT-123",
      requiresStaffSignature: true,
      requiresCustomerSignature: true,
    });
    const row = findDb("job_documents", "insert")?.row as Record<string, unknown>;
    expect(row.doc_type).toBe("eicr");
    expect(row.assigned_to).toBe("user-7");
    expect(row.external_reference).toBe("CERT-123");
    expect(row.requires_staff_signature).toBe(true);
    expect(row.requires_customer_signature).toBe(true);
    expect(row.created_by).toBe("user-1");
  });
});

// =====================================================================
// addJobDocumentVersion
// =====================================================================
describe("addJobDocumentVersion", () => {
  it("rejects a disallowed MIME type before touching any client", async () => {
    const res = await addJobDocumentVersion({
      documentId: "doc-1",
      filename: "x.exe",
      mimeType: "application/x-msdownload",
      bytes: bytes(10),
    });
    expect(res).toEqual({ ok: false, error: "bad_file_type" });
    expect(h.storageCalls.length).toBe(0);
  });

  it("rejects an oversized file", async () => {
    const res = await addJobDocumentVersion({
      documentId: "doc-1",
      filename: "big.pdf",
      mimeType: PDF,
      bytes: bytes(25 * 1024 * 1024 + 1),
    });
    expect(res).toEqual({ ok: false, error: "file_too_large" });
  });

  it("refuses a parent document in another org (admin-path org re-check)", async () => {
    h.cfg.parent = {
      id: "doc-9",
      org_id: "org-OTHER",
      job_id: "job-1",
      visibility: "private",
      status: "draft",
    };
    const res = await addJobDocumentVersion({
      documentId: "doc-9",
      filename: "a.pdf",
      mimeType: PDF,
      bytes: bytes(10),
    });
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(h.storageCalls.length).toBe(0);
  });

  it("refuses to add a version to a completed (locked) document", async () => {
    h.cfg.parent = {
      id: "doc-1",
      org_id: "org-1",
      job_id: "job-1",
      visibility: "staff",
      status: "completed",
    };
    const res = await addJobDocumentVersion({
      documentId: "doc-1",
      filename: "a.pdf",
      mimeType: PDF,
      bytes: bytes(10),
    });
    expect(res).toEqual({ ok: false, error: "locked" });
    expect(h.storageCalls.length).toBe(0);
  });

  it("STAFF version: uploads to job-docs, inserts via TENANT client, audits job_document.version_added", async () => {
    h.cfg.parent = {
      id: "doc-1",
      org_id: "org-1",
      job_id: "job-1",
      visibility: "staff",
      status: "draft",
    };
    const res = await addJobDocumentVersion({
      documentId: "doc-1",
      filename: "report.pdf",
      mimeType: PDF,
      bytes: bytes(100),
    });
    expect(res.ok).toBe(true);
    const upload = h.storageCalls.find((c) => c.method === "upload");
    expect(upload?.bucket).toBe("job-docs");
    expect(upload?.client).toBe("admin"); // storage I/O always via service role
    expect(upload?.path).toMatch(/^org-1\/job-1\/doc-1\/[0-9a-f-]+\.pdf$/i);
    expect(findDb("job_document_versions", "insert")?.client).toBe("tenant");
    expect(lastRpc()?.args.p_action).toBe("job_document.version_added");
  });

  it("PRIVATE drop box: uploads to job-docs-private, inserts via ADMIN client, audits private action", async () => {
    h.cfg.parent = {
      id: "doc-2",
      org_id: "org-1",
      job_id: "job-1",
      visibility: "private",
      status: "draft",
    };
    const res = await addJobDocumentVersion({
      documentId: "doc-2",
      filename: "bank.pdf",
      mimeType: PDF,
      bytes: bytes(100),
    });
    expect(res.ok).toBe(true);
    const upload = h.storageCalls.find((c) => c.method === "upload");
    expect(upload?.bucket).toBe("job-docs-private");
    // Staff JWTs are blocked by the version INSERT policy → write via service role.
    expect(findDb("job_document_versions", "insert")?.client).toBe("admin");
    expect(lastRpc()?.args.p_action).toBe("job_document.private.version_added");
  });

  it("cleans up the orphaned object when the version row insert fails", async () => {
    h.cfg.parent = {
      id: "doc-1",
      org_id: "org-1",
      job_id: "job-1",
      visibility: "staff",
      status: "draft",
    };
    h.cfg.versionInsertError = { message: "boom" };
    const res = await addJobDocumentVersion({
      documentId: "doc-1",
      filename: "report.pdf",
      mimeType: PDF,
      bytes: bytes(100),
    });
    expect(res).toEqual({ ok: false, error: "record_failed" });
    const remove = h.storageCalls.find((c) => c.method === "remove");
    expect(remove?.bucket).toBe("job-docs");
    expect(remove?.paths?.length).toBe(1);
  });
});

// =====================================================================
// getJobDocumentDownloadUrl
// =====================================================================
describe("getJobDocumentDownloadUrl", () => {
  it("returns not_found and never mints a URL when the RLS-gated row read is empty (staff on private)", async () => {
    h.cfg.version = null; // RLS-denied
    const res = await getJobDocumentDownloadUrl("ver-1");
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(h.storageCalls.find((c) => c.method === "createSignedUrl")).toBeUndefined();
  });

  it("reads the version via the TENANT client (RLS gate) then signs via admin (60s)", async () => {
    h.cfg.version = {
      org_id: "org-1",
      document_id: "doc-2",
      visibility: "private",
      storage_bucket: "job-docs-private",
      storage_path: "org-1/job-1/doc-2/file.pdf",
    };
    const res = await getJobDocumentDownloadUrl("ver-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toBe("https://signed.example/url");
    // gate read happened on the tenant client
    expect(findDb("job_document_versions", "select")?.client).toBe("tenant");
    const signed = h.storageCalls.find((c) => c.method === "createSignedUrl");
    expect(signed?.client).toBe("admin");
    expect(signed?.bucket).toBe("job-docs-private");
    expect(lastRpc()?.args.p_action).toBe("job_document.private.downloaded");
  });
});

// =====================================================================
// completeJobDocument
// =====================================================================
describe("completeJobDocument", () => {
  it("updates via the TENANT client (RLS enforces who can complete)", async () => {
    h.cfg.updated = { id: "doc-1", org_id: "org-1", visibility: "staff" };
    const res = await completeJobDocument("doc-1");
    expect(res).toEqual({ ok: true, document_id: "doc-1" });
    expect(findDb("job_documents", "update")?.client).toBe("tenant");
    expect(lastRpc()?.args.p_action).toBe("job_document.completed");
  });

  it("returns forbidden when RLS refuses the update (e.g. staff on a private doc)", async () => {
    h.cfg.updated = null;
    const res = await completeJobDocument("doc-2");
    expect(res).toEqual({ ok: false, error: "forbidden" });
  });
});

// =====================================================================
// deleteJobDocument
// =====================================================================
describe("deleteJobDocument", () => {
  it("returns forbidden and removes NO files when RLS refuses the delete", async () => {
    h.cfg.versions = [{ storage_bucket: "job-docs", storage_path: "p1" }];
    h.cfg.deleted = null; // RLS refused
    const res = await deleteJobDocument("doc-1");
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(h.storageCalls.find((c) => c.method === "remove")).toBeUndefined();
  });

  it("deletes via the TENANT client (admin-only RLS), then removes files via admin and audits", async () => {
    h.cfg.versions = [
      { storage_bucket: "job-docs", storage_path: "org-1/job-1/doc-1/a.pdf" },
      { storage_bucket: "job-docs", storage_path: "org-1/job-1/doc-1/b.pdf" },
    ];
    h.cfg.deleted = { id: "doc-1", visibility: "staff" };
    const res = await deleteJobDocument("doc-1");
    expect(res).toEqual({ ok: true, document_id: "doc-1" });
    expect(findDb("job_documents", "delete")?.client).toBe("tenant");
    const remove = h.storageCalls.find((c) => c.method === "remove");
    expect(remove?.client).toBe("admin");
    expect(remove?.bucket).toBe("job-docs");
    expect(remove?.paths?.length).toBe(2);
    expect(lastRpc()?.args.p_action).toBe("job_document.deleted");
  });

  it("uses the private action prefix when deleting a private document", async () => {
    h.cfg.versions = [{ storage_bucket: "job-docs-private", storage_path: "org-1/job-1/doc-2/a.pdf" }];
    h.cfg.deleted = { id: "doc-2", visibility: "private" };
    const res = await deleteJobDocument("doc-2");
    expect(res.ok).toBe(true);
    expect(lastRpc()?.args.p_action).toBe("job_document.private.deleted");
  });
});

// =====================================================================
// listJobDocuments — area filter is applied
// =====================================================================
describe("listJobDocuments", () => {
  it("filters by job_id and the requested visibility area (RLS still gates private)", async () => {
    h.cfg.versions = []; // unused here
    await listJobDocuments("job-1", "private");
    const sel = findDb("job_documents", "select");
    expect(sel?.client).toBe("tenant");
    expect(sel?.eqs).toContainEqual(["job_id", "job-1"]);
    expect(sel?.eqs).toContainEqual(["visibility", "private"]);
  });
});

// =====================================================================
// listJobDocumentVersionsForDocuments — batched, RLS-gated, grouped
// =====================================================================
describe("listJobDocumentVersionsForDocuments (F-6 N+1 fix)", () => {
  it("does NO query and returns an empty map for an empty id list", async () => {
    const map = await listJobDocumentVersionsForDocuments([]);
    expect(map.size).toBe(0);
    // No round-trip — not even requireOrgContext's downstream read.
    expect(findDb("job_document_versions", "select")).toBeUndefined();
  });

  it("reads every document's versions in ONE .in() query on the TENANT client", async () => {
    h.cfg.versions = [
      { id: "v3", document_id: "doc-A", version_no: 2 },
      { id: "v2", document_id: "doc-A", version_no: 1 },
      { id: "v1", document_id: "doc-B", version_no: 1 },
    ];
    await listJobDocumentVersionsForDocuments(["doc-A", "doc-B"]);
    const sels = h.dbCalls.filter(
      (c) => c.table === "job_document_versions" && c.op === "select",
    );
    // Exactly one version query for the whole batch — the N+1 is gone.
    expect(sels).toHaveLength(1);
    expect(sels[0]?.client).toBe("tenant");
    expect(sels[0]?.ins).toContainEqual(["document_id", ["doc-A", "doc-B"]]);
  });

  it("groups versions by document_id, newest-first within each group", async () => {
    h.cfg.versions = [
      { id: "v3", document_id: "doc-A", version_no: 2, filename: "a-v2.pdf" },
      { id: "v2", document_id: "doc-A", version_no: 1, filename: "a-v1.pdf" },
      { id: "v1", document_id: "doc-B", version_no: 1, filename: "b-v1.pdf" },
    ];
    const map = await listJobDocumentVersionsForDocuments(["doc-A", "doc-B"]);
    expect(map.get("doc-A")?.map((v) => v.id)).toEqual(["v3", "v2"]);
    expect(map.get("doc-B")?.map((v) => v.id)).toEqual(["v1"]);
    // Public row shape is preserved (document_id stripped from the output).
    expect(map.get("doc-A")?.[0]).not.toHaveProperty("document_id");
    expect(map.get("doc-A")?.[0]?.filename).toBe("a-v2.pdf");
  });

  it("a document with no versions is simply absent from the map", async () => {
    h.cfg.versions = [{ id: "v1", document_id: "doc-A", version_no: 1 }];
    const map = await listJobDocumentVersionsForDocuments(["doc-A", "doc-EMPTY"]);
    expect(map.has("doc-A")).toBe(true);
    expect(map.has("doc-EMPTY")).toBe(false);
  });
});
