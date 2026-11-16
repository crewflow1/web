/**
 * scripts/load/trace-fetch.cjs — zero-code-change request tracer for `next start`.
 *
 *   LOAD_TRACE_FILE=/abs/path/trace.jsonl \
 *   NODE_OPTIONS="--require ./scripts/load/trace-fetch.cjs" PORT=3104 npm run start
 *
 * What it records (JSON lines):
 *   {"t":"in","rid":12,"method":"GET","path":"/dashboard","action":null,"status":200,"ms":84.1,
 *    "out":31,"outMs":212.4,"auth":2,"rest":28,"storage":1,"other":0}
 *   {"t":"out","rid":12,"kind":"rest","method":"GET","url":"/rest/v1/jobs?select=…","status":200,"ms":3.2}
 *
 * How: every inbound HTTP request is run inside an AsyncLocalStorage context, and
 * undici's diagnostics channels (published by Node's own fetch AND by the fetch
 * bundled into the middleware's edge sandbox) attribute each OUTBOUND call to
 * the inbound request that caused it. So "how many Supabase
 * round-trips does one page render / one server action make" is measured exactly,
 * per request, even under concurrency — the number that turns into latency once
 * the app server and the database are in different buildings.
 *
 * Safety: inert unless LOAD_TRACE_FILE is set. Records method, path + query
 * string and timing ONLY — never a header, never a body, never a cookie or key.
 * It is a diagnostic preload for local / staging harness runs; it is not imported
 * by the application and is never part of a production deployment.
 */
"use strict";

const file = process.env.LOAD_TRACE_FILE;
if (file) {
  const fs = require("node:fs");
  const http = require("node:http");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const { performance } = require("node:perf_hooks");

  const als = new AsyncLocalStorage();
  const out = fs.createWriteStream(file, { flags: "a" });
  const write = (o) => out.write(JSON.stringify(o) + "\n");
  let seq = 0;

  const kindOf = (pathname) =>
    pathname.startsWith("/auth/v1")
      ? "auth"
      : pathname.startsWith("/rest/v1")
        ? "rest"
        : pathname.startsWith("/storage/v1")
          ? "storage"
          : "other";

  // Outbound capture uses undici's diagnostics channels rather than wrapping
  // globalThis.fetch: Next's middleware runs in an edge sandbox with its OWN
  // bundled fetch (it never touches the Node global), but both copies of undici
  // publish to the same process-wide channels — so this sees the middleware's
  // auth round-trip as well as everything the Node runtime does.
  const dc = require("node:diagnostics_channel");
  const live = new WeakMap();
  dc.subscribe("undici:request:create", ({ request }) => {
    const ctx = als.getStore();
    if (!ctx || !request) return;
    live.set(request, { ctx, t0: performance.now(), status: 0 });
  });
  dc.subscribe("undici:request:headers", ({ request, response }) => {
    const e = live.get(request);
    if (e && response) e.status = response.statusCode;
  });
  const finish = (request, failed) => {
    const e = live.get(request);
    if (!e) return;
    live.delete(request);
    try {
      const ms = performance.now() - e.t0;
      const path = String(request.path || "");
      const q = path.indexOf("?");
      const kind = kindOf(q === -1 ? path : path.slice(0, q));
      e.ctx.out++;
      e.ctx.outMs += ms;
      e.ctx[kind]++;
      write({ t: "out", rid: e.ctx.rid, kind, method: String(request.method || "GET"), url: path, status: failed ? -1 : e.status, ms: Math.round(ms * 10) / 10 });
    } catch {
      /* never let tracing break a request */
    }
  };
  dc.subscribe("undici:request:trailers", ({ request }) => finish(request, false));
  dc.subscribe("undici:request:error", ({ request }) => finish(request, true));

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function tracedEmit(event, req, res) {
    if (event !== "request" || !req || !res) return origEmit.apply(this, arguments);
    const url = String(req.url || "");
    // Static assets are not interesting and would only bloat the trace.
    if (url.startsWith("/_next/static") || url.startsWith("/_next/image")) return origEmit.apply(this, arguments);
    const ctx = { rid: ++seq, out: 0, outMs: 0, auth: 0, rest: 0, storage: 0, other: 0 };
    const t0 = performance.now();
    const q = url.indexOf("?");
    const meta = {
      method: req.method,
      path: q === -1 ? url : url.slice(0, q),
      rsc: req.headers["rsc"] === "1",
      action: req.headers["next-action"] || null,
    };
    res.on("finish", () => {
      write({
        t: "in", rid: ctx.rid, ...meta, status: res.statusCode,
        ms: Math.round((performance.now() - t0) * 10) / 10,
        out: ctx.out, outMs: Math.round(ctx.outMs * 10) / 10,
        auth: ctx.auth, rest: ctx.rest, storage: ctx.storage, other: ctx.other,
      });
    });
    const args = arguments;
    return als.run(ctx, () => origEmit.apply(this, args));
  };
}
