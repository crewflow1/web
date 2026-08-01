import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  queuedWriteMatchesPartition,
  writeQueueKey,
} from "@/lib/offline/write-queue";
import { isOfflineWriteKind } from "@/lib/offline/registry";
import { dispatchOfflineWrite } from "@/server/services/offline-writes";
import type { OrgContext } from "@/server/auth/session";

/**
 * OFFLINE WRITE QUEUE — security contracts.
 *
 * Offline authoring adds two genuinely new risks to CrewFlow, and every test in
 * this file exists to bound one of them:
 *
 *   1. UNSENT USER DATA SITTING IN A SHARED TABLET'S BROWSER. Site tablets are
 *      passed between people. One person's unsent words must never be visible to,
 *      flushed by, or attributed to the next person.
 *   2. A SECOND WRITE PATH INTO THE DATABASE. A queued replay must be exactly as
 *      privileged as an online form post — same session, same RLS, same
 *      validation, same org. Any shortcut (service role, RPC, SECURITY DEFINER,
 *      an org id taken from the payload) would be an authorization bypass that a
 *      stolen or crafted queue item could ride.
 *
 * Behaviour is proven against a real IndexedDB in __tests__/offline/write-queue.test.ts
 * and in a real browser in e2e/offline-diary-queue.spec.ts; the DB-level idempotency
 * proof is in __tests__/integration/rls/offline-write-idempotency.test.ts. These are
 * the source contracts that keep the invariants from being edited away.
 */

