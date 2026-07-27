import { describe, it, expect } from "vitest";
import {
  assessDigitalMaturity,
  assessWebsiteQuality,
  detectTechnologies,
  domainOf,
  extractEmails,
  extractPhones,
  extractText,
  normaliseUrl,
  type DetectedTech,
} from "@/lib/research/extract";

/**
 * Research AI — deterministic extraction (CEO Directive 005, Phase 1 + 2).
 *
 * "Never invent data. Unknown is acceptable." These extractors only ever
 * report a signal the HTML actually contains, so the tests pin both the
 * positive reads and the noise filtering that stops a fake contact / asset
 * hash being reported as real.
 */

describe("extractEmails", () => {
  it("reads mailto + bare addresses, lowercased and deduped", () => {
    const html = `
      <a href="mailto:Hello@Acme.co.uk">Email us</a>
      <p>Or sales@acme.co.uk for quotes</p>
    `;
    const emails = extractEmails(html);
    expect(emails).toContain("hello@acme.co.uk");
    expect(emails).toContain("sales@acme.co.uk");
    // deduped — "Hello@" via mailto and EMAIL_RE collapse to one entry
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("filters placeholder + asset-hash noise so no fake contact is reported", () => {
    const html = `
      <span>placeholder you@example.com</span>
      <img src="logo@2x.png">
      <p>real: ops@buildco.co.uk</p>
    `;
    const emails = extractEmails(html);
    expect(emails).toContain("ops@buildco.co.uk");
    expect(emails.some((e) => e.includes("example"))).toBe(false);
    expect(emails.some((e) => e.includes(".png"))).toBe(false);
    expect(emails.some((e) => e.includes("@2x"))).toBe(false);
  });

  it("returns [] when the page publishes no address", () => {
    expect(extractEmails("<p>no contact here</p>")).toEqual([]);
  });
});

describe("extractPhones", () => {
  it("extracts a valid tel: number", () => {
    const phones = extractPhones(`<a href="tel:+442079460958">Call</a>`);
    expect(phones.length).toBeGreaterThan(0);
    expect(phones[0]).toContain("442079460958");
  });

  it("rejects numbers that are too short to be real", () => {
    expect(extractPhones(`<a href="tel:12345">x</a>`)).toEqual([]);
  });
});

describe("detectTechnologies", () => {
  it("detects technologies from their real signatures", () => {
    const html = `
      <link rel="stylesheet" href="/wp-content/themes/acme/style.css">
      <script src="https://js.stripe.com/v3/"></script>
      <script>gtag('config','G-XXX')</script>
    `;
    const names = detectTechnologies(html).map((t) => t.name);
    expect(names).toContain("WordPress");
    expect(names).toContain("Stripe");
    expect(names).toContain("Google Analytics");
  });

  it("reports nothing for a bare page", () => {
    expect(detectTechnologies("<html><body>hi</body></html>")).toEqual([]);
  });
});

describe("normaliseUrl + domainOf", () => {
  it("upgrades a bare domain to absolute https", () => {
    expect(normaliseUrl("acme.co.uk")).toBe("https://acme.co.uk/");
  });

  it("preserves an already-absolute url", () => {
    expect(normaliseUrl("https://www.acme.com/contact")).toBe(
      "https://www.acme.com/contact",
    );
  });

  it("rejects inputs that cannot be a web address", () => {
    expect(normaliseUrl("")).toBeNull();
    expect(normaliseUrl("localhost")).toBeNull(); // no dot
    expect(normaliseUrl("under_score.com")).toBeNull(); // illegal hostname char
  });

  it("returns the bare, www-stripped, lowercased domain", () => {
    expect(domainOf("https://www.Acme.CO.uk/contact")).toBe("acme.co.uk");
    expect(domainOf("Acme.COM")).toBe("acme.com");
    expect(domainOf("not a domain")).toBeNull();
  });
});

describe("extractText", () => {
  it("strips scripts/styles/tags and collapses whitespace", () => {
    const html = `
      <head><style>.a{color:red}</style><script>var x=1</script></head>
      <body><h1>Acme  Builders</h1><p>Groundworks &amp; civils</p></body>
    `;
    const text = extractText(html);
    expect(text).toContain("Acme Builders");
    expect(text).toContain("Groundworks & civils");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
  });

  it("respects the bounding cap", () => {
    const html = `<p>${"a".repeat(50)}</p>`;
    expect(extractText(html, 10)).toHaveLength(10);
  });
});

describe("assessWebsiteQuality", () => {
  it("sums to 100 for a fully-equipped, content-rich site", () => {
    const score = assessWebsiteQuality({
      title: "Acme Builders",
      metaDescription: "Groundworks specialists",
      hasViewport: true,
      hasOpenGraph: true,
      hasFavicon: true,
      https: true,
      textLength: 3000,
      emails: ["a@acme.co.uk"],
      phones: ["+44 20 7946 0958"],
      socials: {
        linkedin: "x",
        instagram: "y",
        facebook: "z",
        twitter: null,
        youtube: null,
      },
    });
    expect(score).toBe(100);
  });

  it("scores a bare page at zero", () => {
    const score = assessWebsiteQuality({
      title: null,
      metaDescription: null,
      hasViewport: false,
      hasOpenGraph: false,
      hasFavicon: false,
      https: false,
      textLength: 0,
      emails: [],
      phones: [],
      socials: {
        linkedin: null,
        instagram: null,
        facebook: null,
        twitter: null,
        youtube: null,
      },
    });
    expect(score).toBe(0);
  });

  it("is the deterministic sum of its observable components", () => {
    // title 14 + https 12 + textLength>=800 10 = 36
    const score = assessWebsiteQuality({
      title: "Acme",
      metaDescription: null,
      hasViewport: false,
      hasOpenGraph: false,
      hasFavicon: false,
      https: true,
      textLength: 1000,
      emails: [],
      phones: [],
      socials: {
        linkedin: null,
        instagram: null,
        facebook: null,
        twitter: null,
        youtube: null,
      },
    });
    expect(score).toBe(36);
  });
});

describe("assessDigitalMaturity", () => {
  it("is zero when no stack is detected", () => {
    expect(assessDigitalMaturity([])).toBe(0);
  });

  it("scores a single framework deterministically", () => {
    // base 20 + breadth 1*5 + framework 6 = 31
    const tech: DetectedTech[] = [{ name: "React", category: "framework" }];
    expect(assessDigitalMaturity(tech)).toBe(31);
  });

  it("rewards a broad, investment-signalling stack", () => {
    const tech: DetectedTech[] = [
      { name: "Google Analytics", category: "analytics" },
      { name: "HubSpot", category: "marketing" },
      { name: "Intercom", category: "chat" },
      { name: "Shopify", category: "ecommerce" },
      { name: "React", category: "framework" },
    ];
    // 20 + 5*5 + 14 + 14 + 8 + 8 + 6 = 95
    expect(assessDigitalMaturity(tech)).toBe(95);
  });

  it("never exceeds 100", () => {
    const tech: DetectedTech[] = Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`,
      category: "analytics" as const,
    }));
    expect(assessDigitalMaturity(tech)).toBeLessThanOrEqual(100);
  });
});
