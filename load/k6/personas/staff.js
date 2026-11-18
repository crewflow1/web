// load/k6/personas/staff.js — a field operative on a phone.
//
// The largest population. Opens "My day", opens an assigned job, clocks in and
// out (the product has no separate "submit timesheet" step — the timesheet IS
// the clock entries, so clock-out is the submission and the weekly timesheet is
// a read), signs RAMS, uploads site photos.
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, PHOTO_KB } from "../lib/config.js";
import { actionResult, callAction } from "../lib/actions.js";
import { apiGet, businessErrors, links, page, pick, prefetch, think, uploadBytes, weighted, writesOk, writesUnknown } from "../lib/http.js";

const NAV = ["/me", "/jobs", "/health-safety", "/notifications", "/toolbox", "/documents"];

function myDay(ctx) {
  const res = page(ctx, "/me", "page:/me");
  ctx.state.jobs = links(res.body, "/jobs");
  // The page renders EITHER the clock-in form OR the clock-out form — the
  // server is the source of truth for whether this user has an open entry.
  if (typeof res.body === "string" && ctx.actions.clockIn) {
    ctx.state.clockedIn = res.body.indexOf(ctx.actions.clockIn) === -1;
  }
  prefetch(ctx, NAV);
  think(4, 15);
  return res;
}

function openAssignedJob(ctx) {
  if (!ctx.state.jobs || ctx.state.jobs.length === 0) {
    const list = page(ctx, "/jobs", "page:/jobs", { rsc: true });
    ctx.state.jobs = links(list.body, "/jobs");
    think(2, 6);
  }
  if (ctx.state.jobs.length === 0) return myDay(ctx);
  const id = pick(ctx.state.jobs);
  page(ctx, `/jobs/${id}`, "page:/jobs/[id]", { rsc: true });
  apiGet(ctx, `/api/jobs/${id}/photos`, "api:GET /api/jobs/[id]/photos");
  think(8, 30);
}

function clockCycle(ctx) {
  if (!ctx.actions.clockIn || !ctx.actions.clockOut) return myDay(ctx);
  if (ctx.state.clockedIn === undefined) myDay(ctx);
  if (!ctx.state.clockedIn) {
    const jobId = ctx.state.jobs && ctx.state.jobs.length ? pick(ctx.state.jobs) : "";
    const res = callAction("/me", ctx.actions.clockIn, [], { job_id: jobId, note: `run:${ctx.runId}`, gps_lat: "54.5973", gps_lng: "-5.9301" }, "action:clockIn");
    const r = actionResult(res);
    const ok = res.status === 303 && r.redirect === "/me?saved=clocked_in";
    const already = r.redirect === "/me?error=already_clocked_in";
    check(res, { "clockIn accepted": () => ok || already });
    if (ok) writesOk.add(1, { write: "clock_in" });
    else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "clock_in" });
    businessErrors.add(!ok && !already, { name: "action:clockIn" });
    if (ok || already) ctx.state.clockedIn = true;
  } else {
    const res = callAction("/me", ctx.actions.clockOut, [], {}, "action:clockOut");
    const r = actionResult(res);
    const ok = res.status === 303 && r.redirect === "/me?saved=clocked_out";
    const notIn = r.redirect === "/me?error=not_clocked_in";
    check(res, { "clockOut accepted": () => ok || notIn });
    if (ok) writesOk.add(1, { write: "clock_out" });
    else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "clock_out" });
    businessErrors.add(!ok && !notIn, { name: "action:clockOut" });
    if (ok || notIn) ctx.state.clockedIn = false;
  }
  // the client follows the action redirect back to /me
  page(ctx, "/me", "page:/me", { rsc: true });
  think(3, 10);
}

