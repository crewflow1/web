import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_COLUMN_PATTERNS,
  assertMoneySafeAllowlist,
  composeContent,
  toDocument,
  validateAllMappers,
  SOURCE_MAPPERS,
  type SourceMapper,
} from "@/lib/search/semantic/mappers";

describe("tenant search mappers — money/secret allowlist guard", () => {
  it("every registered mapper allowlist is money/secret-safe", () => {
    expect(() => validateAllMappers()).not.toThrow();
  });

  it("rejects an allowlist naming a money column", () => {
    expect(() => assertMoneySafeAllowlist("x", ["title", "total"])).toThrow(/total/);
    expect(() => assertMoneySafeAllowlist("x", ["amount_due"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["unit_price"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["vat_number"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["labour_cost"])).toThrow();
  });

  it("rejects an allowlist naming a secret/credential column", () => {
    expect(() => assertMoneySafeAllowlist("x", ["portal_token"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["api_key"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["password_hash"])).toThrow();
    expect(() => assertMoneySafeAllowlist("x", ["iban"])).toThrow();
  });

  it("accepts a descriptive, money-free allowlist", () => {
    expect(() => assertMoneySafeAllowlist("x", ["title", "notes", "location", "trade"])).not.toThrow();
  });

  it("the forbidden patterns cover the core money + secret vocabulary", () => {
    const vocab = ["amount", "total", "price", "cost", "vat", "tax", "secret", "token", "password", "iban"];
    for (const word of vocab) {
      expect(FORBIDDEN_COLUMN_PATTERNS.some((p) => p.test(word))).toBe(true);
    }
  });

  it("no registered mapper includes a known money/PII-identifier column", () => {
    // Belt-and-braces over the registry's actual columns.
    const banned = ["total", "amount", "vat_number", "company_number", "email", "phone", "portal_token"];
    for (const m of SOURCE_MAPPERS) {
      for (const col of m.allowedColumns) {
        expect(banned, `${m.sourceTable}.${col}`).not.toContain(col);
      }
    }
  });
});

describe("tenant search mappers — composeContent reads ONLY the allowlist", () => {
  it("includes allowlisted string/number columns, newline-joined", () => {
    const row = { title: "Boiler service", notes: "replace valve", count: 3 };
    expect(composeContent(row, ["title", "notes", "count"])).toBe("Boiler service\nreplace valve\n3");
  });

  it("NEVER includes a column outside the allowlist (money/secret cannot leak)", () => {
    const row = {
      title: "Kitchen refit",
      total: 9999.99,
      vat: 2000,
      portal_token: "tok_SECRET_abc",
      password: "hunter2",
    };
    const content = composeContent(row, ["title"]);
    expect(content).toBe("Kitchen refit");
    expect(content).not.toContain("9999");
    expect(content).not.toContain("tok_SECRET");
    expect(content).not.toContain("hunter2");
  });

  it("skips null/empty/non-primitive values", () => {
    const row = { a: "keep", b: null, c: "   ", d: { nested: 1 }, e: "" };
    expect(composeContent(row, ["a", "b", "c", "d", "e"])).toBe("keep");
  });
});

describe("tenant search mappers — toDocument", () => {
  const jobs = SOURCE_MAPPERS.find((m) => m.sourceTable === "jobs") as SourceMapper;
  const jobDocs = SOURCE_MAPPERS.find((m) => m.sourceTable === "job_documents") as SourceMapper;
  const customers = SOURCE_MAPPERS.find((m) => m.sourceTable === "customers") as SourceMapper;

  it("jobs: source_id = row id, job_id = row id, visibility member", () => {
    const doc = toDocument(jobs, { id: "job-1", notes: "leaking tap", site_city: "Leeds" });
    expect(doc).not.toBeNull();
    expect(doc!.sourceId).toBe("job-1");
    expect(doc!.jobId).toBe("job-1");
    expect(doc!.visibility).toBe("member");
    expect(doc!.content).toContain("leaking tap");
    expect(doc!.content).toContain("Leeds");
  });

  it("job_documents: private docs are visibility 'private', others 'staff'", () => {
    const priv = toDocument(jobDocs, { id: "d1", job_id: "j1", title: "Contract", visibility: "private" });
    const staff = toDocument(jobDocs, { id: "d2", job_id: "j1", title: "Method statement", visibility: "staff" });
    expect(priv!.visibility).toBe("private");
    expect(staff!.visibility).toBe("staff");
    expect(priv!.jobId).toBe("j1");
  });

  it("customers: management-only visibility, no job id", () => {
    const doc = toDocument(customers, { id: "c1", name: "Acme Ltd", city: "Hull" });
    expect(doc!.visibility).toBe("management");
    expect(doc!.jobId).toBeNull();
    expect(doc!.content).toContain("Acme Ltd");
  });

  it("returns null when the row has no id or no allowlisted content", () => {
    expect(toDocument(jobs, { notes: "orphan with no id" })).toBeNull();
    expect(toDocument(jobs, { id: "job-2" })).toBeNull(); // no allowlisted content
  });
});
