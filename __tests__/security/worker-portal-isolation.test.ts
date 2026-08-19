import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mintWorkerToken,
  hashWorkerToken,
  isValidWorkerTokenShape,
  isValidWorkerTokenHashShape,
  WORKER_TOKEN_BYTES,
} from "@/lib/health-safety/worker-token";

/**
 * External-worker H&S sign-off portal — the trust-boundary contract.
 *
 * This is a NEW external-access surface, so token/cross-org isolation is the
 * paramount property. The behavioural proof (real RLS + trigger denial) belongs
 * to the integration tier; these pin the load-bearing invariants ON SOURCE so a
 * refactor can never quietly weaken them.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** Comment-stripped source: "the code does X" must test code, not the prose
 *  that names X to explain it. */
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const MIG = read("supabase/migrations/20261185000000_worker_signoff.sql");
const MIG_CODE = readCode("supabase/migrations/20261185000000_worker_signoff.sql");
const LOADER = read("app/worker-portal/_loader.ts");
const LOADER_CODE = readCode("app/worker-portal/_loader.ts");
const MATERIALS = read("app/worker-portal/_materials.ts");
const ACTION = read("app/worker-portal/[token]/actions.ts");
const STAFF_ACTION = read("app/(app)/health-safety/worker-links/actions.ts");
const MIDDLEWARE = read("lib/supabase/middleware.ts");

// ── High-entropy, hashed-at-rest token ─────────────────────────────────────
describe("token: high-entropy, opaque, hashed at rest", () => {
  it("mints a 43-char base64url slug from 256 bits of entropy", () => {
    expect(WORKER_TOKEN_BYTES).toBe(32); // 256 bits
    const { token } = mintWorkerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidWorkerTokenShape(token)).toBe(true);
  });

  it("two mints never collide (entropy sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintWorkerToken().token);
    expect(seen.size).toBe(1000);
  });

  it("stores ONLY the SHA-256 hash — hash != token, deterministic, 64 hex", () => {
    const { token, tokenHash } = mintWorkerToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidWorkerTokenHashShape(tokenHash)).toBe(true);
    expect(tokenHash).not.toContain(token);
    expect(hashWorkerToken(token)).toBe(tokenHash); // deterministic → loader can resolve
  });

  it("rejects malformed / short / wrong-charset tokens before any DB hit", () => {
    expect(isValidWorkerTokenShape("")).toBe(false);
    expect(isValidWorkerTokenShape("too-short")).toBe(false);
    expect(isValidWorkerTokenShape("../etc/passwd")).toBe(false);
    expect(isValidWorkerTokenShape("a".repeat(43) + "=")).toBe(false); // padding not allowed
    expect(isValidWorkerTokenShape(123 as unknown)).toBe(false);
  });

  it("the migration stores a hash, never the plaintext token", () => {
    // Column is token_hash with a 64-hex CHECK and UNIQUE; no `token text` column.
    expect(MIG).toMatch(/token_hash\s+text not null unique/);
    expect(MIG).toMatch(/token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(MIG_CODE).not.toMatch(/\btoken\s+text\b/); // no plaintext token column
  });
});

// ── The single authority: the loader ───────────────────────────────────────
describe("loader is the single authority + fails closed", () => {
  it("shape-gates before the DB and returns null", () => {
    expect(LOADER).toMatch(/if \(!isValidWorkerTokenShape\(token\)\) return null/);
  });
  it("resolves by HASH, never by the raw token", () => {
    expect(LOADER).toMatch(/hashWorkerToken\(token\)/);
    expect(LOADER).toMatch(/\.eq\("token_hash", tokenHash\)/);
    // The raw token is never used in a query filter.
    expect(LOADER).not.toMatch(/\.eq\("token", token\)/);
  });
  it("fails closed on missing row, revoke, and expiry", () => {
    expect(LOADER).toMatch(/if \(!data \|\| !data\.org \|\| !data\.job\) return null/);
    expect(LOADER).toMatch(/if \(row\.revoked_at\) return null/);
    expect(LOADER).toMatch(/if \(Date\.parse\(row\.expires_at\) <= Date\.now\(\)\) return null/);
  });
  it("touches last_used only AFTER the revoke+expiry decision, and never throws", () => {
    const revokeIdx = LOADER.indexOf("if (row.revoked_at) return null");
    const touchIdx = LOADER.indexOf("touchLastUsed(admin");
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(touchIdx).toBeGreaterThan(revokeIdx);
    const fn = LOADER.slice(LOADER.indexOf("async function touchLastUsed"));
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch \(e\) \{/);
    expect(fn).not.toMatch(/throw /);
  });
  it("mints NO session / membership / password machinery", () => {
    // Deliberately specific: the loader TYPE is called WorkerSession, so a bare
    // /session/ would false-match. These are the auth primitives that must be absent.
    expect(LOADER_CODE).not.toMatch(/password|bcrypt|cookie|magic\s*link|\bjwt\b|membership|auth\.uid|getSession|setSession/i);
  });
});

