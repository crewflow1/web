import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  getWeatherReadiness,
  isWeatherAvailable,
  KNOWN_WEATHER_CREDENTIALS,
} from "@/lib/weather/readiness";
import { DISTRICT_CENTROID_COUNT } from "@/lib/weather/geo/district-centroids";
import { assessWorkability } from "@/lib/weather/decision";
import { WORK_TYPES } from "@/lib/weather/thresholds";
import type { PostcodeDistrict } from "@/lib/weather/types";

/**
 * Weather intelligence — trust-boundary invariants (slot 20261074).
 *
 * This wave landed a whole domain BEFORE the provider that feeds it, so two
 * classes of claim have to be proven against SOURCE TEXT rather than against
 * behaviour, because the behaviour is (deliberately) "nothing happens":
 *
 *   A. THE DARKNESS IS REAL — AND EGRESS IS CONFINED TO A DECLARED TRANSPORT.
 *      DELIBERATE PIN UPDATE (Train 7): the original truth here was "no
 *      provider adapter exists and no file can open a socket". The new truth,
 *      updated in the same diff that shipped the adapter — exactly as this
 *      suite was designed to force — is:
 *        - exactly ONE adapter exists (lib/weather/providers/open-meteo.ts),
 *          named on an explicit TRANSPORT allowlist, the analogue of the AI
 *          ratchet's TRANSPORT set in ai-governance-closure.test.ts;
 *        - every OTHER file in the feature is still swept for every egress
 *          primitive and every vendor host, recursively;
 *        - the transport is reachable ONLY through the factory's credential-
 *          gated arm, and the credential (OPEN_METEO_API_KEY) exists in NO
 *          environment — so `available` stays false, the factory returns
 *          null, and CI still exercises zero egress: the adapter is tested
 *          exclusively against checked-in fixture JSON.
 *      The doors are pinned: the factory + the credential gate are what stand
 *      between source-level capability and a byte on the wire.
 *
 *   B. THE CACHE'S BOUNDARY HOLDS. `weather_readings` is deliberately GLOBAL —
 *      no org_id — which makes its read policy the whole trust boundary. An
 *      unrestricted SELECT there would be a cross-tenant inference channel
 *      (which districts is the platform working in?), the same defect class the
 *      20261031–37 storage wave was written to eliminate. The WRITE side is
 *      service-role only (no INSERT policy), and the fetch pipeline that now
 *      exercises it is pinned in section 9.
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
const FETCH_SERVICE = "server/services/weather-fetch.ts";
const CRON_ROUTE = "app/api/cron/weather-fetch/route.ts";
const PAGE = "app/(app)/weather/page.tsx";
const SEAM = "lib/weather/index.ts";
const READINESS = "lib/weather/readiness.ts";
const DECISION = "lib/weather/decision.ts";
const THRESHOLDS = "lib/weather/thresholds.ts";
const POSTCODE = "lib/weather/postcode.ts";
const TYPES = "lib/weather/types.ts";
const GEO_INDEX = "lib/weather/geo/index.ts";
const GEO_DATASET = "lib/weather/geo/district-centroids.ts";

/**
 * THE TRANSPORT ALLOWLIST (Train 7) — the exhaustive roster of files in this
 * feature permitted to contain a network transport primitive in SOURCE. The
 * direct analogue of the AI ratchet's TRANSPORT set: these files do not decide
 * WHETHER to call a vendor — they are constructed by the factory, which has
 * already checked selection + credential + district resolution — so a
 * transport primitive here is capability behind a governed door, not an entry
 * point. Every file NOT on this roster is swept for every egress pattern.
 * Adding a vendor adapter means adding it HERE, visibly.
 */
const WEATHER_TRANSPORT = new Set(["lib/weather/providers/open-meteo.ts"]);
const PROVIDERS_DIR = "lib/weather/providers";

/** The PURE core: no I/O, no env, no clock. The geo resolver and its dataset
 * belong here — resolution is a Map lookup over a checked-in literal. */
