import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { organizationSchema } from "@/lib/seo/schema";

/**
 * CrewFlow is a trading name operated by a sole trader (Northern Ireland). Public
 * surfaces must never present "CrewFlow" as a legal entity, or claim a company form,
 * registration number or registered office that does not exist.
 */
describe("public surfaces make no legal-entity claim", () => {
  it("Organization JSON-LD carries the trading name only (no legalName)", () => {
    const org = organizationSchema() as Record<string, unknown>;
    expect(org.name).toBe("CrewFlow");
    expect(org).not.toHaveProperty("legalName");
  });

  it("no public page, component or email claims a company form or Companies House registration for CrewFlow", () => {
    const roots = ["app", "components", "lib/seo", "lib/email", "emails"];
    const claim = /CrewFlow\s+(Ltd|Limited|LLP|plc)\b|(registered|incorporated)\s+in\s+(England|Wales|Scotland|Northern Ireland)|registered\s+office|company\s+(number|no\.?)\s*[:#]?\s*(NI|SC)?\d{6,8}/i;
    const hits: string[] = [];
    const walk = (dir: string) => {
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { if (!/node_modules|__tests__|admin/.test(p)) walk(p); continue; }
        if (!/\.(tsx?|mdx?|html)$/.test(e)) continue;
        readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (claim.test(line)) hits.push(`${p}:${i + 1}`); });
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});
