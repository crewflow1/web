import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OFFLINE_WRITE_KINDS,
  OFFLINE_WRITE_REGISTRY,
  isOfflineWriteKind,
  offlineWriteEntity,
  describeOfflineCount,
} from "@/lib/offline/registry";

/**
 * The offline write registry — the one place that answers "what may be authored
 * with no signal?".
 *
 * These tests exist because the registry is a PRODUCT boundary, not a code detail.
 * A future change that quietly adds an entity — or that adds one to the registry
 * while forgetting the server handler or the database's idempotency index — must
 * fail CI rather than ship an entity nobody decided to enable.
 */

const root = join(__dirname, "..", "..");
const dispatchSrc = readFileSync(
  join(root, "server/services/offline-writes.ts"),
  "utf8",
);
const migration = readFileSync(
  join(root, "supabase/migrations/20261077000000_offline_write_queue.sql"),
  "utf8",
);

describe("offline write registry — exactly one entity is enabled", () => {
  it("ONLY site_diary.create is offline-writable", () => {
    // If this fails, an entity became offline-writable. That is a CEO/product
    // decision (docs/offline-write-queue.md) — update the doc and this list
    // together, deliberately.
    expect([...OFFLINE_WRITE_KINDS]).toEqual(["site_diary.create"]);
  });

  it("no money, no lifecycle, no signature, no numbered document is enabled", () => {
    const forbidden =
      /invoice|quote|payroll|timesheet|time_entr|expense|purchase_order|payment|stock|permit|signoff|sign_off|toolbox|rams|cis/i;
    for (const k of OFFLINE_WRITE_KINDS) {
      expect(k, `${k} must not be offline-writable`).not.toMatch(forbidden);
    }
  });

  it("no UPDATE or DELETE is enabled — the queue is append-only this milestone", () => {
    for (const k of OFFLINE_WRITE_KINDS) {
      expect(k).not.toMatch(/\.(update|delete|edit|patch)$/);
    }
  });

  it("the gate narrows unknown strings and objects, so callers can't skip it", () => {
    expect(isOfflineWriteKind("site_diary.create")).toBe(true);
    expect(isOfflineWriteKind("site_diary.update")).toBe(false);
    expect(isOfflineWriteKind("invoices.create")).toBe(false);
    expect(isOfflineWriteKind("")).toBe(false);
    expect(isOfflineWriteKind(null)).toBe(false);
    expect(isOfflineWriteKind({ toString: () => "site_diary.create" })).toBe(false);
  });
});

describe("offline write registry — no drift between the three gates", () => {
  it("every registry kind has a server handler (a case in the dispatch switch)", () => {
    for (const kind of OFFLINE_WRITE_KINDS) {
      expect(
        dispatchSrc.includes(`case "${kind}":`),
        `${kind} is in the registry but has no case in dispatchOfflineWrite`,
      ).toBe(true);
    }
  });

  it("the dispatch switch handles no kind the registry does not enable", () => {
    const cases = [...dispatchSrc.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
    for (const c of cases) {
      expect(
        isOfflineWriteKind(c),
        `dispatchOfflineWrite handles "${c}" which is not in the registry`,
      ).toBe(true);
    }
    expect(cases.length).toBe(OFFLINE_WRITE_KINDS.length);
  });

  it("the enabled entity's table has the DB-level idempotency index (gate 1 of 3)", () => {
    // site_diary.create → site_diary_entries. A registry entry without the unique
    // index would be an entity with no duplicate protection at all.
    expect(migration).toMatch(/create unique index[\s\S]*site_diary_entries/);
    expect(migration).toMatch(/\(org_id, client_write_key\)/);
    expect(migration).toMatch(/where client_write_key is not null/);
  });

  it("every registry entry is complete (schema, labels, recovery fields)", () => {
    for (const kind of OFFLINE_WRITE_KINDS) {
      const e = offlineWriteEntity(kind);
      expect(e.label.length, kind).toBeGreaterThan(0);
      expect(e.labelPlural.length, kind).toBeGreaterThan(0);
      expect(e.viewHref.startsWith("/"), kind).toBe(true);
      expect(typeof e.schema.safeParse, kind).toBe("function");
      // recoverFields is what lets a user read back a REJECTED item. An empty list
      // would mean a permanently-refused entry showing no content to copy.
      expect(e.recoverFields.length, kind).toBeGreaterThan(0);
    }
  });
});

describe("offline write registry — the shared schema is genuinely shared", () => {
  it("site_diary.create validates with the SAME schema the online action uses", async () => {
    const { createDiaryEntrySchema } = await import("@/lib/site-diary/schema");
    expect(OFFLINE_WRITE_REGISTRY["site_diary.create"].schema).toBe(
      createDiaryEntrySchema,
    );
  });

  it("that schema refuses offline exactly what it refuses online", () => {
    const schema = offlineWriteEntity("site_diary.create").schema;
    expect(schema.safeParse({ entry_date: "2026-07-30" }).success).toBe(true);
    expect(schema.safeParse({ entry_date: "30/07/2026" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ entry_date: "2026-07-30", labour_count: "-1" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ entry_date: "2026-07-30", job_id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("recoverFields name real payload fields the schema accepts", () => {
    const e = offlineWriteEntity("site_diary.create");
    const parsed = e.schema.safeParse({
      entry_date: "2026-07-30",
      weather: "wet",
      labour_count: "3",
      work_summary: "w",
      delays: "d",
      notes: "n",
    });
    expect(parsed.success).toBe(true);
    const keys = Object.keys((parsed as { data: object }).data);
    for (const f of e.recoverFields) expect(keys, f).toContain(f);
  });
});

describe("offline write registry — user-facing counting", () => {
  it("never says '2 diary entry'", () => {
    expect(describeOfflineCount("site_diary.create", 1)).toBe("1 diary entry");
    expect(describeOfflineCount("site_diary.create", 2)).toBe("2 diary entries");
    expect(describeOfflineCount("site_diary.create", 0)).toBe("0 diary entries");
  });
});

describe("offline write registry — the read-only stance is written down", () => {
  it("documents WHY each major entity is not enabled (not just that it isn't)", () => {
    const src = readFileSync(join(root, "lib/offline/registry.ts"), "utf8");
    // A reviewer must be able to find the reasoning next to the decision.
    for (const topic of [
      "snags",
      "timesheets",
      "expenses",
      "invoices",
      "stock",
      "permits",
      "toolbox",
    ]) {
      expect(src.toLowerCase(), `no rationale recorded for ${topic}`).toContain(topic);
    }
  });
});
