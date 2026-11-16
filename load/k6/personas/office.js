// load/k6/personas/office.js — an office administrator.
//
// The write-heavy persona: prices quotes, turns accepted quotes into jobs +
// invoices, moves the schedule, builds the rota, creates jobs.
import { check } from "k6";
import { actionResult, callAction } from "../lib/actions.js";
import { ltId, userId } from "../lib/data.js";
import { apiGet, apiJson, businessErrors, links, page, pick, prefetch, think, weighted, writesOk, writesUnknown } from "../lib/http.js";

const NAV = ["/jobs", "/quotes", "/invoices", "/customers", "/leads", "/staff/rota", "/jobs/calendar"];
const WORK = ["Kitchen extension", "Flat roof replacement", "Rewire", "Bathroom refit", "Groundworks", "External render", "Loft conversion"];

const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => iso(new Date(Date.now() + n * 86400000));
const rnd = (n) => 1 + Math.floor(Math.random() * n);

function recordWrite(res, ok, kind, name) {
  if (ok) writesOk.add(1, { write: kind });
  else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: kind });
  businessErrors.add(!ok, { name });
}

function createQuote(ctx) {
  if (!ctx.actions.createQuote) return browse(ctx);
  page(ctx, "/quotes/new", "page:/quotes/new", { rsc: true });
  think(20, 75); // pricing a quote takes a while
  const lines = [];
  for (let i = 0, n = 2 + Math.floor(Math.random() * 4); i < n; i++) {
    lines.push({ description: `${pick(WORK)} — line ${i + 1}`, qty: rnd(20), unit: pick(["ea", "m", "m2", "hr", "day"]), unit_price: 20 + rnd(480), vat_rate: 20 });
  }
  const res = callAction(
    "/quotes/new",
    ctx.actions.createQuote,
    [null],
    {
      customer_id: ltId("customer", ctx.org.idx, rnd(ctx.org.customers)),
      property_id: "",
      lead_id: "",
      valid_until: daysFromNow(30),
      notes: `Load-test quote ${ctx.marker} run:${ctx.runId}`,
      terms: "",
      line_items: JSON.stringify(lines),
    },
    "action:createQuote",
  );
  const r = actionResult(res);
  const m = r.redirectTo ? /^\/quotes\/([0-9a-f-]{36})$/.exec(r.redirectTo) : null;
  const ok = res.status === 200 && r.ok === true && !!m;
  check(res, { "quote created": () => ok });
  recordWrite(res, ok, "quote", "action:createQuote");
  if (!ok) return null;
  page(ctx, `/quotes/${m[1]}`, "page:/quotes/[id]", { rsc: true });
  think(5, 15);
  return m[1];
}

/** Quote → accepted → job + invoice auto-created: the product's core money loop. */
function quoteToInvoice(ctx) {
  if (!ctx.actions.acceptQuote) return browse(ctx);
  const quoteId = createQuote(ctx);
  if (!quoteId) return;
  const res = callAction(`/quotes/${quoteId}`, ctx.actions.acceptQuote, [quoteId], { signer_name: `Load run:${ctx.runId}` }, "action:acceptQuoteAsOwner");
  const r = actionResult(res);
  const ok = res.status === 303 && r.redirect === `/quotes/${quoteId}?saved=accepted`;
  check(res, { "quote accepted (job + invoice created)": () => ok });
  recordWrite(res, ok, "quote_accept", "action:acceptQuoteAsOwner");
  page(ctx, "/invoices", "page:/invoices", { rsc: true });
  think(6, 20);
}

/** POST /api/invoices from the seeded pool of accepted-but-uninvoiced quotes. */
function invoiceFromQuote(ctx) {
  ctx.state.poolUsed = ctx.state.poolUsed || 0;
  // Each office user owns a disjoint slice of its org's pool (by admin ordinal).
  const slot = ctx.org.quotes - ctx.org.invoiceable + 1 + (ctx.identity.n - 1) + ctx.state.poolUsed * ctx.org.admins;
  if (slot > ctx.org.quotes) return quoteToInvoice(ctx); // pool exhausted → use the accept path
  ctx.state.poolUsed++;
  page(ctx, "/invoices/new", "page:/invoices/new", { rsc: true });
  think(5, 15);
  const res = apiJson(ctx, "POST", "/api/invoices", { quote_id: ltId("quote", ctx.org.idx, slot) }, "api:POST /api/invoices");
  const ok = res.status === 201;
  check(res, { "invoice created 201": () => ok });
  recordWrite(res, ok, "invoice_api", "api:POST /api/invoices");
  if (ok) {
    const id = res.json("id");
    if (id) page(ctx, `/invoices/${id}`, "page:/invoices/[id]", { rsc: true });
  }
  think(6, 20);
}

