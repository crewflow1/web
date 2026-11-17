// Types for provision-marketing-fonts.mjs (plain Node ESM so predev/prebuild need no TS runtime).
export declare const FONT_DIR: string;
export declare const ACTIVE_DIR: string;
export declare const FALLBACK_DIR: string;
export declare const DEFAULT_REPO: string;
export declare const DEFAULT_REF: string;

export interface FontFileEntry {
  family: string;
  file: string;
  bytes: number;
  sha256: string;
}

export declare function readManifest(
  root: string,
): Array<[slot: string, def: { licensed: FontFileEntry; fallback: FontFileEntry }]>;

export interface ProvisionResult {
  mode: "licensed" | "fallback";
  source?: string;
  reason?: string;
}

export declare function provisionMarketingFonts(options: {
  root: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, "info" | "warn">;
}): Promise<ProvisionResult>;
