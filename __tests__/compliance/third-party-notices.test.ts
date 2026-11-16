import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "..", "..", p), "utf8");

describe("third-party notices ship with the app", () => {
  it("public/third-party-notices.txt is the generated docs/compliance notices file", () => {
    // If this fails: regenerate (scripts/compliance/generate-notices.mjs) and
    // `cp docs/compliance/THIRD-PARTY-NOTICES.md public/third-party-notices.txt`.
    expect(read("public/third-party-notices.txt")).toBe(read("docs/compliance/THIRD-PARTY-NOTICES.md"));
  });

  it("the notices file carries the non-npm attributions the licences require", () => {
    const t = read("public/third-party-notices.txt");
    for (const needle of ["Indian Type Foundry", "Inter Project Authors", "Mozilla Foundation", "Open Government Licence", "SIL OPEN FONT LICENSE Version 1.1"]) {
      expect(t, needle).toContain(needle);
    }
  });

  it("the notices page credits the ITF typefaces by name and links the full file", () => {
    const p = read("app/third-party-notices/page.tsx");
    expect(p).toContain("Indian Type Foundry");
    expect(p).toContain("Clash Display");
    expect(p).toContain("Satoshi");
    expect(p).toContain("/third-party-notices.txt");
  });

  it("the route is public (middleware) and linked from the marketing footer and legal shell", () => {
    expect(read("lib/supabase/middleware.ts")).toContain('pathname.startsWith("/third-party-notices")');
    expect(read("components/marketing/footer.tsx")).toContain("/third-party-notices");
    expect(read("app/_components/legal-shell.tsx")).toContain("/third-party-notices");
  });
});