/**
 * Several contracts below are "this code must NOT do X". These files are heavily
 * commented — including comments that NAME the thing being forbidden, in order to
 * explain why — so a naive grep over the raw text asserts about prose rather than
 * behaviour. `code()` and `sql()` strip comments first, so the negative contracts
 * are genuinely about what executes.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sql = (s: string) => s.replace(/--.*$/gm, "");

const root = join(__dirname, "..", "..");
const queueSrc = readFileSync(join(root, "lib/offline/write-queue.ts"), "utf8");
const registrySrc = readFileSync(join(root, "lib/offline/registry.ts"), "utf8");
const writesSrc = readFileSync(
  join(root, "server/services/offline-writes.ts"),
  "utf8",
);
const actionSrc = readFileSync(
  join(root, "app/(app)/offline-sync-actions.ts"),
  "utf8",
);
const outboxSrc = readFileSync(
  join(root, "app/(app)/_components/offline-outbox.tsx"),
  "utf8",
);
const signOutSrc = readFileSync(
  join(root, "app/(app)/_components/sign-out-button.tsx"),
  "utf8",
);
const offlineShellSrc = readFileSync(join(root, "app/offline/page.tsx"), "utf8");
const diaryActionsSrc = readFileSync(
  join(root, "app/(app)/diary/actions.ts"),
  "utf8",
);
const diaryFormSrc = readFileSync(join(root, "app/(app)/diary/_form.tsx"), "utf8");
const appLayoutSrc = readFileSync(join(root, "app/(app)/layout.tsx"), "utf8");
const migration = readFileSync(
  join(root, "supabase/migrations/20261077000000_offline_write_queue.sql"),
  "utf8",
);

// ── a queued replay is NOT a privileged write ────────────────────────────────
describe("offline sync — runs under the caller's own session, never a privileged one", () => {
  it("the action establishes identity with requireOrgContext(), like every online action", () => {
    expect(actionSrc).toMatch(/await requireOrgContext\(\)/);
    // and it does so BEFORE dispatching any write
    expect(actionSrc.indexOf("requireOrgContext")).toBeLessThan(
      actionSrc.indexOf("dispatchOfflineWrite("),
    );
  });

  it("neither the action nor the write core reaches for the service-role client", () => {
    for (const [name, src] of [
      ["offline-sync-actions.ts", actionSrc],
      ["offline-writes.ts", writesSrc],
    ] as const) {
      expect(src, name).not.toMatch(/createAdminClient|supabase\/admin/);
      expect(src, name).not.toMatch(/SERVICE_ROLE|service_role/);
    }
  });

  it("the entity write goes through the TENANT (user-JWT) client, so RLS applies", () => {
    expect(writesSrc).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server"/);
    expect(writesSrc).toMatch(/const tenant = await createClient\(\)/);
    expect(writesSrc).toMatch(/tenant\.from\("site_diary_entries" as never\)/);
  });

  it("there is no RPC / SECURITY DEFINER / privileged replay path", () => {
    expect(writesSrc).not.toMatch(/\.rpc\(/);
    expect(migration).not.toMatch(/security definer/i);
    expect(migration).not.toMatch(/create (or replace )?function/i);
  });

  it("the migration weakens no RLS policy and adds no policy of its own", () => {
    expect(migration).not.toMatch(/drop policy/i);
    expect(migration).not.toMatch(/create policy/i);
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/\bgrant\b/i);
  });

  it("the sync action takes ONE item and exposes no batch/admin/impersonating variant", () => {
    const exported = [...actionSrc.matchAll(/export async function (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(["syncQueuedWrite"]);
    // no argument can redirect the write to another user or org
    expect(actionSrc).not.toMatch(/userId|actorId|asUser|onBehalfOf/);
  });
});

// ── the org a queued write lands in ──────────────────────────────────────────
describe("offline sync — active-org pin: refused, never re-homed", () => {
  const ctx = (orgId: string) =>
    ({
      membership: { org_id: orgId, role: "owner" },
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
  const item = {
    clientKey: "55555555-5555-4555-8555-555555555555",
    kind: "site_diary.create",
    orgId: "org-A",
    payload: { entry_date: "2026-07-30", work_summary: "basement pour" },
    authoredAt: "2026-07-30T16:02:00.000Z",
  };

  it("an item authored for org A is REFUSED while org B is active (no re-home, no write)", async () => {
    // No Supabase client is constructed on this path at all — the refusal happens
    // before any database access, which is why this runs in the hermetic tier.
    const out = await dispatchOfflineWrite({ ctx: ctx("org-B"), user, item });
    expect(out).toEqual({ status: "rejected", reason: "org_mismatch" });
  });

  it("the org is read from the SESSION, and the payload's org is only ever compared", () => {
    expect(writesSrc).toMatch(/const orgId = args\.ctx\.org\.id/);
    expect(writesSrc).toMatch(/item\.orgId !== args\.ctx\.org\.id/);
    // the item's org is never assigned into the row
    expect(writesSrc).not.toMatch(/org_id:\s*item\.orgId/);
    expect(writesSrc).toMatch(/org_id: orgId/);
  });

  it("created_by is the session user, never anything from the queued item", () => {
    expect(writesSrc).toMatch(/created_by: args\.user\.id/);
    expect(writesSrc).not.toMatch(/created_by:\s*item\./);
  });

  it("the duplicate lookup is pinned to the active org (no cross-org row id leak)", () => {
    const dup = writesSrc.slice(writesSrc.indexOf("UNIQUE_VIOLATION"));
    expect(dup).toMatch(/\.eq\("org_id", orgId\)/);
    expect(dup).toMatch(/\.eq\("client_write_key", clientKey\)/);
  });

  it("the duplicate lookup binds its OWN error and retries rather than rejecting", () => {
    /**
     * Caught by the loud-reads shape ledger and worth pinning here too: if this
     * lookup's error were discarded, a transient read failure between the insert and
     * the lookup would fall through to the permanent `not_permitted` rejection and
     * mark a foreman's entry as refused for a reason that had nothing to do with it.
     */
    const dup = writesSrc.slice(writesSrc.indexOf("UNIQUE_VIOLATION"));
    expect(dup).toMatch(/const \{ data: existing, error: lookupErr \} = await/);
    expect(dup).toMatch(/if \(lookupErr\) \{\s*return \{ status: "retry"/);
    // and the permanent refusal is only reachable AFTER that check
    expect(dup.indexOf("if (lookupErr)")).toBeLessThan(
      dup.indexOf('reason: "not_permitted"'),
    );
  });
});

