import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_REPO,
  provisionMarketingFonts,
  readManifest,
} from "@/scripts/fonts/provision-marketing-fonts.mjs";

/**
 * Build-time provisioning of the licensed marketing fonts
 * (docs/compliance/FONT-LICENCE-RESOLUTION.md). Uses a temp project root with
 * fake "font" bytes, so no licensed file is needed and nothing touches the
 * network: the GitHub source is exercised through an injected fetch.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");
const FONT_DIR = "app/_marketing/fonts";
const TOKEN = "fake-font-token-for-tests-0000";
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const licensedBytes: Record<string, Buffer> = {
  "ClashDisplay-Bold.woff2": Buffer.from("licensed clash bold"),
  "Satoshi-Regular.woff2": Buffer.from("licensed satoshi regular"),
};
const fallbackBytes: Record<string, Buffer> = {
  "Display-700.woff2": Buffer.from("ofl display bold"),
  "Body-400.woff2": Buffer.from("ofl body regular"),
};
const entry = (family: string, file: string, buf: Buffer) => ({ family, file, bytes: buf.length, sha256: sha256(buf) });

let root: string;
let kit: string;
const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cf-fonts-"));
  kit = path.join(root, ".fonts-private");
  mkdirSync(path.join(root, FONT_DIR, "fallback"), { recursive: true });
  mkdirSync(kit);
  const manifest = {
    slots: {
      "display-700": {
        licensed: entry("Clash Display", "ClashDisplay-Bold.woff2", licensedBytes["ClashDisplay-Bold.woff2"]!),
        fallback: entry("Display OFL", "Display-700.woff2", fallbackBytes["Display-700.woff2"]!),
      },
      "body-400": {
        licensed: entry("Satoshi", "Satoshi-Regular.woff2", licensedBytes["Satoshi-Regular.woff2"]!),
        fallback: entry("Body OFL", "Body-400.woff2", fallbackBytes["Body-400.woff2"]!),
      },
    },
  };
  writeFileSync(path.join(root, FONT_DIR, "manifest.json"), JSON.stringify(manifest));
  for (const [f, b] of Object.entries(fallbackBytes)) writeFileSync(path.join(root, FONT_DIR, "fallback", f), b);
  for (const [f, b] of Object.entries(licensedBytes)) writeFileSync(path.join(kit, f), b);
  log.info.mockReset();
  log.warn.mockReset();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const active = (slot: string) => readFileSync(path.join(root, FONT_DIR, "active", `${slot}.woff2`));
const provenance = () => JSON.parse(readFileSync(path.join(root, FONT_DIR, "active", "provenance.json"), "utf8"));
const allLogs = () => JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);

function fakeGitHub(overrides: Record<string, Buffer | number> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const file = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const body = overrides[file] ?? licensedBytes[file];
    if (typeof body === "number") return new Response("nope", { status: body });
    if (!body) return new Response("missing", { status: 404 });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    return new Response(new Uint8Array(body), { status: 200 });
  });
}

describe("provisionMarketingFonts", () => {
  it("with no private source configured, uses the OFL fallback and does not fail", async () => {
    const res = await provisionMarketingFonts({ root, env: {}, log });
    expect(res.mode).toBe("fallback");
    expect(active("display-700")).toEqual(fallbackBytes["Display-700.woff2"]);
    expect(active("body-400")).toEqual(fallbackBytes["Body-400.woff2"]);
    expect(provenance().mode).toBe("fallback");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("copies the licensed files from CREWFLOW_FONTS_DIR after verifying sha256", async () => {
    const res = await provisionMarketingFonts({ root, env: { CREWFLOW_FONTS_DIR: kit }, log });
    expect(res).toEqual({ mode: "licensed", source: "CREWFLOW_FONTS_DIR" });
    expect(active("display-700")).toEqual(licensedBytes["ClashDisplay-Bold.woff2"]);
    expect(active("body-400")).toEqual(licensedBytes["Satoshi-Regular.woff2"]);
  });

  it("fetches from the private GitHub repo with the token in the Authorization header only", async () => {
    const fetchImpl = fakeGitHub();
    const res = await provisionMarketingFonts({
      root,
      env: { CREWFLOW_FONTS_TOKEN: TOKEN, CREWFLOW_FONTS_PATH: "kit" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });
    expect(res).toEqual({ mode: "licensed", source: `github:${DEFAULT_REPO}@main` });
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls).toContain(`https://api.github.com/repos/${DEFAULT_REPO}/contents/kit/ClashDisplay-Bold.woff2?ref=main`);
    for (const u of urls) expect(u).not.toContain(TOKEN);
    expect(allLogs()).not.toContain(TOKEN);
    expect(active("body-400")).toEqual(licensedBytes["Satoshi-Regular.woff2"]);
  });

  it("falls back (never fails) on an HTTP error, without leaking the token", async () => {
    const fetchImpl = fakeGitHub({ "Satoshi-Regular.woff2": 401 });
    const res = await provisionMarketingFonts({
      root,
      env: { CREWFLOW_FONTS_TOKEN: TOKEN },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });
    expect(res.mode).toBe("fallback");
    expect(res.reason).toContain("HTTP 401");
    expect(JSON.stringify(res) + allLogs() + JSON.stringify(provenance())).not.toContain(TOKEN);
    // All-or-nothing: no licensed file is left behind next to fallback files.
    expect(active("display-700")).toEqual(fallbackBytes["Display-700.woff2"]);
  });

  it("redacts the token even if a network error message echoes it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed (auth ${TOKEN})`);
    });
    const res = await provisionMarketingFonts({
      root,
      env: { CREWFLOW_FONTS_TOKEN: TOKEN },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });
    expect(res.mode).toBe("fallback");
    expect(JSON.stringify(res) + allLogs()).not.toContain(TOKEN);
  });

  it("rejects a file that does not match the pinned sha256", async () => {
    writeFileSync(path.join(kit, "ClashDisplay-Bold.woff2"), Buffer.from("subset or edited file"));
    const res = await provisionMarketingFonts({ root, env: { CREWFLOW_FONTS_DIR: kit }, log });
    expect(res.mode).toBe("fallback");
    expect(res.reason).toMatch(/ClashDisplay-Bold\.woff2 does not match the pinned sha256/);
  });

  it("fails the build only when CREWFLOW_FONTS_REQUIRED is set", async () => {
    await expect(provisionMarketingFonts({ root, env: { CREWFLOW_FONTS_REQUIRED: "1" }, log })).rejects.toThrow(
      /CREWFLOW_FONTS_REQUIRED is set/,
    );
    const ok = await provisionMarketingFonts({
      root,
      env: { CREWFLOW_FONTS_REQUIRED: "1", CREWFLOW_FONTS_DIR: kit },
      log,
    });
    expect(ok.mode).toBe("licensed");
  });

  it("rejects an unsafe repo or path value", async () => {
    const fetchImpl = fakeGitHub();
    for (const env of [
      { CREWFLOW_FONTS_TOKEN: TOKEN, CREWFLOW_FONTS_REPO: "https://evil.example/x" },
      { CREWFLOW_FONTS_TOKEN: TOKEN, CREWFLOW_FONTS_PATH: "../other" },
    ]) {
      const res = await provisionMarketingFonts({ root, env, fetchImpl: fetchImpl as unknown as typeof fetch, log });
      expect(res.mode).toBe("fallback");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves identical files untouched on a re-run and removes stale files", async () => {
    await provisionMarketingFonts({ root, env: {}, log });
    const file = path.join(root, FONT_DIR, "active", "display-700.woff2");
    const before = statSync(file).mtimeMs;
    writeFileSync(path.join(root, FONT_DIR, "active", "stale.woff2"), "old");
    await new Promise((r) => setTimeout(r, 20));
    await provisionMarketingFonts({ root, env: {}, log });
    expect(statSync(file).mtimeMs).toBe(before);
    expect(existsSync(path.join(root, FONT_DIR, "active", "stale.woff2"))).toBe(false);
  });
});

describe("real repository manifest", () => {
  it("has six slots whose committed OFL fallback files verify, so a token-less build always works", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cf-fonts-real-"));
    try {
      cpSync(path.join(REPO_ROOT, FONT_DIR, "manifest.json"), path.join(tmp, FONT_DIR, "manifest.json"));
      cpSync(path.join(REPO_ROOT, FONT_DIR, "fallback"), path.join(tmp, FONT_DIR, "fallback"), { recursive: true });
      expect(readManifest(tmp).map(([slot]) => slot)).toEqual([
        "display-500",
        "display-600",
        "display-700",
        "body-400",
        "body-500",
        "body-700",
      ]);
      const res = await provisionMarketingFonts({ root: tmp, env: {}, log });
      expect(res.mode).toBe("fallback");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
