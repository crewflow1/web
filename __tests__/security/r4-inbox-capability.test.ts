import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — inbox module capability enforcement.
 *
 * The inbox IS customer communications, so it is off-limits to staff/field
 * members (R1 #951 first gated it to owner/admin; R4 moves it onto the
 * capability model). Mapping:
 *   layout (whole subtree)          → inbox:view
 *   markEnquiryStatus               → inbox:edit    (triage)
 *   replyToConversation             → inbox:create  (outbound reply)
 *   startConversation               → inbox:create  (new outbound conversation)
 *   setConversationStatus           → inbox:edit    (open / close / archive)
 *   resolveAssistantAction          → inbox:approve (clear the AI review queue)
 *
 * Source pins + a behavioural per-action matrix (owner all; granted admin
 * per-action; ungranted / wrong-grant admin denied; staff denied the whole
 * surface even with a stray grant).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("inbox layout gates the subtree on inbox:view (no residual mgmt gate)", () => {
  it("the /inbox layout requires inbox:view", () => {
    const code = codeOf(read("app/(app)/inbox/layout.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"inbox",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context)/);
    expect(code).not.toMatch(/_guards\/management-layout/);
  });
});

describe("inbox actions carry the right capability action", () => {
  const CASES: Array<{ file: string; fn: string; action: string }> = [
    { file: "app/(app)/inbox/actions.ts", fn: "markEnquiryStatus", action: "edit" },
    { file: "app/(app)/inbox/conversations/actions.ts", fn: "replyToConversation", action: "create" },
    { file: "app/(app)/inbox/conversations/actions.ts", fn: "startConversation", action: "create" },
    { file: "app/(app)/inbox/conversations/actions.ts", fn: "setConversationStatus", action: "edit" },
    { file: "app/(app)/inbox/review/actions.ts", fn: "resolveAssistantAction", action: "approve" },
  ];

  const sliceFn = (code: string, name: string): string => {
    const start = code.indexOf(`export async function ${name}`);
    expect(start, `${name} present`).toBeGreaterThanOrEqual(0);
    const next = code.indexOf("export async function ", start + 1);
    return code.slice(start, next === -1 ? undefined : next);
  };

  for (const { file, fn, action } of CASES) {
    it(`${fn} → inbox:${action}`, () => {
      const body = sliceFn(codeOf(read(file)), fn);
      expect(body).toMatch(
        new RegExp(`requireCapabilityFor\\(\\s*ctx,\\s*user,\\s*"inbox",\\s*"${action}"\\s*\\)`),
      );
    });
  }

  it("no inbox action retains the coarse requireManagementRole gate", () => {
    for (const file of [
      "app/(app)/inbox/actions.ts",
      "app/(app)/inbox/conversations/actions.ts",
      "app/(app)/inbox/review/actions.ts",
    ]) {
      expect(codeOf(read(file)), file).not.toMatch(/requireManagementRole/);
    }
  });
});

// =====================================================================
// Behavioural — each action is enforced distinctly via canWith(), through the
// real requireCapabilityFor. Only the admin-client grant read is mocked.
// =====================================================================
let mockRole: string | null = "owner";
let mockGrants: Array<{ module: string; action: string }> = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "memberships"
                ? { data: { id: "mem-1", role: mockRole }, error: null }
                : { data: null, error: null },
          }),
          limit: async () =>
            table === "membership_permissions"
              ? { data: mockGrants, error: null }
              : { data: [], error: null },
        }),
      }),
    }),
  }),
}));
const { requireCapabilityFor } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) =>
  ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("inbox actions are distinct capabilities", () => {
  it("an admin with inbox:view can view but CANNOT create / edit / approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "inbox", action: "view" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "inbox", "view"),
    ).resolves.toBeUndefined();
    for (const action of ["create", "edit", "approve"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "inbox", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with only inbox:edit cannot create or approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "inbox", action: "edit" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "inbox", "edit"),
    ).resolves.toBeUndefined();
    for (const action of ["create", "approve"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "inbox", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with inbox:manage can view, create, edit and approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "inbox", action: "manage" }];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "inbox", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "inbox", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff are denied the inbox entirely, even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "inbox", action: "manage" }];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      await expect(
        requireCapabilityFor(CTX("staff"), USER, "inbox", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });
});
