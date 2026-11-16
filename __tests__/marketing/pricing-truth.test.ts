import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SITE } from "@/lib/seo/site";

describe("commercial policy: public pricing", () => {
  it("is £1,000 one-time setup + £500/month", () => {
    expect(SITE.pricing.setupGBP).toBe(1000);
    expect(SITE.pricing.monthlyGBP).toBe(500);
  });
  it("homepage pricing block and FAQ show the same figures", () => {
    const block = readFileSync("components/marketing/home/pricing-block.tsx", "utf8");
    const faq = readFileSync("components/marketing/home/faq.tsx", "utf8");
    expect(block).toContain("£500");
    expect(block).toContain("£1,000");
    expect(faq).toContain("£500 a month plus a one-time £1,000");
  });
});
