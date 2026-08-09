import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

/**
 * Class guard — portal / invoice OWNERSHIP checks must resolve the customer
 * through the ONE authority `invoiceCustomerId` (invoice's own customer_id,
 * quote fallback), never through `quote.customer_id` ALONE.
 *
 * Why this is a correctness invariant, not a style preference:
 *   `invoices.quote_id` is ON DELETE SET NULL (see the #349 denormalisation
 *   migration + the deleteQuote guard). A quote-less invoice keeps its own
 *   `customer_id`, so:
 *     - a quote-only ownership gate WRONGLY REJECTS the invoice's legitimate
 *       owner (the concrete defect this file was created for — the portal
 *       payment-proof upload still SHOWS the form for such an invoice because
 *       the list scopes by customer_id, then the action refused it); and
 *     - a stale quote pointing at a different customer could WRONGLY ACCEPT the
 *       wrong owner.
 *
 * Every sibling already resolves the right way: the portal PDF route
 * (`invoiceCustomerId(invoice) !== customer.id`), the invoices list
 * (`.eq("customer_id", customer.id)`) and the bulk download
 * (`invoiceCustomerId(inv) === customer.id`). This guard fails CI if any new
 * portal/invoice ownership site regresses to the quote-only chain.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");

/** Source files in scope for the class guard: the customer portal + the
 *  invoice→customer read helpers. Directories are walked recursively. */
const SCAN_DIRS = ["app/customer-portal", "lib/customers"];
const SCAN_EXTRA = ["lib/invoices/customer.ts"];

function collectFiles(dir: string): string[] {
  const abs = resolve(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // Node's recursive Dirent carries the sub-path in `parentPath` (Node 20+).
    const parent = (entry as unknown as { parentPath?: string; path?: string })
      .parentPath ?? (entry as unknown as { path: string }).path;
    out.push(join(parent, entry.name));
  }
  return out;
}

/** Strip line-comment / block-comment lines so PROSE describing the hazard is
 *  never mistaken for committing it. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/**
 * The one authoritative resolver's own file is exempt — it legitimately reads
 * `quote?.customer_id` as the FALLBACK arm (`customer_id ?? quote?.customer_id`),
 * and it never compares to a portal customer identity. Any other legitimate use
 * must be added here WITH a reason (and should be vanishingly rare).
 */
const ALLOWLIST: Record<string, string> = {
  "lib/invoices/customer.ts":
    "the single resolver itself — reads quote.customer_id as the documented fallback arm, never as an ownership comparison",
};

// A JS ownership comparison of a quote's customer against a portal customer id,
// in either operand order, tolerant of optional chaining.
const JS_GATE_FWD = /quote\??\.customer_id\s*(===|!==)\s*customer\??\.id/;
const JS_GATE_REV = /customer\??\.id\s*(===|!==)\s*quote\??\.customer_id/;
// A PostgREST embedded-column ownership SCOPE through the quote alone, e.g.
// `.eq("quote.customer_id", customer.id)` — same defect in query form.
const PGREST_GATE =
  /\.eq\(\s*['"]quote\.customer_id['"]\s*,\s*customer\??\.id\s*\)/;

describe("class guard — portal/invoice ownership must use invoiceCustomerId, not quote-only", () => {
  it("no scanned source gates invoice ownership on quote.customer_id alone", () => {
    const files = [
      ...SCAN_DIRS.flatMap(collectFiles),
      ...SCAN_EXTRA.map((p) => resolve(ROOT, p)),
    ];
    // Sanity: the scan must actually see the portal upload action — otherwise a
    // broken glob would make this guard vacuously pass.
    expect(
      files.some((f) => f.endsWith("app/customer-portal/_upload-action.ts")),
    ).toBe(true);

    const offenders: string[] = [];
    for (const abs of files) {
      const rel = relative(ROOT, abs);
      if (ALLOWLIST[rel]) continue;
      const code = stripComments(read(abs));
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        if (
          JS_GATE_FWD.test(line) ||
          JS_GATE_REV.test(line) ||
          PGREST_GATE.test(line)
        ) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Portal/invoice ownership must resolve via invoiceCustomerId (lib/invoices/customer.ts), ` +
        `not quote.customer_id alone — quote_id is ON DELETE SET NULL, so a quote-less invoice ` +
        `would wrongly reject its owner. Offending sites:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the payment-proof upload action resolves ownership via the authority", () => {
    const src = read(resolve(ROOT, "app/customer-portal/_upload-action.ts"));
    expect(src).toMatch(/from "@\/lib\/invoices\/customer"/);
    expect(src).toMatch(/invoiceCustomerId\(inv\) !== customer\.id/);
    // Must fetch the direct column so the authority has its authoritative arm.
    expect(src).toMatch(/\.select\("[^"]*\bcustomer_id\b[^"]*"\)/);
  });
});

// =====================================================================
// Behavioural fixture — a quote-less invoice (customer_id set, quote null)
// whose owner's upload SUCCEEDS. Pre-fix (gate on `inv.quote?.customer_id`),
// `null?.customer_id` is undefined, so the owner is rejected 'invoice_not_yours'
// — this test is RED. Post-fix it is GREEN.
// =====================================================================

const CUSTOMER = {
  id: "cust-1",
  org_id: "org-1",
  email: "jane@example.com",
  name: "Jane Homeowner",
};

// The invoice as the DB returns it after its backing quote was deleted:
// its own customer_id survives, the joined quote is null.
const QUOTELESS_INVOICE = {
  id: "inv-1",
  number: "INV-1042",
  customer_id: CUSTOMER.id,
  quote: null as { customer_id: string } | null,
};

const redirectCalls: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    // Real Next redirect() throws to abort the render/action; mirror that so
    // control flow (the `backTo(): never` branches) behaves identically.
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/app/customer-portal/_helpers", () => ({
  loadCustomerByPortalToken: async () => ({
    customer: CUSTOMER,
    org: { id: CUSTOMER.org_id, name: "Acme Roofing" },
  }),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  consume: async () => ({ allowed: true }),
  DEFAULT_LIMITS: { portal_write: { limit: 10, windowMs: 60_000 } },
}));

vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async () => undefined,
}));

vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: async () => undefined,
}));

vi.mock("@/lib/notifications/events", () => ({
  notifyOnPaymentProofUploaded: (x: unknown) => x,
}));

vi.mock("@/lib/supabase/read-failure", () => ({
  readFailure: (msg: string) => new Error(msg),
}));

const insertedRows: unknown[] = [];
const uploadedPaths: string[] = [];

vi.mock("@/lib/supabase/admin", () => {
  const invoiceQuery = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: async () => ({ data: QUOTELESS_INVOICE, error: null }),
  };
  return {
    createAdminClient: () => ({
      from() {
        return {
          select: () => invoiceQuery,
          insert: async (row: unknown) => {
            insertedRows.push(row);
            return { error: null };
          },
        };
      },
      storage: {
        from() {
          return {
            upload: async (path: string) => {
              uploadedPaths.push(path);
              return { error: null };
            },
            remove: async () => ({ error: null }),
          };
        },
      },
    }),
  };
});

async function runUpload(): Promise<string> {
  redirectCalls.length = 0;
  const { uploadPaymentProof } = await import(
    "@/app/customer-portal/_upload-action"
  );
  const fd = new FormData();
  fd.set("token", "a".repeat(8) + "-1111-2222-3333-444444444444");
  fd.set("invoice_id", QUOTELESS_INVOICE.id);
  fd.set(
    "file",
    new File([new Uint8Array([1, 2, 3, 4])], "bank-transfer.pdf", {
      type: "application/pdf",
    }),
  );
  fd.set("notes", "Paid via Faster Payments");
  try {
    await uploadPaymentProof(fd);
  } catch (e) {
    // Expected: the terminal backTo()/redirect throws.
    if (!(e instanceof Error) || !e.message.startsWith("NEXT_REDIRECT:")) {
      throw e;
    }
  }
  expect(redirectCalls).toHaveLength(1);
  return redirectCalls[0] as string;
}

describe("payment-proof upload — quote-less invoice, legitimate owner", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    uploadedPaths.length = 0;
  });

  it("SUCCEEDS for the owner even though the invoice has no quote", async () => {
    const url = await runUpload();
    // Success redirect carries ?saved=uploaded, NOT the ownership rejection.
    expect(url).toContain("saved=uploaded");
    expect(url).not.toContain("invoice_not_yours");
    // And it actually did the work: stored the bytes + recorded the row.
    expect(uploadedPaths).toHaveLength(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      customer_id: CUSTOMER.id,
      target_table: "invoices",
      target_id: QUOTELESS_INVOICE.id,
      kind: "payment_proof",
    });
  });
});