// ── A token can ONLY reach its own org's job ───────────────────────────────
describe("cross-org / cross-job isolation (code + DB)", () => {
  it("materials reads are scoped by BOTH org_id AND job_id from the session", () => {
    // Every subject read pins org_id and job_id — never the URL/client.
    const orgEqs = MATERIALS.match(/\.eq\("org_id", orgId\)/g) ?? [];
    const jobEqs = MATERIALS.match(/\.eq\("job_id", jobId\)/g) ?? [];
    expect(orgEqs.length).toBeGreaterThanOrEqual(3); // ras + permits + talks
    expect(jobEqs.length).toBeGreaterThanOrEqual(3);
    // Only LIVE, signable documents are surfaced (no draft/superseded leak).
    expect(MATERIALS).toMatch(/\.eq\("status", "issued"\)/);
    expect(MATERIALS).toMatch(/\.in\("status", \["issued", "active"\]\)/);
  });

  it("the ack trigger DERIVES org_id + job_id from the token, never trusts input", () => {
    expect(MIG).toMatch(/new\.org_id := t_org;/);
    expect(MIG).toMatch(/new\.job_id := t_job;/);
  });

  it("the ack trigger scopes each subject lookup to the token's org AND job", () => {
    // A subject in another org — or another job in the same org — resolves NULL
    // and is rejected. This is the structural cross-org/cross-job gate.
    expect(MIG).toMatch(/from public\.risk_assessments\s*\n?\s*where id = new\.subject_id and org_id = t_org and job_id = t_job/);
    expect(MIG).toMatch(/from public\.permits_to_work\s*\n?\s*where id = new\.subject_id and org_id = t_org and job_id = t_job/);
    expect(MIG).toMatch(/from public\.toolbox_talks\s*\n?\s*where id = new\.subject_id and org_id = t_org and job_id = t_job/);
    expect(MIG).toMatch(/that document is not available on this job/);
  });

  it("composite (id, org_id) FKs bind token→job and ack→token/job", () => {
    expect(MIG).toMatch(/foreign key \(job_id, org_id\)\s*\n?\s*references public\.jobs \(id, org_id\)/);
    expect(MIG).toMatch(/foreign key \(token_id, org_id\)\s*\n?\s*references public\.worker_signoff_tokens \(id, org_id\)/);
    expect(MIG).toMatch(/unique \(id, org_id\)/); // token candidate key for the child FK
  });

  it("the validate trigger is SECURITY DEFINER with a pinned search_path", () => {
    const fn = MIG.slice(MIG.indexOf("function public.tg_worker_ack_validate"));
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = public/);
  });
});

// ── Expiry + revoke are enforced in BOTH the loader and the DB ──────────────
describe("expiry + revoke enforced defence-in-depth", () => {
  it("expiry is a NOT NULL column (every link lapses)", () => {
    expect(MIG).toMatch(/expires_at\s+timestamptz not null/);
  });
  it("the DB trigger also refuses an expired or revoked token", () => {
    const fn = MIG.slice(MIG.indexOf("function public.tg_worker_ack_validate"));
    expect(fn).toMatch(/if t_revoked is not null then/);
    expect(fn).toMatch(/this sign-off link has been revoked/);
    expect(fn).toMatch(/if t_expires <= now\(\) then/);
    expect(fn).toMatch(/this sign-off link has expired/);
  });
  it("revoke is one-way + admin-gated in RLS", () => {
    expect(MIG).toMatch(/worker_signoff_tokens_update on public\.worker_signoff_tokens/);
    expect(MIG).toMatch(/using \(public\.is_org_admin\(org_id\)\)/);
  });
});

// ── The write path never mints membership + always goes via the authority ──
describe("write path", () => {
  it("the worker action resolves the session first and bails on null", () => {
    expect(ACTION).toMatch(/const session = await loadWorkerSession\(token\)/);
    expect(ACTION).toMatch(/if \(!session\) redirect\(back\)/);
  });
  it("the worker action rate-limits by token + IP", () => {
    expect(ACTION).toMatch(/consume\("quote_action", `\$\{session!\.token\.id\}:\$\{ip\}`/);
  });
  it("org_id + job_id on the insert come from the session token, not the form", () => {
    expect(ACTION).toMatch(/org_id: session!\.token\.org_id/);
    expect(ACTION).toMatch(/job_id: session!\.token\.job_id/);
    expect(ACTION).toMatch(/token_id: session!\.token\.id/);
  });
  it("no membership / user account is ever created for the worker", () => {
    expect(readCode("app/worker-portal/[token]/actions.ts")).not.toMatch(/membership|memberships|auth\.uid|createUser|invite/i);
  });
});

// ── Staff issuance stores a hash, pins the active org ───────────────────────
describe("staff issuance", () => {
  it("mints a token, inserts only its hash, and never persists the plaintext", () => {
    expect(STAFF_ACTION).toMatch(/const \{ token, tokenHash \} = mintWorkerToken\(\)/);
    expect(STAFF_ACTION).toMatch(/token_hash: tokenHash/);
    // The plaintext token is only ever put in the returned URL (shown once).
    expect(STAFF_ACTION).not.toMatch(/token_hash: token\b/);
    expect(STAFF_ACTION).not.toMatch(/token: token,/);
  });
  it("pins the job + the revoke to the ACTIVE org", () => {
    expect(STAFF_ACTION).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(STAFF_ACTION).toMatch(/\.is\("revoked_at", null\)/); // only a live link is revocable
    expect(STAFF_ACTION).toMatch(/count: "exact"/); // count-gated revoke
  });
});

describe("middleware allows the worker portal without auth-redirecting it", () => {
  it("lists /worker-portal/ as a public route", () => {
    expect(MIDDLEWARE).toMatch(/pathname\.startsWith\("\/worker-portal\/"\)/);
  });
});
