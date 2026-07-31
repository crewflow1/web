import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  getWeatherReadiness,
  isWeatherAvailable,
  KNOWN_WEATHER_CREDENTIALS,
} from "@/lib/weather/readiness";
import { assessWorkability } from "@/lib/weather/decision";
import { WORK_TYPES } from "@/lib/weather/thresholds";
import type { PostcodeDistrict } from "@/lib/weather/types";

/**
 * Weather intelligence — trust-boundary invariants (slot 20261074).
 *
 * This wave lands a whole domain BEFORE the provider that feeds it, so two
 * classes of claim have to be proven against SOURCE TEXT rather than against
 * behaviour, because the behaviour is (deliberately) "nothing happens":
 *
 *   A. THE DARKNESS IS REAL — AND NO NETWORK EGRESS IS POSSIBLE. No provider
 *      adapter exists, no credential can activate anything, and no file in the
 *      feature can open a socket. This is the strongest claim in the file and it
 *      is enforced by scanning the DIRECTORY rather than a hard-coded file list,
 *      so it survives someone adding a file later.
 *
 *   B. THE CACHE'S BOUNDARY HOLDS. `weather_readings` is deliberately GLOBAL —
 *      no org_id — which makes its read policy the whole trust boundary. An
 *      unrestricted SELECT there would be a cross-tenant inference channel
 *      (which districts is the platform working in?), the same defect class the
 *      20261031–37 storage wave was written to eliminate.
 *
 * SQL checks run over `exec` (-- comments stripped); TS checks over `code` (//
 * and block comments stripped) — so the prose that DOCUMENTS a contract can
 * neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIG_DIR = resolve(ROOT, "supabase/migrations");
const MIGRATION = "supabase/migrations/20261074000000_weather_intelligence.sql";

const WEATHER_LIB_DIR = "lib/weather";
const SERVICE = "server/services/weather.ts";
const PAGE = "app/(app)/weather/page.tsx";
const SEAM = "lib/weather/index.ts";
const READINESS = "lib/weather/readiness.ts";
const DECISION = "lib/weather/decision.ts";
const THRESHOLDS = "lib/weather/thresholds.ts";
const POSTCODE = "lib/weather/postcode.ts";
const TYPES = "lib/weather/types.ts";

/** The PURE core: no I/O, no env, no clock. */
const PURE_CORE = [TYPES, POSTCODE, THRESHOLDS, DECISION] as const;

/** Every TypeScript file in lib/weather, read from disk so a new file is caught. */
function weatherLibFiles(): string[] {
  return readdirSync(resolve(ROOT, WEATHER_LIB_DIR))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => `${WEATHER_LIB_DIR}/${f}`);
}

/** Every file this wave adds — the sweep for the egress and credential pins. */
function allWaveFiles(): string[] {
  return [...weatherLibFiles(), SERVICE, PAGE];
}

// =====================================================================
// 0. Migration hygiene — the reserved slot, and nothing back-dated under it.
// =====================================================================

