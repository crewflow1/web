import { describe, it, expect } from "vitest";
import { composeActivationRow } from "@/server/services/activation-preflight";

/**
 * Activation preflight — the decision logic that catches the silent
 * "switched on but no activation row" misconfiguration (the prior WhatsApp
 * "0 POSTs" class). Pure; no IO.
 */

const base = {
  id: "x",
  label: "X activation",
  flagHint: "FEATURE_X=true",
  credsMissing: ["X_SECRET"] as const,
  providerHandshakeNote: "confirm the provider handshake.",
};

describe("composeActivationRow", () => {
  it("GREEN when flag on + creds present + all activation rows present", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: true,
      credsPresent: true,
      activationRows: [
        { label: "a route row", present: true },
        { label: "a live setup", present: true },
      ],
    });
    expect(row.status).toBe("green");
    expect(row.summary).toMatch(/Activated/);
    expect(row.summary).toMatch(/provider-side webhook handshake/);
  });

  it("RED when switched on (flag + creds) but an activation row is MISSING (the silent-failure catch)", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: true,
      credsPresent: true,
      activationRows: [
        { label: "a route row", present: true },
        { label: "a live setup", present: false },
      ],
    });
    expect(row.status).toBe("red");
    expect(row.summary).toMatch(/MISCONFIGURED/);
    expect(row.summary).toMatch(/a live setup/);
    expect(row.summary).toMatch(/silent/i);
  });

  it("RED names ALL missing rows when several are absent", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: true,
      credsPresent: true,
      activationRows: [
        { label: "a route row", present: false },
        { label: "a live setup", present: false },
      ],
    });
    expect(row.status).toBe("red");
    expect(row.summary).toContain("a route row");
    expect(row.summary).toContain("a live setup");
  });

  it("AMBER (dark, not red) when fully off — and lists flag + creds + rows to activate", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: false,
      credsPresent: false,
      activationRows: [{ label: "a route row", present: false }],
    });
    expect(row.status).toBe("amber");
    expect(row.summary).toMatch(/Dark/);
    expect(row.summary).toContain("FEATURE_X=true");
    expect(row.summary).toContain("X_SECRET");
    expect(row.summary).toContain("a route row");
  });

  it("AMBER when partially configured (flag on, creds missing) — not a false green, not red", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: true,
      credsPresent: false,
      activationRows: [{ label: "a route row", present: true }],
    });
    expect(row.status).toBe("amber");
    expect(row.summary).toContain("X_SECRET");
  });

  it("does not leak secret values — only names/presence appear", () => {
    const row = composeActivationRow({
      ...base,
      flagOn: true,
      credsPresent: true,
      activationRows: [{ label: "a route row", present: false }],
    });
    // The message references the missing ROW label, never a credential value.
    expect(JSON.stringify(row)).not.toMatch(/eyJ|secret-value|sk_|AC[0-9a-f]{10}/);
  });
});
