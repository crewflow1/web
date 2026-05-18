import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from "@react-pdf/renderer";

/**
 * Branded invoice PDF.
 *
 * Mirrors the quote PDF layout (lib/pdf/quote-pdf.tsx) so customers get
 * a consistent visual identity when a quote is accepted and the invoice
 * is issued. Key differences:
 *   - Title reads "Invoice <number>"
 *   - Shows due_date + paid_at audit instead of valid_until
 *   - Bank-details block is the call-to-action (customer pays from here)
 *
 * Server-side only via @react-pdf renderToBuffer.
 */

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#0f172a",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
  },
  logo: { width: 100, height: 50, objectFit: "contain" },
  orgBlock: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  orgName: { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  metaBlock: { fontSize: 9, textAlign: "right", color: "#475569", lineHeight: 1.5 },
  metaLabel: { color: "#64748b" },
  metaValue: { fontWeight: 700, color: "#0f172a" },
  invoiceTitle: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  statusPill: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    color: "#0f172a",
    backgroundColor: "#f1f5f9",
  },
  customerBlock: {
    backgroundColor: "#f8fafc",
    padding: 12,
    borderRadius: 6,
    marginBottom: 16,
  },
  customerLabel: { fontSize: 8, color: "#64748b", marginBottom: 2 },
  customerName: { fontSize: 12, fontWeight: 700 },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#64748b",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  table: {
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    marginBottom: 12,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  th: { fontSize: 8, fontWeight: 700, color: "#64748b", textTransform: "uppercase" },
  td: { fontSize: 10, color: "#0f172a" },
  colDesc: { flex: 4 },
  colQty: { flex: 1, textAlign: "right" },
  colUnit: { flex: 1.4, textAlign: "right" },
  colVat: { flex: 1, textAlign: "right" },
  colTotal: { flex: 1.5, textAlign: "right" },
  totalsBlock: {
    alignSelf: "flex-end",
    width: 220,
    marginBottom: 18,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  totalsGrand: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
  },
  grandLabel: { fontSize: 11, fontWeight: 700 },
  grandValue: { fontSize: 11, fontWeight: 700 },
  notesBlock: {
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
  },
  notesText: { fontSize: 9, lineHeight: 1.5, color: "#334155" },
  bankBlock: {
    marginTop: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    backgroundColor: "#f8fafc",
  },
  payCta: {
    fontSize: 9,
    color: "#475569",
    marginBottom: 6,
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    fontSize: 8,
    color: "#94a3b8",
    textAlign: "center",
  },
});

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type InvoicePdfInput = {
  number: string;
  status: string;
  amount: number;
  vat_total: number;
  total: number;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  customer_name: string | null;
  org_name: string;
  org_phone: string | null;
  org_vat_number: string | null;
  org_logo_url: string | null;
  org_address: {
    line1?: string;
    city?: string;
    postcode?: string;
  } | null;
  org_bank_details: {
    name?: string;
    sort_code?: string;
    account_number?: string;
    reference?: string;
  } | null;
  line_items: Array<{
    description: string;
    qty: number;
    unit_price: number;
    vat_rate: number;
    line_total: number;
  }>;
};

export function InvoicePdf({ inv }: { inv: InvoicePdfInput }) {
  const addr = inv.org_address ?? {};
  const addrLine = [addr.line1, addr.city, addr.postcode]
    .filter(Boolean)
    .join(", ");

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.orgName}>{inv.org_name}</Text>
            <View style={styles.orgBlock}>
              {addrLine ? <Text>{addrLine}</Text> : null}
              {inv.org_phone ? <Text>{inv.org_phone}</Text> : null}
              {inv.org_vat_number ? <Text>VAT no. {inv.org_vat_number}</Text> : null}
            </View>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            {inv.org_logo_url ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image style={styles.logo} src={inv.org_logo_url} />
            ) : null}
          </View>
        </View>

        {/* Title + meta */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <View>
            <Text style={styles.invoiceTitle}>Invoice {inv.number}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
              <Text style={styles.statusPill}>{inv.status.toUpperCase()}</Text>
            </View>
          </View>
          <View style={styles.metaBlock}>
            {inv.due_date ? (
              <Text>
                <Text style={styles.metaLabel}>Due: </Text>
                <Text style={styles.metaValue}>{inv.due_date}</Text>
              </Text>
            ) : null}
            {inv.paid_at ? (
              <Text>
                <Text style={styles.metaLabel}>Paid: </Text>
                <Text style={styles.metaValue}>{inv.paid_at.slice(0, 10)}</Text>
              </Text>
            ) : null}
          </View>
        </View>

        {/* Customer */}
        <View style={styles.customerBlock}>
          <Text style={styles.customerLabel}>BILL TO</Text>
          <Text style={styles.customerName}>{inv.customer_name ?? "—"}</Text>
        </View>

        {/* Line items */}
        {inv.line_items.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Line items</Text>
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, styles.colDesc]}>Description</Text>
                <Text style={[styles.th, styles.colQty]}>Qty</Text>
                <Text style={[styles.th, styles.colUnit]}>Unit</Text>
                <Text style={[styles.th, styles.colVat]}>VAT %</Text>
                <Text style={[styles.th, styles.colTotal]}>Line total</Text>
              </View>
              {inv.line_items.map((li, i) => (
                <View style={styles.tableRow} key={i}>
                  <Text style={[styles.td, styles.colDesc]}>{li.description}</Text>
                  <Text style={[styles.td, styles.colQty]}>{li.qty}</Text>
                  <Text style={[styles.td, styles.colUnit]}>
                    {GBP.format(li.unit_price)}
                  </Text>
                  <Text style={[styles.td, styles.colVat]}>{li.vat_rate}%</Text>
                  <Text style={[styles.td, styles.colTotal]}>
                    {GBP.format(li.line_total)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Totals */}
        <View style={styles.totalsBlock}>
          <View style={styles.totalsRow}>
            <Text>Net</Text>
            <Text>{GBP.format(inv.amount)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text>VAT</Text>
            <Text>{GBP.format(inv.vat_total)}</Text>
          </View>
          <View style={styles.totalsGrand}>
            <Text style={styles.grandLabel}>Total due</Text>
            <Text style={styles.grandValue}>{GBP.format(inv.total)}</Text>
          </View>
        </View>

        {/* Notes */}
        {inv.notes ? (
          <View style={styles.notesBlock}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{inv.notes}</Text>
          </View>
        ) : null}

        {/* Bank — call-to-action for payment */}
        {inv.org_bank_details ? (
          <View style={styles.bankBlock}>
            <Text style={styles.sectionTitle}>Pay by bank transfer</Text>
            <Text style={styles.payCta}>
              Please use the reference below so we can match your payment.
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, color: "#64748b" }}>Account name</Text>
                <Text style={{ fontSize: 10 }}>{inv.org_bank_details.name ?? "—"}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, color: "#64748b" }}>Sort code</Text>
                <Text style={{ fontSize: 10 }}>{inv.org_bank_details.sort_code ?? "—"}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, color: "#64748b" }}>Account number</Text>
                <Text style={{ fontSize: 10 }}>{inv.org_bank_details.account_number ?? "—"}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, color: "#64748b" }}>Reference</Text>
                <Text style={{ fontSize: 10 }}>{inv.org_bank_details.reference ?? inv.number}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <Text style={styles.footer} fixed>
          {inv.org_name} · Invoice {inv.number} · generated by CrewFlow
        </Text>
      </Page>
    </Document>
  );
}
