import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgContext } from "@/server/auth/session";

/**
 * OFFLINE PHOTO upload — the server dispatch, exercised for REAL against a scripted
 * Supabase mock. Proves the upload-on-reconnect contract and its trust boundary:
 *
 *   - a capture authored for another org is REFUSED, never re-homed (hermetic —
 *     before any client is built);
 *   - a well-formed capture verifies the target belongs to the active org, uploads
 *     the bytes, and records the row under the tenant client;
 *   - IDEMPOTENCY: a re-delivered capture (same client key) is recognised as a
 *     duplicate and NOT uploaded twice;
 *   - a bad MIME / malformed envelope / missing target is a permanent rejection.
 */

const h = vi.hoisted(() => {
  type PgErr = { message: string; code?: string } | null;
  const state = {
    reads: new Map<string, Array<{ data: unknown; error: PgErr }>>(),
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    insertResult: { error: null as PgErr },
    uploads: [] as string[],
    uploadResult: { error: null as { message: string } | null },
    removed: [] as string[],
  };
  const nextRead = (t: string) => {
    const q = state.reads.get(t);
    if (!q || q.length === 0) throw new Error(`unscripted read on ${t}`);
    return q.shift()!;
  };
  const tenant = {
    from(table: string) {
      return {
        select() {
          const rc = { eq: () => rc, maybeSingle: async () => nextRead(table) };
          return rc;
        },
        insert(row: Record<string, unknown>) {
          state.inserts.push({ table, row });
          return Promise.resolve({ error: state.insertResult.error });
        },
      };
    },
  };
  const admin = {
    storage: {
      from() {
        return {
          upload: async (path: string) => {
            state.uploads.push(path);
            return { error: state.uploadResult.error };
          },
          remove: async (paths: string[]) => {
            state.removed.push(...paths);
            return { error: null };
          },
        };
      },
    },
  };
  return { state, tenant, admin };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.tenant }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async () => {},
}));

import { dispatchOfflinePhoto } from "@/server/services/offline-photo-writes";

const ORG = "org-1";
const KEY = "55555555-5555-4555-8555-555555555555";
const TARGET = "11111111-1111-4111-8111-111111111111";

const ctx = (orgId = ORG) =>
  ({
    membership: { org_id: orgId, role: "staff" },
    org: {
      id: orgId,
      name: "Org",
      slug: "org",
      status: "active",
      plan: "trial",
      trial_ends_at: null,
      created_at: "2026-01-01",
      onboarding_state: {},
    },
  }) as OrgContext;
const user = { id: "user-1", email: "a@b.test" };

const item = (over: Record<string, unknown> = {}) => ({
  clientKey: KEY,
  orgId: ORG,
  targetTable: "snags",
  targetId: TARGET,
  filename: "snag.png",
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2, 3, 4]),
  authoredAt: "2026-08-19T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  h.state.reads.clear();
  h.state.inserts.length = 0;
  h.state.uploads.length = 0;
  h.state.removed.length = 0;
  h.state.insertResult.error = null;
  h.state.uploadResult.error = null;
});

describe("dispatchOfflinePhoto — trust boundary (hermetic, no client)", () => {
  it("refuses a capture authored for another org (no re-home, no upload)", async () => {
    const out = await dispatchOfflinePhoto({
      ctx: ctx("org-B"),
      user,
      item: item({ orgId: "org-A" }),
    });
    expect(out).toEqual({ status: "rejected", reason: "org_mismatch" });
    expect(h.state.uploads.length).toBe(0);
  });

  it("refuses a malformed key, an unknown target, and a bad MIME", async () => {
    expect(
      (await dispatchOfflinePhoto({ ctx: ctx(), user, item: item({ clientKey: "nope" }) })).status,
    ).toBe("rejected");
    expect(
      await dispatchOfflinePhoto({ ctx: ctx(), user, item: item({ targetTable: "organizations_secret" }) }),
    ).toEqual({ status: "rejected", reason: "unknown_target" });
    expect(
      await dispatchOfflinePhoto({ ctx: ctx(), user, item: item({ mimeType: "application/zip" }) }),
    ).toEqual({ status: "rejected", reason: "bad_file_type" });
    expect(h.state.uploads.length).toBe(0);
  });
});

describe("dispatchOfflinePhoto — upload on reconnect", () => {
  it("verifies the target's org, uploads the bytes, records the tenant row", async () => {
    h.state.reads.set("snags", [{ data: { id: TARGET }, error: null }]); // target exists in org
    h.state.reads.set("tenant_attachments", [{ data: null, error: null }]); // no dupe yet

    const out = await dispatchOfflinePhoto({ ctx: ctx(), user, item: item() });

    expect(out.status).toBe("accepted");
    // ONE upload, into an org-first path
    expect(h.state.uploads.length).toBe(1);
    expect(h.state.uploads[0]!.startsWith(`${ORG}/snags/${TARGET}/`)).toBe(true);
    // the row is inserted under the tenant client with the idempotency key + hash
    const ins = h.state.inserts.find((i) => i.table === "tenant_attachments");
    expect(ins?.row.client_write_key).toBe(KEY);
    expect(ins?.row.org_id).toBe(ORG);
    expect(typeof ins?.row.content_hash).toBe("string");
    expect(ins?.row.uploaded_by).toBe(user.id); // session user, never from the item
    expect(ins?.row.offline_authored_at).toBe("2026-08-19T10:00:00.000Z");
  });

  it("rejects when the target row is gone or belongs to another org (no upload)", async () => {
    h.state.reads.set("snags", [{ data: null, error: null }]);
    const out = await dispatchOfflinePhoto({ ctx: ctx(), user, item: item() });
    expect(out).toEqual({ status: "rejected", reason: "target_missing" });
    expect(h.state.uploads.length).toBe(0);
  });
});

describe("dispatchOfflinePhoto — idempotency", () => {
  it("a re-delivered capture (same key) is a duplicate, NOT a second upload", async () => {
    h.state.reads.set("snags", [{ data: { id: TARGET }, error: null }]);
    h.state.reads.set("tenant_attachments", [
      { data: { id: "existing-att" }, error: null }, // key already recorded
    ]);

    const out = await dispatchOfflinePhoto({ ctx: ctx(), user, item: item() });
    expect(out).toEqual({ status: "duplicate", id: "existing-att" });
    expect(h.state.uploads.length).toBe(0); // no second upload
    expect(h.state.inserts.length).toBe(0); // no second row
  });

  it("a unique-violation race after upload collapses onto the existing row + cleans the orphan", async () => {
    h.state.reads.set("snags", [{ data: { id: TARGET }, error: null }]);
    h.state.reads.set("tenant_attachments", [
      { data: null, error: null }, // dedupe read: not seen yet
      { data: { id: "won-the-race" }, error: null }, // post-conflict lookup
    ]);
    h.state.insertResult.error = { message: "dup", code: "23505" };

    const out = await dispatchOfflinePhoto({ ctx: ctx(), user, item: item() });
    expect(out).toEqual({ status: "duplicate", id: "won-the-race" });
    // the bytes we uploaded before losing the race are cleaned up
    expect(h.state.removed.length).toBe(1);
  });
});
