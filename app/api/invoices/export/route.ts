import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/invoices/schema";
import { csvEscape } from "@/lib/csv";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * CSV export of an org's invoices.
 *
 *   GET /api/invoices/export?format=xero|sage|simple&from=YYYY-MM-DD&to=YYYY-MM-DD&status=sent,paid
 *
 * Formats:
 *   - "simple" (default): flat per-invoice rows. Same columns the
 *     /invoices list shows: number, date, status, customer, net, vat,
 *     total, due_date, paid_at.
 *   - "xero": one row per line item, mappable directly to Xero's
 *     "Import sales invoices" CSV schema. TaxType is derived from the
 *     line vat_rate. AccountCode is left blank for the operator to
 *     fill in Xero (each Xero account is org-specific).
 *   - "sage": one row per line item, mappable to Sage Business Cloud's
 *     "Import sales invoices" CSV schema. TaxRate is derived from the
 *     line vat_rate. LedgerAccount is left blank — chart of accounts
 *     codes are Sage-side per-org.
 *
 * RLS scopes the underlying queries to the caller's org.
 */

const XERO_DATE = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
};

// Map a numeric VAT rate to Xero's TaxType string. Anything we can't map
// falls through to "Tax Exempt" so the import doesn't reject the row —
// the operator can re-tag inside Xero.
function xeroTaxType(rate: number): string {
  if (rate === 20) return "20% (VAT on Income)";
  if (rate === 5) return "5% (VAT on Income)";
  if (rate === 0) return "Zero Rated Income";
  return "Tax Exempt";
}

// Map a numeric VAT rate to Sage Business Cloud's TaxRate label.
function sageTaxRate(rate: number): string {
  if (rate === 20) return "Standard 20%";
  if (rate === 5) return "Lower Rate 5%";
  if (rate === 0) return "Zero Rated 0%";
  return "Exempt";
}

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
  notes: string | null;
  quote_id: string | null;
  // Direct customer anchor (Issue #349 Phase 1) — preferred over the quote path,
  // which is NULL for every stage-billing invoice.
  customer: { name: string | null } | null;
  quote: { customer: { name: string | null } | null } | null;
};

