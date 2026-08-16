import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from "@react-pdf/renderer";
import { formatGbp } from "@/lib/money";
import { formatDateShortUK } from "@/lib/time/format";

/**
 * Branded Customer Statement of Account PDF — the client-ready deliverable.
 *
 * Reuses the invoice / site-report PDF architecture (@react-pdf/renderer,
 * server-side renderToBuffer, org letterhead + logo, an "as-at" meta block, a
 * ruled ledger table, and a fixed footer with page numbers). It renders a plain
 * input built by server/services/customer-statement.ts from the pure
 * `buildCustomerStatement` fold, so download, email and portal all print the
 * same document.
 *
 * A NEGATIVE balance is a CREDIT balance (the customer is in front / has
 * overpaid); it is labelled as such rather than shown as a bare minus, which a
 * reader misreads as "you owe minus X".
 */

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  logo: { width: 100, height: 50, objectFit: "contain" },
  orgName: { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  orgBlock: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  subtitle: { fontSize: 9, color: "#64748b", marginTop: 2 },
  metaBlock: { fontSize: 9, textAlign: "right", color: "#475569", lineHeight: 1.5 },
  metaLabel: { color: "#64748b" },
  metaValue: { fontWeight: 700, color: "#0f172a" },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16, gap: 12 },
  partyBlock: { flex: 1, backgroundColor: "#f8fafc", padding: 12, borderRadius: 6 },
  partyLabel: { fontSize: 7, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  partyName: { fontSize: 11, fontWeight: 700, color: "#0f172a" },
  partyLine: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  summaryRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  summary: { flex: 1, backgroundColor: "#f8fafc", borderRadius: 6, padding: 8 },
  summaryHi: { flex: 1, backgroundColor: "#eff6ff", borderRadius: 6, padding: 8, borderWidth: 1, borderColor: "#bfdbfe" },
  summaryL: { fontSize: 7, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  summaryV: { fontSize: 13, fontWeight: 700, marginTop: 2 },
  table: { borderTopWidth: 1, borderTopColor: "#e2e8f0", marginBottom: 8 },
  tHead: { flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  tRowOpen: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#e2e8f0", backgroundColor: "#f8fafc" },
  tRowClose: { flexDirection: "row", paddingVertical: 6, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: "#0f172a" },
  th: { fontSize: 8, fontWeight: 700, color: "#64748b", textTransform: "uppercase" },
  td: { fontSize: 9, color: "#0f172a" },
  colDate: { width: "16%" },
  colDetails: { width: "40%" },
  colMoney: { width: "14.66%", textAlign: "right" },
  tdMuted: { fontSize: 9, color: "#94a3b8", textAlign: "right" },
  bold: { fontWeight: 700 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

type AddressShape = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
} | null;

export type StatementPdfEntry = {
  date: string;
  description: string;
  charge: number;
  credit: number;
  balance: number;
};

export type StatementPdfInput = {
  org_name: string;
  org_phone: string | null;
  org_vat_number: string | null;
  org_logo_url: string | null;
  org_address: AddressShape;
  customer_name: string;
  customer_email: string | null;
  customer_address: AddressShape;
  /** Range bounds (YYYY-MM-DD) or null when open-ended. */
  from: string | null;
  to: string | null;
  /** ISO timestamp this statement was produced. */
  generated_at: string;
  openingBalance: number;
  closingBalance: number;
  totalCharged: number;
  totalCredited: number;
  entries: StatementPdfEntry[];
};

/** A currency figure, presented so a credit balance reads as a credit. */
function balanceLabel(v: number): string {
  if (v < 0) return `${formatGbp(-v)} CR`;
  return formatGbp(v);
}

function addressLines(a: AddressShape): string[] {
  if (!a) return [];
  return [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
}

function fmtDay(day: string): string {
  return day ? formatDateShortUK(`${day}T00:00:00Z`) : "—";
}

export function StatementPdf({ s }: { s: StatementPdfInput }) {
  const orgAddr = addressLines(s.org_address);
  const custAddr = addressLines(s.customer_address);
  const period =
    s.from && s.to
      ? `${fmtDay(s.from)} – ${fmtDay(s.to)}`
      : s.from
        ? `From ${fmtDay(s.from)}`
        : s.to
          ? `Up to ${fmtDay(s.to)}`
          : "All activity";

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Letterhead */}
        <View style={styles.headerRow} fixed>
          <View style={{ flex: 1 }}>
            <Text style={styles.orgName}>{s.org_name}</Text>
            <View style={styles.orgBlock}>
              {orgAddr.map((l, i) => (
                <Text key={i}>{l}</Text>
              ))}
              {s.org_phone ? <Text>{s.org_phone}</Text> : null}
              {s.org_vat_number ? <Text>VAT no. {s.org_vat_number}</Text> : null}
            </View>
          </View>
          {s.org_logo_url ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image style={styles.logo} src={s.org_logo_url} />
          ) : null}
        </View>

        {/* Title + as-at meta */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 14 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Statement of account</Text>
            <Text style={styles.subtitle}>{period}</Text>
          </View>
          <View style={styles.metaBlock}>
            <Text>
              <Text style={styles.metaLabel}>Issued </Text>
              <Text style={styles.metaValue}>{fmtDay(s.generated_at.slice(0, 10))}</Text>
            </Text>
          </View>
        </View>

        {/* Parties */}
        <View style={styles.parties}>
          <View style={styles.partyBlock}>
            <Text style={styles.partyLabel}>Account</Text>
            <Text style={styles.partyName}>{s.customer_name}</Text>
            {custAddr.map((l, i) => (
              <Text key={i} style={styles.partyLine}>
                {l}
              </Text>
            ))}
            {s.customer_email ? <Text style={styles.partyLine}>{s.customer_email}</Text> : null}
          </View>
          <View style={styles.partyBlock}>
            <Text style={styles.partyLabel}>Balance due</Text>
            <Text style={[styles.partyName, { fontSize: 16 }]}>
              {balanceLabel(s.closingBalance)}
            </Text>
            <Text style={styles.partyLine}>as at {fmtDay(s.to ?? s.generated_at.slice(0, 10))}</Text>
          </View>
        </View>

        {/* Summary tiles */}
        <View style={styles.summaryRow}>
          <View style={styles.summary}>
            <Text style={styles.summaryL}>Opening balance</Text>
            <Text style={styles.summaryV}>{balanceLabel(s.openingBalance)}</Text>
          </View>
          <View style={styles.summary}>
            <Text style={styles.summaryL}>Invoiced</Text>
            <Text style={styles.summaryV}>{formatGbp(s.totalCharged)}</Text>
          </View>
          <View style={styles.summary}>
            <Text style={styles.summaryL}>Received</Text>
            <Text style={styles.summaryV}>{formatGbp(s.totalCredited)}</Text>
          </View>
          <View style={styles.summaryHi}>
            <Text style={styles.summaryL}>Closing balance</Text>
            <Text style={styles.summaryV}>{balanceLabel(s.closingBalance)}</Text>
          </View>
        </View>

        {/* Ledger */}
        <View style={styles.table}>
          <View style={styles.tHead} fixed>
            <Text style={[styles.th, styles.colDate]}>Date</Text>
            <Text style={[styles.th, styles.colDetails]}>Details</Text>
            <Text style={[styles.th, styles.colMoney]}>Charges</Text>
            <Text style={[styles.th, styles.colMoney]}>Payments</Text>
            <Text style={[styles.th, styles.colMoney]}>Balance</Text>
          </View>

          <View style={styles.tRowOpen} wrap={false}>
            <Text style={[styles.td, styles.colDate]}>{fmtDay(s.from ?? "")}</Text>
            <Text style={[styles.td, styles.colDetails, styles.bold]}>Opening balance</Text>
            <Text style={[styles.tdMuted, styles.colMoney]}>—</Text>
            <Text style={[styles.tdMuted, styles.colMoney]}>—</Text>
            <Text style={[styles.td, styles.colMoney, styles.bold]}>
              {balanceLabel(s.openingBalance)}
            </Text>
          </View>

          {s.entries.map((e, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={[styles.td, styles.colDate]}>{fmtDay(e.date)}</Text>
              <Text style={[styles.td, styles.colDetails]}>{e.description}</Text>
              <Text style={[e.charge > 0 ? styles.td : styles.tdMuted, styles.colMoney]}>
                {e.charge > 0 ? formatGbp(e.charge) : "—"}
              </Text>
              <Text style={[e.credit > 0 ? styles.td : styles.tdMuted, styles.colMoney]}>
                {e.credit > 0 ? formatGbp(e.credit) : "—"}
              </Text>
              <Text style={[styles.td, styles.colMoney]}>{balanceLabel(e.balance)}</Text>
            </View>
          ))}

          {s.entries.length === 0 ? (
            <View style={styles.tRow} wrap={false}>
              <Text style={[styles.tdMuted, { width: "100%", textAlign: "center" }]}>
                No account activity in this period.
              </Text>
            </View>
          ) : null}

          <View style={styles.tRowClose} wrap={false}>
            <Text style={[styles.td, styles.colDate]}>{fmtDay(s.to ?? s.generated_at.slice(0, 10))}</Text>
            <Text style={[styles.td, styles.colDetails, styles.bold]}>Closing balance</Text>
            <Text style={[styles.td, styles.colMoney, styles.bold]}>{formatGbp(s.totalCharged)}</Text>
            <Text style={[styles.td, styles.colMoney, styles.bold]}>{formatGbp(s.totalCredited)}</Text>
            <Text style={[styles.td, styles.colMoney, styles.bold]}>
              {balanceLabel(s.closingBalance)}
            </Text>
          </View>
        </View>

        <Text style={{ fontSize: 8, color: "#94a3b8", marginTop: 8 }}>
          A credit balance (CR) means the account is in credit. Please quote the invoice number
          shown against any payment.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            {s.org_name} · Statement for {s.customer_name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
