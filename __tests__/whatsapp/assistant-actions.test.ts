import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedWhatsAppMessage } from "@/lib/comms/providers/meta-whatsapp";

/**
 * WhatsApp assistant AUTO-ACTIONS — deterministic classification, doctrine-first
 * creation, and ORG ISOLATION. A stateful in-memory admin-client mock stands in
 * for Postgres so the branching + the org-scoping gate are exercised without a
 * DB. The isolation pin is the important one: a service-role write against a job
 * from ANOTHER org must never land, because every write re-reads the job under
 * its org_id first.
 */

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {
    jobs: [] as Row[],
    customers: [] as Row[],
    tenant_attachments: [] as Row[],
    whatsapp_assistant_actions: [] as Row[],
  },
}));

const store = (table: string): Row[] => {
  const bag = h.db as unknown as Record<string, Row[]>;
  return bag[table] ?? (bag[table] = []);
};

// A tiny chainable query builder over the in-memory stores. Supports the exact
// chains the service uses: select/eq/in/order/limit/maybeSingle/single, update+eq,
// insert(+select+single), and thenable resolution for the awaited-eq case.
function makeBuilder(table: string) {
  const rows = store(table);
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" | "insert" = "select";
  let updatePayload: Row | null = null;
  let insertedRow: Row | null = null;

  const matching = () => rows.filter((r) => filters.every((f) => f(r)));
  const resolveSelect = () => ({ data: matching(), error: null });
  const applyUpdate = () => {
    for (const r of matching()) Object.assign(r, updatePayload);
    return { error: null };
  };

  const builder: Record<string, unknown> = {
    select() {
      op = op === "insert" ? "insert" : "select";
      return builder;
    },
    eq(k: string, v: unknown) {
      filters.push((r) => r[k] === v);
      if (op === "update") return { eq: (k2: string, v2: unknown) => { filters.push((r) => r[k2] === v2); return Promise.resolve(applyUpdate()); } };
      return builder;
    },
    in(k: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[k]));
      return builder;
    },
    order() {
      return builder;
    },
    limit(n: number) {
      return Promise.resolve({ data: matching().slice(0, n), error: null });
    },
    range(from: number, to: number) {
      return Promise.resolve({ data: matching().slice(from, to + 1), error: null });
    },
    async maybeSingle() {
      return { data: matching()[0] ?? null, error: null };
    },
    async single() {
      if (op === "insert" && insertedRow) return { data: { id: insertedRow.id }, error: null };
      return { data: matching()[0] ?? null, error: null };
    },
    update(payload: Row) {
      op = "update";
      updatePayload = payload;
      return builder;
    },
    insert(row: Row) {
      op = "insert";
      insertedRow = { id: `row-${table}-${rows.length + 1}`, ...row };
      rows.push(insertedRow);
      // assistant_actions inserts are awaited directly; tenant_attachments too.
      const p = Promise.resolve({ error: null }) as Promise<{ error: null }> & {
        select?: () => { single: () => Promise<{ data: { id: unknown }; error: null }> };
      };
      p.select = () => ({ single: async () => ({ data: { id: insertedRow!.id }, error: null }) });
      return p;
    },
    // Make a bare `.eq(...)` awaitable (customers select().eq('org_id')).
    then(resolve: (v: unknown) => void) {
      resolve(op === "update" ? applyUpdate() : resolveSelect());
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (t: string) => makeBuilder(t.replace(/ as never$/, "")),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  })),
}));

import {
  classifyAssistantIntent,
  runWhatsAppAssistantActions,
  resolveJobForCaller,
} from "@/server/services/whatsapp-assistant-actions";

const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function msg(over: Partial<NormalizedWhatsAppMessage>): NormalizedWhatsAppMessage {
  return {
    phone_number_id: "PNID_1",
    wamid: "wamid.x",
    caller: "447700900123",
    contact_name: "Jane",
    raw_text: "",
    message_type: "text",
    has_media: false,
    media: null,
    provider_timestamp: null,
    ...over,
  };
}

beforeEach(() => {
  h.db.jobs = [];
  h.db.customers = [];
  h.db.tenant_attachments = [];
  h.db.whatsapp_assistant_actions = [];
});

