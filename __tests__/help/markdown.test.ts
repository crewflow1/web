import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, safeHref } from "@/lib/help/markdown";

/**
 * XSS-safety + rendering contract for the help Markdown renderer.
 *
 * The renderer must NEVER emit executable markup or dangerous navigations from
 * article content. We render to static HTML and assert both the escaping
 * (no live tags) and the intended formatting (headings, lists, safe links).
 */

function html(markdown: string): string {
  return renderToStaticMarkup(renderMarkdown(markdown) as React.ReactElement);
}

describe("renderMarkdown — XSS safety", () => {
  it("escapes raw <script> in body to inert text, never a live tag", () => {
    const out = html("Hello <script>alert('xss')</script> world");
    expect(out).not.toContain("<script>");
    // The literal text survives, HTML-escaped.
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes an inline event-handler img/iframe to inert text (no live tag)", () => {
    const out = html('<img src=x onerror="alert(1)"> and <iframe></iframe>');
    // No LIVE tags — the source is escaped to text, so the brackets survive
    // only in entity form. onerror= may appear as literal text between escaped
    // brackets, which is inert; what matters is there is no real <img>/<iframe>.
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<iframe");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&lt;iframe");
  });

  it("drops a javascript: link, rendering only its label", () => {
    const out = html("[click me](javascript:alert(1))");
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out).not.toContain("href=");
    expect(out).toContain("click me");
  });

  it("drops a data: link", () => {
    const out = html("[x](data:text/html,<script>alert(1)</script>)");
    expect(out.toLowerCase()).not.toContain("data:text/html");
    expect(out).not.toContain("<script>");
  });
});

describe("renderMarkdown — formatting", () => {
  it("renders headings", () => {
    const out = html("# Title\n\n## Sub");
    expect(out).toContain("<h2");
    expect(out).toContain("Title");
    expect(out).toContain("<h3");
    expect(out).toContain("Sub");
  });

  it("renders unordered and ordered lists", () => {
    expect(html("- one\n- two")).toContain("<ul");
    expect(html("1. first\n2. second")).toContain("<ol");
  });

  it("renders bold and inline code", () => {
    const out = html("This is **bold** and `code`.");
    expect(out).toContain("<strong");
    expect(out).toContain("<code");
  });

  it("renders a safe https link with noopener and label", () => {
    const out = html("See [the site](https://example.com).");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain("the site");
  });

  it("renders an in-app link as a relative href", () => {
    const out = html("Go to [quotes](/quotes).");
    expect(out).toContain('href="/quotes"');
  });

  it("renders a fenced code block", () => {
    const out = html("```\nnpm install\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("npm install");
  });
});

describe("safeHref", () => {
  it("permits http, https, mailto, in-app and anchors", () => {
    expect(safeHref("https://a.com")).toBe("https://a.com");
    expect(safeHref("http://a.com")).toBe("http://a.com");
    expect(safeHref("mailto:x@y.com")).toBe("mailto:x@y.com");
    expect(safeHref("/help")).toBe("/help");
    expect(safeHref("#section")).toBe("#section");
  });

  it("rejects javascript:, data:, vbscript: and empty", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});
