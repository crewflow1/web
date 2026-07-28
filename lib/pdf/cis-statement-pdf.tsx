import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * CIS Payment and Deduction Statement — the document a contractor must give a
 * subcontractor for each tax month in which a payment was made.
 *
 * A SIBLING of the completion-certificate and toolbox-talk PDFs: same StyleSheet
 * vocabulary (letterhead, id block, section titles, page-numbered footer), its
 * own document. Rendered on demand from the FROZEN `cis_statements` row, exactly
 * as those do — nothing is stored, so there are no bytes to drift from the
 * record, and the row's content_hash is proof of what was issued.
 *
 * ── EVERY REQUIRED FIELD, AND WHY IT IS HERE ────────────────────────────────
 * CIS340 §3.15 / CISR12160 (verified 28 July 2026):
 *   1. "contractor's own name and employer tax reference"  → contractorName / contractorPaye
 *   2. "end date of the tax month in which the payment was made" → taxMonthEnd
 *   3. subcontractor name and UTR                          → subcontractorName / utr
 *   4. "personal verification number if the subcontractor could not be verified
 *      and a deduction at the higher rate has been made"   → verification
 *   5. "gross amount of the payments made"                 → grossAmount
 *   6. "cost of any materials that has reduced the amount" → materialsAmount
 *   7. "amount of the deduction"                           → deductionAmount
 *
 * ── TWO THINGS THIS DOCUMENT WILL NOT DO ────────────────────────────────────
 *  * It never invents a verification number. When one is required and not held,
 *    it prints the absence in words (see `verification.kind === "missing"`).
 *  * It never claims anything was filed with HMRC. This is a statement to a
 *    subcontractor; it is not a return and says so nowhere.
 */

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  orgName: { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  orgBlock: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  title: { fontSize: 16, fontWeight: 700, marginBottom: 2, textAlign: "right" },
  metaBlock: { fontSize: 9, textAlign: "right", color: "#475569", lineHeight: 1.5 },
  metaValue: { fontWeight: 700, color: "#0f172a" },
  statusPill: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, color: "#065f46", backgroundColor: "#d1fae5", marginTop: 4 },
  warnPill: { color: "#92400e", backgroundColor: "#fef3c7" },
  deadPill: { color: "#475569", backgroundColor: "#e2e8f0" },
  idBlock: { backgroundColor: "#f8fafc", padding: 12, borderRadius: 6, marginBottom: 16, flexDirection: "row", flexWrap: "wrap" },
  idCell: { width: "50%", marginBottom: 6 },
  idLabel: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  idValue: { fontSize: 10, color: "#0f172a" },
  sectionTitle: { fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginTop: 12, marginBottom: 6, letterSpacing: 0.5 },
  para: { fontSize: 9, lineHeight: 1.5, color: "#334155", marginBottom: 4 },
  parties: { flexDirection: "row", gap: 12, marginBottom: 4 },
  party: { flex: 1, backgroundColor: "#f8fafc", borderRadius: 6, padding: 10 },
  partyLine: { fontSize: 10, color: "#0f172a", marginTop: 2 },
  moneyTable: { marginTop: 6, borderTopWidth: 1, borderTopColor: "#e2e8f0" },
  moneyRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  moneyLabel: { fontSize: 10, color: "#334155" },
  moneyValue: { fontSize: 10, color: "#0f172a", fontWeight: 700 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, backgroundColor: "#f1f5f9", paddingHorizontal: 8, borderRadius: 4, marginTop: 4 },
  totalLabel: { fontSize: 11, fontWeight: 700, color: "#0f172a" },
  totalValue: { fontSize: 12, fontWeight: 700, color: "#0f172a" },
  breakdownHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#cbd5e1", paddingBottom: 4, marginTop: 4 },
  breakdownRow: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  cDate: { width: "22%", fontSize: 9 },
  cNum: { width: "26%", fontSize: 9, textAlign: "right" },
  headCell: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4 },
  notice: { marginTop: 14, padding: 10, backgroundColor: "#f8fafc", borderRadius: 6, borderLeftWidth: 3, borderLeftColor: "#94a3b8" },
  warnNotice: { backgroundColor: "#fffbeb", borderLeftColor: "#f59e0b" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

export type CisStatementPdfInput = {
  statementNumber: string;
  status: "issued" | "superseded" | "withdrawn";
  /** Contractor's own name — HMRC required field 1. */
  contractorName: string;
  /** Employer PAYE reference — HMRC required field 1. */
  contractorPaye: string;
  contractorBlockLines: string[];
  /** HMRC required field 2. */
  taxMonthEnd: string;
  taxMonthLabel: string;
  statementDueOn: string;
  /** HMRC required field 3. */
  subcontractorName: string;
  /**
   * The subcontractor's UTR. `full` when the profile still holds the same UTR
   * this statement was issued against (verified by comparing the frozen mask);
   * `masked` when it has since changed or is no longer held, so the document
   * shows what WAS used rather than a number that may now be different.
   */
  utr: { kind: "full" | "masked" | "absent"; value: string | null };
  /** HMRC required field 4 — never fabricated. */
  verification: { kind: "not_required" | "present" | "missing"; text: string | null };
  /** HMRC required field 5 — ex-VAT, ex-CITB levy. */
  grossAmount: string;
  /** HMRC required field 6. */
  materialsAmount: string;
  /** HMRC required field 7. */
  deductionAmount: string;
  netPaid: string;
  rateLabel: string;
  isStatutory: boolean;
  issuedOn: string;
  payments: Array<{ paidOn: string; gross: string; materials: string; deduction: string }>;
  supersededNote: string | null;
  withdrawnNote: string | null;
  contentHash: string;
  generatedAt: string;
};

function IdCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.idCell}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={styles.idValue}>{value}</Text>
    </View>
  );
}

