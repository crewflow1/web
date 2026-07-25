import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import type { CertificateSnapshot } from "@/lib/completion-certificates/snapshot";

/**
 * Practical Completion Certificate PDF — the customer-ready contractual document.
 *
 * A SIBLING of the site-report PDF: it reuses the same StyleSheet vocabulary
 * (letterhead, id block, section titles, footer with page numbers) but is its own
 * document — a single-page statement of completion, not a progress report. Renders
 * from the frozen customer-safe snapshot; all substantive content is real <Text>
 * (selectable/searchable) and the smallest type is bumped for a printed legal doc.
 */

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  logo: { width: 100, height: 50, objectFit: "contain" },
  orgName: { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  orgBlock: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  metaBlock: { fontSize: 9, textAlign: "right", color: "#475569", lineHeight: 1.5 },
  metaValue: { fontWeight: 700, color: "#0f172a" },
  statusPill: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, color: "#065f46", backgroundColor: "#d1fae5", marginTop: 4 },
  draftPill: { color: "#475569", backgroundColor: "#e2e8f0" },
  idBlock: { backgroundColor: "#f8fafc", padding: 12, borderRadius: 6, marginBottom: 16, flexDirection: "row", flexWrap: "wrap" },
  idCell: { width: "33%", marginBottom: 6 },
  idLabel: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  idValue: { fontSize: 10, color: "#0f172a" },
  sectionTitle: { fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginTop: 12, marginBottom: 6, letterSpacing: 0.5 },
  para: { fontSize: 10, lineHeight: 1.5, color: "#334155", marginBottom: 4 },
  parties: { flexDirection: "row", gap: 12, marginBottom: 4 },
  party: { flex: 1, backgroundColor: "#f8fafc", borderRadius: 6, padding: 10 },
  signBlock: { marginTop: 24, borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 12, flexDirection: "row", justifyContent: "space-between" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

export type CertificatePdfInput = {
  orgName: string;
  orgBlockLines: string[];
  logoUrl: string | null;
  snapshot: CertificateSnapshot;
  isDraft: boolean;
};

function IdCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.idCell}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={styles.idValue}>{value}</Text>
    </View>
  );
}

export function CompletionCertificatePdf({ c }: { c: CertificatePdfInput }) {
  const s = c.snapshot;
  return (
    <Document title={`Completion certificate ${s.certificate_number}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            {c.logoUrl ? <Image style={styles.logo} src={c.logoUrl} /> : <Text style={styles.orgName}>{c.orgName}</Text>}
            {c.logoUrl ? <Text style={styles.orgName}>{c.orgName}</Text> : null}
            {c.orgBlockLines.map((l, i) => (
              <Text key={i} style={styles.orgBlock}>{l}</Text>
            ))}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.title}>Practical Completion</Text>
            <Text style={styles.title}>Certificate</Text>
            <Text style={styles.metaBlock}>
              <Text style={styles.metaValue}>{s.certificate_number}</Text>
            </Text>
            <Text style={[styles.statusPill, ...(c.isDraft ? [styles.draftPill] : [])]}>
              {c.isDraft ? "Draft — preview" : "Issued"}
            </Text>
          </View>
        </View>

        <View style={styles.idBlock}>
          <IdCell label="Practical completion" value={s.completion_date} />
          <IdCell label="Defects liability" value={`${s.defects_liability_months} months`} />
          <IdCell label="Defects period ends" value={s.defects_liability_end} />
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.idLabel}>Contractor</Text>
            <Text style={styles.idValue}>{s.contractor_name}</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.idLabel}>Client</Text>
            <Text style={styles.idValue}>{s.customer_name ?? "—"}</Text>
          </View>
        </View>
        {s.site_address ? (
          <>
            <Text style={styles.sectionTitle}>Site</Text>
            <Text style={styles.para}>{s.site_address}</Text>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Certificate</Text>
        <Text style={styles.para}>
          {s.statement ??
            `This certifies that the works described below reached Practical Completion on ${s.completion_date}. The Defects Liability Period runs for ${s.defects_liability_months} months, ending ${s.defects_liability_end}.`}
        </Text>

        <Text style={styles.sectionTitle}>Works completed</Text>
        <Text style={styles.para}>{s.works_description}</Text>

        {s.handover_notes ? (
          <>
            <Text style={styles.sectionTitle}>Handover</Text>
            <Text style={styles.para}>{s.handover_notes}</Text>
          </>
        ) : null}
        {s.retention_note ? (
          <>
            <Text style={styles.sectionTitle}>Retention</Text>
            <Text style={styles.para}>{s.retention_note}</Text>
          </>
        ) : null}

        <View style={styles.signBlock}>
          <View>
            <Text style={styles.idLabel}>Issued by</Text>
            <Text style={styles.idValue}>{s.signatory_name ?? c.orgName}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.idLabel}>Date issued</Text>
            <Text style={styles.idValue}>{s.issued_on}</Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>{s.certificate_number} · {c.orgName}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
