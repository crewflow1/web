import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Portal token expiry — single-authority + fail-closed contract.
 *
 * The behavioural proof (expiry rejection, rotation, debounce, isolation) is the
 * real-Postgres integration suite. This pins the invariants that must hold ON
 * SOURCE so a refactor can't quietly break them:
 *   - expiry is decided in exactly ONE place (the loader), never duplicated;
 *   - the loader fails CLOSED (returns null) on every rejection path;
 *   - the usage touch is telemetry — post-validation, non-throwing, debounced —
 *     and can never gate access;
 *   - every portal route still resolves through that one authority.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Comment-stripped: "the code adds no X" must test code, not prose that names X
 *  to explain its absence (the loader's header says "there's no Supabase
 *  session" precisely because it uses none). */
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const HELPERS = read("app/customer-portal/_helpers.ts");
const HELPERS_CODE = readCode("app/customer-portal/_helpers.ts");
const ROTATE = read("app/(app)/customers/actions.ts");

const PORTAL_ROUTES = [
  "app/customer-portal/[token]/page.tsx",
  "app/customer-portal/[token]/quotes/page.tsx",
  "app/customer-portal/[token]/jobs/page.tsx",
  "app/customer-portal/[token]/invoices/page.tsx",
  "app/customer-portal/[token]/invoices/[id]/pdf/route.ts",
  "app/customer-portal/[token]/messages/page.tsx",
  "app/customer-portal/[token]/messages/[ticketId]/page.tsx",
  "app/customer-portal/[token]/documents/page.tsx",
  "app/customer-portal/[token]/reports/page.tsx",
  "app/customer-portal/[token]/certificates/[id]/pdf/route.tsx",
  "app/customer-portal/_message-action.ts",
  "app/customer-portal/_thread-reply-action.ts",
  "app/customer-portal/_upload-action.ts",
];

describe("expiry is decided in ONE authority", () => {
  it("the loader performs the expiry check", () => {
    expect(HELPERS).toMatch(/portal_token_expires_at/);
    expect(HELPERS).toMatch(/Date\.parse\(expiresAt\) <= Date\.now\(\)/);
  });

  it("no portal route or action re-checks expiry itself", () => {
    // Duplicated checks drift. Only the loader may mention the expiry column.
    for (const p of PORTAL_ROUTES) {
      expect(read(p)).not.toMatch(/portal_token_expires_at/);
    }
  });

  it("every portal route still resolves through the single loader", () => {
    for (const p of PORTAL_ROUTES) {
      expect(read(p)).toMatch(/loadCustomerByPortalToken/);
    }
  });
});

describe("the loader fails CLOSED", () => {
  it("returns null on a bad token shape, a missing row, and a DB error", () => {
    expect(HELPERS).toMatch(/if \(!\/\^\[0-9a-f\]/); // shape guard → return null
    // A broken customer row (no joined org) still fails closed.
    expect(HELPERS).toMatch(/if \(!data\.org\) return null/);
    expect(HELPERS).toMatch(/console\.error\("\[customer-portal\] lookup failed"/);
  });

  it("a missing customer row falls to the ADDITIVE contact-token path, which also fails closed", () => {
    // The primary single-token path is unchanged; only when it misses (!data) do
    // we try customer_contacts.portal_token — and that branch returns null on any
    // miss / disabled access / expired contact token (fail-closed, same as above).
    expect(HELPERS).toMatch(/if \(!data\) return resolveContactToken\(admin, token\)/);
    expect(HELPERS).toMatch(/function resolveContactToken/);
    expect(HELPERS).toMatch(/if \(!data \|\| !data\.customer \|\| !data\.customer\.org\) return null/);
    expect(HELPERS).toMatch(/\.eq\("portal_access_enabled", true\)/);
  });

  it("returns null when a set expiry is in the past", () => {
    expect(HELPERS).toMatch(
      /if \(expiresAt && Date\.parse\(expiresAt\) <= Date\.now\(\)\) \{\s*return null/,
    );
  });

  it("a NULL expiry is NOT rejected (existing links stay valid)", () => {
    // The guard is `expiresAt && …`, so a null expiry short-circuits to valid.
    expect(HELPERS).toMatch(/const expiresAt = /);
    expect(HELPERS).toMatch(/if \(expiresAt &&/);
  });
});

describe("usage tracking is telemetry, never authority", () => {
  it("touches last_used_at only AFTER the expiry decision", () => {
    const expiryIdx = HELPERS.indexOf("Date.parse(expiresAt) <= Date.now()");
    const touchIdx = HELPERS.indexOf("touchLastUsed(");
    expect(expiryIdx).toBeGreaterThan(-1);
    expect(touchIdx).toBeGreaterThan(expiryIdx); // touch is downstream of expiry
  });

  it("the touch can never throw out of the loader (wrapped + logged)", () => {
    expect(HELPERS).toMatch(/async function touchLastUsed/);
    // Its body is a try/catch that only logs — no rethrow.
    const fn = HELPERS.slice(HELPERS.indexOf("async function touchLastUsed"));
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch \(e\) \{/);
    expect(fn).not.toMatch(/throw /);
  });

  it("debounces in the DB, not just in memory (concurrency-safe)", () => {
    // A WHERE that re-checks the interval, so two concurrent loads can't both write.
    expect(HELPERS).toMatch(
      /portal_token_last_used_at\.is\.null,portal_token_last_used_at\.lt\./,
    );
  });

  it("scopes the touch to the authenticating token only", () => {
    const fn = HELPERS.slice(HELPERS.indexOf("async function touchLastUsed"));
    expect(fn).toMatch(/\.eq\("portal_token", token\)/);
  });

  it("checks the touch's own { error } result explicitly", () => {
    const fn = HELPERS.slice(HELPERS.indexOf("async function touchLastUsed"));
    expect(fn).toMatch(/if \(error\)/);
  });
});

describe("rotation composes with expiry — no second revocation system", () => {
  it("rotation mints a new token AND clears expiry + usage", () => {
    const fn = ROTATE.slice(ROTATE.indexOf("export async function rotateCustomerPortalToken"));
    expect(fn).toMatch(/portal_token: token/);
    expect(fn).toMatch(/portal_token_expires_at: null/);
    expect(fn).toMatch(/portal_token_last_used_at: null/);
  });

  it("rotation still overwrites in place (old token stops resolving)", () => {
    const fn = ROTATE.slice(ROTATE.indexOf("export async function rotateCustomerPortalToken"));
    expect(fn).toMatch(/\.from\("customers"\)/);
    expect(fn).toMatch(/\.eq\("id", id\)/);
    // No parallel revocation table / flag — rotation IS revocation.
    expect(fn).not.toMatch(/revoked|blacklist|denylist/i);
  });
});

describe("no second portal auth system introduced", () => {
  it("the loader adds no password / session / magic-link machinery", () => {
    expect(HELPERS_CODE).not.toMatch(/password|bcrypt|session|cookie|magic|jwt/i);
  });
});