export function CisStatementPdf({ s }: { s: CisStatementPdfInput }) {
  const utrText =
    s.utr.kind === "absent" ? "Not held" : (s.utr.value ?? "Not held");

  return (
    <Document title={`CIS payment and deduction statement ${s.statementNumber}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.orgName}>{s.contractorName}</Text>
            {s.contractorBlockLines.map((l, i) => (
              <Text key={i} style={styles.orgBlock}>{l}</Text>
            ))}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.title}>Payment and Deduction</Text>
            <Text style={styles.title}>Statement</Text>
            <Text style={styles.metaBlock}>
              <Text style={styles.metaValue}>{s.statementNumber}</Text>
            </Text>
            <Text
              style={[
                styles.statusPill,
                ...(s.status === "issued" ? [] : [styles.deadPill]),
              ]}
            >
              {s.status === "issued" ? "Issued" : s.status === "superseded" ? "Replaced" : "Withdrawn"}
            </Text>
          </View>
        </View>

        {/* HMRC required fields 1 and 2 — contractor identity and the tax month. */}
        <View style={styles.idBlock}>
          <IdCell label="Employer PAYE reference" value={s.contractorPaye} />
          <IdCell label="Tax month ending" value={s.taxMonthEnd} />
          <IdCell label="Tax month" value={s.taxMonthLabel} />
          <IdCell label="Statement due to subcontractor by" value={s.statementDueOn} />
        </View>

        {/* HMRC required fields 3 and 4 — the subcontractor. */}
        <Text style={styles.sectionTitle}>Subcontractor</Text>
        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.idLabel}>Name</Text>
            <Text style={styles.partyLine}>{s.subcontractorName}</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.idLabel}>Unique Taxpayer Reference (UTR)</Text>
            <Text style={styles.partyLine}>{utrText}</Text>
          </View>
        </View>

        {s.verification.kind !== "not_required" ? (
          <View style={[styles.notice, ...(s.verification.kind === "missing" ? [styles.warnNotice] : [])]}>
            <Text style={styles.idLabel}>Verification number</Text>
            <Text style={styles.partyLine}>
              {s.verification.kind === "present" ? s.verification.text : s.verification.text}
            </Text>
          </View>
        ) : null}

        {/* HMRC required fields 5, 6 and 7 — the money. */}
        <Text style={styles.sectionTitle}>Payments in this tax month</Text>
        <View style={styles.moneyTable}>
          <View style={styles.moneyRow}>
            <Text style={styles.moneyLabel}>Gross amount paid (excluding VAT)</Text>
            <Text style={styles.moneyValue}>{s.grossAmount}</Text>
          </View>
          <View style={styles.moneyRow}>
            <Text style={styles.moneyLabel}>Less cost of materials</Text>
            <Text style={styles.moneyValue}>{s.materialsAmount}</Text>
          </View>
          <View style={styles.moneyRow}>
            <Text style={styles.moneyLabel}>Amount liable to deduction{s.rateLabel ? ` · ${s.rateLabel}` : ""}</Text>
            <Text style={styles.moneyValue}>{s.netPaid}</Text>
          </View>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Amount deducted</Text>
          <Text style={styles.totalValue}>{s.deductionAmount}</Text>
        </View>

        {s.payments.length > 1 ? (
          <>
            <Text style={styles.sectionTitle}>Breakdown by payment</Text>
            <View style={styles.breakdownHead}>
              <Text style={[styles.cDate, styles.headCell]}>Paid on</Text>
              <Text style={[styles.cNum, styles.headCell]}>Gross (ex-VAT)</Text>
              <Text style={[styles.cNum, styles.headCell]}>Materials</Text>
              <Text style={[styles.cNum, styles.headCell]}>Deducted</Text>
            </View>
            {s.payments.map((p, i) => (
              <View key={i} style={styles.breakdownRow}>
                <Text style={styles.cDate}>{p.paidOn}</Text>
                <Text style={styles.cNum}>{p.gross}</Text>
                <Text style={styles.cNum}>{p.materials}</Text>
                <Text style={styles.cNum}>{p.deduction}</Text>
              </View>
            ))}
          </>
        ) : null}

        {!s.isStatutory ? (
          <View style={styles.notice}>
            <Text style={styles.para}>
              No deduction was made from these payments. HMRC does not require a statement where a
              subcontractor is paid gross; this one is provided as a record.
            </Text>
          </View>
        ) : null}

        {s.supersededNote ? (
          <View style={[styles.notice, styles.warnNotice]}>
            <Text style={styles.para}>{s.supersededNote}</Text>
          </View>
        ) : null}
        {s.withdrawnNote ? (
          <View style={[styles.notice, styles.warnNotice]}>
            <Text style={styles.para}>{s.withdrawnNote}</Text>
          </View>
        ) : null}

        <View style={styles.notice}>
          <Text style={styles.para}>
            The gross amount above excludes VAT and any CITB levy recovered, and the amount deducted
            has been calculated on the gross amount after the cost of materials shown.
          </Text>
          <Text style={styles.para}>
            Keep this statement. You will need it to claim credit for the deductions shown.
          </Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {s.statementNumber} · issued {s.issuedOn} · ref {s.contentHash.slice(0, 12)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
