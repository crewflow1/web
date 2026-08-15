import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from "@react-pdf/renderer";
import type { ReportDocument, ReportSection } from "@/lib/reports/documents";

/**
 * Shared REPORT PDF — the branded, letterheaded deliverable for every /reports
 * report (profit, cashflow, utilisation, pipeline, overview).
 *
 * Reuses the invoice/quote/site-report PDF architecture (@react-pdf/renderer,
 * server-side renderToBuffer, org letterhead + logo, fixed footer with page
 * numbers). It renders a `ReportDocument` generically — a title block plus one
 * table per section — so a new report needs no new PDF component: it just
 * produces a document and this renders it.
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
  sectionTitle: { fontSize: 11, fontWeight: 700, color: "#1e293b", marginTop: 16, marginBottom: 2, letterSpacing: 0.3 },
  sectionNote: { fontSize: 8, color: "#64748b", marginBottom: 6 },
  table: { borderTopWidth: 1, borderTopColor: "#e2e8f0" },
  tHead: { flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tRow: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  th: { fontSize: 8, fontWeight: 700, color: "#64748b", textTransform: "uppercase" },
  td: { fontSize: 9, color: "#0f172a" },
  empty: { fontSize: 9, color: "#94a3b8", fontStyle: "italic", paddingVertical: 6 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

export type ReportPdfOrg = {
  name: string;
  phone: string | null;
  vat_number: string | null;
  logo_url: string | null;
  address: { line1?: string; city?: string; postcode?: string } | null;
};

function SectionTable({ section }: { section: ReportSection }) {
  const flexes = section.columns.map((_, i) => (i === 0 ? 3 : 1.6));
  return (
    <View wrap={false}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      {section.note ? <Text style={styles.sectionNote}>{section.note}</Text> : null}
      {section.rows.length === 0 ? (
        <Text style={styles.empty}>{section.empty ?? "No data"}</Text>
      ) : (
        <View style={styles.table}>
          <View style={styles.tHead}>
            {section.columns.map((c, i) => (
              <Text
                key={i}
                style={[styles.th, { flex: flexes[i]!, textAlign: c.align === "right" ? "right" : "left" }]}
              >
                {c.label}
              </Text>
            ))}
          </View>
          {section.rows.map((row, r) => (
            <View style={styles.tRow} key={r} wrap={false}>
              {row.map((cell, i) => (
                <Text
                  key={i}
                  style={[styles.td, { flex: flexes[i]!, textAlign: cell.align === "right" ? "right" : "left" }]}
                >
                  {cell.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function ReportPdf({ doc, org }: { doc: ReportDocument; org: ReportPdfOrg }) {
  const addr = org.address ?? {};
  const addrLine = [addr.line1, addr.city, addr.postcode].filter(Boolean).join(", ");
  const generated = doc.generatedAt.slice(0, 19).replace("T", " ");

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow} fixed>
          <View style={{ flex: 1 }}>
            <Text style={styles.orgName}>{org.name}</Text>
            <View style={styles.orgBlock}>
              {addrLine ? <Text>{addrLine}</Text> : null}
              {org.phone ? <Text>{org.phone}</Text> : null}
              {org.vat_number ? <Text>VAT no. {org.vat_number}</Text> : null}
            </View>
          </View>
          {org.logo_url ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image style={styles.logo} src={org.logo_url} />
          ) : null}
        </View>

        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{doc.title}</Text>
            <Text style={styles.subtitle}>{doc.subtitle}</Text>
          </View>
          <View style={styles.metaBlock}>
            <Text>Generated</Text>
            <Text>{generated} UTC</Text>
          </View>
        </View>

        {doc.sections.map((section, i) => (
          <SectionTable key={i} section={section} />
        ))}

        <View style={styles.footer} fixed>
          <Text>
            {org.name} · {doc.title}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