describe("classifyAssistantIntent — deterministic, media-shape then keywords", () => {
  it("classifies an image/document as photo_upload", () => {
    expect(classifyAssistantIntent(msg({ media: { media_id: "M", message_type: "image", mime_type: "image/jpeg", declared_sha256: null, filename: null, caption: null, is_voice_note: false } }))).toBe("photo_upload");
  });
  it("classifies variation keywords as variation_draft", () => {
    expect(classifyAssistantIntent(msg({ raw_text: "Can you also fit an extra socket while you're here" }))).toBe("variation_draft");
  });
  it("classifies booking keywords as task", () => {
    expect(classifyAssistantIntent(msg({ raw_text: "Please book someone to come back tomorrow" }))).toBe("task");
  });
  it("defaults plain text to a note", () => {
    expect(classifyAssistantIntent(msg({ raw_text: "the tap is still dripping" }))).toBe("note");
  });
});

describe("auto-action creation against a resolved job", () => {
  it("appends a NOTE to the org's own job and logs it as created", async () => {
    h.db.jobs.push({ id: "job-1", org_id: ORG_A, customer_id: "c1", status: "in-progress", notes: "existing" });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_A,
      wamid: "wamid.note",
      enquiryId: "enq-1",
      message: msg({ raw_text: "the tap is still dripping", wamid: "wamid.note" }),
      jobId: "job-1",
    });
    expect(res.intent).toBe("note");
    expect(res.actions[0]?.status).toBe("created");
    const job = h.db.jobs.find((j) => j.id === "job-1")!;
    expect(String(job.notes)).toContain("the tap is still dripping");
    expect(String(job.notes)).toContain("existing"); // appended, not replaced
    expect(h.db.whatsapp_assistant_actions).toHaveLength(1);
    expect(h.db.whatsapp_assistant_actions[0]?.status).toBe("created");
  });

  it("creates a tenant_attachments row for a photo against the job", async () => {
    h.db.jobs.push({ id: "job-1", org_id: ORG_A, customer_id: "c1", status: "new", notes: null });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_A,
      wamid: "wamid.photo",
      enquiryId: null,
      message: msg({ wamid: "wamid.photo", message_type: "image", has_media: true, media: { media_id: "M1", message_type: "image", mime_type: "image/jpeg", declared_sha256: null, filename: "leak.jpg", caption: null, is_voice_note: false } }),
      jobId: "job-1",
      media: { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/jpeg" },
    });
    expect(res.intent).toBe("photo_upload");
    expect(res.actions[0]?.status).toBe("created");
    expect(h.db.tenant_attachments).toHaveLength(1);
    expect(h.db.tenant_attachments[0]?.target_table).toBe("jobs");
    expect(h.db.tenant_attachments[0]?.target_id).toBe("job-1");
    expect(h.db.tenant_attachments[0]?.org_id).toBe(ORG_A);
  });

  it("queues a variation as pending_review — never auto-priced (doctrine)", async () => {
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_A,
      wamid: "wamid.var",
      enquiryId: null,
      message: msg({ wamid: "wamid.var", raw_text: "also need an extra radiator on top of the quote" }),
      jobId: "job-1",
    });
    expect(res.intent).toBe("variation_draft");
    expect(res.actions[0]?.status).toBe("pending_review");
    // No quote/variation entity was created.
    expect(h.db.whatsapp_assistant_actions[0]?.action_type).toBe("variation_draft");
    expect(h.db.whatsapp_assistant_actions[0]?.status).toBe("pending_review");
  });
});

describe("ORG ISOLATION — a foreign job is never written", () => {
  it("does NOT append a note to another org's job", async () => {
    // Job belongs to ORG_A only.
    h.db.jobs.push({ id: "job-A", org_id: ORG_A, customer_id: "c1", status: "new", notes: "orgA private" });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_B, // caller is org B, targeting org A's job id
      wamid: "wamid.cross",
      enquiryId: null,
      message: msg({ wamid: "wamid.cross", raw_text: "sneaky note" }),
      jobId: "job-A",
    });
    expect(res.actions[0]?.status).toBe("skipped");
    expect(res.actions[0]?.detail.reason).toBe("job_not_in_org");
    // ORG_A's job is untouched.
    const job = h.db.jobs.find((j) => j.id === "job-A")!;
    expect(job.notes).toBe("orgA private");
    // The (org-scoped) action-log row is stamped with the CALLER's org, not A.
    expect(h.db.whatsapp_assistant_actions[0]?.org_id).toBe(ORG_B);
  });

  it("does NOT attach a photo to another org's job", async () => {
    h.db.jobs.push({ id: "job-A", org_id: ORG_A, customer_id: "c1", status: "new", notes: null });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_B,
      wamid: "wamid.crossphoto",
      enquiryId: null,
      message: msg({ wamid: "wamid.crossphoto", message_type: "image", has_media: true, media: { media_id: "M9", message_type: "image", mime_type: "image/jpeg", declared_sha256: null, filename: null, caption: null, is_voice_note: false } }),
      jobId: "job-A",
      media: { bytes: new Uint8Array([5, 5, 5]), mimeType: "image/jpeg" },
    });
    expect(res.actions[0]?.status).toBe("skipped");
    expect(h.db.tenant_attachments).toHaveLength(0);
  });
});

