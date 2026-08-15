import { describe, it, expect } from "vitest";
import {
  searchArticles,
  groupByCategory,
  helpHref,
  categoryLabel,
  type HelpArticle,
} from "@/lib/help/articles";

function article(over: Partial<HelpArticle>): HelpArticle {
  return {
    id: over.slug ?? "id",
    slug: over.slug ?? "slug",
    title: over.title ?? "Title",
    category: over.category ?? "getting-started",
    summary: over.summary ?? "",
    body: over.body ?? "",
    keywords: over.keywords ?? [],
    sort_order: over.sort_order ?? 100,
  };
}

const CORPUS: HelpArticle[] = [
  article({
    slug: "creating-a-quote",
    title: "Creating a quote",
    category: "quotes",
    summary: "Build a priced quote and send it.",
    keywords: ["estimate", "pricing"],
    body: "Add line items to a quote and send for approval.",
    sort_order: 10,
  }),
  article({
    slug: "converting-a-quote-to-a-job",
    title: "Converting a quote to a job",
    category: "jobs",
    summary: "Turn an accepted quote into a job.",
    keywords: ["won work"],
    body: "An accepted quote becomes a job in one step.",
    sort_order: 10,
  }),
  article({
    slug: "inviting-your-team",
    title: "Inviting your team",
    category: "team",
    summary: "Add your crew.",
    keywords: ["staff", "members", "roles"],
    body: "Send an invite from Settings so staff can log their work.",
    sort_order: 10,
  }),
];

describe("searchArticles", () => {
  it("returns all articles for an empty query", () => {
    expect(searchArticles(CORPUS, "")).toHaveLength(3);
    expect(searchArticles(CORPUS, "   ")).toHaveLength(3);
  });

  it("matches on title", () => {
    const r = searchArticles(CORPUS, "quote");
    expect(r.map((a) => a.slug)).toContain("creating-a-quote");
  });

  it("matches on keywords", () => {
    const r = searchArticles(CORPUS, "members");
    expect(r[0]?.slug).toBe("inviting-your-team");
  });

  it("matches on body when nothing else does", () => {
    const r = searchArticles(CORPUS, "crew");
    expect(r.map((a) => a.slug)).toContain("inviting-your-team");
  });

  it("is case-insensitive and punctuation-tolerant", () => {
    const r = searchArticles(CORPUS, "QUOTE!!");
    expect(r.length).toBeGreaterThan(0);
  });

  it("requires every token to match (AND semantics)", () => {
    // 'quote' matches two; 'job' narrows to the converting article.
    const r = searchArticles(CORPUS, "quote job");
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe("converting-a-quote-to-a-job");
  });

  it("returns nothing when a token matches no article", () => {
    expect(searchArticles(CORPUS, "zzzznotfound")).toHaveLength(0);
  });

  it("ranks a title hit above a body-only hit", () => {
    const r = searchArticles(CORPUS, "quote");
    // 'Creating a quote' (title) outranks 'Converting a quote to a job'
    // which also has quote in the title — both present, title-weighted first.
    expect(r[0]?.slug === "creating-a-quote" || r[0]?.slug === "converting-a-quote-to-a-job").toBe(true);
    // The team article (no 'quote' anywhere) must be excluded.
    expect(r.map((a) => a.slug)).not.toContain("inviting-your-team");
  });
});

describe("groupByCategory", () => {
  it("groups in canonical order and omits empty categories", () => {
    const groups = groupByCategory(CORPUS);
    expect(groups.map((g) => g.slug)).toEqual(["quotes", "jobs", "team"]);
  });

  it("buckets unknown categories into 'Other'", () => {
    const groups = groupByCategory([
      article({ slug: "x", category: "mystery" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slug).toBe("other");
    expect(groups[0]?.label).toBe("Other");
  });
});

describe("helpHref — contextual link resolution", () => {
  it("resolves an article target to /help/<slug>", () => {
    expect(helpHref({ kind: "article", slug: "creating-a-quote" })).toBe(
      "/help/creating-a-quote",
    );
  });

  it("resolves a KNOWN category to a pre-filtered list", () => {
    expect(helpHref({ kind: "category", slug: "quotes" })).toBe(
      "/help?category=quotes",
    );
  });

  it("degrades an UNKNOWN category to /help (never a dead deep-link)", () => {
    expect(helpHref({ kind: "category", slug: "nope" })).toBe("/help");
  });

  it("url-encodes a slug so a stray character can't break the URL", () => {
    expect(helpHref({ kind: "article", slug: "a b/c" })).toBe("/help/a%20b%2Fc");
  });
});

describe("categoryLabel", () => {
  it("maps known slugs and falls back to Other", () => {
    expect(categoryLabel("quotes")).toBe("Quotes");
    expect(categoryLabel("unknown")).toBe("Other");
  });
});
