import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";

/**
 * Quarterly tax-summary PDF. Used as an audit trail for the org's
 * accountant — totals plus every invoice + finance row that fed into
 * the VAT estimate. Not a tax return.
 */

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#475569", marginBottom: 16 },
  banner: {
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 4,
    padding: 10,
    marginBottom: 16,
    fontSize: 9,
    color: "#78350f",
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#64748b",
    marginTop: 10,
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  totalsBlock: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  totalsCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 10,
  },
  totalsLabel: { fontSize: 8, color: "#64748b", textTransform: "uppercase" },
  totalsValue: { fontSize: 14, fontWeight: 700, marginTop: 4 },
  table: { borderTopWidth: 1, borderTopColor: "#e2e8f0", marginBottom: 12 },
  thRow: {
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  tr: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  th: { fontSize: 8, fontWeight: 700, color: "#64748b", textTransform: "uppercase" },
  td: { fontSize: 9, color: "#0f172a" },
  colDate: { flex: 1.2 },
  colRef: { flex: 2 },
  colNet: { flex: 1.3, textAlign: "right" },
  colVat: { flex: 1.3, textAlign: "right" },
  colTotal: { flex: 1.3, textAlign: "right" },
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

export type QuarterRow = {
  date: string;
  ref: string;
  net: number;
  vat: number;
  total: number;
};

export type TaxQuarterPdfInput = {
  org_name: string;
  org_vat_number: string | null;
  quarter_start: string; // YYYY-MM-DD
  quarter_end: string; // YYYY-MM-DD
  output_vat: number;
  input_vat: number;
  net_payable: number;
  /**
   * Domestic reverse-charge VAT (S55A) inside output & input VAT for the quarter.
   * Self-accounted: it is in BOTH the Output VAT and Input VAT cards, so the net
   * is unchanged. Surfaced as a note so the cards reconcile with the row lists
   * (the reverse-charge VAT is a self-assessment, not one of the payment rows).
   */
  reverse_charge_vat?: number;
  paid_invoices: QuarterRow[];
  finance_rows: QuarterRow[];
};

export function TaxQuarterPdf({ data }: { data: TaxQuarterPdfInput }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>VAT quarter — {data.org_name}</Text>
        <Text style={styles.subtitle}>
          {data.quarter_start} to {data.quarter_end}
          {data.org_vat_number ? `  ·  VAT no. ${data.org_vat_number}` : ""}
        </Text>

        <View style={styles.banner}>
          <Text>
            ESTIMATE ONLY. Derived from the invoices + finances logged in
            CrewFlow for this quarter. Not a VAT return — confirm with your
            accountant before submitting to HMRC.
          </Text>
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.totalsCard}>
            <Text style={styles.totalsLabel}>Output VAT</Text>
            <Text style={styles.totalsValue}>{GBP.format(data.output_vat)}</Text>
          </View>
          <View style={styles.totalsCard}>
            <Text style={styles.totalsLabel}>Input VAT</Text>
            <Text style={styles.totalsValue}>{GBP.format(data.input_vat)}</Text>
          </View>
          <View style={styles.totalsCard}>
            <Text style={styles.totalsLabel}>Net payable</Text>
            <Text style={styles.totalsValue}>{GBP.format(data.net_payable)}</Text>
          </View>
        </View>

        {data.reverse_charge_vat && data.reverse_charge_vat > 0 ? (
          <Text style={{ fontSize: 8, color: "#475569", marginBottom: 12 }}>
            Includes {GBP.format(data.reverse_charge_vat)} of domestic
            reverse-charge VAT (VAT Act 1994 s.55A) self-accounted in BOTH output
            and input VAT — net effect nil.
          </Text>
        ) : null}

        <Text style={styles.sectionTitle}>
          Payments received ({data.paid_invoices.length})
        </Text>
        <View style={styles.table}>
          <View style={styles.thRow}>
            <Text style={[styles.th, styles.colDate]}>Paid on</Text>
            <Text style={[styles.th, styles.colRef]}>Invoice</Text>
            <Text style={[styles.th, styles.colNet]}>Net</Text>
            <Text style={[styles.th, styles.colVat]}>VAT</Text>
            <Text style={[styles.th, styles.colTotal]}>Total</Text>
          </View>
          {data.paid_invoices.length === 0 ? (
            <View style={styles.tr}>
              <Text style={[styles.td, { flex: 1 }]}>
                No payments received in this quarter.
              </Text>
            </View>
          ) : (
            data.paid_invoices.map((r, i) => (
              <View style={styles.tr} key={`inv-${i}`}>
                <Text style={[styles.td, styles.colDate]}>{r.date}</Text>
                <Text style={[styles.td, styles.colRef]}>{r.ref}</Text>
                <Text style={[styles.td, styles.colNet]}>{GBP.format(r.net)}</Text>
                <Text style={[styles.td, styles.colVat]}>{GBP.format(r.vat)}</Text>
                <Text style={[styles.td, styles.colTotal]}>
                  {GBP.format(r.total)}
                </Text>
              </View>
            ))
          )}
        </View>

        <Text style={styles.sectionTitle}>
          Finance / expense rows ({data.finance_rows.length})
        </Text>
        <View style={styles.table}>
          <View style={styles.thRow}>
            <Text style={[styles.th, styles.colDate]}>Date</Text>
            <Text style={[styles.th, styles.colRef]}>Category</Text>
            <Text style={[styles.th, styles.colNet]}>Net</Text>
            <Text style={[styles.th, styles.colVat]}>VAT</Text>
            <Text style={[styles.th, styles.colTotal]}>Total</Text>
          </View>
          {data.finance_rows.length === 0 ? (
            <View style={styles.tr}>
              <Text style={[styles.td, { flex: 1 }]}>
                No cost entries in this quarter.
              </Text>
            </View>
          ) : (
            data.finance_rows.map((r, i) => (
              <View style={styles.tr} key={`fin-${i}`}>
                <Text style={[styles.td, styles.colDate]}>{r.date}</Text>
                <Text style={[styles.td, styles.colRef]}>{r.ref}</Text>
                <Text style={[styles.td, styles.colNet]}>{GBP.format(r.net)}</Text>
                <Text style={[styles.td, styles.colVat]}>{GBP.format(r.vat)}</Text>
                <Text style={[styles.td, styles.colTotal]}>
                  {GBP.format(r.total)}
                </Text>
              </View>
            ))
          )}
        </View>

        <Text style={styles.footer} fixed>
          {data.org_name} · VAT quarter {data.quarter_start} → {data.quarter_end}
          · generated by CrewFlow · estimate only
        </Text>
      </Page>
    </Document>
  );
}
