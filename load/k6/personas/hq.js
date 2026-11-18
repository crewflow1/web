// load/k6/personas/hq.js — a CrewFlow HQ operator (super-admin console).
//
// Tiny population (2 per 1,000) but the most expensive reads: the console
// aggregates ACROSS tenants with the service role. Requires the seeded HQ
// emails in the app's CREWFLOW_SUPERADMIN_EMAILS (scripts/load/run-local.sh
// sets it for the local run; staging sets it in the staging project's env).
// HQ legitimately sees every tenant, so its responses are NOT marker-scanned
// (ctx.marker is null) — isolation is proven by the tenant personas.
import { check } from "k6";
import { page, pick, think } from "../lib/http.js";

const PAGES = ["/admin", "/admin/organizations", "/admin/health", "/admin/ops", "/admin/overview"];

export function hq(ctx) {
  const path = pick(PAGES);
  const res = page(ctx, path, `page:${path}`, { rsc: !!ctx.state.landed });
  ctx.state.landed = true;
  check(res, { "HQ console reachable (allowlisted)": (r) => r.status === 200 });
  think(15, 60);
}
