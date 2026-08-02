import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OFFLINE WRITE — the "offl" train's LAST MILE: the two CREATE forms that let a
 * field user author a delay event and a site report with no signal.
 *
 * The queue/server layer (registry, shared write cores, dispatch, migration
 * 20261101) is pinned by offline-write-queue.test.ts and
 * offline-write-expansion.test.ts and is deliberately untouched here. This file
 * pins ONLY what the forms add — mirroring the "expansion forms" block of
 * offline-write-expansion.test.ts for delay_event.create + site_report.create:
 *
 *   1. Each create page threads the SERVER-resolved session identity into its
 *      form (never a client offline-identity marker).
 *   2. The submit intercept is gated on being offline AND the queue being
 *      supported; an online post goes to the server action untouched.
 *   3. The copy is honest: "Saved on this device" (never a bare "Saved"), every
 *      EnqueueError has a specific message, and the evidence/source/photo
 *      unavailability is stated, never silently dropped.
 *   4. The EDIT forms are NOT made offline — the shared delay field block and
 *      the delay [id] edit page carry no queue import.
 */

const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const queueSrc = read("lib/offline/write-queue.ts");

const delayFormSrc = read("app/(app)/delays/_create-form.tsx");
const delayNewPageSrc = read("app/(app)/delays/new/page.tsx");
const delayFieldsSrc = read("app/(app)/delays/_form-fields.tsx");
const delayEditPageSrc = read("app/(app)/delays/[id]/page.tsx");

const reportFormSrc = read("app/(app)/site-reports/_form.tsx");
const reportNewPageSrc = read("app/(app)/site-reports/new/page.tsx");

const outboxSrc = read("app/(app)/_components/offline-outbox.tsx");
const registrySrc = read("lib/offline/registry.ts");

const FORMS = [
  ["delays/_create-form.tsx", delayFormSrc],
  ["site-reports/_form.tsx", reportFormSrc],
] as const;

describe("offl create forms — server-resolved identity, loud failures, honest wording", () => {
  it("both new pages hand the form the SERVER-resolved session identity", () => {
    for (const [name, src] of [
      ["delays/new/page.tsx", delayNewPageSrc],
      ["site-reports/new/page.tsx", reportNewPageSrc],
    ] as const) {
      expect(src, name).toMatch(
        /offline=\{\{ userId: user\.id, orgId: ctx\.org\.id \}\}/,
      );
      // the identity comes from requireOrgContext(), destructured WITH the user
      expect(src, name).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
    }
    // never the client-side offline-identity marker (the #456 attribution hazard)
    for (const [name, src] of FORMS) {
      expect(src, name).not.toMatch(/readOfflineIdentity/);
    }
  });

  it("each form enqueues under its OWN registry kind, never another", () => {
    expect(delayFormSrc).toMatch(/kind: "delay_event\.create"/);
    expect(delayFormSrc).not.toMatch(/site_report\.create|snag\.create|site_diary\.create/);
    expect(reportFormSrc).toMatch(/kind: "site_report\.create"/);
    expect(reportFormSrc).not.toMatch(/delay_event\.create|snag\.create|site_diary\.create/);
  });

  it("every EnqueueError has a user-facing message in BOTH new forms", () => {
    const errors = [...queueSrc.matchAll(/^\s*\| "(\w+)" \/\//gm)].map((m) => m[1]!);
    expect(errors.length).toBeGreaterThan(5);
    for (const [name, src] of FORMS) {
      for (const e of errors) {
        expect(src, `${name}: EnqueueError "${e}" has no user-facing message`).toContain(
          `${e}:`,
        );
      }
    }
  });

  it('both forms say "Saved on this device", never a bare "Saved"/"Sent"', () => {
    for (const [name, src] of FORMS) {
      expect(src, name).toMatch(/Saved on this device/);
    }
    // and both are honest that the synced artefact is a DRAFT
    expect(delayFormSrc).toMatch(/draft/i);
    expect(reportFormSrc).toMatch(/draft/i);
  });

  it("the offline branch only intercepts when offline AND the queue is supported; online posts go untouched", () => {
    for (const [name, src] of FORMS) {
      // online-only guard: bail unless offline config present and queue supported
      expect(src, name).toMatch(/if \(!offline \|\| !isWriteQueueSupported\(\)\) return;/);
      // never intercept while online
      expect(src, name).toMatch(/if \(online\) return;/);
      expect(src, name).toMatch(/e\.preventDefault\(\)/);
      expect(src, name).toMatch(/navigator\.onLine/);
      // the online path is the server action itself: <form action={action} ...>
      expect(src, name).toMatch(/action=\{action\}/);
    }
  });

  it("evidence links / sources / photos are declared UNAVAILABLE offline, not silently dropped", () => {
    // the delay form withholds the job-scoped diary/variation pickers and says so
    expect(delayFormSrc).toMatch(/Evidence links/);
    expect(delayFormSrc).toMatch(/data-offline-evidence-unavailable/);
    expect(delayFormSrc).toMatch(/photos need a connection/i);
    // the report form is honest that source gathering happens at the server
    expect(reportFormSrc).toMatch(/gathered when it reaches the server|gathered until it syncs/);
  });

  it("the outbox + registry can already describe both new kinds (no fallback gap)", () => {
    // the outbox reason strings the two cores can return are all present
    for (const reason of ["job_missing", "invalid_payload", "org_mismatch", "not_permitted"]) {
      expect(outboxSrc, `outbox missing reason "${reason}"`).toMatch(
        new RegExp(`${reason}:`),
      );
    }
    // labels + recover fields exist for both kinds
    expect(registrySrc).toMatch(/"delay_event\.create":/);
    expect(registrySrc).toMatch(/"site_report\.create":/);
  });
});

describe("offl EDIT forms stay online-only (replay would revert concurrent edits)", () => {
  it("the shared delay field block carries NO offline/queue import", () => {
    expect(delayFieldsSrc).not.toMatch(/offline\/write-queue|enqueue|isWriteQueueSupported/);
    // and it is not itself a client component (the create-only wrapper is)
    expect(delayFieldsSrc).not.toMatch(/^"use client"/m);
  });

  it("the delay [id] edit page never touches the write queue", () => {
    expect(delayEditPageSrc).not.toMatch(/offline\/write-queue|enqueue|_create-form|DelayCreateForm/);
    // it posts the edit straight to the server action, as before
    expect(code(delayEditPageSrc)).toMatch(/action=\{updateDelayEvent\}/);
  });
});
