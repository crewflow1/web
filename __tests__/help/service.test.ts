import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Help service execution tests — proves the fetch shape against a chainable
 * Supabase mock: active-only scoping, loud reads (a query error THROWS rather
 * than returning an empty list), and null-vs-throw discipline on single fetch.
 */

const h = vi.hoisted(() => {
  const cfg: {
    listData: unknown;
    listError: unknown;
    oneData: unknown;
    oneError: unknown;
    lastFilters: Array<[string, unknown]>;
  } = {
    listData: [],
    listError: null,
    oneData: null,
    oneError: null,
    lastFilters: [],
  };

  // A chainable query builder. select/eq/order return `this`; the builder is
  // awaitable (list path) and exposes maybeSingle (fetch path).
  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.order = chain;
    builder.eq = (col: string, val: unknown) => {
      cfg.lastFilters.push([col, val]);
      return builder;
    };
    builder.maybeSingle = () =>
      Promise.resolve({ data: cfg.oneData, error: cfg.oneError });
    // Thenable so `await supabase.from(...).select(...)...` resolves (list path).
    builder.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: cfg.listData, error: cfg.listError });
    return builder;
  }

  const supabase = {
    from: vi.fn(() => makeBuilder()),
  };

  return { cfg, supabase };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => h.supabase),
}));

import {
  listHelpArticles,
  getHelpArticleBySlug,
} from "@/server/services/help-service";

beforeEach(() => {
  h.cfg.listData = [];
  h.cfg.listError = null;
  h.cfg.oneData = null;
  h.cfg.oneError = null;
  h.cfg.lastFilters = [];
});

describe("listHelpArticles", () => {
  it("returns mapped articles and scopes to active=true", async () => {
    h.cfg.listData = [
      {
        id: "1",
        slug: "creating-a-quote",
        title: "Creating a quote",
        category: "quotes",
        summary: "Build a quote.",
        body: "# Body",
        keywords: ["estimate"],
        sort_order: 10,
      },
    ];
    const rows = await listHelpArticles();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("creating-a-quote");
    expect(rows[0]?.keywords).toEqual(["estimate"]);
    expect(h.cfg.lastFilters).toContainEqual(["active", true]);
  });

  it("defaults null summary/keywords/sort_order to safe values", async () => {
    h.cfg.listData = [
      {
        id: "1",
        slug: "x",
        title: "X",
        category: "quotes",
        summary: null,
        body: "b",
        keywords: null,
        sort_order: null,
      },
    ];
    const [row] = await listHelpArticles();
    expect(row?.summary).toBe("");
    expect(row?.keywords).toEqual([]);
    expect(row?.sort_order).toBe(100);
  });

  it("THROWS on a query error (loud read, not an empty list)", async () => {
    h.cfg.listError = { code: "PGRST", message: "boom" };
    await expect(listHelpArticles()).rejects.toThrow(/help_articles list read failed/);
  });
});

describe("getHelpArticleBySlug", () => {
  it("returns the mapped article when found, scoped by slug + active", async () => {
    h.cfg.oneData = {
      id: "1",
      slug: "inviting-your-team",
      title: "Inviting your team",
      category: "team",
      summary: "Add crew.",
      body: "b",
      keywords: [],
      sort_order: 10,
    };
    const row = await getHelpArticleBySlug("inviting-your-team");
    expect(row?.slug).toBe("inviting-your-team");
    expect(h.cfg.lastFilters).toContainEqual(["active", true]);
    expect(h.cfg.lastFilters).toContainEqual(["slug", "inviting-your-team"]);
  });

  it("returns null for no matching row (not an error)", async () => {
    h.cfg.oneData = null;
    expect(await getHelpArticleBySlug("nope")).toBeNull();
  });

  it("THROWS on a genuine query error", async () => {
    h.cfg.oneError = { code: "PGRST", message: "boom" };
    await expect(getHelpArticleBySlug("x")).rejects.toThrow(/help_article fetch read failed/);
  });
});