// ── the registry is a real gate, not documentation ───────────────────────────
describe("offline sync — the registry gate runs on the SERVER", () => {
  it("rejects a kind that is not registered, before any dispatch", async () => {
    const out = await dispatchOfflineWrite({
      ctx: {
        membership: { org_id: "org-A", role: "owner" },
        org: {
          id: "org-A",
          name: "Org",
          slug: "org",
          status: "active",
          plan: "trial",
          trial_ends_at: null,
          created_at: "2026-01-01",
          onboarding_state: {},
        },
      } as OrgContext,
      user: { id: "u", email: null },
      item: {
        clientKey: "44444444-4444-4444-8444-444444444444",
        kind: "invoices.create", // never enabled
        orgId: "org-A",
        payload: { total: 999999 },
        authoredAt: "2026-07-30T00:00:00Z",
      },
    });
    expect(out).toEqual({ status: "rejected", reason: "unknown_kind" });
  });

  it("rejects a malformed envelope rather than guessing at it", async () => {
    const ctx = {
      membership: { org_id: "org-A", role: "owner" },
      org: {
        id: "org-A",
        name: "Org",
        slug: "org",
        status: "active",
        plan: "trial",
        trial_ends_at: null,
        created_at: "2026-01-01",
        onboarding_state: {},
      },
    } as OrgContext;
    const user = { id: "u", email: null };
    for (const bad of [
      { clientKey: "", kind: "site_diary.create", orgId: "org-A", payload: {}, authoredAt: "" },
      { clientKey: "44444444-4444-4444-8444-444444444444", kind: "site_diary.create", orgId: "", payload: {}, authoredAt: "" },
    ]) {
      const out = await dispatchOfflineWrite({ ctx, user, item: bad });
      expect(out).toEqual({ status: "rejected", reason: "malformed_item" });
    }
  });

  it("the gate is applied before the schema and before the org pin is trusted", () => {
    const gate = writesSrc.indexOf("isOfflineWriteKind(item.kind)");
    const schema = writesSrc.indexOf("offlineWriteEntity(item.kind).schema.safeParse");
    const dispatch = writesSrc.indexOf('case "site_diary.create":');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(schema);
    expect(schema).toBeLessThan(dispatch);
  });

  it("the client applies the same gate before anything is stored", () => {
    expect(queueSrc).toMatch(/if \(!isOfflineWriteKind\(args\.kind\)\) return/);
  });
});

