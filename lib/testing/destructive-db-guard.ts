/**
 * Destructive-target guard — the single policy that decides whether a database
 * is safe to CREATE, MUTATE, TRUNCATE and DELETE against.
 *
 * ## Why this exists
 *
 * CrewFlow's integration and E2E tiers are genuinely destructive: they create
 * and delete organisations, cascade-delete every tenant table, and reset
 * lifecycle state. They are designed for a LOCAL `supabase start` stack.
 *
 * There is exactly ONE production Supabase project and NO staging environment.
 * Every one of those suites resolves its target from the ambient environment
 * (`SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`), so a shell that still has
 * production credentials exported, a `.env` edited for a one-off production
 * query and not reverted, or a CI secret bound to the wrong environment is the
 * only thing between the suite and real customer data. Nothing structural
 * stopped it. This module is that structure.
 *
 * ## Policy
 *
 * **Fail closed, allowlist only.** A target is safe if and only if it parses as
 * a URL whose host is a known-local host (see {@link LOCAL_HOSTS}). Everything
 * else is refused: unset, empty, unparseable, an unexpected scheme, and *any*
 * host the allowlist does not name — including hosts that do not exist yet.
 *
 * A denylist ("refuse the known production ref") would fail the moment a second
 * project is created, and fails for every production-shaped URL nobody thought
 * to enumerate. An allowlist cannot fail that way: a host it has never seen is
 * refused by construction.
 *
 * ## There is deliberately NO override
 *
 * No `ALLOW_DESTRUCTIVE=1`, no `--force`, no environment escape hatch. The
 * realistic incident is a shell with the wrong environment in it; an override
 * variable lives in that exact same shell and is one copy-paste away from a
 * runbook. It would convert a structural guarantee back into a convention.
 *
 * The escape hatch is a **code change**: add the host to {@link LOCAL_HOSTS} in
 * a reviewed pull request. That is durable, visible in git history, attributable,
 * and impossible to do accidentally at 2am. If a disposable remote database is
 * ever introduced (a Supabase branch, a scratch project), allowlisting its host
 * here is the correct and only way in.
 *
 * ## Never printed
 *
 * Refusal messages are rendered through {@link redactTarget}. Postgres
 * connection strings embed a password in the authority section and API URLs can
 * carry credentials in a query string, so userinfo is masked and query/fragment
 * are dropped before anything reaches a log. Input that does not parse is never
 * echoed at all — a mis-set variable can easily contain a service-role JWT.
 *
 * Pure and dependency-free on purpose: importable from the vitest integration
 * harness, the Playwright global setup, and `tsx` scripts alike, and unit
 * testable without a database.
 */

/**
 * Hosts that are, by construction, not reachable outside the machine running
 * the tests. This is the entire safety policy.
 *
 * - `localhost`, `127.0.0.1`, `::1` — loopback, in every form a URL can spell.
 * - `0.0.0.0` — the unspecified address; addresses this host, never a remote one.
 *
 * The whole `127.0.0.0/8` block is accepted (see {@link isLoopbackIpv4}), not
 * just `127.0.0.1`, because it is definitionally loopback.
 *
 * CI is covered by this list: `.github/workflows/ci.yml` boots the stack with
 * `supabase start` on the runner and maps `supabase status -o env`, which
 * reports `http://127.0.0.1:54321`. There is no hosted CI database to allow.
 *
 * Deliberately NOT allowlisted: `host.docker.internal` and docker-compose
 * service names. Nothing in this repository runs the suites from inside a
 * container today, and an unused entry is an unreviewed hole. Add one here, in
 * a pull request, if that changes.
 */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];

/** Schemes a database target may legitimately use. Anything else is refused. */
const ALLOWED_PROTOCOLS: readonly string[] = ["http:", "https:", "postgres:", "postgresql:"];

/** Why a target was refused. Stable identifiers — asserted by the unit tests. */
export type RefusalReason =
  | "missing" // unset, empty, or whitespace only
  | "unparseable" // not a URL at all (a bare hostname, a stray JWT, a typo)
  | "unsupported-scheme" // parsed, but not an http(s)/postgres(ql) target
  | "non-local-host"; // parsed fine — and points somewhere that is not local

export type TargetVerdict =
  | { readonly safe: true; readonly host: string; readonly redacted: string }
  | { readonly safe: false; readonly reason: RefusalReason; readonly redacted: string };

/** Identifies the caller in a refusal message, so the reader knows what refused and what to fix. */
export interface GuardContext {
  /** Human name of the destructive entry point, e.g. "integration test harness". */
  readonly entryPoint: string;
  /** The environment variable(s) the caller actually resolved the target from. */
  readonly envVar: string;
}

/** True for any address in 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1. */
function isLoopbackIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * Render a target safe to print.
 *
 * Masks userinfo (a Postgres connection string carries its password there) and
 * drops query + fragment (an API key can ride in either). Input that does not
 * parse as a URL is NOT echoed — only its length is reported, because a
 * mis-set variable frequently contains a service-role JWT rather than a URL.
 */
