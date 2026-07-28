import { describe, expect, it } from "vitest";
import {
  LOCAL_HOSTS,
  assertLocalDestructiveTarget,
  assertLocalDestructiveTargetIfConfigured,
  classifyDestructiveTarget,
  describeRefusal,
  redactTarget,
} from "@/lib/testing/destructive-db-guard";

/**
 * Unit proofs for the destructive-target guard (lib/testing/destructive-db-guard.ts).
 *
 * The guard is the only thing standing between a destructive test suite and the
 * single production Supabase project, so its policy is pinned here explicitly:
 * ALLOWLIST (not denylist), FAIL CLOSED, and REDACTED in every message.
 *
 * Production-shaped values appear here only as strings handed to a pure
 * function. Nothing in this file opens a connection.
 */

// A production-shaped URL that is NOT CrewFlow's project. Load-bearing: if the
// guard ever regresses into a denylist of known-production refs, this passes
// and the test fails — which is the entire point of the allowlist design.
const UNKNOWN_PROD_SHAPED = "https://abcdefghijklmnopqrst.supabase.co";
const CREWFLOW_PROD_SHAPED = "https://jzntbskdqdopzwdqwvkp.supabase.co";

describe("classifyDestructiveTarget — local targets are accepted", () => {
  const accepted = [
    // The exact value `supabase status` reports locally AND in CI.
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://LOCALHOST:54321",
    "http://0.0.0.0:54321",
    "http://[::1]:54321",
    // Anywhere in 127.0.0.0/8 is loopback by definition.
    "http://127.0.0.2:54321",
    "http://127.1.2.3:54321",
    // Postgres connection strings, both spellings, password embedded.
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgres://postgres:postgres@localhost:54322/postgres",
    // https against loopback, and a bare host with no port.
    "https://127.0.0.1",
    "http://localhost",
  ];

  for (const target of accepted) {
    it(`accepts ${target}`, () => {
      expect(classifyDestructiveTarget(target).safe).toBe(true);
    });
  }

  it("returns the normalised host so a caller can log where it connected", () => {
    const v = classifyDestructiveTarget("http://[::1]:54321");
    expect(v.safe).toBe(true);
    if (v.safe) expect(v.host).toBe("::1");
  });

  it("tolerates surrounding whitespace (a trailing newline from `eval $(...)`)", () => {
    expect(classifyDestructiveTarget("  http://127.0.0.1:54321\n").safe).toBe(true);
  });
});

describe("classifyDestructiveTarget — the production project is refused", () => {
  it("refuses CrewFlow's production ref", () => {
    const v = classifyDestructiveTarget(CREWFLOW_PROD_SHAPED);
    expect(v.safe).toBe(false);
    if (!v.safe) expect(v.reason).toBe("non-local-host");
  });

  it("refuses a production-SHAPED url that is NOT the known production ref (allowlist, not denylist)", () => {
    const v = classifyDestructiveTarget(UNKNOWN_PROD_SHAPED);
    expect(v.safe).toBe(false);
    if (!v.safe) expect(v.reason).toBe("non-local-host");
  });

  it("refuses every other remote host, including ones nobody enumerated", () => {
    for (const target of [
      "https://db.crewflow.uk",
      "https://aws-0-eu-west-2.pooler.supabase.com:6543",
      "postgresql://postgres:hunter2@db.jzntbskdqdopzwdqwvkp.supabase.co:5432/postgres",
      "http://10.0.0.5:54321",
      "http://192.168.1.10:54321",
      "https://staging.example.com",
    ]) {
      const v = classifyDestructiveTarget(target);
      expect(v.safe, `${target} must be refused`).toBe(false);
    }
  });

  it("is not fooled by a local-looking hostname on a remote domain", () => {
    for (const target of [
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
      // WHATWG parses the leading segment as USERINFO here — host is evil.com.
      "http://127.0.0.1@evil.com",
      "http://localhost@evil.com",
    ]) {
      expect(classifyDestructiveTarget(target).safe, `${target} must be refused`).toBe(false);
    }
  });
});

describe("classifyDestructiveTarget — fails closed on anything it cannot confirm", () => {
  it("refuses undefined / null / empty / whitespace as `missing`", () => {
    for (const target of [undefined, null, "", "   ", "\n"]) {
      const v = classifyDestructiveTarget(target);
      expect(v.safe).toBe(false);
      if (!v.safe) expect(v.reason).toBe("missing");
    }
  });

  it("refuses malformed values as `unparseable`", () => {
    for (const target of ["not a url", "127.0.0.1:54321", "localhost", "://", "http//localhost"]) {
      const v = classifyDestructiveTarget(target);
      expect(v.safe, `${target} must be refused`).toBe(false);
      if (!v.safe) expect(v.reason).toBe("unparseable");
    }
  });

  it("refuses a URL with an unexpected scheme even when the host is local", () => {
    for (const target of ["ftp://127.0.0.1", "file:///tmp/x", "ws://localhost:54321"]) {
      const v = classifyDestructiveTarget(target);
      expect(v.safe, `${target} must be refused`).toBe(false);
      if (!v.safe) expect(v.reason).toBe("unsupported-scheme");
    }
  });

  it("never accepts a target by accident — only the allowlist can accept", () => {
    // Sanity pin on the policy surface itself.
    expect([...LOCAL_HOSTS].sort()).toEqual(["0.0.0.0", "127.0.0.1", "::1", "localhost"]);
  });
});

