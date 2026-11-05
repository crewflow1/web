import { describe, it, expect } from "vitest";
import { escapeHtml } from "@/lib/html";

/**
 * Unit tests for the canonical HTML escaper. This function replaced nine
 * byte-identical copies scattered across the email templates, review actions,
 * and the material-request / leave mailers, so these tests pin the exact
 * contract every former copy relied on.
 */
describe("escapeHtml", () => {
  it("escapes all five unsafe characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes the ampersand FIRST so introduced entities are not re-escaped", () => {
    // If `<` were escaped before `&`, the `&lt;` would become `&amp;lt;`.
    expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("neutralises a script-injection attempt", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("neutralises an attribute-breakout attempt (both quote kinds)", () => {
    expect(escapeHtml(`" onmouseover='alert(1)'`)).toBe(
      "&quot; onmouseover=&#39;alert(1)&#39;",
    );
  });

  it("leaves already-safe text untouched", () => {
    expect(escapeHtml("Acme Roofing Ltd — Invoice 1001")).toBe(
      "Acme Roofing Ltd — Invoice 1001",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });
});
