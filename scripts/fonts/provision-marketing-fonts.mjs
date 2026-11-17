// Provision the marketing typefaces into app/_marketing/fonts/active/ before
// `next dev` / `next build` (wired into predev + prebuild).
//
// Why: Clash Display and Satoshi are licensed under the ITF Free Font License.
// It allows self-hosting them on our own site but forbids making the font files
// available through a public repository, so they are not in git. This script
// copies them in at build time from a PRIVATE source and checks every file
// against the sha256 pinned in app/_marketing/fonts/manifest.json, so only the
// exact, unmodified files we reviewed are ever served.
//
// Sources, in order:
//   1. CREWFLOW_FONTS_DIR    a local folder holding the six kit files (dev).
//   2. CREWFLOW_FONTS_TOKEN  read-only token for the private GitHub repo
//                            CREWFLOW_FONTS_REPO (default below) at
//                            CREWFLOW_FONTS_REF (default "main"), files under
//                            CREWFLOW_FONTS_PATH (default: repo root).
// If neither is set, or anything fails, the build uses the OFL fallback files
// in app/_marketing/fonts/fallback/ and still succeeds. Set
// CREWFLOW_FONTS_REQUIRED=1 (production only) to fail the build instead, so a
// missing or expired token can never silently change the live typeface.
//
// The token is only ever sent in the Authorization header; it is never logged.
// See docs/compliance/FONT-LICENCE-RESOLUTION.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FONT_DIR = "app/_marketing/fonts";
export const ACTIVE_DIR = `${FONT_DIR}/active`;
export const FALLBACK_DIR = `${FONT_DIR}/fallback`;
export const DEFAULT_REPO = "crewflow1/crewflow-brand-fonts";
export const DEFAULT_REF = "main";
const FETCH_TIMEOUT_MS = 20_000;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

export function readManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, FONT_DIR, "manifest.json"), "utf8"));
  const slots = Object.entries(manifest.slots ?? {});
  if (slots.length === 0) throw new Error("font manifest has no slots");
  return slots;
}

function verify(entry, buf) {
  const got = sha256(buf);
  if (buf.length !== entry.bytes || got !== entry.sha256) {
    throw new Error(
      `${entry.file} does not match the pinned sha256 in ${FONT_DIR}/manifest.json ` +
        `(expected ${entry.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…). ` +
        "If you intentionally replaced the font files, update the manifest.",
    );
  }
  return buf;
}

function loadFromDir(dir, slots, kind) {
  const out = new Map();
  for (const [slot, def] of slots) {
    const entry = def[kind];
    const file = join(dir, entry.file);
    if (!existsSync(file)) throw new Error(`${entry.file} not found in ${kind === "licensed" ? "CREWFLOW_FONTS_DIR" : dir}`);
    out.set(slot, verify(entry, readFileSync(file)));
  }
  return out;
}

async function loadFromGitHub({ token, repo, ref, path }, slots, fetchImpl) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("CREWFLOW_FONTS_REPO must look like owner/name");
  const prefix = path
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg === "..") throw new Error("CREWFLOW_FONTS_PATH may not contain ..");
      return encodeURIComponent(seg) + "/";
    })
    .join("");
  const out = new Map();
  for (const [slot, def] of slots) {
    const entry = def.licensed;
    const url =
      `https://api.github.com/repos/${repo}/contents/${prefix}${encodeURIComponent(entry.file)}` +
      `?ref=${encodeURIComponent(ref)}`;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "crewflow-font-provisioner",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `GitHub returned HTTP ${res.status} for ${entry.file} ` +
          "(check CREWFLOW_FONTS_REPO / CREWFLOW_FONTS_REF / CREWFLOW_FONTS_PATH and that the token can read the repository)",
      );
    }
    out.set(slot, verify(entry, Buffer.from(await res.arrayBuffer())));
  }
  return out;
}

function writeActive(root, files, provenance) {
  const dir = join(root, ACTIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const keep = new Set(["provenance.json"]);
  for (const [slot, buf] of files) {
    const name = `${slot}.woff2`;
    keep.add(name);
    const target = join(dir, name);
    // Leave identical files untouched so `next dev` does not see a change.
    if (existsSync(target) && sha256(readFileSync(target)) === sha256(buf)) continue;
    writeFileSync(target, buf);
  }
  for (const name of readdirSync(dir)) if (!keep.has(name)) rmSync(join(dir, name), { force: true });
  const json = JSON.stringify(provenance, null, 2) + "\n";
  const provFile = join(dir, "provenance.json");
  if (!existsSync(provFile) || readFileSync(provFile, "utf8") !== json) writeFileSync(provFile, json);
}

/**
 * @returns {Promise<{ mode: "licensed" | "fallback", source?: string, reason?: string }>}
 */
export async function provisionMarketingFonts({
  root,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  if (!root) throw new Error("provisionMarketingFonts: root is required");
  const slots = readManifest(root);
  const token = env.CREWFLOW_FONTS_TOKEN?.trim();
  const redact = (msg) => (token ? String(msg).split(token).join("***") : String(msg));

  let licensed;
  let source;
  let reason;
  try {
    if (env.CREWFLOW_FONTS_DIR?.trim()) {
      source = "CREWFLOW_FONTS_DIR";
      licensed = loadFromDir(resolve(root, env.CREWFLOW_FONTS_DIR.trim()), slots, "licensed");
    } else if (token) {
      const repo = env.CREWFLOW_FONTS_REPO?.trim() || DEFAULT_REPO;
      const ref = env.CREWFLOW_FONTS_REF?.trim() || DEFAULT_REF;
      source = `github:${repo}@${ref}`;
      licensed = await loadFromGitHub(
        { token, repo, ref, path: env.CREWFLOW_FONTS_PATH?.trim() || "" },
        slots,
        fetchImpl,
      );
    } else {
      reason = "no private font source configured (set CREWFLOW_FONTS_TOKEN or CREWFLOW_FONTS_DIR)";
    }
  } catch (err) {
    licensed = undefined;
    reason = redact(err instanceof Error ? err.message : err);
  }

  if (licensed) {
    writeActive(root, licensed, { mode: "licensed", source });
    log.info(`[fonts] Clash Display + Satoshi provisioned from ${source} (sha256 verified)`);
    return { mode: "licensed", source };
  }

  if (truthy(env.CREWFLOW_FONTS_REQUIRED)) {
    throw new Error(
      `[fonts] CREWFLOW_FONTS_REQUIRED is set but the licensed fonts could not be provisioned: ${reason}`,
    );
  }

  // Committed OFL files: a failure here means the repo itself is broken.
  writeActive(root, loadFromDir(join(root, FALLBACK_DIR), slots, "fallback"), { mode: "fallback", reason });
  const families = [...new Set(slots.map(([, def]) => def.fallback.family))].join(" + ");
  log.warn(`[fonts] using the OFL fallback typefaces (${families}): ${reason}`);
  return { mode: "fallback", reason };
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    // Pick up CREWFLOW_FONTS_* from .env.local in local dev (Vercel/CI use real env).
    const mod = await import("@next/env");
    const loadEnvConfig = mod.loadEnvConfig ?? mod.default?.loadEnvConfig;
    loadEnvConfig?.(root, false, { info() {}, error() {} });
  } catch {
    // @next/env unavailable: rely on process.env only.
  }
  try {
    await provisionMarketingFonts({ root });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
