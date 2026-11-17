import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

/**
 * `.env.example` — kept honest by construction.
 *
 * The file is the one committed place that names every environment variable the
 * application reads and says, per variable, whether it is PUBLIC (shipped to the
 * browser), a SECRET (server-only credential) or plain config. It is useless —
 * worse, misleading — the moment it drifts from the code or acquires a real
 * value. So:
 *
 *   1. COMPLETE   every key of the lib/env.ts schema, and every `process.env.X`
 *                 the app reads directly, is listed.
 *   2. NO STALE   every listed name is one the code actually reads.
 *   3. NO VALUES  a [SECRET] line has an EMPTY value. No line anywhere carries
 *                 anything secret-shaped.
 *   4. CLASSIFIED every variable carries exactly one tag, a NEXT_PUBLIC_ name is
 *                 never tagged SECRET, and a credential-shaped name is never
 *                 tagged PUBLIC unless it is on the short, reasoned list of
 *                 public-by-design identifiers.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

type Entry = { name: string; value: string; tag: string };

function parseExample(): Entry[] {
  const out: Entry[] = [];
  let tag = "";
  for (const line of read(".env.example").split("\n")) {
    const t = line.match(/^# \[(PUBLIC|SECRET|CONFIG|PLATFORM)\]/);
    if (t) {
      tag = t[1]!;
      continue;
    }
    const kv = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (kv) {
      out.push({ name: kv[1]!, value: kv[2]!, tag });
      tag = "";
    }
  }
  return out;
}

function schemaKeys(): string[] {
  return [...read("lib/env.ts").matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*(?:z\b|[a-zA-Z]+\()/gm)].map(
    (m) => m[1]!,
  );
}

/** `process.env.NAME` / `process.env["NAME"]` reads in shipped application code. */
function directAppReads(): Set<string> {
  const names = new Set<string>();
  const rx = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
  const scan = (file: string) => {
    for (const m of readFileSync(file, "utf8").matchAll(rx)) names.add((m[1] ?? m[2])!);
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.(test|spec)\./.test(entry)) scan(full);
    }
  };
  for (const root of ["app", "lib", "server", "components", "sdks"]) walk(resolve(ROOT, root));
  for (const f of [
    "middleware.ts",
    "instrumentation.ts",
    "next.config.ts",
    "sentry.client.config.ts",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
  ]) {
    scan(resolve(ROOT, f));
  }
  return names;
}

/** Runtime/tooling names that are not configuration anyone supplies. */
const NOT_CONFIGURATION = new Set(["CI", "NEXT_RUNTIME"]);

/**
 * Names that LOOK like credentials but are public by design. Each needs a
 * reason; adding one is a reviewed act.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "Supabase anon/publishable key — RLS is the boundary, not the key",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "Stripe publishable key — designed to ship in the browser",
  NEXT_PUBLIC_POSTHOG_KEY: "PostHog project key — a write-only public identifier",
  VAPID_PUBLIC_KEY: "the PUBLIC half of the web-push key pair",
};

describe(".env.example — complete, current, classified, and value-free", () => {
  const entries = parseExample();
  const listed = new Set(entries.map((e) => e.name));

  it("lists every key of the lib/env.ts schema", () => {
    const missing = schemaKeys().filter((k) => !listed.has(k));
    expect(missing, "add these to .env.example (with a [PUBLIC]/[SECRET]/[CONFIG] tag)").toEqual([]);
    expect(schemaKeys().length).toBeGreaterThan(100);
  });

  it("lists every variable the application reads directly from process.env", () => {
    const missing = [...directAppReads()]
      .filter((n) => !NOT_CONFIGURATION.has(n) && !listed.has(n))
      .sort();
    expect(missing, "a direct process.env read that is not in .env.example").toEqual([]);
  });

  it("lists nothing the code no longer reads", () => {
    const known = new Set([...schemaKeys(), ...directAppReads()]);
    expect(entries.map((e) => e.name).filter((n) => !known.has(n))).toEqual([]);
  });

  it("names each variable exactly once and tags every one", () => {
    const names = entries.map((e) => e.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect(entries.filter((e) => !e.tag).map((e) => e.name)).toEqual([]);
  });

  it("a [SECRET] never has a value, and no line carries anything secret-shaped", () => {
    expect(entries.filter((e) => e.tag === "SECRET" && e.value !== "").map((e) => e.name)).toEqual([]);
    // The only non-empty values permitted are these inert local defaults.
    const SAFE_VALUES = new Set(["http://localhost:3000", "http://127.0.0.1:54321", "CrewFlow", "development"]);
    expect(
      entries.filter((e) => e.value !== "" && !SAFE_VALUES.has(e.value)).map((e) => e.name),
      "only inert local defaults may carry a value",
    ).toEqual([]);
    const text = read(".env.example");
    for (const shape of [
      /eyJ[A-Za-z0-9_-]{10,}\./, // a JWT
      /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/, // Stripe
      /\bwhsec_[A-Za-z0-9]{8,}/,
      /sk-ant-[A-Za-z0-9_-]{8,}/, // Anthropic
      /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{8,}/, // Resend
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ]) {
      expect(text).not.toMatch(shape);
    }
  });

  it("no NEXT_PUBLIC_ name is a SECRET, and no credential-shaped name is PUBLIC unless public by design", () => {
    expect(
      entries.filter((e) => e.name.startsWith("NEXT_PUBLIC_") && e.tag === "SECRET").map((e) => e.name),
      "a NEXT_PUBLIC_ variable is inlined into the browser bundle — it cannot hold a secret",
    ).toEqual([]);
    const credentialShaped = /(SECRET|TOKEN|PASSWORD|PRIVATE|_KEY$|_HMAC$)/;
    const wronglyPublic = entries
      .filter((e) => e.tag === "PUBLIC" && credentialShaped.test(e.name))
      .map((e) => e.name)
      .filter((n) => !(n in PUBLIC_BY_DESIGN));
    expect(wronglyPublic).toEqual([]);
    // Every public-by-design exception is still listed and still PUBLIC.
    for (const name of Object.keys(PUBLIC_BY_DESIGN)) {
      expect(entries.find((e) => e.name === name)?.tag, name).toBe("PUBLIC");
    }
  });

  it("every NEXT_PUBLIC_ variable the build can inline is tagged PUBLIC or PLATFORM", () => {
    expect(
      entries
        .filter((e) => e.name.startsWith("NEXT_PUBLIC_") && !["PUBLIC", "PLATFORM"].includes(e.tag))
        .map((e) => e.name),
    ).toEqual([]);
  });

  it("the service-role key and every provider secret are tagged SECRET", () => {
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "CRON_SECRET",
      "INTEGRATION_TOKEN_ENCRYPTION_KEY",
      "VAPID_PRIVATE_KEY",
      "DEV_TEST_LOGIN_TOKEN",
    ]) {
      expect(entries.find((e) => e.name === name)?.tag, name).toBe("SECRET");
    }
  });

  it(".gitignore still ignores real env files while allowing this one", () => {
    const gi = read(".gitignore");
    expect(gi).toMatch(/^\.env$/m);
    expect(gi).toMatch(/^\.env\.\*$/m);
    expect(gi).toMatch(/^!\.env\.example$/m);
    expect(relative(ROOT, resolve(ROOT, ".env.example"))).toBe(".env.example");
  });
});