type LineItemRow = {
  invoice_id: string;
  description: string;
  qty: number | string | null;
  unit_price: number | string | null;
  vat_rate: number | string | null;
  line_total: number | string | null;
  sort_order: number | null;
};

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const format = (url.searchParams.get("format") ?? "simple").toLowerCase();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const status = url.searchParams.get("status");

  if (format !== "simple" && format !== "xero" && format !== "sage") {
    return NextResponse.json(
      { error: "Unsupported format. Use 'simple', 'xero', or 'sage'." },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // F-1: a Xero/Sage/simple export must be COMPLETE. A single `.limit(N)` is
  // silently clamped to PostgREST max_rows (1000), so page the full sales ledger
  // with a unique (created_at, id) total order. ACTIVE-org pin — RLS alone merged
  // a dual-org user's two companies into one accounting import.
  const { data: invoices, error } = await fetchAllRows<InvoiceRow>((rangeFrom, rangeTo) => {
    let q = supabase
      .from("invoices")
      .select(
        `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        created_at, notes, quote_id,
        customer:customers!invoices_customer_org_fkey ( name ),
        quote:quotes ( customer:customers ( name ) )
      `,
      )
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(rangeFrom, rangeTo);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      q = q.gte("created_at", `${from}T00:00:00Z`);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      q = q.lte("created_at", `${to}T23:59:59Z`);
    }
    if (status) {
      const allowed = new Set<string>(INVOICE_STATUSES);
      const wanted: InvoiceStatus[] = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => allowed.has(s)) as InvoiceStatus[];
      if (wanted.length > 0) q = q.in("status", wanted);
    }
    return q as unknown as PromiseLike<{ data: InvoiceRow[] | null; error: unknown }>;
  });
  if (error) {
    console.error("[invoices] export failed", error);
    return NextResponse.json({ error: "Failed to export" }, { status: 500 });
  }

  const rows = invoices;
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "simple") {
    const header = [
      "invoice_number",
      "date",
      "status",
      "customer",
      "net",
      "vat",
      "total",
      "due_date",
      "paid_at",
      "notes",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const net = Number(r.amount ?? 0);
      const vat = Number(r.vat_total ?? 0);
      lines.push(
        [
          r.number,
          r.created_at.slice(0, 10),
          r.status,
          r.customer?.name ?? r.quote?.customer?.name ?? "",
          net.toFixed(2),
          vat.toFixed(2),
          (net + vat).toFixed(2),
          r.due_date ?? "",
          r.paid_at ? r.paid_at.slice(0, 10) : "",
          r.notes ?? "",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="crewflow-invoices-${stamp}.csv"`,
      },
    });
  }

  // format === "xero" | "sage" — both are one-row-per-line-item accounting
  // exports. Fetch line items once, then branch on format for header /
  // column composition + tax-code mapping.
  // Line items come from each invoice's own snapshot (Issue #349 Phase 2),
  // keyed by invoice_id — so the export reflects what was billed, not the live
  // (possibly since-edited or deleted) quote.
  const invoiceIds = rows.map((r) => r.id);

  const lineItemsByInvoice = new Map<string, LineItemRow[]>();
  if (invoiceIds.length > 0) {
    // F-1 + URL safety: chunk the id list (a large `.in()` overflows the ~8KB
    // request-line limit) AND page each chunk (a single read is clamped to 1000
    // — a corrupt accounting export silently dropped line items past that).
    const CHUNK = 100;
    for (let i = 0; i < invoiceIds.length; i += CHUNK) {
      const idsChunk = invoiceIds.slice(i, i + CHUNK);
      const { data: lis, error: lisError } = await fetchAllRows<LineItemRow>(
        (rangeFrom, rangeTo) =>
          supabase
            .from("invoice_line_items")
            .select("id, invoice_id, description, qty, unit_price, vat_rate, line_total, sort_order")
            .eq("org_id", ctx.org.id)
            .in("invoice_id", idsChunk)
            .order("invoice_id", { ascending: true })
            .order("sort_order", { ascending: true })
            .order("id", { ascending: true })
            .range(rangeFrom, rangeTo) as unknown as PromiseLike<{
            data: LineItemRow[] | null;
            error: unknown;
          }>,
      );
      if (lisError) {
        // A failed line-item read must not produce a CSV with silently
        // missing rows — that's a corrupt accounting export.
        console.error("[invoices] export line items failed", lisError);
        return NextResponse.json({ error: "Failed to export" }, { status: 500 });
      }
      for (const li of lis) {
        const arr = lineItemsByInvoice.get(li.invoice_id) ?? [];
        arr.push(li);
        lineItemsByInvoice.set(li.invoice_id, arr);
      }
    }
    // Page/chunk boundaries can interleave; restore per-invoice line order.
    for (const arr of lineItemsByInvoice.values()) {
      arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
  }

  const isXero = format === "xero";
  const header = isXero
    ? [
        "ContactName",
        "InvoiceNumber",
        "InvoiceDate",
        "DueDate",
        "Description",
        "Quantity",
        "UnitAmount",
        "AccountCode",
        "TaxType",
        "TaxAmount",
        "Currency",
      ]
    : [
        "ContactName",
        "Reference",
        "Date",
        "DueDate",
        "Description",
        "Quantity",
        "UnitPrice",
        "LedgerAccount",
        "TaxRate",
        "NetAmount",
        "TaxAmount",
        "Currency",
      ];
  const lines = [header.join(",")];

  for (const inv of rows) {
    const contact = inv.customer?.name ?? inv.quote?.customer?.name ?? "";
    const invDate = XERO_DATE(inv.created_at);
    const dueDate = inv.due_date ? XERO_DATE(`${inv.due_date}T00:00:00Z`) : "";

    const liList = lineItemsByInvoice.get(inv.id) ?? [];

    if (liList.length === 0) {
      // No source line items — collapse to a single fallback row using
      // the invoice's header totals so the import doesn't drop it.
      const net = Number(inv.amount ?? 0);
      const vat = Number(inv.vat_total ?? 0);
      const taxRate = net > 0 ? Math.round((vat / net) * 100) : 0;
      const row = isXero
        ? [
            contact,
            inv.number,
            invDate,
            dueDate,
            inv.notes ?? `Invoice ${inv.number}`,
            "1",
            net.toFixed(2),
            "",
            xeroTaxType(taxRate),
            vat.toFixed(2),
            "GBP",
          ]
        : [
            contact,
            inv.number,
            invDate,
            dueDate,
            inv.notes ?? `Invoice ${inv.number}`,
            "1",
            net.toFixed(2),
            "", // LedgerAccount — operator fills in Sage
            sageTaxRate(taxRate),
            net.toFixed(2),
            vat.toFixed(2),
            "GBP",
          ];
      lines.push(row.map(csvEscape).join(","));
      continue;
    }

    for (const li of liList) {
      const qty = Number(li.qty ?? 0);
      const unit = Number(li.unit_price ?? 0);
      const rate = Number(li.vat_rate ?? 0);
      const lineTotalNet = qty * unit;
      const taxAmount = lineTotalNet * (rate / 100);
      const row = isXero
        ? [
            contact,
            inv.number,
            invDate,
            dueDate,
            li.description,
            qty.toString(),
            unit.toFixed(2),
            "", // AccountCode — operator fills in Xero
            xeroTaxType(rate),
            taxAmount.toFixed(2),
            "GBP",
          ]
        : [
            contact,
            inv.number,
            invDate,
            dueDate,
            li.description,
            qty.toString(),
            unit.toFixed(2),
            "", // LedgerAccount — operator fills in Sage
            sageTaxRate(rate),
            lineTotalNet.toFixed(2),
            taxAmount.toFixed(2),
            "GBP",
          ];
      lines.push(row.map(csvEscape).join(","));
    }
  }

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="crewflow-invoices-${format}-${stamp}.csv"`,
    },
  });
}