function ramsSignOff(ctx) {
  if (!ctx.actions.ackSafety) return myDay(ctx);
  const list = page(ctx, "/health-safety", "page:/health-safety", { rsc: true });
  const ids = links(list.body, "/health-safety");
  think(3, 8);
  if (ids.length === 0) return; // staff see only RAMS for their assigned jobs
  const id = pick(ids);
  const detail = page(ctx, `/health-safety/${id}`, "page:/health-safety/[id]", { rsc: true });
  // The sign-off panel carries the issued reference the acknowledgement must anchor to.
  const flat = typeof detail.body === "string" ? detail.body.replace(/\\/g, "") : "";
  const m = /"name":"subjectVersion","value":"([^"]+)"/.exec(flat) || /name="subjectVersion"[^>]*value="([^"]+)"/.exec(flat);
  think(15, 60); // reading the method statement
  if (!m) return; // already superseded / not signable
  const res = callAction(
    `/health-safety/${id}`,
    ctx.actions.ackSafety,
    [],
    { subjectType: "risk_assessment", subjectId: id, subjectVersion: m[1], signedName: `Load Operative ${ctx.runId}`, signatureDataUrl: "" },
    "action:acknowledgeSafetyDocument",
  );
  const r = actionResult(res);
  const ok = res.status === 303 && r.redirect === `/health-safety/${id}?saved=acknowledged`;
  check(res, { "RAMS sign-off accepted": () => ok });
  if (ok) writesOk.add(1, { write: "rams_ack" }); // idempotent: a re-sign of the same version is also "ok"
  else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "rams_ack" });
  businessErrors.add(!ok, { name: "action:acknowledgeSafetyDocument" });
  think(2, 6);
}

// A real, decodable 16x16 JPEG (generated with sharp) followed by padding up to PHOTO_KB.
// The release re-encodes every upload to strip metadata (lib/uploads/strip-image-metadata.ts),
// so the bytes must decode; trailing bytes after the EOI marker are ignored by the decoder.
const JPEG_HEAD = [255,216,255,219,0,67,0,6,4,5,6,5,4,6,6,5,6,7,7,6,8,10,16,10,10,9,9,10,20,14,15,12,16,23,20,24,24,23,20,22,22,26,29,37,31,26,27,35,28,22,22,32,44,32,35,38,39,41,42,41,25,31,45,48,45,40,48,37,40,41,40,255,219,0,67,1,7,7,7,10,8,10,19,10,10,19,40,26,22,26,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,255,192,0,17,8,0,16,0,16,3,1,34,0,2,17,1,3,17,1,255,196,0,20,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,196,0,20,16,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,196,0,21,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,4,255,196,0,20,17,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,218,0,12,3,1,0,2,17,3,17,0,63,0,0,160,15,255,217];
function photoBytes() {
  const buf = new Uint8Array(Math.max(JPEG_HEAD.length, PHOTO_KB * 1024));
  buf.set(JPEG_HEAD, 0);
  return buf.buffer;
}

function photoUpload(ctx) {
  if (!ctx.state.jobs || ctx.state.jobs.length === 0) myDay(ctx);
  if (!ctx.state.jobs || ctx.state.jobs.length === 0) return;
  const id = pick(ctx.state.jobs);
  ctx.state.photoSeq = (ctx.state.photoSeq || 0) + 1;
  // Unique filename per (run, VU, sequence): the server keys objects as
  // `<org>/<job>/<Date.now()>-<filename>` with upsert:false.
  const filename = `lt-${ctx.runId}-v${ctx.vu}-${ctx.state.photoSeq}.jpg`;
  const data = photoBytes();
  const res = http.post(
    `${BASE_URL}/api/jobs/${id}/photos`,
    { photos: http.file(data, filename, "image/jpeg") },
    { headers: { Origin: BASE_URL, Accept: "application/json" }, redirects: 0, tags: { name: "api:POST /api/jobs/[id]/photos", kind: "upload" } },
  );
  const ok = res.status === 201;
  check(res, { "photo upload 201": () => ok });
  if (ok) {
    writesOk.add(1, { write: "photo" });
    uploadBytes.add(data.byteLength);
  } else if (res.status >= 500 || res.status === 0) writesUnknown.add(1, { write: "photo" });
  businessErrors.add(!ok, { name: "api:POST /api/jobs/[id]/photos" });
  apiGet(ctx, `/api/jobs/${id}/photos`, "api:GET /api/jobs/[id]/photos");
  think(5, 15);
}

function timesheet(ctx) {
  page(ctx, `/staff/${ctx.identity.userId}/timesheet`, "page:/staff/[id]/timesheet", { rsc: true });
  think(6, 20);
}

function notifications(ctx) {
  page(ctx, "/notifications", "page:/notifications", { rsc: true });
  think(4, 12);
}

export function staff(ctx) {
  if (!ctx.state.landed) {
    ctx.state.landed = true;
    return myDay(ctx); // first paint after sign-in is a full document load
  }
  weighted([
    [28, myDay],
    [22, openAssignedJob],
    [16, clockCycle],
    [10, ramsSignOff],
    [10, photoUpload],
    [9, timesheet],
    [5, notifications],
  ])(ctx);
}