export function redactTarget(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.trim() === "") return "<unset>";
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `<unparseable target, ${value.length} chars — not printed, it may be a credential>`;
  }
  if (url.password) url.password = "***";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Decide whether `raw` is a database this repository may run destructive
 * operations against. Pure: no I/O, no environment reads, no connection.
 *
 * Callers MUST pass the exact same string they hand to `createClient` / `psql`.
 * A guard that inspects a variable the caller does not actually use is theatre.
 */
export function classifyDestructiveTarget(raw: string | null | undefined): TargetVerdict {
  const redacted = redactTarget(raw);

  if (raw === null || raw === undefined || raw.trim() === "") {
    return { safe: false, reason: "missing", redacted };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { safe: false, reason: "unparseable", redacted };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return { safe: false, reason: "unsupported-scheme", redacted };
  }

  // `URL#hostname` renders IPv6 bracketed ("[::1]"); normalise before matching.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (LOCAL_HOSTS.includes(host) || isLoopbackIpv4(host)) {
    return { safe: true, host, redacted };
  }
  return { safe: false, reason: "non-local-host", redacted };
}

const REASON_TEXT: Record<RefusalReason, string> = {
  missing: "no database target was configured at all",
  unparseable: "the configured value is not a URL",
  "unsupported-scheme": "the target does not use an http(s) or postgres(ql) scheme",
  "non-local-host": "the target host is not a known-local database",
};

/**
 * The message someone reads at 2am. It must say what was detected, why it was
 * refused, and exactly what to do — without printing a single credential.
 */
export function describeRefusal(
  verdict: Extract<TargetVerdict, { safe: false }>,
  ctx: GuardContext,
): string {
  return [
    "",
    "╔══════════════════════════════════════════════════════════════════════════╗",
    "║  REFUSED: destructive operation blocked — target is not a local database  ║",
    "╚══════════════════════════════════════════════════════════════════════════╝",
    "",
    `  entry point   : ${ctx.entryPoint}`,
    `  resolved from : ${ctx.envVar}`,
    `  detected      : ${verdict.redacted}`,
    `  reason        : ${REASON_TEXT[verdict.reason]} (${verdict.reason})`,
    "",
    "  This code creates, mutates and DELETES rows. CrewFlow has exactly one",
    "  production Supabase project and no staging environment, so it may only run",
    "  against a local stack. Any target this guard cannot positively confirm as",
    "  local is refused — including one it simply does not recognise.",
    "",
    `  Allowed hosts : ${LOCAL_HOSTS.join(", ")} (plus all of 127.0.0.0/8)`,
    "",
    "  To fix:",
    "    1. supabase start",
    "    2. Export that stack into this shell:",
    "         set -a",
    '         eval "$(supabase status -o env \\',
    "           --override-name api.url=SUPABASE_URL \\",
    "           --override-name auth.anon_key=SUPABASE_ANON_KEY \\",
    '           --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY)"',
    '         export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"',
    '         export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"',
    '         export NEXT_PUBLIC_APP_URL="http://localhost:3000"',
    "         set +a",
    "    3. Re-run.",
    "",
    "  There is NO override flag or environment variable, by design. If a target",
    "  genuinely should be allowed, add its host to LOCAL_HOSTS in",
    "  lib/testing/destructive-db-guard.ts in a reviewed pull request.",
    "",
    "  If you did not expect this: your shell is probably still holding another",
    "  environment's Supabase variables. Check before you export anything.",
    "",
  ].join("\n");
}

/**
 * Throw unless `raw` is a confirmed-local database. Call this BEFORE
 * constructing a client or opening a connection — a guard that runs after the
 * first write is decoration.
 *
 * @returns the target unchanged, so it can be used inline at the call site:
 *          `createClient(assertLocalDestructiveTarget(url, ctx), key)`.
 */
export function assertLocalDestructiveTarget(
  raw: string | null | undefined,
  ctx: GuardContext,
): string {
  const verdict = classifyDestructiveTarget(raw);
  if (verdict.safe) return raw!.trim();
  throw new Error(describeRefusal(verdict, ctx));
}

/**
 * Gate for a whole test tier, run once at setup before any test file is
 * imported.
 *
 * Says nothing when NO target is configured: deciding what that means belongs
 * to the tier (the integration harness skips locally and fails loudly in CI —
 * see `describeIntegration`). This only refuses a target that IS configured and
 * is not local, so existing behaviour is untouched in every legitimate case.
 */
export function assertLocalDestructiveTargetIfConfigured(
  raw: string | null | undefined,
  ctx: GuardContext,
): void {
  if (raw === null || raw === undefined || raw.trim() === "") return;
  assertLocalDestructiveTarget(raw, ctx);
}
