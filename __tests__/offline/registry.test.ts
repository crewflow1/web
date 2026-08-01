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
const foundationMigration = readFileSync(
  join(root, "supabase/migrations/20261077000000_offline_write_queue.sql"),
  "utf8",
);
const expansionMigration = readFileSync(
  join(root, "supabase/migrations/20261083000000_offline_write_expansion.sql"),
  "utf8",
);

/**
 * kind → (table with the DB idempotency gate, the migration that opened it,
 * a payload the kind's schema accepts — used to prove recoverFields are real).
 */
const GATES: Record<
  (typeof OFFLINE_WRITE_KINDS)[number],
  { table: string; migration: string; validPayload: Record<string, unknown> }
> = {
  "site_diary.create": {
    table: "site_diary_entries",
    migration: foundationMigration,
    validPayload: {
      entry_date: "2026-07-30",
      weather: "wet",
      labour_count: "3",
      work_summary: "w",
      delays: "d",
      notes: "n",
    },
  },
  "snag.create": {
    table: "snags",
    migration: expansionMigration,
    validPayload: {
      title: "Cracked tile in the ensuite",
      description: "Replace and re-seal",
      location: "Plot 4 ensuite",
      trade: "Tiling",
      priority: "high",
      due_date: "2026-08-07",
    },
  },
  "material_request.create": {
    table: "material_requests",
    migration: expansionMigration,
    validPayload: {
      needed_by: "2026-08-03",
      priority: "urgent",
      notes: "rear gate before 10am",
      lines: [{ description: "Cement 25kg", qty: 20, unit: "bag" }],
    },
  },
};