function scheduleChange(ctx) {
  page(ctx, "/jobs/calendar", "page:/jobs/calendar", { rsc: true });
  const res = apiGet(ctx, `/api/schedule?from=${daysFromNow(-7)}&to=${daysFromNow(35)}`, "api:GET /api/schedule");
  let rows = [];
  try {
    rows = res.json("data") || [];
  } catch (e) {
    rows = [];
  }
  think(5, 20);
  const movable = rows.filter((j) => !j.is_recurring_occurrence);
  if (movable.length === 0) return;
  const job = pick(movable);
  const put = apiJson(ctx, "PUT", `/api/schedule/${job.id}`, { scheduled_date: daysFromNow(rnd(30)) }, "api:PUT /api/schedule/[id]");
  const ok = put.status === 200;
  check(put, { "job rescheduled": () => ok });
  recordWrite(put, ok, "reschedule", "api:PUT /api/schedule/[id]");
  think(3, 10);
}

function rotaCreate(ctx) {
  if (!ctx.actions.createRota) return browse(ctx);
  page(ctx, "/staff/rota", "page:/staff/rota", { rsc: true });
  think(8, 25);
  // A slot nobody else can hold: staff member × a far-future day unique to (VU, sequence).
  ctx.state.rotaSeq = (ctx.state.rotaSeq || 0) + 1;
  const day = iso(new Date(Date.UTC(2031, 0, 1) + ((ctx.vu * 997 + ctx.state.rotaSeq) % 3000) * 86400000));
  const res = callAction(
    "/staff/rota",
    ctx.actions.createRota,
    [null],
    { user_id: userId(ctx.org.idx, "staff", rnd(ctx.org.staff)), starts_at: `${day}T08:00`, ends_at: `${day}T16:30`, job_id: "", notes: `run:${ctx.runId}` },
    "action:createRotaEntry",
  );
  const r = actionResult(res);
  const conflict = r.ok === false && r.error && r.error.indexOf("Conflict") === 0;
  const ok = res.status === 200 && r.ok === true;
  check(res, { "shift added": () => ok || conflict });
  if (ok) writesOk.add(1, { write: "rota" });
  else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "rota" });
  businessErrors.add(!ok && !conflict, { name: "action:createRotaEntry" });
  think(3, 10);
}

function createJob(ctx) {
  if (!ctx.actions.createJob) return browse(ctx);
  page(ctx, "/jobs/new", "page:/jobs/new", { rsc: true });
  think(15, 45);
  const res = callAction(
    "/jobs/new",
    ctx.actions.createJob,
    [null],
    {
      customer_id: ltId("customer", ctx.org.idx, rnd(ctx.org.customers)),
      assigned_to: userId(ctx.org.idx, "staff", rnd(ctx.org.staff)),
      status: "new",
      scheduled_date: daysFromNow(rnd(40)),
      scheduled_end_date: "",
      template_id: "",
      notes: `${pick(WORK)} ${ctx.marker} run:${ctx.runId}`,
      recurring_pattern: "",
      recurring_end_date: "",
    },
    "action:createJob",
  );
  const r = actionResult(res);
  const ok = res.status === 200 && r.ok === true;
  check(res, { "job created": () => ok });
  recordWrite(res, ok, "job", "action:createJob");
  think(4, 12);
}

function browse(ctx) {
  const path = pick(["/customers", "/leads", "/invoices", "/quotes", "/jobs"]);
  const res = page(ctx, path, `page:${path}`, { rsc: ctx.state.landed });
  ctx.state.landed = true;
  prefetch(ctx, NAV);
  const ids = links(res.body, path);
  think(5, 20);
  if (ids.length > 0 && Math.random() < 0.5) {
    page(ctx, `${path}/${pick(ids)}`, `page:${path}/[id]`, { rsc: true });
    think(8, 25);
  }
}

function customerSearch(ctx) {
  apiGet(ctx, `/api/customers/search?q=${pick(["har", "oka", "dev", "ltd", "mc", "ash"])}`, "api:GET /api/customers/search");
  think(2, 8);
}

export function office(ctx) {
  if (!ctx.state.landed) return browse(ctx);
  weighted([
    [18, createQuote],
    [10, quoteToInvoice],
    [8, invoiceFromQuote],
    [18, scheduleChange],
    [10, rotaCreate],
    [8, createJob],
    [20, browse],
    [8, customerSearch],
  ])(ctx);
}
