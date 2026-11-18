#!/usr/bin/env node
/**
 * scripts/load/cost-model.mjs — the arithmetic behind docs/engineering/LOAD-TEST-APPROVAL-REQUEST.md.
 * Pure calculation (no network, no secrets). Every unit price below is copied from the vendor's own
 * pricing page (URL + retrieval date in the approval request §4); change a constant, re-run, re-paste.
 *
 *   node scripts/load/cost-model.mjs            # plain-text lines
 *   node scripts/load/cost-model.mjs --json
 */

// ── unit prices (USD unless stated) — retrieved 2026-11-16 ───────────────────
export const P = {
  eurUsd: 1.2, // ASSUMPTION (conservative; an exchange rate is not a vendor price) — re-convert at the day's rate
  supa: {
    // https://supabase.com/docs/guides/platform/compute-and-disk  (hourly)
    hour: { micro: 0.01344, large: 0.1517, xl: 0.2877, "2xl": 0.562, "4xl": 1.32, "8xl": 2.562, "16xl": 5.12 },
    proBase: 25, // https://supabase.com/pricing  ($25/month, includes a $10 compute credit)
    computeCredit: 10,
    diskGbHour: 0.000171, // https://supabase.com/docs/guides/platform/manage-your-usage/disk-size  (gp3, 8 GB included)
    diskIncludedGb: 8,
    egressGb: 0.09, // https://supabase.com/docs/guides/platform/manage-your-usage/egress  (250 GB included)
    egressIncludedGb: 250,
    iopsMonth: 0.024, // https://supabase.com/pricing  (3,000 IOPS included)
    mbpsMonth: 0.095, // 125 MB/s included
    storageGbMonth: 0.0213, // 100 GB included
  },
  vercel: {
    // https://vercel.com/docs/pricing/regional-pricing/dub1  (Pro, on-demand)
    activeCpuHour: 0.168,
    memGbHour: 0.0139,
    cdnReqPerM: 2.4,
    fdtGb: 0.15, // Fast Data Transfer
    fotGb: 0.06, // Fast Origin Transfer
    cdnCpuHour: 0.36, // CDN Requests - Additional CPU Duration
    invocationPerM: 0.6, // https://vercel.com/docs/functions/usage-and-pricing
    platformFee: 20, // https://vercel.com/docs/plans/pro-plan  ($20/mo incl. $20 usage credit)
    credit: 20,
  },
  hetzner: { ccx33Hour: 0.1891 }, // EUR, https://www.hetzner.com/cloud/general-purpose  (8 vCPU / 32 GB dedicated, HEL1, 30 TB traffic incl.)
  grafanaVuh: 0.15, // https://grafana.com/pricing/  (Cloud k6 Pro, "starts at")
};

// ── the ladder (sessions, VU-hours from the plan §6; req/session/min measured locally) ──
export const REQ_PER_SESSION_MIN = 9.4;
export const GATES = [
  { id: "G1", sessions: 100, vuh: 22, gen: 1 },
  { id: "G2", sessions: 500, vuh: 163, gen: 1 },
  { id: "G3", sessions: 1000, vuh: 377, gen: 1 },
  { id: "G4", sessions: 5000, vuh: 3150, gen: 1 },
  { id: "G5", sessions: 10000, vuh: 7150, gen: 2 },
  { id: "G6", sessions: 25000, vuh: 19917, gen: 5 },
  { id: "G7", sessions: 50000, vuh: 63167, gen: 10 },
];
const sum = (a, f) => a.reduce((x, g) => x + f(g), 0);
const r2 = (n) => Math.round(n * 100) / 100;