describe("offline write registry — exactly the entities the product enabled", () => {
  it("the enabled set is site_diary.create + snag.create + material_request.create", () => {
    // If this fails, an entity became (or stopped being) offline-writable.
    // That is a CEO/product decision (docs/offline-write-queue.md) — update the
    // doc, the registry rationale and this list together, deliberately.
    // Train 5 (migration 20261083) added the snag CREATE and the material
    // request DRAFT create; toolbox-talk acks were considered and REJECTED
    // (server-pinned attestation time — see the registry header).
    expect([...OFFLINE_WRITE_KINDS]).toEqual([
      "site_diary.create",
      "snag.create",
      "material_request.create",
    ]);
  });

  it("no money, no lifecycle transition, no signature, no numbered-offline document is enabled", () => {
    // material_request.create allocates its number AT SYNC TIME on the server
    // (never on the device) and lands as a draft — so "numbered document" and
    // "lifecycle" stay true product exclusions even with it enabled.
    const forbidden =
      /invoice|quote|payroll|timesheet|time_entr|expense|purchase_order|payment|stock|permit|signoff|sign_off|toolbox|rams|cis|\.submit|\.approve|\.decide|\.issue/i;
    for (const k of OFFLINE_WRITE_KINDS) {
      expect(k, `${k} must not be offline-writable`).not.toMatch(forbidden);
    }
  });

  it("no UPDATE or DELETE is enabled — the queue is append-only", () => {
    for (const k of OFFLINE_WRITE_KINDS) {
      expect(k).toMatch(/\.create$/);
      expect(k).not.toMatch(/\.(update|delete|edit|patch)$/);
    }
  });

  it("the gate narrows unknown strings and objects, so callers can't skip it", () => {
    expect(isOfflineWriteKind("site_diary.create")).toBe(true);
    expect(isOfflineWriteKind("snag.create")).toBe(true);
    expect(isOfflineWriteKind("material_request.create")).toBe(true);
    expect(isOfflineWriteKind("site_diary.update")).toBe(false);
    expect(isOfflineWriteKind("snag.update")).toBe(false);
    expect(isOfflineWriteKind("material_request.submit")).toBe(false);
    expect(isOfflineWriteKind("toolbox_talk.acknowledge")).toBe(false);
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

  it("every enabled entity's table has the DB-level idempotency index (gate 1 of 3)", () => {
    // A registry entry without the unique index would be an entity with no
    // duplicate protection at all.
    for (const kind of OFFLINE_WRITE_KINDS) {
      const gate = GATES[kind];
      expect(gate.migration, `${kind}: unique index on ${gate.table}`).toMatch(
        new RegExp(`create unique index[^;]*on public\\.${gate.table}\\s*\\(org_id, client_write_key\\)[^;]*where client_write_key is not null`),
      );
      expect(gate.migration).toMatch(
        new RegExp(`alter table public\\.${gate.table}[\\s\\S]{0,400}client_write_key uuid`),
      );
      expect(gate.migration).toMatch(
        new RegExp(`alter table public\\.${gate.table}[\\s\\S]{0,600}offline_authored_at`),
      );
    }
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

describe("offline write registry — the shared schemas are genuinely shared", () => {
  it("site_diary.create validates with the SAME schema the online action uses", async () => {
    const { createDiaryEntrySchema } = await import("@/lib/site-diary/schema");
    expect(OFFLINE_WRITE_REGISTRY["site_diary.create"].schema).toBe(
      createDiaryEntrySchema,
    );
  });

  it("snag.create validates with the SAME schema the online action uses", async () => {
    const { createSnagSchema } = await import("@/lib/snags/schema");
    expect(OFFLINE_WRITE_REGISTRY["snag.create"].schema).toBe(createSnagSchema);
  });

  it("material_request.create validates with the SAME schema the online action uses", async () => {
    const { materialRequestFormSchema } = await import(
      "@/lib/material-requests/schema"
    );
    expect(OFFLINE_WRITE_REGISTRY["material_request.create"].schema).toBe(
      materialRequestFormSchema,
    );
  });

  it("each schema refuses offline exactly what it refuses online", () => {
    const diary = offlineWriteEntity("site_diary.create").schema;
    expect(diary.safeParse({ entry_date: "2026-07-30" }).success).toBe(true);
    expect(diary.safeParse({ entry_date: "30/07/2026" }).success).toBe(false);
    expect(diary.safeParse({}).success).toBe(false);
    expect(
      diary.safeParse({ entry_date: "2026-07-30", labour_count: "-1" }).success,
    ).toBe(false);

    const snag = offlineWriteEntity("snag.create").schema;
    expect(snag.safeParse({ title: "Cracked tile" }).success).toBe(true);
    expect(snag.safeParse({}).success).toBe(false); // a title is required
    expect(snag.safeParse({ title: "  " }).success).toBe(false);
    expect(
      snag.safeParse({ title: "t", priority: "urgent" }).success, // not a snag priority
    ).toBe(false);
    expect(snag.safeParse({ title: "t", job_id: "not-a-uuid" }).success).toBe(false);
    expect(snag.safeParse({ title: "t", due_date: "07/08/2026" }).success).toBe(false);

    const mr = offlineWriteEntity("material_request.create").schema;
    expect(
      mr.safeParse({ lines: [{ description: "Cement", qty: "2", unit: "bag" }] })
        .success,
    ).toBe(true);
    expect(mr.safeParse({ lines: [] }).success).toBe(false); // at least one line
    expect(mr.safeParse({}).success).toBe(false);
    expect(
      mr.safeParse({ lines: [{ description: "Cement", qty: 0 }] }).success, // qty > 0
    ).toBe(false);
    expect(
      mr.safeParse({ lines: [{ description: "", qty: 1 }] }).success,
    ).toBe(false);
    expect(
      mr.safeParse({
        priority: "high", // not in the two-value house set for requests
        lines: [{ description: "Cement", qty: 1 }],
      }).success,
    ).toBe(false);
  });

  it("no schema can carry a lifecycle STATUS into the queue", () => {
    // The cores pin status server-side ('open' / 'draft'); Zod strips the key,
    // so a crafted payload cannot even smuggle one into IndexedDB.
    const snag = offlineWriteEntity("snag.create").schema.safeParse({
      title: "t",
      status: "verified",
    });
    expect(snag.success).toBe(true);
    expect((snag as { data: object }).data).not.toHaveProperty("status");

    const mr = offlineWriteEntity("material_request.create").schema.safeParse({
      status: "approved",
      lines: [{ description: "Cement", qty: 1 }],
    });
    expect(mr.success).toBe(true);
    expect((mr as { data: object }).data).not.toHaveProperty("status");
  });

  it("recoverFields name real payload fields the schema accepts (every kind)", () => {
    for (const kind of OFFLINE_WRITE_KINDS) {
      const e = offlineWriteEntity(kind);
      const parsed = e.schema.safeParse(GATES[kind].validPayload);
      expect(parsed.success, kind).toBe(true);
      const keys = Object.keys((parsed as { data: object }).data);
      for (const f of e.recoverFields) expect(keys, `${kind}.${f}`).toContain(f);
    }
  });

  it("a material request's LINES recover as readable text, not [object Object]", () => {
    const e = offlineWriteEntity("material_request.create");
    const text = e.formatRecoverField?.("lines", [
      { description: "Cement 25kg", qty: 20, unit: "bag" },
      { description: "Sharp sand", qty: 2, unit: "t" },
    ]);
    expect(text).toBe("20 bag — Cement 25kg\n2 t — Sharp sand");
    // non-lines fields fall back to the default rendering
    expect(e.formatRecoverField?.("notes", "rear gate")).toBeNull();
  });
});

describe("offline write registry — user-facing counting", () => {
  it("never says '2 diary entry' / '2 snag' / '2 materials request'", () => {
    expect(describeOfflineCount("site_diary.create", 1)).toBe("1 diary entry");
    expect(describeOfflineCount("site_diary.create", 2)).toBe("2 diary entries");
    expect(describeOfflineCount("snag.create", 1)).toBe("1 snag");
    expect(describeOfflineCount("snag.create", 2)).toBe("2 snags");
    expect(describeOfflineCount("material_request.create", 1)).toBe(
      "1 materials request",
    );
    expect(describeOfflineCount("material_request.create", 2)).toBe(
      "2 materials requests",
    );
  });
});

describe("offline write registry — the read-only stance is written down", () => {
  it("documents WHY each excluded entity is not enabled (not just that it isn't)", () => {
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
    // The Train 5 swap decision must be findable where the decision lives: the
    // ack was rejected because the attestation TIME is server-pinned evidence.
    expect(src).toMatch(/acknowledged_at/);
    expect(src).toMatch(/material_request\.submit/);
  });
});
