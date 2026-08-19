import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { hashWorkerToken, isValidWorkerTokenShape } from "@/lib/health-safety/worker-token";

/**
 * Server-only loader for the EXTERNAL WORKER sign-off portal — and the SINGLE
 * authority for worker token validity.
 *
 * The token in the URL is the entire auth surface: there is no Supabase JWT and
 * no membership, so we hash the inbound token and look the link up on the
 * service-role admin client. Because every worker-portal page and action funnels
 * through here, this one function is where malformed / unknown / EXPIRED /
 * REVOKED tokens are rejected — individual routes never re-check, so they can
 * never drift (mirrors app/customer-portal/_helpers.ts).
 *
 * Fails closed to null on: bad token shape, no matching hash, a DB error, a
 * REVOKED link, or an EXPIRED link. It never mints a session or a membership.
 *
 * The token can ONLY ever reach its own org's job: the loader returns the
 * token's org_id + job_id, and every downstream read (materials, evidence)
 * scopes by BOTH — the same "scope in code on the admin client" discipline the
 * customer portal uses, backed by the DB validate trigger on writes.
 */

/** Debounce window for the last_used_at telemetry touch: at most one write per
 *  link per hour, regardless of request volume. */
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// worker_signoff_tokens post-dates the generated Supabase types, so reads cast
// through a loose from-chain (the safety_acknowledgements / snags idiom).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };

export type WorkerSession = {
  token: {
    id: string;
    org_id: string;
    job_id: string;
    worker_name: string;
    worker_company: string | null;
    expires_at: string;
  };
  org: {
    id: string;
    name: string;
    phone: string | null;
    logo_url: string | null;
  };
  job: {
    id: string;
    customer_name: string | null;
    status: string;
    scheduled_date: string | null;
  };
};

export async function loadWorkerSession(token: string): Promise<WorkerSession | null> {
  // Shape-gate BEFORE the DB so a stray "/foo" path segment (or probing junk)
  // can't trigger a lookup.
  if (!isValidWorkerTokenShape(token)) return null;

  const admin = createAdminClient();
  const tokenHash = hashWorkerToken(token);

  const { data, error } = await (admin as unknown as FromChain)
    .from("worker_signoff_tokens")
    .select(
      `
        id, org_id, job_id, worker_name, worker_company, expires_at,
        revoked_at, last_used_at,
        org:organizations ( id, name, phone, logo_path, logo_url ),
        job:jobs ( id, status, scheduled_date, customer:customers ( name ) )
      `,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    console.error("[worker-portal] lookup failed", error);
    return null;
  }
  if (!data || !data.org || !data.job) return null;

  const row = data as unknown as {
    id: string;
    org_id: string;
    job_id: string;
    worker_name: string;
    worker_company: string | null;
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    org: { id: string; name: string; phone: string | null; logo_path: string | null; logo_url: string | null };
    job: { id: string; status: string; scheduled_date: string | null; customer: { name: string | null } | null };
  };

  // REVOKE + EXPIRY — the auth decision, made here and nowhere else. Either
  // fails closed exactly like an unknown token, so a dead link reveals no
  // org / job / H&S data.
  if (row.revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  // USAGE TELEMETRY — only now that the link is valid. Never authority, never
  // throws (see touchLastUsed), debounced in the DB.
  await touchLastUsed(admin, tokenHash, row.last_used_at);

  return {
    token: {
      id: row.id,
      org_id: row.org_id,
      job_id: row.job_id,
      worker_name: row.worker_name,
      worker_company: row.worker_company,
      expires_at: row.expires_at,
    },
    org: {
      id: row.org.id,
      name: row.org.name,
      phone: row.org.phone ?? null,
      logo_url: await resolveOrgLogoSrc(
        { logo_path: row.org.logo_path, logo_url: row.org.logo_url },
        admin,
      ),
    },
    job: {
      id: row.job.id,
      customer_name: row.job.customer?.name ?? null,
      status: row.job.status,
      scheduled_date: row.job.scheduled_date,
    },
  };
}

/**
 * Record link usage — debounced, never-throwing telemetry. Scoped to the ONE
 * link by its unique token_hash. The UPDATE re-checks the interval in its own
 * WHERE so two concurrent loads can't both write; any failure is logged and
 * dropped so a valid portal request never fails because telemetry couldn't be
 * written.
 */
async function touchLastUsed(
  admin: ReturnType<typeof createAdminClient>,
  tokenHash: string,
  lastUsedAt: string | null,
): Promise<void> {
  try {
    const cutoffMs = Date.now() - LAST_USED_TOUCH_INTERVAL_MS;
    if (lastUsedAt && Date.parse(lastUsedAt) > cutoffMs) return;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const { error } = await (
      admin.from("worker_signoff_tokens" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => {
            or: (f: string) => Promise<{ error: { message: string } | null }>;
          };
        };
      }
    )
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash)
      .or(`last_used_at.is.null,last_used_at.lt.${cutoffIso}`);
    if (error) {
      console.error("[worker-portal] last_used touch failed", error.message);
    }
  } catch (e) {
    console.error(
      "[worker-portal] last_used touch threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}
