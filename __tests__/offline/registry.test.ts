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
const expansion2Migration = readFileSync(
  join(root, "supabase/migrations/20261101000000_offline_write_expansion_2.sql"),
  "utf8",
);
const conflictMigration = readFileSync(
  join(
    root,
    "supabase/migrations/20261129000000_offline_write_conflict_resolution.sql",
  ),
  "utf8",
);
const delayUpdateMigration = readFileSync(
  join(
    root,
    "supabase/migrations/20261195000000_offline_delay_event_update.sql",
  ),
  "utf8",
);

/**
 * Which migration adds the last_offline_write_key marker for each UPDATE-enabled
 * table. The diary and snag markers landed together in the conflict-resolution
 * migration; the delay-event draft-update marker landed in its own later migration.
 */
const UPDATE_MARKER_MIGRATION: Record<string, string> = {
  site_diary_entries: conflictMigration,
  snags: conflictMigration,
  delay_events: delayUpdateMigration,
};

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
  "site_diary.update": {
    table: "site_diary_entries",
    migration: foundationMigration,
    validPayload: {
      id: "11111111-1111-4111-8111-111111111111",
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
  "snag.update": {
    table: "snags",
    migration: expansionMigration,
    validPayload: {
      id: "11111111-1111-4111-8111-111111111111",
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
  "delay_event.create": {
    table: "delay_events",
    migration: expansion2Migration,
    validPayload: {
      jobId: "11111111-1111-4111-8111-111111111111",
      category: "weather",
      startedOn: "2026-07-30",
      endedOn: "2026-07-31",
      workingDaysLost: 2,
      description: "Heavy rain stopped groundworks",
    },
  },
  "delay_event.update": {
    table: "delay_events",
    migration: expansion2Migration,
    validPayload: {
      id: "11111111-1111-4111-8111-111111111111",
      jobId: "11111111-1111-4111-8111-111111111111",
      category: "weather",
      startedOn: "2026-07-30",
      endedOn: "2026-07-31",
      workingDaysLost: 2,
      description: "Heavy rain stopped groundworks",
    },
  },
  "site_report.create": {
    table: "site_reports",
    migration: expansion2Migration,
    validPayload: {
      job_id: "11111111-1111-4111-8111-111111111111",
      title: "Week 30 progress",
      period_start: "2026-07-27",
      period_end: "2026-07-31",
    },
  },
};

describe("offline write registry — exactly the entities the product enabled", () => {
  it("the enabled set is diary + snag + material_request + delay_event + site_report", () => {
    // If this fails, an entity became (or stopped being) offline-writable.
    // That is a CEO/product decision (docs/offline-write-queue.md) — update the
    // doc, the registry rationale and this list together, deliberately.
    // Train 5 (migration 20261083) added the snag CREATE and the material
    // request DRAFT create; the "offl" train (migration 20261101) added the
    // delay-event DRAFT create and the site-report DRAFT create. Toolbox-talk
    // acks and ITP inspection sign-offs were considered and REJECTED (server-
    // pinned attestation time — see the registry header).
    expect([...OFFLINE_WRITE_KINDS]).toEqual([
      "site_diary.create",
      "site_diary.update",
      "snag.create",
      "snag.update",
      "material_request.create",
      "delay_event.create",
      "delay_event.update",
      "site_report.create",
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

  it("only CREATE and (conflict-resolved) UPDATE are enabled — never DELETE", () => {
    for (const k of OFFLINE_WRITE_KINDS) {
      // Every kind is a create or an update; a delete can never be reconciled by a
      // merge, so it is never offline-writable.
      expect(k).toMatch(/\.(create|update)$/);
      expect(k).not.toMatch(/\.(delete|remove|destroy)$/);
    }
  });

  it("every UPDATE kind declares its owned merge fields (and no create does)", () => {
    for (const kind of OFFLINE_WRITE_KINDS) {
      const e = offlineWriteEntity(kind);
      if (kind.endsWith(".update")) {
        expect(e.mode, kind).toBe("update");
        expect(e.mergeFields && e.mergeFields.length, kind).toBeGreaterThan(0);
        // the merge set never includes the row identity or a lifecycle status
        expect(e.mergeFields, kind).not.toContain("id");
        expect(e.mergeFields, kind).not.toContain("status");
      } else {
        expect(e.mode, kind).toBe("create");
        expect(e.mergeFields, kind).toBeUndefined();
      }
    }
  });

  it("the gate narrows unknown strings and objects, so callers can't skip it", () => {
    expect(isOfflineWriteKind("site_diary.create")).toBe(true);
    expect(isOfflineWriteKind("snag.create")).toBe(true);
    expect(isOfflineWriteKind("material_request.create")).toBe(true);
    expect(isOfflineWriteKind("delay_event.create")).toBe(true);
    expect(isOfflineWriteKind("site_report.create")).toBe(true);
    // UPDATE is now enabled for the entities that carry a conflict policy —
    // diary, snag, and the DRAFT delay event.
    expect(isOfflineWriteKind("site_diary.update")).toBe(true);
    expect(isOfflineWriteKind("snag.update")).toBe(true);
    expect(isOfflineWriteKind("delay_event.update")).toBe(true);
    // …but DELETE never is, nor a lifecycle transition.
    expect(isOfflineWriteKind("site_diary.delete")).toBe(false);
    expect(isOfflineWriteKind("snag.delete")).toBe(false);
    expect(isOfflineWriteKind("material_request.submit")).toBe(false);
    // the delay-event lifecycle transitions are NOT offline-writable
    expect(isOfflineWriteKind("delay_event.record")).toBe(false);
    expect(isOfflineWriteKind("delay_event.withdraw")).toBe(false);
    // the site-report lifecycle transitions are NOT offline-writable
    expect(isOfflineWriteKind("site_report.issue")).toBe(false);
    expect(isOfflineWriteKind("site_report.approve")).toBe(false);
    expect(isOfflineWriteKind("toolbox_talk.acknowledge")).toBe(false);
    expect(isOfflineWriteKind("inspection.signoff")).toBe(false);
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

  it("every UPDATE-enabled table gains the last_offline_write_key idempotency marker", () => {
    // An offline UPDATE creates no new row, so the create's unique index cannot
    // dedupe it — the conflict migration adds a per-row marker (20261129000000).
    const updateTables = new Set(
      OFFLINE_WRITE_KINDS.filter((k) => k.endsWith(".update")).map(
        (k) => GATES[k].table,
      ),
    );
    for (const table of updateTables) {
      const mig = UPDATE_MARKER_MIGRATION[table] ?? "";
      expect(mig, `${table}: a migration is mapped for its marker`).toBeTruthy();
      expect(mig, `${table}: last_offline_write_key column`).toMatch(
        new RegExp(
          `alter table public\\.${table}[\\s\\S]{0,900}last_offline_write_key uuid`,
        ),
      );
      // and it adds no privileged write path (the whole security argument). Strip
      // `--` comments first, or the prose ("NO SECURITY DEFINER") would self-match.
      const sql = mig.replace(/--.*$/gm, "");
      expect(sql, `${table}`).not.toMatch(/security definer/i);
      expect(sql, `${table}`).not.toMatch(/create (or replace )?function/i);
      expect(sql, `${table}`).not.toMatch(/create policy|drop policy|\bgrant\b/i);
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

  it("the UPDATE kinds validate with the SAME update schemas the online edits use", async () => {
    const { updateDiaryEntrySchema } = await import("@/lib/site-diary/schema");
    const { updateSnagSchema } = await import("@/lib/snags/schema");
    expect(OFFLINE_WRITE_REGISTRY["site_diary.update"].schema).toBe(
      updateDiaryEntrySchema,
    );
    expect(OFFLINE_WRITE_REGISTRY["snag.update"].schema).toBe(updateSnagSchema);
    // an update schema REQUIRES the target id — a create schema must not accept one
    expect(updateSnagSchema.safeParse({ title: "t" }).success).toBe(false);
    expect(
      updateSnagSchema.safeParse({
        id: "11111111-1111-4111-8111-111111111111",
        title: "t",
      }).success,
    ).toBe(true);
    // a status can never ride an update (Zod strips it — lifecycle stays online)
    const withStatus = updateSnagSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      title: "t",
      status: "verified",
    });
    expect(withStatus.success).toBe(true);
    expect((withStatus as { data: object }).data).not.toHaveProperty("status");
  });

  it("material_request.create validates with the SAME schema the online action uses", async () => {
    const { materialRequestFormSchema } = await import(
      "@/lib/material-requests/schema"
    );
    expect(OFFLINE_WRITE_REGISTRY["material_request.create"].schema).toBe(
      materialRequestFormSchema,
    );
  });

  it("delay_event.create validates with the SAME schema the online action uses", async () => {
    const { createDelayEventSchema } = await import("@/lib/eot/schema");
    expect(OFFLINE_WRITE_REGISTRY["delay_event.create"].schema).toBe(
      createDelayEventSchema,
    );
  });

  it("site_report.create validates with the SAME schema the online action uses", async () => {
    const { createSiteReportSchema } = await import("@/lib/site-reports/schema");
    expect(OFFLINE_WRITE_REGISTRY["site_report.create"].schema).toBe(
      createSiteReportSchema,
    );
  });

  it("delay_event + site_report refuse offline exactly what they refuse online", () => {
    const delay = offlineWriteEntity("delay_event.create").schema;
    const okDelay = {
      jobId: "11111111-1111-4111-8111-111111111111",
      category: "weather",
      startedOn: "2026-07-30",
      description: "Rain stopped work",
    };
    expect(delay.safeParse(okDelay).success).toBe(true);
    expect(delay.safeParse({ ...okDelay, jobId: "not-a-uuid" }).success).toBe(false);
    expect(delay.safeParse({ ...okDelay, category: "act_of_god" }).success).toBe(false);
    expect(delay.safeParse({ ...okDelay, startedOn: "30/07/2026" }).success).toBe(false);
    expect(delay.safeParse({ ...okDelay, description: "" }).success).toBe(false);
    // a lifecycle status can never be smuggled into the queue — Zod strips it
    const stripped = delay.safeParse({ ...okDelay, status: "recorded" });
    expect(stripped.success).toBe(true);
    expect((stripped as { data: object }).data).not.toHaveProperty("status");

    const report = offlineWriteEntity("site_report.create").schema;
    const okReport = {
      job_id: "11111111-1111-4111-8111-111111111111",
      title: "Week 30",
      period_start: "2026-07-27",
      period_end: "2026-07-31",
    };
    expect(report.safeParse(okReport).success).toBe(true);
    expect(report.safeParse({ ...okReport, job_id: "not-a-uuid" }).success).toBe(false);
    expect(report.safeParse({ ...okReport, title: "" }).success).toBe(false);
    // period_end before period_start is refused, offline as online
    expect(
      report.safeParse({ ...okReport, period_end: "2026-07-01" }).success,
    ).toBe(false);
    // no lifecycle status rides in
    const r2 = report.safeParse({ ...okReport, status: "issued" });
    expect(r2.success).toBe(true);
    expect((r2 as { data: object }).data).not.toHaveProperty("status");
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
    expect(describeOfflineCount("delay_event.create", 1)).toBe("1 delay event");
    expect(describeOfflineCount("delay_event.create", 2)).toBe("2 delay events");
    expect(describeOfflineCount("site_report.create", 1)).toBe("1 site report");
    expect(describeOfflineCount("site_report.create", 2)).toBe("2 site reports");
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
      // the "offl" train's enabled entities and its rejections, documented
      // where the decision lives.
      "delay event",
      "site report",
      "progress observation",
    ]) {
      expect(src.toLowerCase(), `no rationale recorded for ${topic}`).toContain(topic);
    }
    // The Train 5 swap decision must be findable where the decision lives: the
    // ack was rejected because the attestation TIME is server-pinned evidence.
    expect(src).toMatch(/acknowledged_at/);
    expect(src).toMatch(/material_request\.submit/);
    // The "offl" train rejected ITP sign-offs on the same server-pinned-time
    // ground and progress observations on the upsert-revert ground.
    expect(src).toMatch(/recorded_at/);
    expect(src).toMatch(/inspection_signoffs/);
  });
});