describe("voice-note note path — governed STT, dark-safe, org-scoped", () => {
  function voiceMsg(over: Partial<NormalizedWhatsAppMessage> = {}): NormalizedWhatsAppMessage {
    return msg({
      wamid: "wamid.voice",
      raw_text: "",
      message_type: "audio",
      has_media: true,
      media: {
        media_id: "MV1",
        message_type: "audio",
        mime_type: "audio/ogg; codecs=opus",
        declared_sha256: null,
        filename: null,
        caption: null,
        is_voice_note: true,
      },
      ...over,
    });
  }

  it("DEFERS while dark — records the note with a null (never fabricated) transcript", async () => {
    h.db.jobs.push({ id: "job-v", org_id: ORG_A, customer_id: "c1", status: "in-progress", notes: null });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_A,
      wamid: "wamid.voice",
      enquiryId: null,
      message: voiceMsg(),
      jobId: "job-v",
      media: { bytes: new Uint8Array([9, 9, 9, 9]), mimeType: "audio/ogg" },
    });
    expect(res.intent).toBe("note");
    const rec = res.actions[0]!;
    expect(rec.status).toBe("created");
    // The transcription outcome is recorded as DEFERRED — dark, not fabricated.
    const detail = rec.detail as { transcription?: { status: string; reason?: string } };
    expect(detail.transcription?.status).toBe("deferred");
    // No transcript ⇒ the note body is NOT a made-up string.
    const job = h.db.jobs.find((j) => j.id === "job-v")!;
    expect(String(job.notes ?? "")).not.toContain("SHOULD");
  });

  it("never writes a voice note against ANOTHER org's job", async () => {
    h.db.jobs.push({ id: "job-A", org_id: ORG_A, customer_id: "c1", status: "new", notes: "orgA private" });
    const res = await runWhatsAppAssistantActions({
      orgId: ORG_B,
      wamid: "wamid.voicecross",
      enquiryId: null,
      message: voiceMsg({ wamid: "wamid.voicecross" }),
      jobId: "job-A",
      media: { bytes: new Uint8Array([1, 1, 1]), mimeType: "audio/ogg" },
    });
    expect(res.actions[0]?.status).toBe("skipped");
    const job = h.db.jobs.find((j) => j.id === "job-A")!;
    expect(job.notes).toBe("orgA private");
  });
});

describe("resolveJobForCaller — deterministic, org-scoped", () => {
  it("matches a caller to a customer's most recent open job in the SAME org only", async () => {
    h.db.customers.push({ id: "c1", org_id: ORG_A, phone: "+44 7700 900123" });
    h.db.customers.push({ id: "c2", org_id: ORG_B, phone: "07700900123" }); // same tail, other org
    h.db.jobs.push({ id: "jobA", org_id: ORG_A, customer_id: "c1", status: "in-progress", created_at: "2026-01-01" });
    h.db.jobs.push({ id: "jobB", org_id: ORG_B, customer_id: "c2", status: "new", created_at: "2026-01-01" });

    const a = await resolveJobForCaller(ORG_A, "447700900123");
    const b = await resolveJobForCaller(ORG_B, "447700900123");
    expect(a).toBe("jobA");
    expect(b).toBe("jobB");
  });

  it("returns null when no customer matches", async () => {
    expect(await resolveJobForCaller(ORG_A, "447700900999")).toBeNull();
    expect(await resolveJobForCaller(ORG_A, null)).toBeNull();
  });
});
