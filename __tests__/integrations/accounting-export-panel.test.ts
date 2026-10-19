import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * G-8 — the accounting export panel offers EVERY provider the push action
 * supports, gated on the org's connection, with honest copy.
 *
 * THE DEFECT (pre-fix): `requestAccountingPush` + the adapters supported
 * xero / quickbooks / sage (the Sage adapter ships with its own push suite,
 * accounting-sage-push.test.ts), but the panel rendered buttons only for
 * xero/qbo — Sage was UNREACHABLE from the UI — and both buttons carried
 * "(coming soon)" copy contradicting the shipped capability (the push is live
 * per-org the moment a provider is connected).
 *
 * No component-render infrastructure exists in this repo, so these are source
 * pins (the house idiom — see the telephony/receptionist invariant suites):
 * they fail CI if a provider button is dropped, the connection gating is
 * removed, or the false "coming soon" claim creeps back.
 */

const PANEL = join(
  process.cwd(),
  "app/(app)/reports/accounting/AccountingExportPanel.tsx",
);
const PAGE = join(process.cwd(), "app/(app)/reports/page.tsx");
const PREFS = join(
  process.cwd(),
  "app/(app)/settings/_notification-prefs.client.tsx",
);

const read = (p: string) => readFileSync(p, "utf8");
/** Strip comments so prose can neither satisfy nor trip a pin. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("AccountingExportPanel — every supported provider is reachable", () => {
  const code = codeOf(read(PANEL));

  it("renders a push control per provider, INCLUDING sage", () => {
    // The provider list the panel maps over must carry all three.
    expect(code).toMatch(
      /PROVIDERS[\s\S]{0,120}=\s*\[\s*"xero",\s*"quickbooks",\s*"sage"\s*\]/,
    );
    expect(code).toMatch(/PROVIDERS\.map\(/);
    // Sage has a human label like its siblings.
    expect(code).toMatch(/sage:\s*"Sage"/);
  });

  it("button state follows the org's CONNECTION for that provider", () => {
    // The gate is the same state the connections panel renders: a `connected` row.
    expect(code).toMatch(/status\s*===\s*"connected"/);
    // Both branches exist: a live submit and a disabled not-connected control.
    expect(code).toMatch(/type="submit"[\s\S]{0,200}value=\{provider\}/);
    expect(code).toMatch(/aria-disabled="true"/);
  });

  it("carries NO false '(coming soon)' claim — the push shipped and activates per-org by connecting", () => {
    expect(read(PANEL).toLowerCase()).not.toContain("coming soon");
  });
});

describe("reports page — the panel is fed the org's real connection state", () => {
  it("passes the loaded accounting connections into the export panel", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/<AccountingExportPanel[\s\S]{0,300}connections=\{/);
  });
});

describe("P3 copy honesty — settings SMS copy matches the shipped state", () => {
  it("notification prefs no longer claim text messages are 'coming soon'", () => {
    const src = read(PREFS);
    expect(src.toLowerCase()).not.toContain("coming soon");
    // The honest replacement names the real activation condition (SMS set up),
    // matching lib/notifications/sms.ts's two-switch contract.
    expect(src).toMatch(/send once SMS is set up/);
  });
});
