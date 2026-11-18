// load/k6/personas/public.js — an unauthenticated prospect.
//
// Lands on the marketing site, then on a tenant's public enquiry page
// (/l/<slug>), and occasionally submits an enquiry (POST /api/public/lead —
// creates a lead in that tenant, IP rate-limited at 5 / 10 min, so most
// submissions from one load generator are expected 429s: measured, not failed).
// Isolation: the persona adopts the visited tenant's marker, so any OTHER
// tenant's marker in the enquiry page is a cross-tenant leak.
import { check } from "k6";
import { orgs } from "../lib/data.js";
import { apiJson, businessErrors, page, pick, think, weighted, writesOk, writesUnknown } from "../lib/http.js";

const MARKETING = ["/", "/pricing", "/features", "/construction-software"];
const SERVICES = ["Roof repair", "Kitchen extension", "Rewire", "Bathroom refit", "Driveway"];

function marketing() {
  const path = pick(MARKETING);
  page({ marker: null }, path, `page:${path}`, { authed: false });
  think(8, 40);
}

function enquiryPage(ctx) {
  ctx.org = pick(orgs);
  ctx.marker = ctx.org.marker;
  const res = page(ctx, `/l/${ctx.org.slug}`, "page:/l/[slug]", { authed: false });
  check(res, { "enquiry page names the tenant": (r) => typeof r.body === "string" && r.body.indexOf(`#${ctx.org.idx}]`) !== -1 });
  think(10, 45);
}

function submitEnquiry(ctx) {
  if (!ctx.org) enquiryPage(ctx);
  ctx.state.seq = (ctx.state.seq || 0) + 1;
  const res = apiJson(
    ctx,
    "POST",
    "/api/public/lead",
    {
      orgSlug: ctx.org.slug,
      name: `Load Prospect ${ctx.vu}-${ctx.state.seq}`,
      email: `lt-prospect-v${ctx.vu}-${ctx.state.seq}@loadtest.crewflow.invalid`,
      phone: "",
      service: pick(SERVICES),
      postcode: "ZZ1 1ZZ",
      message: `Synthetic load-test enquiry ${ctx.org.marker} run:${ctx.runId}`,
      consent: true,
      website: "",
    },
    "api:POST /api/public/lead",
    { authed: false },
  );
  const ok = res.status === 200 || res.status === 201;
  const limited = res.status === 429;
  check(res, { "enquiry accepted or rate-limited": () => ok || limited });
  if (ok) writesOk.add(1, { write: "public_lead" });
  else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "public_lead" });
  businessErrors.add(!ok && !limited, { name: "api:POST /api/public/lead" });
  think(20, 60);
}

export function publicVisitor(ctx) {
  weighted([
    [45, marketing],
    [45, enquiryPage],
    [10, submitEnquiry],
  ])(ctx);
}