export const SCENARIOS = {
  expected: {
    label: "Expected",
    runMultiplier: 1, // every gate passes first time
    windowH: 4, // paid compute window per gate (resize, warm-up, run, verify)
    g7Windows: 1,
    projectLifeH: 144, // 6 calendar days
    diskGb: 25,
    reqKbSupabaseEgress: 25, // KB per app request leaving Supabase (10.5 calls x ~2.4 KB) — ASSUMPTION, calibrate at G2/G3
    respKbVisitor: 10.4, // measured: k6 data_received / http_reqs, local baseline
    reqKbUpOrigin: 2.8, // measured non-upload request bytes
    uploadGb: 207, // 14.7 photo uploads / VU-hour x 150 KB x VU-hours
    cpuMs: 50, // active CPU per request (laptop: 76 % of 1 core at 15.7 RPS = 48 ms)
    latS: 0.3, memGb: 2, concurrencyPerInstance: 8,
    mwCpuMsOver10: 0,
    genHoursMult: 1, g7Gens: 10,
    diskPerfWindows: 3, // G5..G7 windows carry the provisioned IOPS/throughput add-on
  },
  worst: {
    label: "Worst case",
    runMultiplier: 2, // every gate re-run once after a fix (+ crons-during-peak / 4 MB-photo variants)
    windowH: 8,
    g7Windows: 3,
    projectLifeH: 336, // 14 days
    diskGb: 50,
    reqKbSupabaseEgress: 50,
    respKbVisitor: 20,
    reqKbUpOrigin: 5,
    uploadGb: 828, // 2x runs and a 2x photo-size variant
    cpuMs: 100,
    latS: 0.6, memGb: 2, concurrencyPerInstance: 4,
    mwCpuMsOver10: 10,
    genHoursMult: 2, g7Gens: 15,
    diskPerfWindows: 7,
  },
};

export function compute(sc, ids = GATES.map((g) => g.id)) {
  const S = P.supa, V = P.vercel;
  const GS = GATES.filter((g) => ids.includes(g.id));
  const has = (...x) => x.some((i) => ids.includes(i));
  const requests = sum(GS, (g) => g.vuh) * REQ_PER_SESSION_MIN * 60 * sc.runMultiplier;
  const requestsM = requests / 1e6;

  // Supabase compute: one window per gate at its tier (G1-G3 share one Large window), seed on XL, rest Micro.
  const windows = [
    { tier: "xl", h: 4 },
    { tier: "large", h: has("G1", "G2", "G3") ? sc.windowH : 0 },
    { tier: "2xl", h: has("G4") ? sc.windowH : 0 },
    { tier: "4xl", h: has("G5") ? sc.windowH : 0 },
    { tier: "8xl", h: has("G6") ? sc.windowH : 0 },
    { tier: "16xl", h: has("G7") ? 4 * sc.g7Windows : 0 },
  ];
  const upsizedH = sum(windows, (w) => w.h);
  const microH = Math.max(0, sc.projectLifeH - upsizedH);
  const computeUsd = sum(windows, (w) => w.h * S.hour[w.tier]) + microH * S.hour.micro;
  const diskUsd = Math.max(0, sc.diskGb - S.diskIncludedGb) * S.diskGbHour * sc.projectLifeH;
  const perfH = (sc.diskPerfWindows * 4 * (has("G5", "G6", "G7") ? ids.filter((i) => ["G5", "G6", "G7"].includes(i)).length / 3 : 0));
  const perfUsd = (((16000 - 3000) * S.iopsMonth + (1000 - 125) * S.mbpsMonth) / 730) * perfH;
  const egressGb = (requests * sc.reqKbSupabaseEgress) / 1e6;
  const egressUsd = Math.max(0, egressGb - S.egressIncludedGb) * S.egressGb;
  const storageUsd = Math.max(0, sc.uploadGb - 100) * S.storageGbMonth;
  const supa = {
    "Pro org base (separate org; $10 compute credit applied)": S.proBase - S.computeCredit,
    "Compute (hourly, by tier)": computeUsd,
    "Disk (GB-hours above 8 GB)": diskUsd,
    "Disk IOPS/throughput add-on (assumed 16k IOPS + 1,000 MB/s in heavy windows)": perfUsd,
    "Egress (above 250 GB)": egressUsd,
    "Storage (photo uploads, above 100 GB)": storageUsd,
  };

  // Vercel (separate Pro team; on-demand at dub1 rates)
  const cpuH = (requests * sc.cpuMs) / 1000 / 3600;
  const memGbH = (requests * sc.latS * sc.memGb) / sc.concurrencyPerInstance / 3600;
  const fdtGb = (requests * sc.respKbVisitor) / 1e6;
  const fotGb = fdtGb + (requests * sc.reqKbUpOrigin) / 1e6 + sc.uploadGb;
  const vercel = {
    "Pro team platform fee (includes $20 credit, shown net)": V.platformFee - V.credit,
    "Active CPU": cpuH * V.activeCpuHour,
    "Provisioned memory": memGbH * V.memGbHour,
    "Function invocations": requestsM * V.invocationPerM,
    "CDN requests": requestsM * V.cdnReqPerM,
    "Fast Data Transfer (to load generators)": fdtGb * V.fdtGb,
    "Fast Origin Transfer": fotGb * V.fotGb,
    "CDN request CPU above 10 ms (middleware)": ((requests * sc.mwCpuMsOver10) / 1000 / 3600) * V.cdnCpuHour,
  };

  // Load generators: Hetzner CCX33, ~5,000 VUs each; k6 itself is free.
  const vmH = sum(GS, (g) => (g.id === "G7" ? sc.g7Gens : g.gen) * 4) * sc.genHoursMult;
  const gens = {
    "k6 generators, Hetzner CCX33 (VM-hours x EUR 0.1891 x FX)": vmH * P.hetzner.ccx33Hour * P.eurUsd,
    "IPv4 + snapshots/volumes allowance": 5,
  };

  const tot = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    scenario: sc.label, requestsM: r2(requestsM), vmHours: vmH, upsizedComputeH: upsizedH, microH,
    egressGb: Math.round(egressGb), fdtGb: Math.round(fdtGb), cpuHours: Math.round(cpuH),
    supa: map2(supa), vercel: map2(vercel), gens: map2(gens),
    totals: { supabase: r2(tot(supa)), vercel: r2(tot(vercel)), generators: r2(tot(gens)), all: r2(tot(supa) + tot(vercel) + tot(gens)) },
  };
}
const map2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));

