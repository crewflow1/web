import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { operatorDisclosure } from "@/lib/legal/operator";
import { paymentReceivedEmail, setupPaymentEmail } from "@/lib/email/demo-templates";
import {
  buildCancellationEmail,
  buildCancellationScheduleEmail,
} from "@/lib/billing/cancellation-email";

const KEYS = [
  "CREWFLOW_OPERATOR_LEGAL_NAME",
  "CREWFLOW_OPERATOR_SERVICE_ADDRESS",
  "CREWFLOW_OPERATOR_VAT_NUMBER",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configure(vat?: string) {
  process.env.CREWFLOW_OPERATOR_LEGAL_NAME = "Test Person";
  process.env.CREWFLOW_OPERATOR_SERVICE_ADDRESS = "1 Test Street, Testtown TT1 1TT";
  if (vat) process.env.CREWFLOW_OPERATOR_VAT_NUMBER = vat;
}
const LINE = "CrewFlow is a trading name of Test Person, 1 Test Street, Testtown TT1 1TT.";

describe("operatorDisclosure()", () => {
  it("is null when unset", () => expect(operatorDisclosure()).toBeNull());
  it("is null when only the name is set", () => {
    process.env.CREWFLOW_OPERATOR_LEGAL_NAME = "Test Person";
    expect(operatorDisclosure()).toBeNull();
  });
  it("is null when only the address is set", () => {
    process.env.CREWFLOW_OPERATOR_SERVICE_ADDRESS = "1 Test Street";
    expect(operatorDisclosure()).toBeNull();
  });
  it("is null for whitespace-only values", () => {
    process.env.CREWFLOW_OPERATOR_LEGAL_NAME = "   ";
    process.env.CREWFLOW_OPERATOR_SERVICE_ADDRESS = "\n\t ";
    expect(operatorDisclosure()).toBeNull();
  });
  it("renders the line when name and address are set", () => {
    configure();
    expect(operatorDisclosure()).toEqual({ line: LINE });
  });
  it("trims and collapses whitespace", () => {
    process.env.CREWFLOW_OPERATOR_LEGAL_NAME = "  Test   Person ";
    process.env.CREWFLOW_OPERATOR_SERVICE_ADDRESS = " 1 Test Street,\n Testtown TT1 1TT ";
    expect(operatorDisclosure()?.line).toBe(LINE);
  });
  it("appends the VAT number only when set", () => {
    configure("GB123456789");
    expect(operatorDisclosure()?.line).toBe(`${LINE} VAT no. GB123456789`);
    process.env.CREWFLOW_OPERATOR_VAT_NUMBER = "  ";
    expect(operatorDisclosure()?.line).toBe(LINE);
  });
});

describe("billing documents render the disclosure only when configured", () => {
  const docs: Record<string, () => { html: string; text: string }> = {
    setupPayment: () =>
      setupPaymentEmail({ name: "A", company: "Co", paymentLinkUrl: "https://x.test/p", amountGbp: 100 }),
    setupPaymentNoLink: () =>
      setupPaymentEmail({ name: "A", company: "Co", paymentLinkUrl: null, amountGbp: 100 }),
    paymentReceived: () => paymentReceivedEmail({ name: "A", company: "Co", amountGbp: 100 }),
    cancellation: () =>
      buildCancellationEmail({ orgName: "Co", appUrl: "https://x.test", hadSubscription: true }),
    cancellationScheduled: () =>
      buildCancellationScheduleEmail({ orgName: "Co", appUrl: "https://x.test", kind: "scheduled", at: 1900000000 }),
    cancellationResumed: () =>
      buildCancellationScheduleEmail({ orgName: "Co", appUrl: "https://x.test", kind: "resumed", at: 1900000000 }),
  };
  for (const [name, build] of Object.entries(docs)) {
    it(`${name}: includes the line in text + html when configured`, () => {
      configure("GB123456789");
      const d = build();
      expect(d.text).toContain(`${LINE} VAT no. GB123456789`);
      expect(d.html).toContain(`${LINE} VAT no. GB123456789`);
    });
    it(`${name}: omits it when unconfigured`, () => {
      const d = build();
      expect(d.text).not.toContain("trading name of");
      expect(d.html).not.toContain("trading name of");
    });
  }
});

describe("source guard: CrewFlow's own billing documents must call operatorDisclosure()", () => {
  const root = resolve(__dirname, "../..");
  const MUST_CALL = [
    "lib/email/demo-templates.ts",
    "lib/billing/cancellation-email.ts",
    "app/payment/success/page.tsx",
    "app/account/billing/page.tsx",
  ];
  for (const f of MUST_CALL) {
    it(`${f} calls operatorDisclosure()`, () => {
      expect(readFileSync(resolve(root, f), "utf-8")).toMatch(/operatorDisclosure\(\)/);
    });
  }
  it("every demo-templates billing builder passes disclosure", () => {
    const src = readFileSync(resolve(root, "lib/email/demo-templates.ts"), "utf-8");
    for (const heading of ["One-off setup payment.", "Payment received."]) {
      const i = src.indexOf(`heading: \`${heading}\``);
      expect(i).toBeGreaterThan(-1);
      expect(src.slice(i, i + 80)).toContain("disclosure: true");
    }
  });
  it("any new billing-email builder (cancellation-email.ts) wires every html footer", () => {
    const src = readFileSync(resolve(root, "lib/billing/cancellation-email.ts"), "utf-8");
    const builders = src.match(/^export function build\w+Email/gm) ?? [];
    const calls = src.match(/operatorDisclosure\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(builders.length);
  });
  it("hard-codes no personal details (env-driven only)", () => {
    const src = readFileSync(resolve(root, "lib/legal/operator.ts"), "utf-8");
    expect(src).toMatch(/CREWFLOW_OPERATOR_LEGAL_NAME/);
    expect(src).toMatch(/CREWFLOW_OPERATOR_SERVICE_ADDRESS/);
  });
});