// ── validation is not weakened for the offline path ──────────────────────────
describe("offline sync — identical validation to the online form", () => {
  it("both paths call the SAME write core, so they cannot diverge", () => {
    expect(diaryActionsSrc).toMatch(/createDiaryEntryRecord\(/);
    expect(writesSrc).toMatch(/export async function createDiaryEntryRecord/);
    expect(writesSrc).toMatch(/export async function dispatchOfflineWrite/);
    // and the online action has no insert statement of its own any more
    const create = diaryActionsSrc.slice(
      diaryActionsSrc.indexOf("export async function createDiaryEntry"),
      diaryActionsSrc.indexOf("export async function updateDiaryEntry"),
    );
    expect(create).not.toMatch(/\.insert\(/);
  });

  it("the queued payload is re-validated server-side with the registry schema", () => {
    expect(writesSrc).toMatch(/offlineWriteEntity\(item\.kind\)\.schema\.safeParse\(item\.payload\)/);
  });

  it("the cross-org job guard runs on the shared core, so it covers BOTH paths", () => {
    expect(writesSrc).toMatch(/\.eq\("org_id", orgId\)[\s\S]{0,80}maybeSingle/);
    expect(writesSrc).toMatch(/reason: "job_missing"/);
  });
});

// ── failure handling must never destroy user content ─────────────────────────
describe("offline sync — an unclassified failure NEVER discards the user's work", () => {
  it("permanent rejection is an explicit allowlist; everything else is a retry", () => {
    expect(writesSrc).toMatch(/const PERMANENT_CODES: Record<string, OfflineRejectReason>/);
    // the fall-through after the allowlist is a retry, not a rejection
    const tail = writesSrc.slice(writesSrc.indexOf("const permanent = error.code"));
    expect(tail).toMatch(/return \{ status: "retry"/);
    expect(tail.indexOf('status: "retry"')).toBeLessThan(
      tail.indexOf("recordAdminActivity"),
    );
  });

  it("the outbox treats a THROWN action (expired session) as transient", () => {
    // The catch around the sync call ONLY, not the rest of the file.
    const body = code(outboxSrc);
    const start = body.indexOf("} catch {", body.indexOf("await syncQueuedWrite("));
    const catchBlock = body.slice(start, body.indexOf("}", body.indexOf("break;", start)));
    expect(catchBlock).toMatch(/markAttemptFailed/);
    expect(catchBlock).not.toMatch(/markRejected|removeQueued/);
  });

  it("only accepted/duplicate deletes a queued item — rejection retains it", () => {
    expect(outboxSrc).toMatch(
      /outcome\.status === "accepted" \|\| outcome\.status === "duplicate"[\s\S]{0,200}removeQueued/,
    );
    expect(outboxSrc).toMatch(/status === "rejected"[\s\S]{0,120}markRejected/);
    // a rejected item's content is shown so it can be recovered before discarding
    expect(outboxSrc).toMatch(/data-outbox-recover/);
    expect(outboxSrc).toMatch(/window\.confirm\(/); // discard is explicit
  });

  it("the queue's own failure modes are all surfaced — no silent drop path exists", () => {
    // Every EnqueueError has a user-facing message in the form.
    const errors = [
      ...queueSrc.matchAll(/^\s*\| "(\w+)" \/\//gm),
    ].map((m) => m[1]!);
    expect(errors.length).toBeGreaterThan(5);
    for (const e of errors) {
      expect(diaryFormSrc, `EnqueueError "${e}" has no user-facing message`).toContain(
        `${e}:`,
      );
    }
  });

  it("the store never evicts to make room — it refuses", () => {
    expect(queueSrc).toMatch(/error: "queue_full"/);
    expect(queueSrc).toMatch(/error: "store_full"/);
    // no LRU / oldest-first eviction anywhere in the executing code
    expect(code(queueSrc)).not.toMatch(/evict|shift\(\)|slice\(1\)|oldest/i);
  });
});

// ── shared-device safety ─────────────────────────────────────────────────────
describe("offline write queue — shared-device safety (the highest-severity risk)", () => {
  it("every item is keyed by userId + orgId + clientKey", () => {
    expect(queueSrc).toMatch(/\$\{userId\}\$\{SEP\}\$\{orgId\}\$\{SEP\}/);
    expect(writeQueueKey("a", "o", "k")).toBe("a::o::k");
  });

  it("the partition guard rejects a foreign user or org", () => {
    expect(queuedWriteMatchesPartition({ userId: "a", orgId: "o1" }, "a", "o1")).toBe(true);
    expect(queuedWriteMatchesPartition({ userId: "a", orgId: "o1" }, "b", "o1")).toBe(false);
    expect(queuedWriteMatchesPartition({ userId: "a", orgId: "o1" }, "a", "o2")).toBe(false);
  });

  it("reads are filtered through the partition guard, so a forged key can't flush", () => {
    expect(queueSrc).toMatch(
      /isValidQueuedWrite\(r\) && queuedWriteMatchesPartition\(r, userId, orgId\)/,
    );
  });

  it("the outbox purges FOREIGN-USER items before it can flush anything", () => {
    expect(outboxSrc).toMatch(/await purgeForeignUsers\(userId\)/);
    expect(outboxSrc.indexOf("purgeForeignUsers")).toBeLessThan(
      outboxSrc.indexOf("await flush()"),
    );
  });

  it("the outbox identity comes from the SERVER session, not from browser storage", () => {
    expect(appLayoutSrc).toMatch(/<OfflineOutbox userId=\{user\.id\} orgId=\{ctx\.org\.id\}/);
    // never the client-side offline identity marker (which the public shell uses)
    expect(outboxSrc).not.toMatch(/readOfflineIdentity/);
  });

  it("authoring requires a server-rendered identity too (same reason)", () => {
    expect(diaryFormSrc).not.toMatch(/readOfflineIdentity/);
    expect(
      readFileSync(join(root, "app/(app)/diary/new/page.tsx"), "utf8"),
    ).toMatch(/offline=\{\{ userId: user\.id, orgId: ctx\.org\.id \}\}/);
  });

  it("the PUBLIC offline shell exposes a COUNT and never queued content", () => {
    expect(offlineShellSrc).toMatch(/countOnDevice/);
    // no content-bearing reader is imported into the public route
    expect(offlineShellSrc).not.toMatch(/listForPartition|listPending|syncQueuedWrite/);
    // and there is no authoring form on the public shell
    expect(offlineShellSrc).not.toMatch(/enqueue\(/);
  });
});

describe("offline write queue — LOGOUT purge, wired into the real lifecycle", () => {
  it("sign-out purges the write queue BEFORE the server signOut", () => {
    expect(signOutSrc).toMatch(/clearAll as clearWriteQueue/);
    expect(signOutSrc).toMatch(/await clearWriteQueue\(\)/);
    expect(signOutSrc.indexOf("await clearWriteQueue()")).toBeLessThan(
      signOutSrc.indexOf("await signOut()"),
    );
  });

  it("the existing drawing-cache purge still runs before signOut (no regression)", () => {
    expect(signOutSrc).toMatch(/clearAll\(\);\s*clearOfflineIdentity\(\)/);
    expect(signOutSrc.indexOf("clearAll()")).toBeLessThan(
      signOutSrc.indexOf("await signOut()"),
    );
  });

  it("the user is WARNED with a count before unsent work is deleted", () => {
    expect(signOutSrc).toMatch(/countOnDevice\(\)/);
    expect(signOutSrc).toMatch(/window\.confirm\(/);
    // cancelling the confirm must abort the sign-out, not fall through to the purge
    expect(signOutSrc).toMatch(/if \(!ok\) return;/);
    expect(signOutSrc.indexOf("if (!ok) return;")).toBeLessThan(
      signOutSrc.indexOf("await clearWriteQueue()"),
    );
  });

  it("purge failure never blocks logout", () => {
    const body = signOutSrc.slice(signOutSrc.indexOf("action={async"));
    expect(body).toMatch(/try \{\s*await clearWriteQueue\(\);\s*\} catch/);
  });
});

// ── nothing sensitive is ever persisted in the browser ───────────────────────
describe("offline write queue — never persists credentials or URLs", () => {
  it("the store references no token, signed URL, storage path, or service role", () => {
    expect(queueSrc).not.toMatch(
      /createSignedUrl|signedUrl|\?token=|access_token|refresh_token|service_role|Authorization|Bearer|storage_path|storage\.from/,
    );
  });

  it("the payload is re-parsed through the registry schema, which STRIPS unknown keys", () => {
    expect(queueSrc).toMatch(
      /offlineWriteEntity\(args\.kind\)\.schema\.safeParse\(args\.payload\)/,
    );
    // the PARSED value is what gets stored, not the caller's object
    expect(queueSrc).toMatch(/const payload = parsed\.data as Record<string, unknown>/);
    expect(queueSrc).not.toMatch(/payload: args\.payload/);
    // the registry schemas are not .passthrough() (which would defeat the stripping)
    expect(registrySrc).not.toMatch(/passthrough|catchall/);
  });

  it("the offline write registry is the only place kinds are declared", () => {
    expect(isOfflineWriteKind("site_diary.create")).toBe(true);
    // the queue itself hardcodes no kind list
    expect(queueSrc).not.toMatch(/"site_diary\.create"/);
  });
});

// ── the migration itself ─────────────────────────────────────────────────────
describe("offline write queue — migration 20261077 is additive and teardown-safe", () => {
  it("is additive only: no drop table/column, no destructive rewrite", () => {
    expect(sql(migration)).not.toMatch(/drop table|drop column|truncate|delete from/i);
    expect(migration).toMatch(/add column if not exists client_write_key uuid/);
    expect(migration).toMatch(/add column if not exists offline_authored_at/);
  });

  it("adds NO new foreign key and no RESTRICT (the 20261052 cascade lesson)", () => {
    // A referencing object is what made org teardown fail in 20261052; this
    // migration introduces none, so `delete from organizations` is unaffected.
    expect(sql(migration)).not.toMatch(/references/i);
    expect(sql(migration)).not.toMatch(/on delete restrict|on update restrict/i);
    expect(sql(migration)).not.toMatch(/create table/i);
  });

  it("scopes the idempotency index to the org (one tenant can never collapse another's)", () => {
    expect(migration).toMatch(
      /create unique index if not exists[\s\S]*\(org_id, client_write_key\)/,
    );
  });

  it("is re-runnable (every statement is if-not-exists)", () => {
    const stmts = migration.match(/^(alter table|create unique index)/gim) ?? [];
    expect(stmts.length).toBeGreaterThan(0);
    expect(migration).toMatch(/create unique index if not exists/);
    expect(migration).toMatch(/add column if not exists/);
  });
});
