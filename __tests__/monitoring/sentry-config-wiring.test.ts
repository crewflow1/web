import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scrubEvent } from "@/lib/monitoring/scrub";

/**
 * Sentry config wiring — drift guard.
 *
 * The privacy contract lives in lib/monitoring/scrub.ts, but it only protects
 * anything if every sentry.*.config.ts actually wires it onto BOTH event paths.
 * This proves each config, when enabled (DSN + non-silent env), calls
 * Sentry.init with `beforeSend === scrubEvent`, `beforeSendTransaction ===
 * scrubEvent`, and `sendDefaultPii === false`. Deleting any of those wirings
 * (or letting error + transaction paths drift apart) fails here.
 */

const { initMock } = vi.hoisted(() => ({ initMock: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  init: (opts: unknown) => initMock(opts),
  captureRequestError: vi.fn(),
}));

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

// Each config is imported at most once across the suite (first import runs its
// side-effecting init), so no module reset is needed — which keeps the
// `scrubEvent` identity stable between this file and the freshly-imported config.
const CONFIGS = [
  { name: "sentry.server.config", path: "../../sentry.server.config" },
  { name: "sentry.edge.config", path: "../../sentry.edge.config" },
  { name: "sentry.client.config", path: "../../sentry.client.config" },
] as const;

beforeEach(() => {
  initMock.mockClear();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
  vi.stubEnv("SENTRY_DSN", DSN);
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
});

afterAll(() => vi.unstubAllEnvs());

describe("sentry config wiring", () => {
  for (const cfg of CONFIGS) {
    it(`${cfg.name} wires scrubEvent on beforeSend + beforeSendTransaction and disables default PII`, async () => {
      await import(cfg.path);
      expect(initMock).toHaveBeenCalledTimes(1);
      const opts = initMock.mock.calls[0]![0] as {
        beforeSend?: unknown;
        beforeSendTransaction?: unknown;
        sendDefaultPii?: unknown;
      };
      expect(opts.beforeSend).toBe(scrubEvent);
      expect(opts.beforeSendTransaction).toBe(scrubEvent);
      expect(opts.sendDefaultPii).toBe(false);
    });
  }
});