describe("redaction — no credential material ever reaches a log", () => {
  it("masks the password embedded in a postgres connection string", () => {
    const secret = "sup3r-s3cret-db-passw0rd";
    const out = redactTarget(`postgresql://postgres:${secret}@db.example.com:5432/postgres`);
    expect(out).not.toContain(secret);
    expect(out).toContain("***");
    // Still useful: the host survives so the reader knows WHERE it pointed.
    expect(out).toContain("db.example.com");
  });

  it("drops query strings and fragments, which can carry an api key", () => {
    const out = redactTarget("https://db.example.com/rest?apikey=eyJhbGciOiJIUzI1NiJ9.SECRET#tok");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("apikey");
  });

  it("does NOT echo unparseable input — a mis-set var is often a service-role JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SIGNATUREMATERIAL";
    const out = redactTarget(jwt);
    expect(out).not.toContain("SIGNATUREMATERIAL");
    expect(out).not.toContain("eyJhbGciOi");
    // It still tells you something actionable.
    expect(out).toContain("unparseable");
    expect(out).toContain(String(jwt.length));
  });

  it("reports an unset target as <unset> rather than 'undefined'", () => {
    expect(redactTarget(undefined)).toBe("<unset>");
    expect(redactTarget("")).toBe("<unset>");
  });
});

describe("refusal message — helpful at 2am, leaks nothing", () => {
  const password = "prod-db-passw0rd";
  const target = `postgresql://postgres:${password}@db.jzntbskdqdopzwdqwvkp.supabase.co:5432/postgres`;
  const verdict = classifyDestructiveTarget(target);
  const message = verdict.safe
    ? ""
    : describeRefusal(verdict, { entryPoint: "integration test harness", envVar: "SUPABASE_URL" });

  it("contains no credential material", () => {
    expect(message).not.toContain(password);
  });

  it("says WHAT was detected", () => {
    expect(message).toContain("db.jzntbskdqdopzwdqwvkp.supabase.co");
  });

  it("says WHICH entry point refused and WHICH variable to look at", () => {
    expect(message).toContain("integration test harness");
    expect(message).toContain("SUPABASE_URL");
  });

  it("says WHY", () => {
    expect(message).toContain("non-local-host");
    expect(message).toMatch(/not a known-local database/);
  });

  it("says WHAT TO DO", () => {
    expect(message).toContain("supabase start");
    expect(message).toContain("supabase status -o env");
  });

  it("states that there is no override, so nobody goes looking for one", () => {
    expect(message).toMatch(/NO override/);
  });

  it("lists the allowed hosts", () => {
    for (const host of LOCAL_HOSTS) expect(message).toContain(host);
  });
});

describe("assertLocalDestructiveTarget", () => {
  it("returns the target unchanged when local, so it can be used inline", () => {
    expect(
      assertLocalDestructiveTarget("http://127.0.0.1:54321", { entryPoint: "x", envVar: "Y" }),
    ).toBe("http://127.0.0.1:54321");
  });

  it("throws for a production target", () => {
    expect(() =>
      assertLocalDestructiveTarget(CREWFLOW_PROD_SHAPED, { entryPoint: "x", envVar: "Y" }),
    ).toThrow(/REFUSED/);
  });

  it("throws for a missing target (fail closed — absence is never safety)", () => {
    expect(() => assertLocalDestructiveTarget(undefined, { entryPoint: "x", envVar: "Y" })).toThrow(
      /REFUSED/,
    );
  });
});

describe("assertLocalDestructiveTargetIfConfigured — tier gate", () => {
  it("stays silent when nothing is configured (the tier decides skip-vs-fail)", () => {
    expect(() =>
      assertLocalDestructiveTargetIfConfigured(undefined, { entryPoint: "x", envVar: "Y" }),
    ).not.toThrow();
    expect(() =>
      assertLocalDestructiveTargetIfConfigured("", { entryPoint: "x", envVar: "Y" }),
    ).not.toThrow();
  });

  it("refuses a configured non-local target", () => {
    expect(() =>
      assertLocalDestructiveTargetIfConfigured(CREWFLOW_PROD_SHAPED, {
        entryPoint: "x",
        envVar: "Y",
      }),
    ).toThrow(/REFUSED/);
  });

  it("permits a configured local target", () => {
    expect(() =>
      assertLocalDestructiveTargetIfConfigured("http://127.0.0.1:54321", {
        entryPoint: "x",
        envVar: "Y",
      }),
    ).not.toThrow();
  });
});