describe("20261074 migration hygiene", () => {
  const versions = () =>
    readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();

  it("exists in its reserved slot", () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  it("uses its slot, with NO duplicate version prefix anywhere in the directory", () => {
    // Supabase keys migration identity on the numeric prefix. Two files sharing
    // one prefix replay unpredictably from a fresh database while looking fine on
    // an already-migrated one — the failure that only shows up in a restore.
    const v = versions();
    expect(v).toContain("20261074000000");
    expect(new Set(v).size, "duplicate migration version prefixes").toBe(v.length);
  });

  it("sorts strictly AFTER the applied production tip (20261071)", () => {
    const v = versions();
    expect(v.indexOf("20261074000000")).toBeGreaterThan(v.indexOf("20261071000000"));
  });

  it("claims ONLY its own slot — 20261072 and 20261073 belong to other lanes", () => {
    const owned = readdirSync(MIG_DIR).filter((f) => /^2026(1072|1073)/.test(f));
    for (const f of owned) {
      expect(f).not.toMatch(/weather/i);
    }
  });

  it("is ADDITIVE — it creates its own objects and alters no pre-existing table", () => {
    const exec = execOf(read(MIGRATION));
    // The only `alter table` statements are the RLS enables on this wave's own
    // two tables.
    const alters = exec.match(/alter\s+table\s+public\.(\w+)/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toMatch(/public\.(weather_readings|weather_watches)/);
    }
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    // It must not touch the tables it references.
    expect(exec).not.toMatch(/alter\s+table\s+public\.(jobs|sites|organizations)/i);
  });

  it("documents its own rollback", () => {
    const text = read(MIGRATION);
    expect(text).toMatch(/To roll back/i);
    expect(text).toMatch(/drop table if exists public\.weather_readings/);
    expect(text).toMatch(/drop table if exists public\.weather_watches/);
    expect(text).toMatch(/drop function if exists public\.purge_weather_readings/);
  });

  it("creates exactly the two tables it claims", () => {
    const exec = execOf(read(MIGRATION));
    const creates = (exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? []).map(
      (m) => m.split(".").pop()!,
    );
    expect(creates.sort()).toEqual(["weather_readings", "weather_watches"]);
  });
});

// =====================================================================
// 1. The cache's shape: global, PII-safe, teardown-safe.
// =====================================================================

describe("weather_readings — the GLOBAL cache", () => {
  const exec = () => execOf(read(MIGRATION));
  const table = () => {
    const m = exec().match(
      /create\s+table\s+if\s+not\s+exists\s+public\.weather_readings\s*\(([\s\S]*?)\n\);/i,
    );
    return m![1]!;
  };

  it("has NO org_id and NO reference to organizations — weather is not tenant data", () => {
    // The decisive property. An org_id here would multiply both storage and
    // provider calls by the tenant count for a fact that is identical for
    // everyone, and would forfeit the cross-tenant sharing that makes the free
    // tier viable.
    expect(table()).not.toMatch(/\borg_id\b/);
    expect(table()).not.toMatch(/references\s+public\.organizations/i);
  });

  it("is therefore TRIVIALLY teardown-safe — org deletion cannot reach it", () => {
    // The 20261052 class avoided outright rather than mitigated.
    const t = table();
    expect(t).not.toMatch(/on\s+delete\s+cascade/i);
  });

  it("STRUCTURALLY REFUSES a full postcode — the PII containment control", () => {
    // The CHECK is the reason a cross-tenant-readable table is safe: a full
    // postcode plus a house number identifies a household, and this table is
    // readable by other tenants. The pattern admits only the six outward-code
    // shapes plus GIR.
    const t = table();
    expect(t).toMatch(/postcode_district\s+text\s+not\s+null/i);
    expect(t).toMatch(/\^\[A-Z\]\{1,2\}\[0-9\]\[A-Z0-9\]\?\$/);
    expect(t).toMatch(/GIR/);
  });

  it("ties expiry to kind, so an expiring observation is unrepresentable", () => {
    const t = table();
    expect(t).toMatch(/kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(\s*'forecast'\s*,\s*'observation'\s*\)/i);
    expect(t).toMatch(/weather_readings_expiry_matches_kind/);
    expect(t).toMatch(/kind\s*=\s*'forecast'\s+and\s+expires_at\s+is\s+not\s+null/i);
    expect(t).toMatch(/kind\s*=\s*'observation'\s+and\s+expires_at\s+is\s+null/i);
  });

  it("carries the provenance coordinate, bounded to real latitudes and longitudes", () => {
    const t = table();
    expect(t).toMatch(/resolved_lat[\s\S]*between\s+-90\s+and\s+90/i);
    expect(t).toMatch(/resolved_lon[\s\S]*between\s+-180\s+and\s+180/i);
  });

  it("bounds every measurement that has a physical range", () => {
    const t = table();
    expect(t).toMatch(/wind_speed_ms[\s\S]*>=\s*0/i);
    expect(t).toMatch(/wind_gust_ms[\s\S]*>=\s*0/i);
    expect(t).toMatch(/precip_rate_mm_h[\s\S]*>=\s*0/i);
    expect(t).toMatch(/humidity_pct[\s\S]*between\s+0\s+and\s+100/i);
    expect(t).toMatch(/precip_prob_pct[\s\S]*between\s+0\s+and\s+100/i);
    expect(t).toMatch(/wind_bearing_deg[\s\S]*between\s+0\s+and\s+360/i);
  });

  it("has a single identity index that doubles as the upsert target", () => {
    expect(exec()).toMatch(
      /create\s+unique\s+index[\s\S]*weather_readings_identity[\s\S]*\(\s*provider\s*,\s*postcode_district\s*,\s*kind\s*,\s*valid_at\s*\)/i,
    );
  });
});

describe("weather_readings — RLS is the whole trust boundary", () => {
  const exec = () => execOf(read(MIGRATION));

  it("RLS is ENABLED", () => {
    expect(exec()).toMatch(
      /alter\s+table\s+public\.weather_readings\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("has EXACTLY ONE policy, and it is a SELECT", () => {
    const policies = exec().match(/create\s+policy\s+(\w+)\s+on\s+public\.weather_readings/gi) ?? [];
    expect(policies).toHaveLength(1);
    expect(exec()).toMatch(/create\s+policy\s+weather_readings_select[\s\S]*?for\s+select/i);
  });

  it("is created AFTER weather_watches exists — the from-scratch replay ordering bug", () => {
    // REGRESSION. `create policy` resolves the tables its expression names AT
    // CREATION TIME. The first draft of this migration declared the policy in §1
    // and created `weather_watches` in §2, which worked on any database that
    // already had the table and failed a fresh replay with
    //   ERROR: relation "public.weather_watches" does not exist (SQLSTATE 42P01)
    // — a bug that only ever surfaces in a restore. `supabase db reset` caught it;
    // this pins the ordering so it cannot come back through a tidy-up that moves
    // the RLS block back "where it belongs".
    const exc = exec();
    const watchTableAt = exc.search(
      /create\s+table\s+if\s+not\s+exists\s+public\.weather_watches/i,
    );
    const policyAt = exc.search(/create\s+policy\s+weather_readings_select/i);
    expect(watchTableAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(-1);
    expect(
      policyAt,
      "weather_readings_select references weather_watches and must be created after it",
    ).toBeGreaterThan(watchTableAt);
  });

  it("that SELECT is GATED on the caller's own watch — never unrestricted", () => {
    // An unrestricted read would let any tenant enumerate which districts the
    // whole platform is working in: a cross-tenant inference channel over a
    // table with no org_id to protect it.
    const m = exec().match(
      /create\s+policy\s+weather_readings_select\s+on\s+public\.weather_readings([\s\S]*?);/i,
    );
    const policy = m![1]!;
    expect(policy).toMatch(/exists\s*\(/i);
    expect(policy).toMatch(/public\.weather_watches/);
    expect(policy).toMatch(/public\.current_org_ids\(\)/);
    // Not a bare `using (true)`.
    expect(policy).not.toMatch(/using\s*\(\s*true\s*\)/i);
  });

  it("the policy's EXISTS is backed by an index whose columns match its predicate", () => {
    // Not a performance nicety: this policy runs for every candidate row on the
    // hottest read in the feature. Neither of the watch table's other indexes
    // serves it — one leads with org_id, the other is partial on `active` while
    // the policy deliberately ignores `active`.
    expect(exec()).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+weather_watches_district_org_idx[\s\S]*?\(\s*postcode_district\s*,\s*org_id\s*\)/i,
    );
  });

  it("has NO insert / update / delete policy — a tenant can never FORGE a reading", () => {
    // A forged reading would drive a false work-viability verdict, which is the
    // most consequential write in this domain.
    const exc = exec();
    for (const verb of ["insert", "update", "delete"]) {
      const re = new RegExp(
        `create\\s+policy\\s+\\w+\\s+on\\s+public\\.weather_readings[\\s\\S]{0,200}?for\\s+${verb}`,
        "i",
      );
      expect(exc, `weather_readings must have no ${verb} policy`).not.toMatch(re);
    }
  });
});

// =====================================================================
// 2. The org-scoped half.
// =====================================================================

describe("weather_watches — ordinary tenant data, with a graded write rule", () => {
  const exec = () => execOf(read(MIGRATION));
  const table = () => {
    const m = exec().match(
      /create\s+table\s+if\s+not\s+exists\s+public\.weather_watches\s*\(([\s\S]*?)\n\);/i,
    );
    return m![1]!;
  };

  it("is org-scoped and cascades from organizations", () => {
    expect(table()).toMatch(
      /org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\(id\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("carries NO delete guard and NO restrict_violation ANYWHERE in the file", () => {
    // The 20261052 lesson, stated as an absolute. A watch is a cache-warming
    // hint; a RESTRICT protecting one could abort a whole tenant teardown, which
    // is exactly the P1 that migration fixed.
    expect(exec()).not.toMatch(/restrict_violation/i);
    expect(exec()).not.toMatch(/on\s+delete\s+restrict/i);
    expect(exec()).not.toMatch(/weather_watches_delete_guard/i);
  });

  it("does NOT add itself to sites_delete_guard — a weather watch cannot block retiring a depot", () => {
    expect(exec()).not.toMatch(/tg_sites_delete_guard/i);
  });

  it("both anchors CASCADE, so losing the job or the site loses only the watch", () => {
    const t = table();
    expect(t).toMatch(/job_id\s+uuid\s+references\s+public\.jobs\(id\)\s+on\s+delete\s+cascade/i);
    expect(t).toMatch(/site_id\s+uuid\s+references\s+public\.sites\(id\)\s+on\s+delete\s+cascade/i);
  });

  it("permits AT MOST ONE anchor, structurally", () => {
    expect(table()).toMatch(
      /weather_watches_single_anchor\s+check\s*\(\s*job_id\s+is\s+null\s+or\s+site_id\s+is\s+null\s*\)/i,
    );
  });

  it("uses the same PII containment CHECK as the cache", () => {
    expect(table()).toMatch(/\^\[A-Z\]\{1,2\}\[0-9\]\[A-Z0-9\]\?\$/);
  });

  it("dedupes with PARTIAL unique indexes, because NULL is distinct from NULL", () => {
    // A plain composite unique over nullable anchors would admit ten identical
    // standing watches on the same district.
    const exc = exec();
    expect(exc).toMatch(/weather_watches_org_district_standing[\s\S]*?where\s+job_id\s+is\s+null\s+and\s+site_id\s+is\s+null/i);
    expect(exc).toMatch(/weather_watches_org_job_district[\s\S]*?where\s+job_id\s+is\s+not\s+null/i);
    expect(exc).toMatch(/weather_watches_org_site_district[\s\S]*?where\s+site_id\s+is\s+not\s+null/i);
  });

  it("guards BOTH anchors against cross-tenant reference", () => {
    // RLS checks the row's own org_id and says nothing about the org of the thing
    // it points at — the class 20261011 closed for purchase orders.
    const exc = exec();
    expect(exc).toMatch(/create\s+or\s+replace\s+function\s+public\.tg_weather_watch_org_integrity/i);
    expect(exc).toMatch(/security\s+definer\s+set\s+search_path\s*=\s*public/i);
    expect(exc).toMatch(/from\s+public\.jobs\s+where\s+id\s*=\s*new\.job_id/i);
    expect(exc).toMatch(/from\s+public\.sites\s+where\s+id\s*=\s*new\.site_id/i);
    expect(exc).toMatch(
      /create\s+trigger\s+weather_watches_org_integrity[\s\S]*?before\s+insert\s+or\s+update\s+on\s+public\.weather_watches/i,
    );
  });

  it("gates STANDING (unanchored) watches on admin, on insert AND on update", () => {
    // The escalation this closes: a member edits an anchored watch they may edit,
    // nulls out its anchor, and arrives at a standing watch they were never
    // allowed to create. The WITH CHECK arm is what forbids it.
    const exc = exec();
    const insert = exc.match(
      /create\s+policy\s+weather_watches_insert\s+on\s+public\.weather_watches([\s\S]*?);/i,
    )![1]!;
    expect(insert).toMatch(/is_org_admin/);
    expect(insert).toMatch(/job_id\s+is\s+not\s+null\s+or\s+site_id\s+is\s+not\s+null/i);

    const update = exc.match(
      /create\s+policy\s+weather_watches_update\s+on\s+public\.weather_watches([\s\S]*?);/i,
    )![1]!;
    expect(update).toMatch(/using/i);
    expect(update).toMatch(/with\s+check/i);
    // is_org_admin must appear on BOTH sides of the update policy.
    expect((update.match(/is_org_admin/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// =====================================================================
// 3. Retention.
// =====================================================================

describe("purge_weather_readings — explicit, service-role only, unprivileged", () => {
  const exec = () => execOf(read(MIGRATION));

  it("is NOT security definer — a privileged delete primitive over a cross-tenant table", () => {
    const fn = exec().match(
      /create\s+or\s+replace\s+function\s+public\.purge_weather_readings([\s\S]*?)\$\$;/i,
    )![1]!;
    expect(fn).not.toMatch(/security\s+definer/i);
    expect(fn).toMatch(/set\s+search_path\s*=\s*public/i);
  });

  it("revokes EXECUTE from public/anon/authenticated BEFORE granting to service_role", () => {
    const exc = exec();
    const revokeAt = exc.search(/revoke\s+execute\s+on\s+function\s+public\.purge_weather_readings/i);
    const grantAt = exc.search(/grant\s+execute\s+on\s+function\s+public\.purge_weather_readings/i);
    expect(revokeAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(revokeAt);
    expect(exc).toMatch(/from\s+public,\s*anon,\s*authenticated/i);
    expect(exc).toMatch(/to\s+service_role/i);
  });

  it("has two arms with different windows, and defaults both", () => {
    const exc = exec();
    expect(exc).toMatch(/p_forecast_grace\s+interval\s+default\s+interval\s+'7 days'/i);
    expect(exc).toMatch(/p_observation_retention\s+interval\s+default\s+interval\s+'24 months'/i);
    expect(exc).toMatch(/kind\s*=\s*'forecast'[\s\S]*?expires_at\s*<\s*now\(\)\s*-\s*p_forecast_grace/i);
    expect(exc).toMatch(/kind\s*=\s*'observation'[\s\S]*?valid_at\s*<\s*now\(\)\s*-\s*p_observation_retention/i);
  });

  it("contains no dynamic SQL", () => {
    expect(exec()).not.toMatch(/\bexecute\s+format\b|\bexecute\s+'/i);
  });

  it("nothing calls it automatically — deleting an observation destroys a record of fact", () => {
    // A cron or trigger invocation would make retention silent. It must be
    // deliberate.
    for (const f of allWaveFiles()) {
      expect(codeOf(read(f)), f).not.toMatch(/purge_weather_readings/);
    }
  });
});

// =====================================================================
// 4. A. THE DARKNESS IS REAL — AND NO NETWORK EGRESS IS POSSIBLE.
//    The most important section in this file.
// =====================================================================

describe("A. zero network egress is possible from this build", () => {
  /** Anything that could put a byte on the wire. */
  const EGRESS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, "fetch("],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bnew\s+EventSource\b/, "EventSource"],
    [/from\s+["']node:(http|https|net|tls|dgram)["']/, "node http/net import"],
    [/from\s+["'](http|https|net|tls|axios|undici|node-fetch|got|superagent)["']/, "http client import"],
    [/require\s*\(\s*["'](node:)?(http|https|net|axios|undici|node-fetch)["']/, "http client require"],
    [/navigator\.sendBeacon/, "sendBeacon"],
  ];

  /** Any weather vendor host. A URL is the other half of an egress capability. */
  const VENDOR_HOSTS = [
    /datahub\.metoffice/i,
    /api[-.]metoffice/i,
    /metoffice\.gov\.uk/i,
    /open-meteo\.com/i,
    /openweathermap\.org/i,
    /api\.openweather/i,
    /visualcrossing\.com/i,
    /weatherapi\.com/i,
    /tomorrow\.io/i,
    /weatherkit\.apple/i,
  ];

  it("scans the DIRECTORY, not a fixed list, so a new file cannot slip past", () => {
    // The guard's own guard: if this ever reads zero files, every assertion below
    // passes vacuously.
    const files = weatherLibFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain(SEAM);
    expect(files).toContain(READINESS);
    expect(files).toContain(DECISION);
  });

  it("NO file in the feature can open a network connection", () => {
    for (const file of allWaveFiles()) {
      const code = codeOf(read(file));
      for (const [pattern, label] of EGRESS_PATTERNS) {
        expect(code, `${file} must not contain ${label}`).not.toMatch(pattern);
      }
    }
  });

  it("NO file in the feature contains a weather vendor URL", () => {
    for (const file of allWaveFiles()) {
      const code = codeOf(read(file));
      for (const host of VENDOR_HOSTS) {
        expect(code, `${file} must not reference ${host}`).not.toMatch(host);
      }
    }
  });

  it("NO provider adapter directory exists", () => {
    // The one place an adapter would live. Its absence is the structural fact
    // behind `providerImplemented: false`.
    expect(existsSync(resolve(ROOT, "lib/weather/providers"))).toBe(false);
  });

  it("the seam's every arm returns null — the switch is literally dark", () => {
    const code = codeOf(read(SEAM));
    const body = code.match(/export\s+function\s+getWeatherProvider[\s\S]*?\n\}/)![0];
    // No construction of anything.
    expect(body).not.toMatch(/\bnew\s+[A-Z]/);
    expect(body).not.toMatch(/create\w*Provider\s*\(/);
    // Every case resolves to null.
    const returns = body.match(/return\s+[^;]+;/g) ?? [];
    expect(returns.length).toBeGreaterThan(2);
    for (const r of returns) {
      expect(r, "every arm of the weather seam must return null").toMatch(/return\s+null;/);
    }
  });

  it("`PROVIDER_IMPLEMENTED` is false for EVERY known vendor, in the source", () => {
    // Flipping one is a visible diff that trips this test — activation can never
    // be a quiet configuration change.
    const code = codeOf(read(READINESS));
    const map = code.match(/PROVIDER_IMPLEMENTED[\s\S]*?=\s*\{([\s\S]*?)\}/)![1]!;
    expect(map).toMatch(/metoffice:\s*false/);
    expect(map).toMatch(/"open-meteo":\s*false/);
    expect(map).not.toMatch(/:\s*true/);
  });

  it("district resolution is false — the activation blocker that is not a credential", () => {
    const code = codeOf(read(READINESS));
    expect(code).toMatch(/DISTRICT_RESOLUTION_AVAILABLE\s*=\s*false/);
  });

  it("the DARK READINESS SURFACES report false at RUNTIME, not just in source", () => {
    const r = getWeatherReadiness();
    expect(r.available).toBe(false);
    expect(isWeatherAvailable()).toBe(false);
    expect(r.providerImplemented).toBe(false);
    expect(r.providerResolvable).toBe(false);
    expect(r.districtResolutionAvailable).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("readiness mirrors the comms precedent's decomposition — not one ambiguous boolean", () => {
    const code = codeOf(read(READINESS));
    for (const field of [
      "decisionLayerImplemented",
      "providerImplemented",
      "districtResolutionAvailable",
      "credentialsPresent",
      "providerResolvable",
      "available",
      "blockers",
    ]) {
      expect(code, `readiness must report ${field}`).toContain(field);
    }
    // The invariant, in source: `available` requires the build-time facts.
    expect(code).toMatch(
      /available\s*=\s*decisionLayerImplemented\s*&&\s*providerResolvable\s*&&\s*districtResolutionAvailable/,
    );
    expect(code).toMatch(
      /providerResolvable\s*=\s*providerImplemented\s*&&\s*selectionUsable\s*&&\s*credentialsPresent/,
    );
  });

  it("readiness is edge-safe: no server-only, no DB client, no SDK", () => {
    // /api/health runs on the edge runtime and imports this module.
    const code = codeOf(read(READINESS));
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/createAdminClient|@\/lib\/supabase/);
  });

  it("introduces exactly TWO credential names and no third anywhere in the wave", () => {
    expect([...KNOWN_WEATHER_CREDENTIALS].sort()).toEqual([
      "MET_OFFICE_API_KEY",
      "OPEN_METEO_API_KEY",
    ]);
    // No file invents another secret-looking env var.
    const allowed = new Set([...KNOWN_WEATHER_CREDENTIALS, "WEATHER_PROVIDER"]);
    for (const file of allWaveFiles()) {
      const code = codeOf(read(file));
      const refs = code.match(/process\.env\.([A-Z][A-Z0-9_]*)/g) ?? [];
      for (const r of refs) {
        const name = r.split(".").pop()!;
        expect(allowed.has(name), `${file} reads unexpected env var ${name}`).toBe(true);
      }
    }
  });

  it("no weather credential is read by anything that could make a request", () => {
    // Only the readiness module (which reports) and lib/env (which declares) may
    // mention these names. The seam reads WEATHER_PROVIDER only.
    for (const file of allWaveFiles()) {
      if (file === READINESS) continue;
      const code = codeOf(read(file));
      for (const cred of KNOWN_WEATHER_CREDENTIALS) {
        expect(code, `${file} must not read ${cred}`).not.toContain(cred);
      }
    }
  });
});

// =====================================================================
// 5. The pure core stays pure — the basis of determinism.
// =====================================================================

describe("the decision layer is PURE and DETERMINISTIC", () => {
  it("reads no environment, no database, no clock and no filesystem", () => {
    for (const file of PURE_CORE) {
      const code = codeOf(read(file));
      expect(code, `${file} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${file} must not import server-only`).not.toMatch(/server-only/);
      expect(code, `${file} must not touch supabase`).not.toMatch(/@\/lib\/supabase|createClient/);
      expect(code, `${file} must not read the filesystem`).not.toMatch(/node:fs|from\s+["']fs["']/);
      // THE DETERMINISM PIN: no wall clock. A verdict that depended on "now"
      // could not be reproduced when somebody later asks why work stopped.
      expect(code, `${file} must not read the clock`).not.toMatch(/Date\.now\(\)|new\s+Date\(\s*\)/);
    }
  });

  it("holds no mutable MODULE state, so one assessment cannot influence the next", () => {
    // Anchored at column zero: a `let` inside a function body is ordinary local
    // computation, while a top-level one is shared state that would make the
    // layer's output depend on call order — the thing that would break
    // reproducibility without breaking any single test.
    for (const file of PURE_CORE) {
      const code = codeOf(read(file));
      expect(code, `${file} must not declare module-level let/var`).not.toMatch(
        /^(let|var)\s+\w+/m,
      );
    }
  });

  it("thresholds are a frozen literal, not built at runtime", () => {
    const code = codeOf(read(THRESHOLDS));
    expect(code).toMatch(/WORK_TYPE_THRESHOLDS[\s\S]*?as\s+const/);
  });

  it("EVERY work type returns `unknown` on an empty window — never `viable`", () => {
    // The runtime proof of the dark path's behaviour, and the single most
    // important safety property: with no provider there is no weather, and no
    // weather must never read as good weather.
    const w = { district: "LS1" as PostcodeDistrict, readings: [] as const };
    for (const workType of WORK_TYPES) {
      const a = assessWorkability(w, workType);
      expect(a.verdict, workType).toBe("unknown");
      expect(a.verdict, workType).not.toBe("viable");
    }
  });
});

// =====================================================================
// 6. The service short-circuits BEFORE it touches Postgres.
// =====================================================================

describe("the service's dark short-circuit comes before any query", () => {
  const code = () => codeOf(read(SERVICE));

  it("checks readiness BEFORE calling createClient", () => {
    const c = code();
    const readinessAt = c.search(/getWeatherReadiness\s*\(/);
    const clientAt = c.search(/createClient\s*\(/);
    const guardAt = c.search(/if\s*\(\s*!\s*readiness\.available\s*\)/);
    expect(readinessAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(readinessAt);
    // The early return must precede the first client construction.
    expect(clientAt).toBeGreaterThan(guardAt);
  });

  it("returns shortCircuited on the dark path", () => {
    expect(code()).toMatch(/shortCircuited:\s*true/);
  });

  it("makes no network call and imports no vendor SDK", () => {
    const c = code();
    expect(c).not.toMatch(/\bfetch\s*\(/);
    expect(c).not.toMatch(/getWeatherProvider/); // the service never even resolves one yet
  });

  it("reads the cache through the TENANT client, so the watch-gated policy applies", () => {
    // A service-role read would silently bypass the only boundary this global
    // table has.
    const c = code();
    expect(c).toMatch(/@\/lib\/supabase\/server/);
    expect(c).not.toMatch(/createAdminClient/);
  });

  it("pins the watch list to the ACTIVE org on top of RLS", () => {
    // `current_org_ids()` spans both estates of a dual-org user and would blend
    // two companies' watch lists onto one screen — the active-org defect class.
    expect(code()).toMatch(/from\("weather_watches"[\s\S]*?\.eq\("org_id"/);
  });

  it("a FAILED read is reported and never renders as an empty forecast", () => {
    // Worse here than anywhere: an empty window would show "no warnings" when the
    // truth is "we could not look".
    const c = code();
    expect(c).toMatch(/reportReadFailure/);
    expect(c).toMatch(/import\s*\{\s*reportReadFailure\s*\}\s*from\s*"@\/lib\/supabase\/read-failure"/);
  });

  it("coerces PostgREST numerics — a string comparison would break every threshold", () => {
    // Postgres `numeric` arrives as a STRING over PostgREST.
    expect(code()).toMatch(/function\s+num\s*\(/);
  });
});

// =====================================================================
// 7. The UI is honest: no fabricated weather.
// =====================================================================

describe("the dark UI renders no weather it has not got", () => {
  const code = () => codeOf(read(PAGE));

  it("exists and is read-only — no form, no server action, no mutation", () => {
    expect(existsSync(resolve(ROOT, PAGE))).toBe(true);
    const c = code();
    expect(c).not.toMatch(/"use server"/);
    expect(c).not.toMatch(/<form\b/);
    expect(c).not.toMatch(/useActionState|revalidatePath/);
    // A dark surface that could write would be a surface that could create
    // provider spend before anybody decided to.
    expect(c).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("contains no hard-coded weather figures — no sample forecast", () => {
    // A greyed-out mock forecast on a live operational screen is a hazard, not a
    // placeholder: a site manager who skim-reads it has been misled by their own
    // software. Threshold VALUES come from lib/weather/thresholds.ts; no
    // temperature, wind speed or rainfall is spelled here.
    const c = code();
    expect(c).not.toMatch(/\b\d+\s*°C\b/);
    expect(c).not.toMatch(/\bmm\/h\b/);
    expect(c).not.toMatch(/airTempC\s*:/);
    expect(c).not.toMatch(/windGustMs\s*:/);
    expect(c).not.toMatch(/sample|mock|placeholder|dummy|fixture/i);
  });

  it("takes its status wording from the readiness module, not from the component", () => {
    expect(code()).toMatch(/weatherStatusLine/);
  });

  it("renders the advisory disclaimer and names the statutory duties", () => {
    const raw = read(PAGE);
    expect(raw).toMatch(/Advisory only/i);
    expect(raw).toMatch(/CDM 2015/);
    expect(raw).toMatch(/Work at Height Regulations 2005/);
    expect(raw).toMatch(/LOLER 1998/);
    expect(raw).toMatch(/competent person/i);
  });

  it("marks CrewFlow's own thresholds as such, so they cannot pass for a standard", () => {
    const raw = read(PAGE);
    expect(raw).toMatch(/CrewFlow default/);
    expect(code()).toMatch(/isSourced/);
  });
});

// =====================================================================
// 8. The readiness surface reaches the health endpoint.
// =====================================================================

describe("readiness is observable", () => {
  it("/api/health reports weather availability, booleans only", () => {
    const code = codeOf(read("app/api/health/route.ts"));
    expect(code).toMatch(/getWeatherReadiness/);
    expect(code).toMatch(/available:\s*weather\.available/);
    // The endpoint is public — it must never name an env var.
    for (const cred of KNOWN_WEATHER_CREDENTIALS) {
      expect(code).not.toContain(cred);
    }
  });

  it("the health endpoint reports `available`, never the weaker 'a key is set'", () => {
    const code = codeOf(read("app/api/health/route.ts"));
    expect(code).not.toMatch(/weather\.credentialsPresent/);
  });
});
