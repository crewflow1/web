// load/k6/personas/owner.js — an owner / director.
//
// Read-heavy and the most expensive reads in the product: the dashboard (the
// post-login landing page) and reports fan out into dozens of database
// round-trips each. Owners mostly look; the write-heavy work is the office persona.
import { check } from "k6";
import { apiGet, links, page, pick, prefetch, think, weighted } from "../lib/http.js";

const NAV = ["/dashboard", "/jobs", "/quotes", "/invoices", "/customers", "/leads", "/staff", "/reports", "/cash", "/payroll"];
const TERMS = ["har", "oka", "roof", "ext", "mill", "ltd", "kit", "dev", "ash", "loft"];

function dashboard(ctx) {
  const res = page(ctx, "/dashboard", "page:/dashboard", { rsc: ctx.state.landed });
  check(res, { "dashboard shows own tenant": (r) => typeof r.body === "string" && r.body.indexOf(ctx.marker) !== -1 });
  ctx.state.landed = true;
  prefetch(ctx, NAV);
  think(10, 40);
}

function reports(ctx) {
  page(ctx, "/reports", "page:/reports", { rsc: true });
  think(3, 8);
  apiGet(ctx, "/api/reports", "api:GET /api/reports");
  think(10, 35);
}

function list(path) {
  return (ctx) => {
    const res = page(ctx, path, `page:${path}`, { rsc: true });
    ctx.state[path] = links(res.body, path);
    prefetch(ctx, ctx.state[path].slice(0, 6).map((id) => `${path}/${id}`));
    think(6, 25);
  };
}

function detail(path) {
  return (ctx) => {
    if (!ctx.state[path] || ctx.state[path].length === 0) list(path)(ctx);
    const ids = ctx.state[path] || [];
    if (ids.length === 0) return;
    page(ctx, `${path}/${pick(ids)}`, `page:${path}/[id]`, { rsc: true });
    think(8, 30);
  };
}

function search(ctx) {
  const res = apiGet(ctx, `/api/search?q=${pick(TERMS)}`, "api:GET /api/search");
  check(res, { "search json": (r) => r.status === 200 && typeof r.body === "string" && r.body.charAt(0) === "{" });
  think(3, 10);
}

export function owner(ctx) {
  if (!ctx.state.landed) return dashboard(ctx);
  weighted([
    [30, dashboard],
    [14, reports],
    [10, list("/jobs")],
    [8, detail("/jobs")],
    [8, list("/invoices")],
    [5, detail("/invoices")],
    [7, list("/customers")],
    [4, detail("/customers")],
    [5, list("/quotes")],
    [4, list("/staff")],
    [5, search],
  ])(ctx);
}
