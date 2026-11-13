#!/usr/bin/env node
/**
 * Non-code asset register: every tracked binary/media/font/data asset + the `public/` tree,
 * enriched from git history (first commit, author, date, subject) and classified by rule.
 *
 * The VERDICT rules below encode what was verified by hand (see ASSET-REGISTER.md for the evidence);
 * anything that matches no rule falls through to UNKNOWN-PROVENANCE on purpose.
 *
 * Output: docs/compliance/asset-register.csv
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|heic|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|lottie|zip|xlsx?|xls[mb]|ods|csv|tsv|bmp|tiff?|glb|mjs|js)$/i;
const files = git("ls-files").split("\n").filter((f) => f.startsWith("public/") || (ASSET_EXT.test(f) && /^(app|components|lib|e2e|__tests__|docs|scripts|sdks|server)\//.test(f) && !/\.(ts|tsx)$/.test(f) && !/^(scripts|sdks|server|lib)\/.*\.m?js$/.test(f)))
  .filter((f) => !/\.DS_Store$/.test(f));

const RULES = [
  { re: /^public\/product-shots\//, type: "screenshot (PNG)", use: "marketing site (home hero, job-journey, product pages) via next/image", verdict: "OWNED/ORIGINAL", evidence: "Screenshots of CrewFlow's own UI rendered from the seeded demo org 'Brightwork Construction' (demo@brightwork.example, *.example e-mail domains). Content visually inspected 2026-11-13: no third-party logos/photos/real people. No Software/Make EXIF.", note: "Names/addresses/phone numbers are fictional-looking but use real-format UK postcodes and one phone number (+44 1274 555 0198) outside the Ofcom drama ranges: confirm seed data is fully fictitious (FOUNDER-CONFIRMATIONS Q6)." },
  { re: /^public\/icons\//, type: "app icon (PNG)", use: "PWA manifest + service-worker precache + push notification icon", verdict: "OWNED/ORIGINAL", evidence: "Raster of the three-gold-bar CrewFlow mark on #0F172A (geometry identical to app/icon.svg, which is hand-written SVG). Added by repo owner in c5bf737e; no embedded metadata other than 25.4 dpi.", note: "Authorship of the mark itself (designed by whom?) is a founder fact: Q1." },
  { re: /^app\/icon\.svg$/, type: "logo/favicon (SVG)", use: "favicon, manifest icon, PWA precache", verdict: "OWNED/ORIGINAL", evidence: "Hand-authored 5-line SVG (rounded rect + three stroked lines), committed by repo owner. No traced or imported artwork.", note: "Q1 (who designed the mark)." },
  { re: /^app\/favicon\.ico$/, type: "favicon (ICO)", use: "legacy favicon", verdict: "OWNED/ORIGINAL", evidence: "Commit 1694b50f 'add favicon.ico (CrewFlow flow-bars logo)'; 16/32/48px raster of the same mark.", note: "Q1." },
  { re: /^app\/_marketing\/fonts\/ClashDisplay/, type: "font (WOFF2)", use: "marketing display face via next/font/local (self-hosted)", verdict: "LICENSED", evidence: "name table: (c) 2021 Indian Type Foundry; licence URL https://fontshare.com/terms; fsType 0; requires the ITF fonts to be identified by name/credited. Free commercial use + self-hosting per ITF Free Font License (secondary sources; primary terms page not machine-readable here).", note: "Keep the Fontshare download receipt/licence PDF; render credit (Q2). Do not make repo public without re-reading the redistribution clause." },
  { re: /^app\/_marketing\/fonts\/Satoshi/, type: "font (WOFF2)", use: "marketing body face via next/font/local (self-hosted)", verdict: "LICENSED", evidence: "name table: (c) 2017-2021 Indian Type Foundry, designer Deni Anggara; licence URL https://fontshare.com/terms; fsType 0; credit clause as Clash.", note: "As Clash Display (Q2)." },
  { re: /^public\/pdf\.worker\.min\.mjs$/, type: "JS worker (third-party, minified)", use: "pdf.js worker for blueprint viewer (served same-origin, copied from pdfjs-dist by scripts/copy-pdf-worker.mjs)", verdict: "LICENSED", evidence: "Byte-identical to node_modules/pdfjs-dist/build/pdf.worker.min.mjs (cmp). Apache-2.0, (c) 2024 Mozilla Foundation; @licstart header retained in file.", note: "Listed in THIRD-PARTY-NOTICES." },
  { re: /^public\/sw\.js$/, type: "JS (first-party service worker)", use: "PWA offline shell + push", verdict: "OWNED/ORIGINAL", evidence: "Hand-written; header documents design; no third-party code (no Workbox).", note: "" },
  { re: /^public\/landing\/README\.md$/, type: "doc", use: "instructions for dropping in a hero screenshot", verdict: "OWNED/ORIGINAL", evidence: "First-party text. No hero image is present in the folder.", note: "" },
  { re: /^docs\/ux-rebuild\/screenshots\//, type: "screenshot (PNG), internal doc", use: "UX-rebuild evidence in docs/ (not served)", verdict: "OWNED/ORIGINAL", evidence: "Screenshots of CrewFlow's own UI on local seeded data (e.g. ceo@crewflow.test); one inspected (hq-after/desktop-02-boardroom.png): own UI only.", note: "Not shipped to users; committed to the repo. If the repo is ever opened/shared, re-check for incidental personal data." },
  { re: /^e2e\/login-page\.visual\.ts-snapshots\//, type: "Playwright visual baseline (PNG)", use: "visual-regression test", verdict: "OWNED/ORIGINAL", evidence: "Generated by Playwright from CrewFlow's own login page (#894).", note: "Contains the Google and Microsoft sign-in marks as rendered (see third-party marks item)." },
  { re: /^__tests__\/imports\/fixtures\/invoice-photo\./, type: "test fixture (image)", use: "OCR/ingest tests", verdict: "OWNED/ORIGINAL", evidence: "Synthetic: a plain-text 'INVOICE / CrewFlow OCR Test Document / OCR PNG Builders Ltd' page rendered by the team (visually inspected); same page in jpg/png/webp/gif/heic.", note: "'OCR PNG Builders Ltd' is a made-up name." },
  { re: /^__tests__\/imports\/fixtures\//, type: "test fixture (data)", use: "import-format ingestion tests", verdict: "OWNED/ORIGINAL", evidence: "Tiny synthetic customer lists / invoice PDF generated by the team (commit 2ccb4b23).", note: "" },
  { re: /^__tests__\/weather\/fixtures\//, type: "recorded API response (JSON)", use: "weather adapter unit tests", verdict: "LICENSED", evidence: "Recorded Open-Meteo responses; Open-Meteo data is CC BY 4.0 (attribution), API free tier is non-commercial only.", note: "Test-only, never served. Attribution string is in lib/weather/providers/open-meteo.ts." },
  { re: /^lib\/weather\/geo\//, type: "dataset (generated TS)", use: "postcode-district centroids for weather lookup", verdict: "LICENSED", evidence: "Derived from ONS Postcode Directory (May 2026) under Open Government Licence v3.0; attribution text embedded in the file and rendered via lib/weather.", note: "NI caveat in file header: OSNI/LPS terms apply to NI postcodes beyond in-product display (Q8)." },
  { re: /^docs\/release-artifacts\//, type: "JSON snapshot", use: "internal release record", verdict: "OWNED/ORIGINAL", evidence: "Machine snapshot of CrewFlow's own configuration.", note: "" },
  { re: /^docs\/roadmap\//, type: "JSON", use: "internal roadmap data", verdict: "OWNED/ORIGINAL", evidence: "First-party.", note: "" },
  { re: /^docs\/ux-rebuild\/perf\//, type: "JSON perf traces", use: "internal evidence", verdict: "OWNED/ORIGINAL", evidence: "First-party measurements.", note: "" },
  { re: /^lib\/gdpr\//, type: "JSON (table list)", use: "GDPR export/erase table map", verdict: "OWNED/ORIGINAL", evidence: "First-party schema metadata.", note: "" },
  { re: /^scripts\/ops\//, type: "ops script / launchd plist", use: "backup automation (developer machine)", verdict: "OWNED/ORIGINAL", evidence: "First-party.", note: "" },
];
const GIT_FIELDS = (f) => {
  try {
    const out = git("log", "--follow", "--diff-filter=A", "--format=%h|%an|%ad|%s", "--date=short", "--", f).split("\n").filter(Boolean);
    const last = out[out.length - 1] || git("log", "--follow", "--format=%h|%an|%ad|%s", "--date=short", "--", f).split("\n").pop() || "";
    const [h, a, d, ...s] = last.split("|");
    return { commit: h || "", author: a || "", date: d || "", subject: s.join("|") };
  } catch { return { commit: "", author: "", date: "", subject: "" }; }
};

const rows = [];
for (const f of files) {
  const st = fs.statSync(f);
  const buf = fs.readFileSync(f);
  const g = GIT_FIELDS(f);
  const rule = RULES.find((r) => r.re.test(f));
  rows.push({
    path: f, type: rule?.type || path.extname(f).slice(1), size_bytes: st.size, sha256_12: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12),
    how_used: rule?.use || "", first_commit: g.commit, first_author: g.author, first_date: g.date, first_subject: g.subject,
    verdict: rule?.verdict || "UNKNOWN-PROVENANCE", evidence: rule?.evidence || "No rule matched: needs manual review", notes: rule?.note || "",
  });
}
// Assets that are not files in the repo but are shipped/loaded or imported
const VIRTUAL = [
  { path: "(next/font/google) Inter", type: "font (remote fetch at build, self-served)", how_used: "app shell typeface (app/layout.tsx)", verdict: "LICENSED", evidence: "Google Fonts Inter, SIL OFL 1.1. next/font/google downloads at build time and serves from own origin (CSP font-src 'self' data: confirms no remote font host).", notes: "OFL text should be carried in THIRD-PARTY-NOTICES (reference included)." },
  { path: "(npm) lucide-react icon set", type: "icon library (SVG components)", how_used: "product + marketing UI icons", verdict: "LICENSED", evidence: "ISC (c) Lucide Contributors; portions MIT (c) Cole Bemis / Feather. LICENSE read from node_modules/lucide-react.", notes: "" },
  { path: "(inline) Google 'G' + Microsoft 4-square sign-in marks", type: "third-party brand marks (inline SVG)", how_used: "login page sign-in buttons (app/(auth)/login/page.tsx)", verdict: "LICENSED", evidence: "Official marks used for 'continue with <provider>' buttons, which the providers' brand guidelines permit when used unaltered for sign-in.", notes: "Trademark use is conditional on following each provider's button guidelines (spacing, text, no recolour). Review before launch (Q7)." },
  { path: "(code) app/opengraph-image.tsx", type: "social card (generated at request time by next/og)", how_used: "OG/Twitter image", verdict: "GENERATED", evidence: "Rendered from JSX (gold bars + text) by ImageResponse; no bitmap asset, no embedded font file.", notes: "" },
  { path: "(code) lib/pdf/*.tsx", type: "generated PDFs (@react-pdf/renderer)", how_used: "quotes/invoices/reports", verdict: "GENERATED", evidence: "Use PDF base-14 Helvetica (not embedded); customer logos come from the customer's own upload (lib/branding/logo.ts).", notes: "Customer-uploaded logos are the customer's IP; ToS should say so." },
];
for (const v of VIRTUAL) rows.push({ size_bytes: "", sha256_12: "", first_commit: "", first_author: "", first_date: "", first_subject: "", ...v });

const cols = ["path", "type", "size_bytes", "sha256_12", "how_used", "first_commit", "first_author", "first_date", "first_subject", "verdict", "evidence", "notes"];
const esc = (s) => { s = String(s ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync("docs/compliance/asset-register.csv", [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
const t = {}; for (const r of rows) t[r.verdict] = (t[r.verdict] || 0) + 1;
console.log(rows.length, t);
for (const r of rows.filter((r) => r.verdict === "UNKNOWN-PROVENANCE")) console.log("UNKNOWN:", r.path);