// Fallback F: self-host the Next.js tier on Hetzner (Vercel's policy does not permit Pro-plan load tests, request §3).
export function fallbackSelfHost(sc) {
  let vmH = 0;
  const rows = GATES.map((g) => {
    const rps = (g.sessions * REQ_PER_SESSION_MIN) / 60;
    const vms = Math.max(1, Math.ceil((rps * (sc.cpuMs / 1000)) / (8 * 0.6)));
    vmH += vms * 4 * sc.genHoursMult;
    return { gate: g.id, rps: Math.round(rps), appVms: vms };
  });
  return { rows, vmHours: vmH, usd: r2(vmH * P.hetzner.ccx33Hour * P.eurUsd) };
}

export function grafanaCloud(sc) {
  const vuh = sum(GATES, (g) => g.vuh) * sc.runMultiplier;
  return { vuh, usd: Math.round(vuh * P.grafanaVuh) };
}

if (process.argv[1] && process.argv[1].endsWith("cost-model.mjs")) {
  if (process.argv.includes("--tranches")) {
    for (const [k, sc] of Object.entries(SCENARIOS))
      for (const ids of [["G1", "G2", "G3", "G4", "G5"], ["G6"], ["G7"]]) {
        const r = compute(sc, ids);
        console.log(k, ids.join("+"), r.requestsM, "M req", JSON.stringify(r.totals));
      }
    process.exit(0);
  }
  const out = Object.fromEntries(Object.entries(SCENARIOS).map(([k, sc]) => [k, { ...compute(sc), selfHostFallback: fallbackSelfHost(sc), grafana: grafanaCloud(sc) }]));
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of Object.values(out)) {
      console.log(`\n### ${r.scenario}: ${r.requestsM} M app requests, ${r.egressGb} GB Supabase egress, ${r.cpuHours} active-CPU hours, ${r.vmHours} generator VM-hours`);
      for (const [name, o] of [["Supabase", r.supa], ["Vercel", r.vercel], ["Generators", r.gens]])
        for (const [k, v] of Object.entries(o)) console.log(`| ${name} | ${k} | $${v.toFixed(2)} |`);
      console.log("TOTALS", JSON.stringify(r.totals));
      console.log("fallback self-host app tier", JSON.stringify(r.selfHostFallback));
      console.log("grafana cloud k6", JSON.stringify(r.grafana));
    }
  }
}