const PURE_CORE = [TYPES, POSTCODE, THRESHOLDS, DECISION, GEO_INDEX, GEO_DATASET] as const;

/**
 * Every TypeScript file under lib/weather — RECURSIVE, so lib/weather/geo/**
 * (the district-centroid dataset and its resolver) sits inside the same
 * zero-egress boundary as the rest of the feature, and any future subdirectory
 * is swept automatically rather than remembered manually.
 */
function weatherLibFiles(dir: string = WEATHER_LIB_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...weatherLibFiles(rel));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/** Every file the feature owns — the sweep for the egress and credential pins.
 * Train 7 added the fetch pipeline and its cron seam to the boundary. */
function allWaveFiles(): string[] {
  return [...weatherLibFiles(), SERVICE, FETCH_SERVICE, PAGE, CRON_ROUTE];
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
// 4. A. THE DARKNESS IS REAL — AND EGRESS IS CONFINED TO THE TRANSPORT.
//    The most important section in this file.
//
//    DELIBERATE PIN UPDATE (Train 7). The previous truth was "zero egress
//    is POSSIBLE from this build" — no adapter, no fetch(, providers dir
//    absent. The adapter now exists, so the pins state the NEW truth:
//    egress primitives exist in EXACTLY the allowlisted transport files,
//    the transport is constructible only through the factory's
//    credential-gated arm, and with no credential in any environment the
//    runtime behaviour is unchanged: dark, and nothing on any wire in CI.
//    Every replaced pin below has an equivalent-or-stronger successor.
// =====================================================================

describe("A. egress exists only in the declared transport, behind credential-gated doors", () => {
  /** Anything that could put a byte on the wire. */
  const EGRESS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, "fetch("],
    [/\bglobalThis\.fetch\b/, "globalThis.fetch"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bnew\s+EventSource\b/, "EventSource"],
    [/from\s+["']node:(http|https|net|tls|dgram)["']/, "node http/net import"],
    [/from\s+["'](http|https|net|tls|axios|undici|node-fetch|got|superagent)["']/, "http client import"],
    [/require\s*\(\s*["'](node:)?(http|https|net|axios|undici|node-fetch)["']/, "http client require"],
    [/navigator\.sendBeacon/, "sendBeacon"],
  ];

  /**
   * The transport may use the PLATFORM fetch and nothing else — no SDK, no
   * http client library, no raw sockets. One sanctioned primitive keeps the
   * egress surface auditable by eye.
   */
  const TRANSPORT_FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = EGRESS_PATTERNS.filter(
    ([, label]) => label !== "fetch(" && label !== "globalThis.fetch",
  );

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

  /** The one vendor the transport is allowed to name. */
  const TRANSPORT_HOST = /open-meteo\.com/i;

  it("scans the DIRECTORY, recursively, so a new file cannot slip past", () => {
    // The guard's own guard: if this ever reads zero files, every assertion below
    // passes vacuously — and it must reach INTO lib/weather/geo and
    // lib/weather/providers, or transport files would sit outside the boundary.
    const files = weatherLibFiles();
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files).toContain(SEAM);
    expect(files).toContain(READINESS);
    expect(files).toContain(DECISION);
    expect(files).toContain(GEO_INDEX);
    expect(files).toContain(GEO_DATASET);
    for (const t of WEATHER_TRANSPORT) {
      expect(files, "the transport must be inside the swept boundary").toContain(t);
    }
  });

  it("the providers directory contains EXACTLY the allowlisted transport — no stowaway adapter", () => {
    // Successor to the old "NO provider adapter directory exists" pin,
    // strictly stronger than silence: the directory's whole contents are
    // pinned, so a second adapter (or a helper that quietly grows a fetch)
    // must be added to the roster in a visible diff.
    const providerFiles = weatherLibFiles().filter((f) => f.startsWith(`${PROVIDERS_DIR}/`));
    expect([...providerFiles].sort()).toEqual([...WEATHER_TRANSPORT].sort());
  });

  it("NO file OUTSIDE the transport allowlist can open a network connection", () => {
    for (const file of allWaveFiles()) {
      if (WEATHER_TRANSPORT.has(file)) continue;
      const code = codeOf(read(file));
      for (const [pattern, label] of EGRESS_PATTERNS) {
        expect(code, `${file} must not contain ${label}`).not.toMatch(pattern);
      }
    }
  });

  it("the transport uses the platform fetch ONLY — no SDK, no http client, no sockets", () => {
    for (const file of WEATHER_TRANSPORT) {
      const code = codeOf(read(file));
      // Positive: it really is the transport (the pin is not vacuous)…
      expect(code, `${file} should reference the platform fetch`).toMatch(/globalThis\.fetch/);
      // …and negative: nothing beyond that one primitive.
      for (const [pattern, label] of TRANSPORT_FORBIDDEN) {
        expect(code, `${file} must not contain ${label}`).not.toMatch(pattern);
      }
    }
  });

  it("NO file outside the transport contains a weather vendor URL", () => {
    for (const file of allWaveFiles()) {
      if (WEATHER_TRANSPORT.has(file)) continue;
      const code = codeOf(read(file));
      for (const host of VENDOR_HOSTS) {
        expect(code, `${file} must not reference ${host}`).not.toMatch(host);
      }
    }
  });

  it("the transport names ITS vendor only — and ONLY the commercial hosts (the licence pin)", () => {
    for (const file of WEATHER_TRANSPORT) {
      const code = codeOf(read(file));
      for (const host of VENDOR_HOSTS) {
        if (host.source === TRANSPORT_HOST.source) continue;
        expect(code, `${file} must not reference another vendor: ${host}`).not.toMatch(host);
      }
      // THE LICENCE PIN. Open-Meteo's keyless open-access endpoints are
      // non-commercial-only. The adapter must speak to the commercial
      // `customer-` hosts and must NOT carry the free hosts at all — so there
      // is no code path that could quietly run on the wrong licence.
      expect(code).toMatch(/customer-api\.open-meteo\.com/);
      expect(code).toMatch(/customer-archive-api\.open-meteo\.com/);
      expect(code, "the non-commercial open-access host must not appear").not.toMatch(
        /https:\/\/api\.open-meteo\.com/,
      );
      expect(code, "the non-commercial archive host must not appear").not.toMatch(
        /https:\/\/archive-api\.open-meteo\.com/,
      );
    }
  });

  it("the transport reads NO environment and NO credential — the key arrives injected", () => {
    // The comms/AI pattern: transport is handed a key by the factory, which
    // has already consulted readiness. An adapter that read the environment
    // itself would be a door with its own lock, invisible to the readiness
    // surface — exactly the strandedCredentialRisk drift class.
    for (const file of WEATHER_TRANSPORT) {
      const code = codeOf(read(file));
      expect(code, `${file} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${file} must not import the validated env object`).not.toMatch(
        /from\s+["']@\/lib\/env["']/,
      );
      for (const cred of KNOWN_WEATHER_CREDENTIALS) {
        expect(code, `${file} must not name ${cred}`).not.toContain(cred);
      }
    }
  });

  it("the transport is imported by the SEAM alone — no side door into a vendor", () => {
    // The factory arm is the ONLY sanctioned constructor path in runtime code.
    // (Tests may import the adapter to feed it fixtures; runtime must not.)
    const importsProviders = (code: string): boolean =>
      /from\s+["'][^"']*weather\/providers\//.test(code) ||
      /from\s+["']\.\/providers\//.test(code) ||
      /from\s+["']\.\.\/providers\//.test(code);
    for (const file of allWaveFiles()) {
      if (file === SEAM || WEATHER_TRANSPORT.has(file)) continue;
      expect(
        importsProviders(codeOf(read(file))),
        `${file} must not import a provider adapter directly — only the factory may`,
      ).toBe(false);
    }
    expect(importsProviders(codeOf(read(SEAM))), "the seam is the one importer").toBe(true);
  });

  it("the seam's open-meteo arm is credential-gated; every other arm still returns null", () => {
    // DELIBERATE PIN UPDATE (Train 7): successor to "every arm returns null".
    // What is pinned now is the DOOR: construction happens in exactly one arm,
    // AFTER a key-presence guard and a district-resolution guard, and the
    // metoffice / off / default arms are unchanged — null, no construction.
    const code = codeOf(read(SEAM));
    const body = code.match(/export\s+function\s+getWeatherProvider[\s\S]*?\n\}/)![0];

    // Exactly ONE construction site in the whole factory.
    const constructions = body.match(/createOpenMeteoProvider\s*\(/g) ?? [];
    expect(constructions, "exactly one adapter construction").toHaveLength(1);
    expect(body).not.toMatch(/\bnew\s+[A-Z]/);

    // The metoffice arm: everything between its case label and the open-meteo
    // label returns null and constructs nothing.
    const metofficeArm = body.match(/case\s+"metoffice":([\s\S]*?)case\s+"open-meteo":/)![1]!;
    expect(metofficeArm).toMatch(/return\s+null;/);
    expect(metofficeArm).not.toMatch(/createOpenMeteoProvider|new\s+[A-Z]/);

    // The open-meteo arm: key read from the validated env, a null return
    // GUARDING construction (order pinned by index), then the resolver check.
    const openMeteoArm = body.match(/case\s+"open-meteo":([\s\S]*?)case\s+"":/)![1]!;
    expect(openMeteoArm).toMatch(/env\.OPEN_METEO_API_KEY/);
    expect(openMeteoArm).toMatch(/districtResolutionAvailable/);
    const guardAt = openMeteoArm.search(/return\s+null;/);
    const constructAt = openMeteoArm.search(/createOpenMeteoProvider\s*\(/);
    expect(guardAt, "the missing-key gate exists").toBeGreaterThan(-1);
    expect(constructAt).toBeGreaterThan(guardAt);

    // The off/unknown arms after the switch's vendor cases: null, always.
    const tail = body.slice(body.indexOf('case ""'));
    const tailReturns = tail.match(/return\s+[^;]+;/g) ?? [];
    expect(tailReturns.length).toBeGreaterThanOrEqual(2);
    for (const r of tailReturns) {
      expect(r, "off/default arms must return null").toMatch(/return\s+null;/);
    }
  });

  it("`PROVIDER_IMPLEMENTED` is true for open-meteo ALONE — metoffice stays false", () => {
    // DELIBERATE PIN UPDATE (Train 7): the flip this suite existed to make
    // visible has happened, in the same diff as the adapter and this pin.
    // What is pinned now: exactly ONE implemented vendor, and it is the one
    // whose adapter file the transport roster names. A second `true` without
    // a second adapter on the roster cannot land quietly.
    const code = codeOf(read(READINESS));
    const map = code.match(/PROVIDER_IMPLEMENTED[\s\S]*?=\s*\{([\s\S]*?)\}/)![1]!;
    expect(map).toMatch(/metoffice:\s*false/);
    expect(map).toMatch(/"open-meteo":\s*true/);
    expect(map.match(/:\s*true/g), "exactly one implemented vendor").toHaveLength(1);
  });

  it("district resolution is DERIVED from the dataset — never a hard-coded true", () => {
    // DELIBERATE PIN UPDATE (Train 3): this blocker is now CLOSED — the build
    // carries the ONSPD-derived centroid dataset — and the previous pin
    // (`DISTRICT_RESOLUTION_AVAILABLE = false`) was updated in the same diff
    // that shipped the data, exactly as designed: activation is a visible,
    // test-tripping change. What is pinned now is HOW it is true: computed
    // from the dataset's size, so a deleted or truncated dataset flips the
    // capability off by itself. A literal `= true` (or `= false`) here would
    // be the flag outliving the data — the false-green one layer down.
    const code = codeOf(read(READINESS));
    expect(code).toMatch(
      /DISTRICT_RESOLUTION_AVAILABLE\s*=\s*DISTRICT_CENTROID_COUNT\s*>\s*MINIMUM_DISTRICT_COVERAGE/,
    );
    expect(code).not.toMatch(/DISTRICT_RESOLUTION_AVAILABLE\s*=\s*(true|false)\b/);
    // The floor is meaningful: the UK has ~2,900 districts.
    expect(code).toMatch(/MINIMUM_DISTRICT_COVERAGE\s*=\s*2500/);
  });

  it("the centroid dataset is real, checked in, and big enough to mean UK coverage", () => {
    expect(existsSync(resolve(ROOT, GEO_DATASET))).toBe(true);
    expect(DISTRICT_CENTROID_COUNT).toBeGreaterThan(2500);
    // And it declares its provenance and licence obligations in-band.
    const raw = read(GEO_DATASET);
    expect(raw).toMatch(/ONS Postcode Directory/);
    expect(raw).toMatch(/Open Government Licence/);
    expect(raw).toMatch(/Contains OS data © Crown copyright/);
    expect(raw).toMatch(/Contains Royal Mail data © Royal Mail copyright/);
  });

  it("the dataset ships in the repo — resolution NEVER fetches, reads disk, or geocodes", () => {
    // The dataset and resolver are inside the recursive egress sweep above;
    // this adds the runtime-shape pins: pure data + a Map lookup, nothing else.
    for (const file of [GEO_INDEX, GEO_DATASET]) {
      const code = codeOf(read(file));
      expect(code, `${file} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${file} must not read the filesystem`).not.toMatch(
        /node:fs|from\s+["']fs["']/,
      );
      expect(code, `${file} must not import server-only`).not.toMatch(/server-only/);
      expect(code, `${file} must not import from scripts/`).not.toMatch(
        /from\s+["'][^"']*scripts\//,
      );
    }
  });

  it("the derivation script stays OUT of the runtime — scripts/ is tooling, not a dependency", () => {
    // The script that BUILT the dataset may use node:fs against a downloaded
    // ONSPD; nothing in the feature may reach it at runtime.
    // Import/require ONLY — the readiness blocker string may NAME the script
    // as the remedy for a regressed dataset; naming a tool is not depending
    // on one.
    for (const file of allWaveFiles()) {
      const code = codeOf(read(file));
      expect(code, `${file} must not import the derivation script`).not.toMatch(
        /(from\s+["']|require\s*\(\s*["'])[^"']*(scripts\/|derive-district-centroids)/,
      );
    }
    // And the script itself performs no network I/O — it derives from a file a
    // human downloaded, it does not download.
    const script = codeOf(read("scripts/derive-district-centroids.ts"));
    expect(script).not.toMatch(/\bfetch\s*\(/);
    expect(script).not.toMatch(/from\s+["']node:(http|https|net|tls|dgram)["']/);
  });

  it("the DARK READINESS SURFACES still report unavailable at RUNTIME — an adapter in the build lights nothing", () => {
    // Train 7 note: `providerImplemented` is still false HERE because nothing
    // in this environment selects a vendor (WEATHER_PROVIDER unset ⇒ there is
    // no vendor whose implementation could count). The adapter existing as a
    // file changes no runtime answer without selection + credential.
    const r = getWeatherReadiness();
    expect(r.available).toBe(false);
    expect(isWeatherAvailable()).toBe(false);
    expect(r.providerImplemented).toBe(false);
    expect(r.providerResolvable).toBe(false);
    expect(r.districtResolutionAvailable).toBe(true);
    expect(r.blockers.length).toBeGreaterThan(0);
    // The blocker list no longer names the coordinate dataset…
    expect(r.blockers.join(" ")).not.toMatch(/coordinate dataset is missing/i);
    // …and what remains is exactly the provider decision (selection/key).
  });

  it("COMPOSITE INVARIANT: dataset + credential can NEVER make weather available without an adapter", () => {
    // Still the metoffice truth, verbatim: `available` requires
    // providerResolvable, which no dataset and no env var can manufacture.
    // Injected, so it holds regardless of today's configuration.
    const r = getWeatherReadiness({
      providerImplemented: false,
      credentialPresent: true,
      districtResolutionAvailable: true,
      decisionLayerImplemented: true,
    });
    expect(r.available).toBe(false);
    expect(r.providerResolvable).toBe(false);
  });

  it("COMPOSITE INVARIANT (Train 7): a BUILT adapter without its credential is still dark", () => {
    // The new door's other half, injected: even granting the build-time fact
    // (adapter implemented) and every other capability, a missing credential
    // alone keeps `available` false. This is the commercial-licence gate as a
    // testable invariant — the state of every real environment today.
    const r = getWeatherReadiness({
      providerImplemented: true,
      credentialPresent: false,
      districtResolutionAvailable: true,
      decisionLayerImplemented: true,
    });
    expect(r.available).toBe(false);
    expect(r.providerResolvable).toBe(false);
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

  it("weather credentials are read by the two governed doors ONLY — readiness and the factory", () => {
    // DELIBERATE PIN UPDATE (Train 7): the readiness module reports presence;
    // the SEAM's factory arm now also reads OPEN_METEO_API_KEY — that is the
    // credential-gated door itself, and it INJECTS the key into the adapter.
    // Everything else — the adapter, both services, the cron route, the page —
    // must not so much as name a credential. Same shape as the AI ratchet:
    // the door may hold the key, the transport may not.
    const mayMentionCredentials = new Set([READINESS, SEAM]);
    for (const file of allWaveFiles()) {
      if (mayMentionCredentials.has(file)) continue;
      const code = codeOf(read(file));
      for (const cred of KNOWN_WEATHER_CREDENTIALS) {
        expect(code, `${file} must not read ${cred}`).not.toContain(cred);
      }
    }
    // And the factory's read is via the VALIDATED env object, never process.env
    // (the process.env sweep above already enforces the raw-read half).
    const seam = codeOf(read(SEAM));
    expect(seam).toMatch(/env\.OPEN_METEO_API_KEY/);
    expect(seam).not.toMatch(/process\.env\.OPEN_METEO_API_KEY/);
    // The metoffice credential still has NO reader outside readiness — there
    // is no metoffice adapter to hand it to.
    expect(seam).not.toContain("MET_OFFICE_API_KEY");
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

// =====================================================================
// 9. The fetch pipeline (Train 7) — the service-role writer.
//    `weather_readings` has NO insert policy, so this service is the only
//    code that can fill the cache — which makes its discipline part of the
//    trust boundary, not an implementation detail.
// =====================================================================

describe("the fetch pipeline writes with service role, honestly, and dark-first", () => {
  const code = () => codeOf(read(FETCH_SERVICE));

  it("checks readiness BEFORE resolving a provider or constructing the admin client", () => {
    // The same source-order pin as the read service's short-circuit: on a dark
    // build this runs ZERO queries and constructs ZERO clients.
    const c = code();
    const readinessAt = c.search(/getWeatherReadiness\s*\(/);
    const guardAt = c.search(/if\s*\(\s*!\s*readiness\.available\s*\)/);
    const providerAt = c.search(/getWeatherProvider\s*\(/);
    const adminAt = c.search(/createAdminClient\s*\(/);
    expect(readinessAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(readinessAt);
    expect(providerAt).toBeGreaterThan(guardAt);
    expect(adminAt).toBeGreaterThan(providerAt);
  });

  it("writes through the SERVICE-ROLE client and never the tenant client", () => {
    // The inverse of the read service's pin, and just as deliberate: the read
    // side must go through RLS, the write side cannot (no INSERT policy).
    const c = code();
    expect(c).toMatch(/createAdminClient/);
    expect(c).not.toMatch(/@\/lib\/supabase\/server/);
  });

  it("upserts onto EXACTLY the migration's identity index", () => {
    expect(code()).toMatch(/onConflict:\s*"provider,postcode_district,kind,valid_at"/);
  });

  it("records the resolver's coordinates as provenance and NEVER guesses a district", () => {
    const c = code();
    expect(c).toMatch(/resolveDistrictCoordinates\s*\(/);
    expect(c).toMatch(/resolved_lat:\s*coordinates\.lat/);
    expect(c).toMatch(/resolved_lon:\s*coordinates\.lon/);
    // An unresolvable district is a RECORDED outcome, not a silent skip and
    // never a substituted coordinate.
    expect(c).toMatch(/"unresolvable_district"/);
  });

  it("derives expires_at from kind in exactly the CHECK's shape — forecast expires, observation never", () => {
    expect(code()).toMatch(
      /expires_at:\s*kind\s*===\s*"forecast"\s*\?[\s\S]{0,160}?:\s*null/,
    );
  });

  it("reads are LOUD — a failed watch or freshness read aborts rather than refetching blind", () => {
    const c = code();
    // `reportReadFailure` is imported from the read-failure module (the F-1 paging
    // fix also pulls in `type SupabaseReadError` alongside it for the paged error
    // cast, so allow additional named imports in the same statement).
    expect(c).toMatch(/import\s*\{[^}]*\breportReadFailure\b[^}]*\}\s*from\s*"@\/lib\/supabase\/read-failure"/);
    expect((c.match(/reportReadFailure\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("retry is bounded, backoff is jittered-injectable, and the breaker exists", () => {
    const c = code();
    expect(c).toMatch(/MAX_ATTEMPTS\s*=\s*3/);
    expect(c).toMatch(/BREAKER_TRIP_AFTER\s*=\s*3/);
    expect(c).toMatch(/BACKOFF_CAP_MS/);
    // Injectable time: no hidden real sleep in tests, no un-mockable clock.
    expect(c).toMatch(/options\.sleep/);
    expect(c).toMatch(/options\.random/);
    expect(c).toMatch(/options\.now\s*\?\?\s*new Date\(\)/);
  });

  it("bounds one run — a runaway watch list cannot eat a call budget", () => {
    expect(code()).toMatch(/MAX_DISTRICTS_PER_RUN\s*=\s*200/);
  });

  it("retries ONLY what the adapter classified retryable — via the seam's typed error", () => {
    const c = code();
    expect(c).toMatch(/WeatherProviderError/);
    expect(c).toMatch(/e\s+instanceof\s+WeatherProviderError\s*&&\s*e\.retryable/);
  });
});

// =====================================================================
// 10. The cron seam — authorised, dark-safe, and DELIBERATELY unscheduled.
// =====================================================================

describe("the weather-fetch cron route is gated, dark-safe and unscheduled", () => {
  const code = () => codeOf(read(CRON_ROUTE));

  it("auth first, readiness second, telemetry only after BOTH — dark is a 204 with zero DB access", () => {
    // Telemetry writes a cron_runs row through the admin client, so the dark
    // no-op must return BEFORE it — a scheduled-but-dark tick touches nothing.
    const c = code();
    const authAt = c.search(/isCronAuthorised\s*\(/);
    const readyAt = c.search(/isWeatherAvailable\s*\(/);
    const noopAt = c.search(/status:\s*204/);
    const telemetryAt = c.search(/withCronTelemetry\s*\(/);
    expect(authAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(authAt);
    expect(noopAt).toBeGreaterThan(readyAt);
    expect(telemetryAt).toBeGreaterThan(noopAt);
  });

  it("touches no database client of its own — the service owns every read and write", () => {
    const c = code();
    expect(c).not.toMatch(/@\/lib\/supabase/);
    expect(c).not.toMatch(/createAdminClient|createClient/);
  });

  it("is ABSENT from vercel.json — scheduling it is an activation step, not an engineering one", () => {
    // The pin that keeps 'built' and 'running' as two different decisions:
    // adding the schedule is a visible diff against this test's expectation
    // of silence, to be updated in the activation change itself.
    const vercel = read("vercel.json");
    expect(vercel).not.toContain("weather-fetch");
  });
});
